import { describe, it, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "./cli-program.js";

// Capture the full help output (base + addHelpText before/after/afterAll)
// by routing `outputHelp` through a string-collecting writer.
function captureHelp(cmd: Command): string {
  let out = "";
  cmd.configureOutput({
    writeOut: (chunk: string) => {
      out += chunk;
    },
    writeErr: (chunk: string) => {
      out += chunk;
    },
  });
  cmd.outputHelp();
  return out;
}

describe("buildProgram", () => {
  it("top-level --help includes environment variables section", () => {
    const program = buildProgram();
    const help = captureHelp(program);
    expect(help).toContain("Environment variables");
    expect(help).toContain("ANTHROPIC_API_KEY");
    expect(help).toContain("GEMINI_API_KEY");
    expect(help).toContain("SYGIL_LOCAL_OAI_URL");
    expect(help).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
  });

  it("top-level --help includes monitor URL + token pattern", () => {
    const program = buildProgram();
    const help = captureHelp(program);
    expect(help).toContain("?token=<uuid>");
    expect(help).toContain("monitor?ws=");
  });

  it("top-level --help includes quickstart pointers", () => {
    const program = buildProgram();
    const help = captureHelp(program);
    expect(help).toContain("Quick start");
    expect(help).toContain("sygil init");
    expect(help).toContain("sygil export tdd-feature");
    expect(help).toContain("sygil run");
  });

  it("`run` subcommand --help includes canonical invocations", () => {
    const program = buildProgram();
    const runCmd = program.commands.find((c) => c.name() === "run");
    expect(runCmd).toBeDefined();
    const help = captureHelp(runCmd!);
    expect(help).toContain("Examples:");
    expect(help).toContain("sygil run templates/tdd-feature.json");
    expect(help).toContain("--metrics-port 9090");
  });

  it("`resume` subcommand --help includes canonical invocations", () => {
    const program = buildProgram();
    const resumeCmd = program.commands.find((c) => c.name() === "resume");
    expect(resumeCmd).toBeDefined();
    const help = captureHelp(resumeCmd!);
    expect(help).toContain("Examples:");
    expect(help).toContain("sygil resume");
  });

  it("`replay` subcommand --help includes canonical invocations", () => {
    const program = buildProgram();
    const replayCmd = program.commands.find((c) => c.name() === "replay");
    expect(replayCmd).toBeDefined();
    const help = captureHelp(replayCmd!);
    expect(help).toContain("Examples:");
    expect(help).toContain("-s 0");
  });

  it("`export` subcommand --help lists bundled templates", () => {
    const program = buildProgram();
    const exportCmd = program.commands.find((c) => c.name() === "export");
    expect(exportCmd).toBeDefined();
    const help = captureHelp(exportCmd!);
    expect(help).toContain("Examples:");
    expect(help).toContain("tdd-feature");
    expect(help).toContain("optimize");
  });

  it("`init` subcommand --help includes telemetry flag guidance", () => {
    const program = buildProgram();
    const initCmd = program.commands.find((c) => c.name() === "init");
    expect(initCmd).toBeDefined();
    const help = captureHelp(initCmd!);
    expect(help).toContain("Examples:");
    expect(help).toContain("--no-telemetry");
  });
});
