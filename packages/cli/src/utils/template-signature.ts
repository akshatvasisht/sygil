import { readFile } from "node:fs/promises";

/**
 * Sigstore cosign keyless signature verification for bundled workflow templates.
 *
 * Design:
 *   - Default off. `SYGIL_VERIFY_TEMPLATES` env var gates the behavior so that
 *     95% of users who never set it pay nothing (no dynamic import, no FS
 *     probe, no sigstore module pulled in).
 *   - When on, we look for a `<template>.sigstore.json` sidecar next to the
 *     workflow JSON. This bundle is emitted by `cosign sign-blob --bundle` in
 *     `.github/workflows/sign-templates.yml` and ships inside the npm tarball.
 *   - Missing sidecar is treated as "no-signature" (fail-open). That is what
 *     makes this safe to turn on for arbitrary user-authored workflows — only
 *     bundled Sygil templates carry sidecars, so user workflows silently skip.
 *   - Present sidecar triggers verification against a pinned certificate
 *     identity + OIDC issuer. Any mismatch / revocation / transparency-log
 *     failure → hard fail (the caller exits the process).
 *
 * The `sigstore` npm package is an OPTIONAL dependency. If it isn't installed
 * and the user opts in via SYGIL_VERIFY_TEMPLATES=1, we hard-fail with a
 * pointer to `npm install sigstore` — silently skipping would defeat the
 * entire point of the opt-in.
 *
 * Replay-determinism: verification is a pure function of the template bytes
 * and the sidecar bytes, runs BEFORE the scheduler boots, and is not recorded
 * in NDJSON. Enabling verification cannot change execution semantics.
 */

/**
 * Certificate identity that a valid Sygil template signature must match.
 * This is the OIDC subject that GitHub Actions emits when either of the two
 * trusted signing workflows runs:
 *
 *   - `.github/workflows/release.yml` — the release pipeline (push to main),
 *     which signs templates inline before `changesets/action@v1` publishes to
 *     npm. This is the source of every signature on a released tarball.
 *   - `.github/workflows/sign-templates.yml` — standalone signer, invokable
 *     via `workflow_dispatch` for operational validation. Not part of the
 *     release flow today but retained for manual re-signing.
 *
 * Both workflows live in the Sygil repo, both require `id-token: write`, and
 * neither is reachable from a fork-PR context. Signatures produced by any
 * other workflow (including a forked `release.yml`) will mismatch on either
 * the repo path or the workflow-name segment.
 *
 * The `refs/` anchor accepts any ref (tag or branch) — release.yml runs on
 * `refs/heads/main`; sign-templates.yml on dispatch reports the dispatched
 * ref; version-tag signing would produce `refs/tags/…`.
 */
export const EXPECTED_IDENTITY_REGEXP: RegExp = new RegExp(
  "^https://github\\.com/akshatvasisht/sigil/\\.github/workflows/(release|sign-templates)\\.yml@refs/",
);

/** OIDC issuer for GitHub Actions keyless signing. */
export const EXPECTED_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export type VerifyOutcome =
  | { status: "verified"; identity: string }
  | { status: "no-signature" }
  | { status: "verifier-unavailable"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "disabled" };

/** True when SYGIL_VERIFY_TEMPLATES=1 is set in the environment. */
export function isVerificationEnabled(): boolean {
  return process.env["SYGIL_VERIFY_TEMPLATES"] === "1";
}

/** Derive the sidecar path for a workflow file: `<path>.sigstore.json`. */
export function sidecarPathFor(templatePath: string): string {
  return `${templatePath}.sigstore.json`;
}

/**
 * Minimal shape of the upstream sigstore-js `Signer` return value. We only
 * consume the Subject Alternative Name for post-verify regex pinning; the
 * issuer is already enforced inside `sigstore.verify` via `certificateIssuer`,
 * so we don't re-check the returned `identity.extensions.issuer`.
 */
interface SigstoreSigner {
  identity?: {
    subjectAlternativeName?: string;
  };
}

/**
 * Subset of the upstream sigstore-js `VerifyOptions` type we actually use.
 * Upstream supports `certificateIssuer`, `certificateIdentityURI`, and
 * `certificateIdentityEmail` as exact-string matches. There is no regex-based
 * option, so we pin the issuer here and regex-match the SAN ourselves on the
 * returned `Signer`.
 */
interface SigstoreModule {
  verify: (
    bundle: unknown,
    data: Buffer,
    options?: { certificateIssuer?: string },
  ) => Promise<SigstoreSigner>;
}

export type SigstoreLoader = () => Promise<SigstoreModule | null>;

async function defaultLoadSigstore(): Promise<SigstoreModule | null> {
  try {
    // @ts-ignore -- optional peer dep, resolved at runtime
    const mod = (await import("sigstore")) as unknown as SigstoreModule;
    if (typeof mod?.verify !== "function") return null;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Verify the Sigstore sidecar for a workflow file, if verification is
 * enabled and a sidecar exists.
 *
 * Caller is responsible for acting on the outcome (typically: print a warning
 * and continue for `no-signature`, exit the process for `failed` and
 * `verifier-unavailable`).
 */
export async function verifyTemplateSignature(
  templatePath: string,
  loader: SigstoreLoader = defaultLoadSigstore,
): Promise<VerifyOutcome> {
  if (!isVerificationEnabled()) {
    return { status: "disabled" };
  }

  const sidecar = sidecarPathFor(templatePath);
  let bundleRaw: string;
  try {
    bundleRaw = await readFile(sidecar, "utf8");
  } catch {
    // No sidecar → fail-open. User-authored workflows don't have one; unsigned
    // bundled templates also take this path during the rollout window.
    return { status: "no-signature" };
  }

  let bundle: unknown;
  try {
    bundle = JSON.parse(bundleRaw);
  } catch (err) {
    return {
      status: "failed",
      reason: `sidecar at "${sidecar}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const sigstore = await loader();
  if (!sigstore) {
    return {
      status: "verifier-unavailable",
      reason:
        "SYGIL_VERIFY_TEMPLATES=1 is set but the 'sigstore' module is not installed. " +
        "Install it with `npm install sigstore` to enable keyless signature verification.",
    };
  }

  let data: Buffer;
  try {
    data = await readFile(templatePath);
  } catch (err) {
    return {
      status: "failed",
      reason: `cannot read template "${templatePath}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Upstream `sigstore.verify` only supports exact-string identity matching
  // (`certificateIdentityURI` / `certificateIdentityEmail`). We want regex
  // pinning so any tag or branch ref on the pinned workflow path is accepted,
  // so we pin the issuer here and inspect the returned `Signer.identity.subjectAlternativeName`
  // ourselves. Passing the (unsupported-upstream) cosign flag names here was a
  // no-op — the keys were silently ignored and every valid GH-Actions signature
  // verified, which is why the post-verify SAN check matters.
  let signer: SigstoreSigner;
  try {
    signer = await sigstore.verify(bundle, data, {
      certificateIssuer: EXPECTED_OIDC_ISSUER,
    });
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const san = signer.identity?.subjectAlternativeName;
  if (!san) {
    return {
      status: "failed",
      reason: "signature verified but certificate has no subjectAlternativeName — cannot pin identity",
    };
  }
  if (!EXPECTED_IDENTITY_REGEXP.test(san)) {
    return {
      status: "failed",
      reason: `certificate identity "${san}" does not match pinned workflow ${EXPECTED_IDENTITY_REGEXP.source}`,
    };
  }

  return { status: "verified", identity: san };
}
