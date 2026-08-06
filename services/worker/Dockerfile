FROM golang:1.22-alpine AS build
WORKDIR /src
RUN apk add --no-cache git ca-certificates
COPY go.mod ./
COPY main.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -o /worker .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /worker /worker
CMD ["/worker"]
