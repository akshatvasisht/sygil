#!/usr/bin/env node
// Load .env from cwd. Native API, no dotenv dep needed (Node >=20.12).
// Throws if the file doesn't exist — swallow to match dotenv semantics.
try { process.loadEnvFile(); } catch { /* no .env present */ }
import { buildProgram } from "./cli-program.js";

const program = buildProgram();

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
