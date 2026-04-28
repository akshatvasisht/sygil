# Observability

Sygil exposes runtime metrics in two complementary modes: **pull** (Prometheus
scrape) and **push** (OTLP/HTTP JSON). Both read from the same in-process
`PrometheusMetrics` registry; the metric set is identical.

## Pull mode: Prometheus scrape

Implementation: `packages/cli/src/monitor/metrics-server.ts`

Start the metrics HTTP server by passing `--metrics-port <port>` to `sygil run`:

```bash
sygil run workflow.json --metrics-port 9090
```

Exposes `GET /metrics` (Prometheus 0.0.4 text exposition) and `GET /healthz`.
`/metrics` requires the per-run auth token printed to stdout at run start —
pass as `?token=<uuid>` or `Authorization: Bearer <uuid>`. `/healthz` is open
so orchestrators can probe liveness without credentials.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: sygil
    static_configs: [{ targets: ["localhost:9090"] }]
    params:
      token: ["<per-run-uuid>"]
```

## Push mode: OTLP

Implementation: `packages/cli/src/monitor/otlp-push.ts`

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to activate the pusher:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 \
  sygil run workflow.json --metrics-port 9090
```

**Behavior:**
- Cumulative snapshot every **15 seconds** (fire-and-forget).
- Posts to `<endpoint>/v1/metrics`; if the endpoint already ends in `/v1/metrics` it is used verbatim.
- Per-request timeout **10 seconds**; push failures log at debug and never crash the scheduler.
- Flushes one final snapshot at workflow end.

Optional bearer auth:

```bash
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>" \
  sygil run workflow.json
```

## Exposed metrics

Prometheus naming conventions (`sygil_` prefix, `snake_case`, seconds base unit, `_total` on counters).

### `sygil_node_duration_seconds` — Histogram

Wall-clock duration of each node execution.

**Labels:** `adapter`, `status` (`ok`/`error`), `gen_ai_system`, `gen_ai_request_model`, `gen_ai_operation_name` (always `chat`)
**Buckets (s):** 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 600, 1800

### `sygil_node_total` — Counter

Total completed node executions. **Labels:** same as `sygil_node_duration_seconds`.

### `sygil_gate_total` — Counter

Total gate evaluations.
**Labels:** `type` (`exit_code`, `file_exists`, `regex`, `script`, `human_review`, `spec_compliance`), `result` (`passed`/`failed`)

### `sygil_adapter_acquire_wait_seconds` — Histogram

Time spent waiting for an adapter pool slot (0 for uncontended acquires).
**Labels:** `adapter`, `gen_ai_system`
**Buckets (s):** 0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 30, 60

### `sygil_checkpoint_write_total` — Counter

Total successful checkpoint writes. **Labels:** none.

## Routing to LangFuse / Grafana Cloud / Datadog / etc.

Any OTLP-compatible backend works. The canonical setup is an
[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) between Sygil and the backend — Sygil pushes OTLP/HTTP to the collector, the collector forwards in whatever format the backend wants. Point `OTEL_EXPORTER_OTLP_ENDPOINT` at your collector's HTTP receiver (typically `http://host:4318`) and configure the collector's exporter per your backend's docs.

For pull-mode (`--metrics-port`), any Prometheus-compatible scraper works — Grafana Cloud, Mimir, Thanos, Victoria Metrics all accept the standard exposition format directly.
