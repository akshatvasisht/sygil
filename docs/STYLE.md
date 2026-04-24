# Coding Standards

## Language

All source files are TypeScript 5 with strict mode enabled (`"strict": true`). No `any` without an explicit justification comment; prefer `unknown` with a type guard.

### Base tsconfig (CLI and shared)

```jsonc
{
  "strict": true,
  "exactOptionalPropertyTypes": true,  // optional props cannot be explicitly set to undefined
  "noUncheckedIndexedAccess": true,    // array/object index reads return T | undefined
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true
}
```

The web package disables `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` (Next.js incompatibility). Do not carry these assumptions back to CLI/shared fixes.

## Naming

| Construct | Convention | Example |
|---|---|---|
| Variables and functions | `camelCase` | `runWorkflow`, `nodeId` |
| Classes and interfaces | `PascalCase` | `WorkflowScheduler`, `AgentAdapter` |
| Type aliases | `PascalCase` | `AdapterType`, `GateCondition` |
| Zod schemas | `PascalCase` + `Schema` suffix | `WorkflowGraphSchema` |
| Constants | `UPPER_SNAKE_CASE` | `STALL_EXIT_CODE`, `CHECKPOINT_DEBOUNCE_MS` |
| Files | `kebab-case` | `claude-sdk.ts`, `ndjson-stream.ts` |
| Test files | Same name as source + `.test.ts` | `cursor-cli.test.ts` |
| React components | `PascalCase.tsx` | `NodeCard.tsx`, `EventStream.tsx` |
| Unused parameters | Prefix with `_` | `_event` (ESLint `argsIgnorePattern: "^_"`) |

## Imports

- Use `.js` extensions on relative imports even in TypeScript source (required for ESM Node.js).
- Group imports: Node built-ins → third-party → internal packages (`@sygil/shared`) → relative.
- Type-only imports use `import type { ... }`.

## Async

- Prefer `async`/`await` over raw Promise chains.
- Async generators (`async function*`) for event streams; never buffer and return an array.
- Use `AbortController` with a timeout for all outbound HTTP fetches.

## Error handling

- Validate at system boundaries (CLI input, external HTTP responses, workflow JSON). Trust internal types inside the boundary.
- Never swallow errors silently. Either rethrow, log with `logger.error`, or return a typed result object.
- Use `SygilErrorCode` from `@sygil/shared` for programmatic error classification.
- Errors from child processes use the `message` field of `Error` — do not parse `stderr` unless necessary.

## TypeScript patterns

### exactOptionalPropertyTypes

**Wrong:**
```ts
return { costUsd: value > 0 ? value : undefined }; // TS2375
```
**Correct:**
```ts
const costUsd = value > 0 ? value : undefined;
return { ...(costUsd !== undefined ? { costUsd } : {}) };
```

### noUncheckedIndexedAccess

All array index reads return `T | undefined`. Use `arr[i]!` or `arr[i]?.method()`:
```ts
// In tests with mock.calls:
mock.calls[0]![1] as string[];
```

### Narrowing across awaits

TypeScript preserves narrowing of class properties through async boundaries. If you check `if (this.state === "cancelled") throw` before an `await`, the second check after the await will error as unreachable. Fix with `(this.state as string) === "cancelled"` or re-read into a typed local variable.

## Comments

- Comments explain *why*, not *what*. Omit comments that restate the code.
- JSDoc on exported functions and interfaces only.
- `// TODO:` and `// FIXME:` comments must include a short rationale.
- `eslint-disable-next-line` comments must include a justification after `--`.
- No task-numbered comments (e.g., `// Task 4: ...`) — use descriptive text.

## Logging

- `no-console` ESLint rule is `"off"` — direct `console.log` is allowed in CLI commands.
- Use `logger.info()` / `logger.debug()` inside the scheduler and adapters (respects `--verbose`).

## React (web package)

- Functional components only; no class components (except error boundaries).
- `useCallback` dependency arrays must be accurate — do not suppress `react-hooks/exhaustive-deps` without a documented reason.
- Mutable refs (`useRef`) for values that must not trigger re-renders (timers, WebSocket handles, latest-callback refs).
- All components exported as named exports, not default exports.

## Testing

See [TESTING.md](TESTING.md).

## Git

- Branch names: `feature/<short-description>`, `fix/<short-description>`.
- Commit messages: imperative mood, present tense ("Add retry counter reset" not "Added retry counter reset").
- One logical change per commit.
