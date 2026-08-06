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
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type orderEvent struct {
	ID                     string   `json:"id"`
	ProductID              int      `json:"product_id"`
	Quantity               int      `json:"quantity"`
	AmountCents            int      `json:"amount_cents"`
	Currency               string   `json:"currency"`
	WeatherTempC           *float64 `json:"weather_temp_c"`
	StripePaymentIntentID  *string  `json:"stripe_payment_intent_id"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	shutdown, err := setupOTel(ctx)
	if err != nil {
		log.Fatalf("otel setup: %v", err)
	}
	defer func() { _ = shutdown(context.Background()) }()

	dbURL := envOr("DATABASE_URL", "postgres://otel:otel@localhost:5432/otel_demo?sslmode=disable")
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()

	rabbitURL := envOr("RABBITMQ_URL", "amqp://otel:otel@localhost:5672/")
	conn, err := amqp.Dial(rabbitURL)
	if err != nil {
		log.Fatalf("rabbitmq: %v", err)
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		log.Fatalf("channel: %v", err)
	}
	defer ch.Close()

	_, err = ch.QueueDeclare("orders.created", true, false, false, false, nil)
	if err != nil {
		log.Fatalf("queue: %v", err)
	}

	deliveries, err := ch.Consume("orders.created", "worker-service", false, false, false, false, nil)
	if err != nil {
		log.Fatalf("consume: %v", err)
	}

	tracer := otel.Tracer("worker-service")
	client := &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport), Timeout: 10 * time.Second}

	log.Println("worker-service consuming orders.created")
	for {
		select {
		case <-ctx.Done():
			return
		case d, ok := <-deliveries:
			if !ok {
				return
			}
			processDelivery(ctx, tracer, client, pool, d)
		}
	}
}

func processDelivery(ctx context.Context, tracer trace.Tracer, client *http.Client, pool *pgxpool.Pool, d amqp.Delivery) {
	propagator := otel.GetTextMapPropagator()
	carrier := amqpHeaderCarrier(d.Headers)
	ctx = propagator.Extract(ctx, carrier)

	ctx, span := tracer.Start(ctx, "worker.consume_order_created",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "rabbitmq"),
			attribute.String("messaging.destination.name", "orders.created"),
			attribute.String("messaging.operation", "process"),
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
	span.SetAttributes(attribute.String("order.id", event.ID))

	ref, err := callJSONPlaceholder(ctx, client, event.ID)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		_ = d.Nack(false, true)
		return
	}

	_, err = pool.Exec(ctx,
		`UPDATE orders SET status = 'processed', external_ref = $2, updated_at = NOW() WHERE id = $1`,
		event.ID, ref,
	)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		_ = d.Nack(false, true)
		return
	}

	span.SetAttributes(attribute.String("order.external_ref", ref))
	_ = d.Ack(false)
	log.Printf("processed order %s ref=%s", event.ID, ref)
}

func callJSONPlaceholder(ctx context.Context, client *http.Client, orderID string) (string, error) {
	ctx, span := otel.Tracer("worker-service").Start(ctx, "worker.call_jsonplaceholder",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("peer.service", "jsonplaceholder"),
			attribute.String("dependency.type", "third_party"),
			attribute.String("order.id", orderID),
		),
	)
	defer span.End()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://jsonplaceholder.typicode.com/posts/1", nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return "", err
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
	endpoint := envOr("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317")
	endpoint = stripScheme(endpoint)

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

	conn, err := grpc.NewClient(endpoint, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}

	traceExp, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExp),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	metricExp, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, err
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp, sdkmetric.WithInterval(15*time.Second))),
		sdkmetric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	logExp, err := otlploggrpc.New(ctx, otlploggrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, err
	}
	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExp)),
		sdklog.WithResource(res),
	)
	global.SetLoggerProvider(lp)

	return func(ctx context.Context) error {
		var first error
		for _, fn := range []func(context.Context) error{tp.Shutdown, mp.Shutdown, lp.Shutdown} {
			if err := fn(ctx); err != nil && first == nil {
				first = err
			}
		}
		return first
	}, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func stripScheme(endpoint string) string {
	for _, p := range []string{"https://", "http://"} {
		if len(endpoint) > len(p) && endpoint[:len(p)] == p {
			return endpoint[len(p):]
		}
	}
	return endpoint
}

type amqpHeaders map[string]any

func amqpHeaderCarrier(h amqp.Table) propagation.TextMapCarrier {
	out := propagation.MapCarrier{}
	if h == nil {
		return out
	}
	for k, v := range h {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	return out
}
