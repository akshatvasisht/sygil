/**
 * Lightweight logger that writes to stderr (warn/error) or stdout (info/success/debug).
 * Output is level-filtered: debug and verbose messages are suppressed unless verbose
 * mode is enabled via setVerbose(true). Coloured output is provided by chalk.
 */
import chalk from "chalk";

let verbose = false;

/** Enables or disables verbose/debug output for the logger. */
export function setVerbose(v: boolean): void {
  verbose = v;
}

/** Returns true if verbose mode is currently enabled. */
export function isVerbose(): boolean {
  return verbose;
}

/**
 * Structured logger with coloured output.
 * - info: plain stdout
 * - success: green stdout
 * - warn: yellow stderr
 * - error: red stderr
 * - debug/verbose: dim stdout, only when verbose mode is active
 */
export const logger = {
  info: (msg: string) => console.log(msg),
  success: (msg: string) => console.log(chalk.green(msg)),
  warn: (msg: string) => console.warn(chalk.yellow(msg)),
  error: (msg: string) => console.error(chalk.red(msg)),
  debug: (msg: string) => {
    if (verbose) console.log(chalk.dim(`[debug] ${msg}`));
  },
  verbose: (msg: string) => {
    if (verbose) console.log(chalk.dim(msg));
  },
};
