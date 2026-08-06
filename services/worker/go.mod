module github.com/otel-demo/worker

go 1.22

require (
        github.com/jackc/pgx/v5 v5.7.2
        github.com/rabbitmq/amqp091-go v1.10.0
        go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.58.0
        go.opentelemetry.io/otel v1.33.0
        go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc v0.9.0
        go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc v1.33.0
        go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.33.0
        go.opentelemetry.io/otel/log v0.9.0
        go.opentelemetry.io/otel/sdk v1.33.0
        go.opentelemetry.io/otel/sdk/log v0.9.0
        go.opentelemetry.io/otel/sdk/metric v1.33.0
        go.opentelemetry.io/otel/trace v1.33.0
        google.golang.org/grpc v1.68.1
)
