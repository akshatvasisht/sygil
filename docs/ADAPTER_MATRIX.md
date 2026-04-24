# Adapter Field Support Matrix

Runtime behavior of `NodeConfig` fields per adapter. Mirrors `packages/shared/src/adapter-parity.ts`.

**Legend:** `✅ enforced` = honored at runtime · `⚠️ partial` = best-effort / unreliable · `✗ ignored` = silently no-ops · `–` = not applicable

| Field            | claude-cli    | claude-sdk    | codex         | cursor        | gemini-cli    | local-oai     |
|------------------|---------------|---------------|---------------|---------------|---------------|---------------|
| `adapter`        | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   |
| `model`          | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   |
| `role`           | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   |
| `prompt`         | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   |
| `maxTurns`       | ✅ enforced   | ✅ enforced   | ✗ ignored    | ✗ ignored    | ✗ ignored    | ✅ enforced   |
| `timeoutMs`      | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   |
| `idleTimeoutMs`  | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   |
| `tools`          | ✅ enforced   | ✅ enforced   | ✗ ignored    | ✗ ignored    | ✗ ignored    | ✅ enforced   |
| `disallowedTools`| ✅ enforced   | ✅ enforced   | ✗ ignored    | ✗ ignored    | ✗ ignored    | ✅ enforced   |
| `sandbox`        | ⚠️ partial   | –             | ✅ enforced   | ✅ enforced   | –             | –             |
| `outputSchema`   | ⚠️ partial   | ✅ enforced   | ⚠️ partial   | ⚠️ partial   | ⚠️ partial   | ✅ enforced   |
| `providers`      | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   | ✅ enforced   |
| `maxBudgetUsd`   | ✅ enforced   | ✅ enforced   | ⚠️ partial   | ✅ enforced   | ✅ enforced   | ✗ ignored    |

## Notes

- **`tools` / `disallowedTools`** — `codex`, `cursor`, and `gemini-cli` manage their own tool inventory; the `tools`/`disallowedTools` fields are passed to the CLI but have no effect.
- **`sandbox`** — `claude-cli` maps modes to `--sandbox` flags (partial because not all modes are supported). `claude-sdk` and `local-oai` run in-process; sandbox does not apply (`–`).
- **`outputSchema`** — `claude-sdk` and `local-oai` pass the schema directly to the API for structured output. Others rely on the post-hoc `validateStructuredOutput` pass in the scheduler.
- **`maxBudgetUsd`** — `local-oai` does not track cost (no billing endpoint); the field is ignored. `codex` reports cost estimate, not actual billing, so support is partial.
- **`gemini-cli` tools** — upstream switched `--allowed-tools` → `--policy` in v0.30.0; tools allowlist is currently ignored with a warning.

Source of truth: `packages/shared/src/adapter-parity.ts > ADAPTER_FIELD_SUPPORT`.
Pre-flight integration: `packages/cli/src/commands/run.ts` warns at workflow start when a used field is `ignored` or `na`.
