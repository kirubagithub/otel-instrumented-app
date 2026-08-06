FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
COPY src ./src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
# OpenTelemetry Java agent for auto-instrumentation (HTTP, JDBC, etc.)
ADD https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v2.10.0/opentelemetry-javaagent.jar /otel/opentelemetry-javaagent.jar
COPY --from=build /src/target/catalog-service-1.0.0.jar /app/app.jar
ENV JAVA_TOOL_OPTIONS="-javaagent:/otel/opentelemetry-javaagent.jar"
EXPOSE 8082
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
