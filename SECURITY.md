# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities via **GitHub Security Advisory**:

> https://github.com/akshatvasisht/sygil/security/advisories/new

Do not open a public issue for security bugs. Use the private advisory form above.

**Disclosure window:** We follow a 90-day coordinated disclosure policy.
After 90 days from first report (or earlier if a fix ships), the advisory
becomes public.

## Current audit status

As of 2026-04-24, `npm audit --omit=dev --audit-level=high` reports 2 high
and 1 moderate finding. All three are in packages that are never reachable
at runtime in the deployed artifact — see the acceptance rationale below.

There are **zero high-severity production runtime vulnerabilities** in the
Sygil CLI binary or the compiled web bundle.

## Accepted vulnerabilities (with rationale)

The following vulnerabilities are flagged by `npm audit` but are accepted
because they either affect only development/build-time tooling, or they are
in production-tree packages where the specific attack vector is not reachable
(library vs. CLI usage, build-time vs. runtime). None of the vulnerable code
paths are exercisable against the deployed Sygil CLI binary or web bundle.

### Group 1: Test tooling (vitest stack)

| Package | Severity | CVE / Advisory | Why acceptable |
|---|---|---|---|
| `vitest` | moderate | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) (via `vite`), [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) (via `vite`) | devDependency — used only during `npm test`. Dev server / path-traversal vectors require `vite dev` to be running, which never happens in CI or production. |
| `@vitest/coverage-v8` | moderate | Same via chain | devDependency — coverage reporting only. No runtime exposure. |
| `vite` (transitive) | moderate | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) | Transitive through vitest. Path-traversal in Vite's dev server only; dev server is never started in CI or production. |
| `vite-node` (transitive) | moderate | Same via chain | Transitive through vitest. Test-runtime only. |
| `esbuild` (transitive) | moderate | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | Dev-server CORS issue in esbuild's built-in HTTP server. That server is never started; Sygil uses esbuild only as a bundler via vitest/vite internals. |

Fix requires bumping `vitest` v1 → v4 (major). Scheduled for a dedicated test-infra upgrade PR; blocked on breaking changes in the vitest v2/v3/v4 migration path.

### Group 2: Linting tooling (ESLint / Next.js ESLint plugin)

| Package | Severity | CVE / Advisory | Why acceptable |
|---|---|---|---|
| `eslint-config-next` | high | [GHSA-5j98-mcp5-4vw2](https://github.com/advisories/GHSA-5j98-mcp5-4vw2) (via `glob`) | devDependency (`packages/web/package.json > devDependencies`). Linting only; no prod runtime exposure. |
| `@next/eslint-plugin-next` (transitive) | high | Same via chain | Transitive through `eslint-config-next`. Linting only. |

Fix requires bumping `eslint-config-next` v14 → v16 (major). Bundled with Next.js; pending the broader Next.js major upgrade.

### Group 3: `glob` library via production build toolchain

| Package | Severity | CVE / Advisory | Why acceptable |
|---|---|---|---|
| `glob@10.3.10` (transitive) | high | [GHSA-5j98-mcp5-4vw2](https://github.com/advisories/GHSA-5j98-mcp5-4vw2) | Appears in prod tree via `sigstore → @sigstore/sign → make-fetch-happen → cacache → glob`. The CVE is a **CLI command injection** via the `glob` binary's `-c/--cmd` flag when invoked as a shell tool. `cacache` uses `glob` as a library for file-pattern matching — it never invokes the `glob` CLI binary nor exposes `-c/--cmd` to external input. Not exploitable as a library dependency. |

Note: npm audit also flags `glob` via `@next/eslint-plugin-next` (ESLint, dev-only). The same package in the prod tree (`cacache`) has an identical version but a completely different (unexploitable) usage context. The advisory resolution ties the fix to `eslint-config-next@16.2.4`, not to the `cacache` path.

### Group 4: Next.js web build tool

| Package | Severity | CVE / Advisory | Why acceptable |
|---|---|---|---|
| `next` | high | [GHSA-9g9p-9gw9-jx7f](https://github.com/advisories/GHSA-9g9p-9gw9-jx7f), [GHSA-h25m-26qc-wcjf](https://github.com/advisories/GHSA-h25m-26qc-wcjf), [GHSA-ggv3-7p47-pfv8](https://github.com/advisories/GHSA-ggv3-7p47-pfv8), [GHSA-3x4c-7xq6-9pq8](https://github.com/advisories/GHSA-3x4c-7xq6-9pq8), [GHSA-q4gf-8mx6-v5v3](https://github.com/advisories/GHSA-q4gf-8mx6-v5v3) | Sygil's web package uses `output: "export"` in `next.config.mjs` — Next.js runs only at build time and produces a static HTML/CSS/JS bundle. All five CVEs affect the **Next.js runtime server** (Image Optimizer endpoint, React Server Components HTTP handler, rewrite middleware, next/image disk cache). None of these server components are instantiated in static-export mode. The compiled output is a bundle of static files with no server-side runtime. No data exfil vector from a production artifact. |
| `postcss` (transitive) | moderate | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | Transitive through `next`. The XSS is in PostCSS's CSS serializer output inside a `<style>` tag. Since Next.js is used as a static build tool here and PostCSS runs only at build time, there is no runtime exposure via a browser. |

Fix requires bumping `next` v14 → v16 (major). Planned upgrade; blocked on `pages/` → `app/` router migration audit and React 19 compatibility check. Not appropriate to rush pre-launch.

## Auditing policy

- **Monthly:** `npm audit --omit=dev --audit-level=high` is run in CI on every
  pull request (non-blocking, `continue-on-error: true`). Results are visible
  in the workflow run summary.
- **On dep bumps:** Any PR touching `package.json` or `package-lock.json`
  should check audit output before merging.
- **No `--force`:** We never use `npm audit fix --force` in the release flow.
  Major-version bumps that may introduce regressions are gated on dedicated
  upgrade PRs with full test suite confirmation.
- **Production only:** The standard for blocking a release is a high-severity
  vuln in the production runtime artifact (`npm audit --omit=dev --audit-level=high`).
  Dev-only vulns are documented here and tracked for planned upgrades.
