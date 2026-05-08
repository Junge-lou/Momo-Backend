# Stage 1: Build Go binary
FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /app/momo-backend ./main.go

# Stage 2: Runtime
FROM alpine:3.21
RUN apk --no-cache add ca-certificates tzdata
WORKDIR /app

# Copy binary
COPY --from=builder /app/momo-backend .

# Copy dashboard static files (injected by CI)
COPY public ./public

# Data and config directories (mount volumes here)
RUN mkdir -p /app/data /app/config

EXPOSE 3000

VOLUME ["/app/data", "/app/config"]

CMD ["./momo-backend"]
