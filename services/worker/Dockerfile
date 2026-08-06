FROM golang:1.23-alpine AS build
WORKDIR /src
RUN apk add --no-cache git ca-certificates
COPY go.mod go.sum ./
COPY main.go ./
RUN go mod download && CGO_ENABLED=0 go build -o /worker .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /worker /worker
CMD ["/worker"]
