package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	flagd "github.com/open-feature/go-sdk-contrib/providers/flagd/pkg"
	"github.com/open-feature/go-sdk/openfeature"
	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.opentelemetry.io/otel/trace"
)

type chaosOptions struct {
	WorkerLatencyMs     int  `json:"worker_latency_ms"`
	QueueLagMs          int  `json:"queue_lag_ms"`
	FailJSONPlaceholder bool `json:"fail_jsonplaceholder"`
}

type orderEvent struct {
	ID                    string        `json:"id"`
	ProductID             int           `json:"product_id"`
	Quantity              int           `json:"quantity"`
	AmountCents           int           `json:"amount_cents"`
	Currency              string        `json:"currency"`
	WeatherTempC          *float64      `json:"weather_temp_c"`
	StripePaymentIntentID *string       `json:"stripe_payment_intent_id"`
	Chaos                 *chaosOptions `json:"chaos"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	shutdown, err := setupOTel(ctx)
	if err != nil {
		log.Printf("otel setup warning (continuing): %v", err)
	} else {
		defer func() { _ = shutdown(context.Background()) }()
	}

	// Never block the consumer on flagd — evaluate with defaults until ready.
	go setupFeatureFlags()

	dbURL := envOr("DATABASE_URL", "postgres://otel:otel@localhost:5432/otel_demo?sslmode=disable")
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()
	ensureColumns(ctx, pool)

	go serveHealth(pool)

	tracer := otel.Tracer("worker-service")
	client := &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
		Timeout:   12 * time.Second,
	}

	rabbitURL := envOr("RABBITMQ_URL", "amqp://otel:otel@localhost:5672/")
	for {
		if ctx.Err() != nil {
			return
		}
		if err := consumeLoop(ctx, rabbitURL, tracer, client, pool); err != nil {
			log.Printf("consumer stopped: %v — reconnecting in 2s", err)
			time.Sleep(2 * time.Second)
		}
	}
}

func serveHealth(pool *pgxpool.Pool) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		status := "ok"
		if err := pool.Ping(r.Context()); err != nil {
			status = "degraded"
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_, _ = w.Write([]byte(fmt.Sprintf(`{"status":"%s","service":"worker-service"}`, status)))
	})
	addr := ":" + envOr("HEALTH_PORT", "8083")
	log.Printf("worker health on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Printf("health server: %v", err)
	}
}

func consumeLoop(ctx context.Context, rabbitURL string, tracer trace.Tracer, client *http.Client, pool *pgxpool.Pool) error {
	conn, err := amqp.Dial(rabbitURL)
	if err != nil {
		return fmt.Errorf("rabbitmq dial: %w", err)
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("channel: %w", err)
	}
	defer ch.Close()

	if _, err = ch.QueueDeclare("orders.created", true, false, false, false, nil); err != nil {
		return fmt.Errorf("queue: %w", err)
	}
	if err = ch.Qos(1, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	deliveries, err := ch.Consume("orders.created", "worker-service", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	log.Println("worker-service consuming orders.created")
	notify := conn.NotifyClose(make(chan *amqp.Error, 1))

	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-notify:
			if err != nil {
				return fmt.Errorf("connection closed: %w", err)
			}
			return fmt.Errorf("connection closed")
		case d, ok := <-deliveries:
			if !ok {
				return fmt.Errorf("delivery channel closed")
			}
			processDelivery(ctx, tracer, client, pool, d)
		}
	}
}

func setupFeatureFlags() {
	host := envOr("FLAGD_HOST", "flagd")
	port := envOr("FLAGD_PORT", "8013")
	provider := flagd.NewProvider(
		flagd.WithHost(host),
		flagd.WithPort(uint16(mustAtoi(port, 8013))),
	)
	// Non-blocking: consumer must start even if flagd is slow/down.
	if err := openfeature.SetProvider(provider); err != nil {
		log.Printf("openfeature set provider: %v", err)
		return
	}
	log.Printf("OpenFeature flagd provider registered at %s:%s", host, port)
}

func mustAtoi(s string, def int) int {
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return def
	}
	return n
}

func resolveChaosFromFlags(ctx context.Context, orderID string) chaosOptions {
	client := openfeature.NewClient("worker-service")
	evalCtx := openfeature.NewEvaluationContext(orderID, map[string]any{})
	out := chaosOptions{}
	if v, err := client.IntValue(ctx, "chaos.worker_latency_ms", 0, evalCtx); err == nil {
		out.WorkerLatencyMs = int(v)
	}
	if v, err := client.IntValue(ctx, "chaos.queue_lag_ms", 0, evalCtx); err == nil {
		out.QueueLagMs = int(v)
	}
	if v, err := client.BooleanValue(ctx, "chaos.fail_jsonplaceholder", false, evalCtx); err == nil {
		out.FailJSONPlaceholder = v
	}
	return out
}

func mergeChaos(msg *chaosOptions, flags chaosOptions) chaosOptions {
	out := flags
	if msg == nil {
		return out
	}
	if msg.WorkerLatencyMs > out.WorkerLatencyMs {
		out.WorkerLatencyMs = msg.WorkerLatencyMs
	}
	if msg.QueueLagMs > out.QueueLagMs {
		out.QueueLagMs = msg.QueueLagMs
	}
	out.FailJSONPlaceholder = out.FailJSONPlaceholder || msg.FailJSONPlaceholder
	return out
}

func ensureColumns(ctx context.Context, pool *pgxpool.Pool) {
	_, _ = pool.Exec(ctx, `ALTER TABLE orders ADD COLUMN IF NOT EXISTS error_message TEXT`)
	_, _ = pool.Exec(ctx, `ALTER TABLE orders ADD COLUMN IF NOT EXISTS chaos_flags JSONB`)
}

func markOrder(ctx context.Context, pool *pgxpool.Pool, id, status, ref, errMsg string) error {
	_, err := pool.Exec(ctx, `
		UPDATE orders
		SET status = $2,
		    external_ref = COALESCE($3, external_ref),
		    error_message = $4,
		    updated_at = NOW()
		WHERE id = $1::uuid`,
		id, status, nullIfEmpty(ref), nullIfEmpty(errMsg),
	)
	return err
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func processDelivery(ctx context.Context, tracer trace.Tracer, client *http.Client, pool *pgxpool.Pool, d amqp.Delivery) {
	propagator := otel.GetTextMapPropagator()
	ctx = propagator.Extract(ctx, amqpHeaderCarrier(d.Headers))

	ctx, span := tracer.Start(ctx, "worker.consume_order_created",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "rabbitmq"),
			attribute.String("messaging.destination.name", "orders.created"),
			attribute.String("messaging.operation", "process"),
			attribute.String("feature_flag.source", "openfeature/flagd"),
		),
	)
	defer span.End()

	var event orderEvent
	if err := json.Unmarshal(d.Body, &event); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		_ = d.Nack(false, false)
		return
	}
	if event.ID == "" {
		span.SetStatus(codes.Error, "missing order id")
		_ = d.Nack(false, false)
		return
	}
	span.SetAttributes(attribute.String("order.id", event.ID))
	log.Printf("received order %s", event.ID)

	chaos := mergeChaos(event.Chaos, resolveChaosFromFlags(ctx, event.ID))
	span.SetAttributes(
		attribute.Int("chaos.worker_latency_ms", chaos.WorkerLatencyMs),
		attribute.Int("chaos.queue_lag_ms", chaos.QueueLagMs),
		attribute.Bool("chaos.fail_jsonplaceholder", chaos.FailJSONPlaceholder),
	)

	// Mark processing before artificial lag so the UI does not look "stuck pending"
	// while chaos.queue_lag_ms is intentionally delaying the consumer.
	if err := markOrder(ctx, pool, event.ID, "processing", "", ""); err != nil {
		span.RecordError(err)
		log.Printf("mark processing failed for %s: %v", event.ID, err)
		_ = d.Nack(false, true)
		return
	}

	if chaos.QueueLagMs > 0 {
		_, lagSpan := tracer.Start(ctx, "chaos.queue_lag")
		lagSpan.SetAttributes(
			attribute.Int("chaos.queue_lag_ms", chaos.QueueLagMs),
			attribute.String("feature_flag.key", "chaos.queue_lag_ms"),
		)
		time.Sleep(time.Duration(chaos.QueueLagMs) * time.Millisecond)
		lagSpan.End()
	}

	if chaos.WorkerLatencyMs > 0 {
		_, delaySpan := tracer.Start(ctx, "chaos.delay.worker")
		delaySpan.SetAttributes(
			attribute.Int("chaos.latency_ms", chaos.WorkerLatencyMs),
			attribute.String("feature_flag.key", "chaos.worker_latency_ms"),
		)
		time.Sleep(time.Duration(chaos.WorkerLatencyMs) * time.Millisecond)
		delaySpan.End()
	}

	ref, err := callJSONPlaceholder(ctx, client, event.ID, chaos.FailJSONPlaceholder)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		if dbErr := markOrder(ctx, pool, event.ID, "failed", "", err.Error()); dbErr != nil {
			log.Printf("mark failed error for %s: %v", event.ID, dbErr)
			_ = d.Nack(false, true)
			return
		}
		_ = d.Ack(false)
		log.Printf("order %s failed: %v", event.ID, err)
		return
	}

	if err := markOrder(ctx, pool, event.ID, "processed", ref, ""); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		_ = d.Nack(false, true)
		return
	}

	span.SetAttributes(attribute.String("order.external_ref", ref))
	_ = d.Ack(false)
	log.Printf("processed order %s ref=%s", event.ID, ref)
}

func callJSONPlaceholder(ctx context.Context, client *http.Client, orderID string, failInjected bool) (string, error) {
	ctx, span := otel.Tracer("worker-service").Start(ctx, "worker.call_jsonplaceholder",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("peer.service", "jsonplaceholder"),
			attribute.String("dependency.type", "third_party"),
			attribute.String("order.id", orderID),
		),
	)
	defer span.End()

	if failInjected {
		err := fmt.Errorf("chaos_jsonplaceholder_failure")
		span.SetAttributes(
			attribute.Bool("chaos.fail_jsonplaceholder", true),
			attribute.String("feature_flag.key", "chaos.fail_jsonplaceholder"),
		)
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://jsonplaceholder.typicode.com/posts/1", nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		// Offline / egress-blocked environments still complete the order with a local ref
		// so demos are not stuck in pending. Span remains ERROR for observability.
		fallback := fmt.Sprintf("local-fallback-%s", orderID[:8])
		span.SetAttributes(attribute.String("worker.fallback_ref", fallback))
		span.AddEvent("third_party.unreachable_using_fallback")
		return fallback, nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	span.SetAttributes(attribute.Int("http.response.status_code", resp.StatusCode))
	if resp.StatusCode >= 400 {
		err = fmt.Errorf("jsonplaceholder status %d", resp.StatusCode)
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return "", err
	}

	var parsed map[string]any
	_ = json.Unmarshal(body, &parsed)
	ref := fmt.Sprintf("jp-post-%v", parsed["id"])
	span.SetAttributes(attribute.String("jsonplaceholder.post_id", fmt.Sprintf("%v", parsed["id"])))
	return ref, nil
}

func setupOTel(ctx context.Context) (func(context.Context) error, error) {
	// Shared lab default: OTLP/HTTP to local collector (same as all other services).
	endpoint := strings.TrimRight(envOr("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318"), "/")

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(envOr("OTEL_SERVICE_NAME", "worker-service")),
			semconv.ServiceNamespace("otel-demo"),
			semconv.ServiceVersion("1.0.0"),
		),
	)
	if err != nil {
		return nil, err
	}

	traceExp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint+"/v1/traces"))
	if err != nil {
		return nil, fmt.Errorf("otlp http traces: %w", err)
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(traceExp), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))

	metricExp, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(endpoint+"/v1/metrics"))
	if err != nil {
		return nil, fmt.Errorf("otlp http metrics: %w", err)
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp, sdkmetric.WithInterval(15*time.Second))),
		sdkmetric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	return func(ctx context.Context) error {
		_ = tp.Shutdown(ctx)
		_ = mp.Shutdown(ctx)
		return nil
	}, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func amqpHeaderCarrier(h amqp.Table) propagation.TextMapCarrier {
	out := propagation.MapCarrier{}
	if h == nil {
		return out
	}
	for k, v := range h {
		switch t := v.(type) {
		case string:
			out[k] = t
		case []byte:
			out[k] = string(t)
		}
	}
	return out
}
