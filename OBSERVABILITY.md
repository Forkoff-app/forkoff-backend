# ForkOff API Observability

## Overview

Structured JSON logging → CloudWatch Logs → Metric Filters → Alarms.

All application logs are shipped to CloudWatch via Docker's `awslogs` driver. In production, every log line is valid JSON with `level`, `message`, `timestamp`, and `context` fields. In development, logs are colorized and human-readable.

## Architecture

```
NestJS App (Winston JSON logs)
  → Docker awslogs driver
    → CloudWatch Logs (/forkoff/production/api)
      → Metric Filters (ForkOff/API namespace)
        → CloudWatch Alarms
          → SNS Topic (forkoff-api-alerts)
```

## Logging Configuration

### Winston Logger (`src/logging/winston.config.ts`)

| Environment | Format | Default Level |
|---|---|---|
| Production (`NODE_ENV=production` or `Prod`) | JSON (one line per event) | `info` |
| Development | Colorized human-readable | `debug` |

Override log level with `LOG_LEVEL` env var.

### HTTP Request Logging (`src/logging/http-logging.middleware.ts`)

Every HTTP request (except `/health`) is logged with:

| Field | Description |
|---|---|
| `requestId` | From `x-request-id`, `x-amzn-trace-id` (ALB), or generated UUID |
| `method` | HTTP method |
| `url` | Request URL |
| `statusCode` | Response status code |
| `durationMs` | Response time in milliseconds |
| `ip` | Client IP (from `x-forwarded-for` or direct) |
| `userAgent` | User-Agent header |

Log levels by status code:
- **5xx** → `error`
- **4xx** → `warn`
- **2xx/3xx** → `info`

The `/health` endpoint is skipped to avoid noise from ALB health checks (every 30s).

### Global Exception Filter (`src/logging/all-exceptions.filter.ts`)

Catches all unhandled exceptions and logs structured error data including `requestId`, `method`, `url`, `statusCode`, and stack trace. Returns a consistent error response shape.

### Request ID

The `X-Request-Id` response header is set on every request. Downstream code can access `(req as any).requestId`. The middleware honors ALB's `x-amzn-trace-id` header when present.

## CloudWatch

### Log Group

| Environment | Log Group | Retention |
|---|---|---|
| Production | `/forkoff/production/api` | 30 days |

### Metric Filters (Namespace: `ForkOff/API`)

| Filter Name | Pattern | Metric |
|---|---|---|
| ErrorCount | `{ $.level = "error" }` | `ErrorCount` |
| 5xxCount | `{ $.statusCode >= 500 }` | `5xxCount` |
| 4xxCount | `{ $.statusCode >= 400 && $.statusCode < 500 }` | `4xxCount` |
| ResponseLatency | `{ $.durationMs = * }` | `ResponseLatencyMs` (value from field) |

### Alarms (→ SNS: `forkoff-api-alerts`)

| Alarm | Condition | Period |
|---|---|---|
| `forkoff-api-high-error-rate` | ErrorCount > 10 | 5 min |
| `forkoff-api-5xx-spike` | 5xxCount > 5 | 5 min |
| `forkoff-api-high-latency` | ResponseLatencyMs p99 > 5000ms | 5 min (2 consecutive) |

All alarms use `treat-missing-data: notBreaching`.

### SNS Topic

**ARN:** `arn:aws:sns:us-east-1:962795992718:forkoff-api-alerts`

Add an email subscriber:
```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:962795992718:forkoff-api-alerts \
  --protocol email \
  --notification-endpoint your@email.com \
  --region us-east-1
```

## IAM

Inline policy `CloudWatchLogsAccess` on `forkoff-ec2-role`:

```json
{
  "Effect": "Allow",
  "Action": [
    "logs:CreateLogGroup",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "logs:DescribeLogGroups",
    "logs:DescribeLogStreams"
  ],
  "Resource": "arn:aws:logs:us-east-1:962795992718:log-group:/forkoff/*"
}
```

## Docker (`deploy.sh`)

The container runs with:
```bash
--log-driver=awslogs
--log-opt awslogs-region=us-east-1
--log-opt awslogs-group=/forkoff/production/api
--log-opt awslogs-create-group=true
```

**Note:** With `awslogs` driver, `docker logs` no longer works on the EC2 instance. Use CloudWatch instead.

## Useful CloudWatch Logs Insights Queries

### Recent errors
```
fields @timestamp, level, message, context, statusCode, durationMs
| filter level = "error"
| sort @timestamp desc
| limit 20
```

### Slow requests (>1s)
```
fields @timestamp, method, url, statusCode, durationMs, requestId
| filter durationMs > 1000
| sort durationMs desc
| limit 20
```

### All 5xx responses
```
fields @timestamp, method, url, statusCode, durationMs, requestId
| filter statusCode >= 500
| sort @timestamp desc
| limit 20
```

### Request volume by endpoint
```
stats count(*) as requests by url
| filter ispresent(statusCode)
| sort requests desc
| limit 20
```

## Files Changed

### New files
- `src/logging/winston.config.ts` — Winston configuration
- `src/logging/http-logging.middleware.ts` — HTTP request logging middleware
- `src/logging/all-exceptions.filter.ts` — Global exception filter

### Modified files
- `src/main.ts` — Winston logger, exception filter, removed ad-hoc `/devices` middleware
- `src/app.module.ts` — Registered `HttpLoggingMiddleware` for all routes
- `src/auth/auth.controller.ts` — Replaced `console.log/error` with `Logger`
- `src/websocket/websocket.gateway.ts` — Replaced `console.log` with `this.logger.debug()`
- `src/config/secrets.ts` — Replaced `console.log/error` with `Logger`
- `package.json` — Added `winston`, `nest-winston`

### Known limitation
The `loadSecrets()` function in `secrets.ts` runs before `NestFactory.create()`, so its 2-3 startup log lines use NestJS's default logger format (colorized, not JSON). All subsequent logs are structured JSON.
