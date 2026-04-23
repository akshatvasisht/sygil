import type { PrometheusMetrics } from "./prometheus-metrics.js";
import { logger } from "../utils/logger.js";

/**
 * Periodic OTLP/HTTP JSON pusher.
 *
 * Activates when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Sends a cumulative
 * snapshot of the registry's state every `exportIntervalMs` (default 15s).
 * Requests use Content-Type `application/json` and respect the standard OTLP
 * path conventions: if the endpoint is `http://host:4318` the POST goes to
 * `http://host:4318/v1/metrics`; if the operator supplies a full URL ending
 * in `/v1/metrics` that is used verbatim.
 *
 * Push failures are logged at debug level and do NOT throw — a collector
 * outage must never crash the run. Fire-and-forget with no retry; the next
 * tick will re-send the current cumulative snapshot.
 */

const DEFAULT_EXPORT_INTERVAL_MS = 15_000;
// Per the OTel OTLP spec, exporters should bound every export; default 10s is
// what the OpenTelemetry SDK uses via `OTEL_EXPORTER_OTLP_TIMEOUT`. Without
// this, a hung collector would block `await otlpPusher.stop()` in the run-
// command finally block indefinitely, stranding the CLI process.
const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;

export interface OtlpPusherConfig {
  endpoint: string;
  metrics: PrometheusMetrics;
  exportIntervalMs?: number;
  /** Per-request timeout in ms. Aborts the HTTP POST if the collector hangs. */
  exportTimeoutMs?: number;
  /** Optional bearer token for OTLP backends that require auth. */
  headers?: Record<string, string>;
  /** Override the HTTP fetcher — used by tests. */
  fetchImpl?: typeof fetch;
  /** Override the timer — used by tests. Defaults to global setInterval. */
  setIntervalImpl?: typeof setInterval;
  /** Override the timer — used by tests. Defaults to global clearInterval. */
  clearIntervalImpl?: typeof clearInterval;
}

export class OtlpPusher {
  private readonly endpoint: string;
  private readonly metrics: PrometheusMetrics;
  private readonly exportIntervalMs: number;
  private readonly exportTimeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pushInFlight: Promise<void> | null = null;

  constructor(config: OtlpPusherConfig) {
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.metrics = config.metrics;
    this.exportIntervalMs = config.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS;
    this.exportTimeoutMs = config.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
    this.headers = config.headers ?? {};
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.setIntervalImpl = config.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = config.clearIntervalImpl ?? clearInterval;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.setIntervalImpl(() => {
      this.pushInFlight = this.pushOnce().catch((err) => {
        logger.debug(`[OtlpPusher] push failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.exportIntervalMs);
    // Prevent the timer from keeping the process alive after the workflow
    // finishes — the workflow lifecycle decides when to stop the pusher.
    if (this.timer !== null && typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
    if (this.pushInFlight) {
      await this.pushInFlight.catch(() => {});
    }
  }

  /** One-shot push. Exposed so callers can force a flush on workflow end. */
  async pushOnce(): Promise<void> {
    const payload = this.metrics.renderOtlp();
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.exportTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`OTLP endpoint returned HTTP ${res.status}`);
    }
  }
}

function normalizeEndpoint(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/metrics")) return trimmed;
  return `${trimmed}/v1/metrics`;
}
