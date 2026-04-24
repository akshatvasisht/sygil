import chalk from "chalk";
import type { WorkflowGraph } from "@sygil/shared";
import { getAdapter } from "../adapters/index.js";
import { WorkflowScheduler } from "../scheduler/index.js";
import { WsMonitorServer } from "../monitor/websocket.js";
import { PrometheusMetrics } from "../monitor/prometheus-metrics.js";
import { MetricsServer } from "../monitor/metrics-server.js";
import { OtlpPusher } from "../monitor/otlp-push.js";
import type { HooksConfig } from "../utils/config.js";

/**
 * Shared scheduler bootstrap for the `run` and `resume` commands.
 *
 * Extracts the construction sequence (monitor, optional Prometheus/OTLP
 * exporters, scheduler) and the teardown sequence (pushOnce + stop + drain)
 * that previously lived duplicated in both commands. Determinism-neutral.
 */

export interface BootstrapOpts {
  workflow: WorkflowGraph;
  /** Optional path to the workflow JSON — threaded into the scheduler so the
   * run state records it for later `resume` calls. */
  workflowPath?: string;
  /** Lifecycle hook script paths (from `.sygil/config.json > hooks`). */
  hooks?: HooksConfig;
  /** Start the WebSocket monitor server. Default true. Skipped in --no-monitor
   * (headless) mode. */
  enableMonitor?: boolean;
  /** Opt-in Prometheus exporter port (already parsed from --metrics-port).
   * When set, activates the HTTP metrics endpoint and — if
   * OTEL_EXPORTER_OTLP_ENDPOINT is defined — the periodic OTLP pusher. */
  metricsPort?: number;
}

export interface SchedulerContext {
  scheduler: WorkflowScheduler;
  monitor: WsMonitorServer;
  /** null when monitor is disabled (headless mode). */
  monitorPort: number | null;
  /** null when monitor is disabled (headless mode). */
  monitorAuthToken: string | null;
  prometheusMetrics: PrometheusMetrics | null;
  /** Actual bound port returned by MetricsServer.start (0 = random). */
  metricsPort: number | null;
  metricsAuthToken: string | null;
  /** Set when OTEL_EXPORTER_OTLP_ENDPOINT is present and metricsPort is set. */
  otlpEndpoint: string | null;
  /** Bundles monitor.stop, otlp flush+stop, and metrics-server stop. Idempotent;
   * callers should invoke from a `finally` block. AdapterPool drain is handled
   * internally by WorkflowScheduler.run/resume. */
  teardown: () => Promise<void>;
}

export async function buildSchedulerContext(
  opts: BootstrapOpts,
): Promise<SchedulerContext> {
  let prometheusMetrics: PrometheusMetrics | null = null;
  let metricsServer: MetricsServer | null = null;
  let otlpPusher: OtlpPusher | null = null;
  let metricsPort: number | null = null;
  let metricsAuthToken: string | null = null;
  let otlpEndpoint: string | null = null;

  if (opts.metricsPort !== undefined) {
    prometheusMetrics = new PrometheusMetrics();
    metricsServer = new MetricsServer({ port: opts.metricsPort, metrics: prometheusMetrics });
    try {
      metricsPort = await metricsServer.start(opts.metricsPort);
      metricsAuthToken = metricsServer.getAuthToken();
    } catch (err) {
      throw new Error(
        `Failed to start metrics server: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const envOtlp = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    if (envOtlp) {
      otlpPusher = new OtlpPusher({ endpoint: envOtlp, metrics: prometheusMetrics });
      otlpPusher.start();
      otlpEndpoint = envOtlp;
    }
  }

  const monitor = new WsMonitorServer();
  if (prometheusMetrics) {
    monitor.setPrometheusMetrics(prometheusMetrics);
  }

  let monitorPort: number | null = null;
  let monitorAuthToken: string | null = null;
  if (opts.enableMonitor !== false) {
    monitorPort = await monitor.start();
    monitorAuthToken = monitor.getAuthToken();
  }

  const scheduler = new WorkflowScheduler(
    opts.workflow,
    getAdapter,
    monitor,
    opts.workflowPath,
  );

  const teardown = async (): Promise<void> => {
    await monitor.stop().catch(() => {});
    if (otlpPusher) {
      await otlpPusher.pushOnce().catch(() => {});
      await otlpPusher.stop();
    }
    if (metricsServer) {
      await metricsServer.stop();
    }
  };

  return {
    scheduler,
    monitor,
    monitorPort,
    monitorAuthToken,
    prometheusMetrics,
    metricsPort,
    metricsAuthToken,
    otlpEndpoint,
    teardown,
  };
}

/** Convenience: render the hooks field unchanged — placeholder to keep the
 * bootstrap API surface narrow. Callers pass `hooks` through to the scheduler's
 * `RunOptions` / `ResumeOptions`. */
export function hooksFromContext(opts: BootstrapOpts): HooksConfig | undefined {
  return opts.hooks;
}

/** Util: format the Prometheus URL for user display. Returned so the caller
 * decides whether to log it (run does, resume does not today). */
export function formatMetricsUrl(port: number, token: string): string {
  return (
    chalk.dim(`  Prometheus metrics: `) +
    chalk.cyan(`http://localhost:${port}/metrics?token=${token}`)
  );
}
