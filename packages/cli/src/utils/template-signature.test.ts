import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_IDENTITY_REGEXP,
  EXPECTED_OIDC_ISSUER,
  isVerificationEnabled,
  sidecarPathFor,
  verifyTemplateSignature,
} from "./template-signature.js";

describe("isVerificationEnabled", () => {
  const original = process.env["SYGIL_VERIFY_TEMPLATES"];

  afterEach(() => {
    if (original === undefined) delete process.env["SYGIL_VERIFY_TEMPLATES"];
    else process.env["SYGIL_VERIFY_TEMPLATES"] = original;
  });

  it("returns false when the env var is unset", () => {
    delete process.env["SYGIL_VERIFY_TEMPLATES"];
    expect(isVerificationEnabled()).toBe(false);
  });

  it("returns false for any value other than '1'", () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "true";
    expect(isVerificationEnabled()).toBe(false);
    process.env["SYGIL_VERIFY_TEMPLATES"] = "yes";
    expect(isVerificationEnabled()).toBe(false);
    process.env["SYGIL_VERIFY_TEMPLATES"] = "0";
    expect(isVerificationEnabled()).toBe(false);
  });

  it("returns true only for '1'", () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    expect(isVerificationEnabled()).toBe(true);
  });
});

describe("sidecarPathFor", () => {
  it("appends .sigstore.json to the workflow file path", () => {
    expect(sidecarPathFor("/tmp/foo.json")).toBe("/tmp/foo.json.sigstore.json");
    expect(sidecarPathFor("./ralph.json")).toBe("./ralph.json.sigstore.json");
  });
});

describe("pinned identity constants", () => {
  it("pins the identity to the two trusted Sygil signing workflows", () => {
    // sign-templates.yml — manual operational signing path.
    expect(EXPECTED_IDENTITY_REGEXP.test(
      "https://github.com/akshatvasisht/sigil/.github/workflows/sign-templates.yml@refs/tags/v0.2.0",
    )).toBe(true);
    expect(EXPECTED_IDENTITY_REGEXP.test(
      "https://github.com/akshatvasisht/sigil/.github/workflows/sign-templates.yml@refs/heads/main",
    )).toBe(true);
    // release.yml — the inline signing path that actually produces the
    // signatures shipped on npm.
    expect(EXPECTED_IDENTITY_REGEXP.test(
      "https://github.com/akshatvasisht/sigil/.github/workflows/release.yml@refs/heads/main",
    )).toBe(true);
    expect(EXPECTED_IDENTITY_REGEXP.test(
      "https://github.com/akshatvasisht/sigil/.github/workflows/release.yml@refs/tags/v0.2.0",
    )).toBe(true);
  });

  it("rejects identities from unrelated workflows or repos", () => {
    expect(EXPECTED_IDENTITY_REGEXP.test(
      "https://github.com/evil/sigil-fork/.github/workflows/sign-templates.yml@refs/tags/v0.2.0",
    )).toBe(false);
    expect(EXPECTED_IDENTITY_REGEXP.test(
      "https://github.com/evil/sigil-fork/.github/workflows/release.yml@refs/heads/main",
    )).toBe(false);
    // Any other workflow file in the Sygil repo is still rejected.
    expect(EXPECTED_IDENTITY_REGEXP.test(
      "https://github.com/akshatvasisht/sigil/.github/workflows/ci.yml@refs/heads/main",
    )).toBe(false);
    expect(EXPECTED_IDENTITY_REGEXP.test(
      "https://github.com/akshatvasisht/sigil/.github/workflows/e2e.yml@refs/heads/main",
    )).toBe(false);
  });

  it("pins the OIDC issuer to GitHub Actions", () => {
    expect(EXPECTED_OIDC_ISSUER).toBe("https://token.actions.githubusercontent.com");
  });
});

describe("verifyTemplateSignature", () => {
  const original = process.env["SYGIL_VERIFY_TEMPLATES"];
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sygil-sig-test-"));
  });

  afterEach(async () => {
    if (original === undefined) delete process.env["SYGIL_VERIFY_TEMPLATES"];
    else process.env["SYGIL_VERIFY_TEMPLATES"] = original;
    await rm(tmpDir, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns 'disabled' when the env var is not set", async () => {
    delete process.env["SYGIL_VERIFY_TEMPLATES"];
    const tplPath = join(tmpDir, "tpl.json");
    await writeFile(tplPath, "{}", "utf8");
    const outcome = await verifyTemplateSignature(tplPath);
    expect(outcome.status).toBe("disabled");
  });

  it("returns 'no-signature' when the env var is set but no sidecar exists (fail-open for user workflows)", async () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    const tplPath = join(tmpDir, "user-workflow.json");
    await writeFile(tplPath, '{"version":"1","name":"x","nodes":{},"edges":[]}', "utf8");
    const outcome = await verifyTemplateSignature(tplPath);
    expect(outcome.status).toBe("no-signature");
  });

  it("returns 'failed' when the sidecar is not valid JSON", async () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    const tplPath = join(tmpDir, "tpl.json");
    await writeFile(tplPath, "{}", "utf8");
    await writeFile(`${tplPath}.sigstore.json`, "this is not json", "utf8");
    const outcome = await verifyTemplateSignature(tplPath);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("not valid JSON");
    }
  });

  it("returns 'verified' when the loader yields a signer whose SAN matches the pinned identity", async () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    const tplPath = join(tmpDir, "tpl.json");
    await writeFile(tplPath, "{}", "utf8");
    await writeFile(`${tplPath}.sigstore.json`, "{}", "utf8");

    const verify = vi.fn().mockResolvedValue({
      identity: {
        subjectAlternativeName:
          "https://github.com/akshatvasisht/sigil/.github/workflows/sign-templates.yml@refs/tags/v0.3.0",
        extensions: { issuer: EXPECTED_OIDC_ISSUER },
      },
    });
    const loader = async () => ({ verify });

    const outcome = await verifyTemplateSignature(tplPath, loader);

    expect(outcome.status).toBe("verified");
    expect(verify).toHaveBeenCalledOnce();
    const callArgs = verify.mock.calls[0]!;
    expect(callArgs[2]).toEqual({ certificateIssuer: EXPECTED_OIDC_ISSUER });
  });

  it("returns 'failed' when the signer SAN does not match the pinned workflow identity", async () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    const tplPath = join(tmpDir, "tpl.json");
    await writeFile(tplPath, "{}", "utf8");
    await writeFile(`${tplPath}.sigstore.json`, "{}", "utf8");

    const loader = async () => ({
      verify: vi.fn().mockResolvedValue({
        identity: {
          subjectAlternativeName:
            "https://github.com/evil/sigil-fork/.github/workflows/sign-templates.yml@refs/tags/v1.0.0",
        },
      }),
    });

    const outcome = await verifyTemplateSignature(tplPath, loader);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("does not match pinned workflow");
    }
  });

  it("returns 'failed' when the signer has no subjectAlternativeName", async () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    const tplPath = join(tmpDir, "tpl.json");
    await writeFile(tplPath, "{}", "utf8");
    await writeFile(`${tplPath}.sigstore.json`, "{}", "utf8");

    const loader = async () => ({
      verify: vi.fn().mockResolvedValue({ identity: {} }),
    });

    const outcome = await verifyTemplateSignature(tplPath, loader);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("subjectAlternativeName");
    }
  });

  it("returns 'failed' when upstream verify throws (invalid bundle, mismatched issuer, etc.)", async () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    const tplPath = join(tmpDir, "tpl.json");
    await writeFile(tplPath, "{}", "utf8");
    await writeFile(`${tplPath}.sigstore.json`, "{}", "utf8");

    const loader = async () => ({
      verify: vi.fn().mockRejectedValue(new Error("bundle signature invalid")),
    });

    const outcome = await verifyTemplateSignature(tplPath, loader);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("bundle signature invalid");
    }
  });

  it("returns 'verifier-unavailable' when the loader returns null", async () => {
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    const tplPath = join(tmpDir, "tpl.json");
    await writeFile(tplPath, "{}", "utf8");
    await writeFile(`${tplPath}.sigstore.json`, "{}", "utf8");

    const outcome = await verifyTemplateSignature(tplPath, async () => null);

    expect(outcome.status).toBe("verifier-unavailable");
    if (outcome.status === "verifier-unavailable") {
      expect(outcome.reason).toContain("npm install sigstore");
    }
  });

  it("returns 'verifier-unavailable' when sigstore cannot be loaded", async () => {
    // We cannot mock an optional dep that isn't installed, but we CAN test the
    // integration path here: if 'sigstore' truly isn't installed in this env,
    // the dynamic import fails and we expect the unavailable path. If it IS
    // installed, we skip this assertion (the next describe block covers the
    // verified/failed paths through a mock).
    process.env["SYGIL_VERIFY_TEMPLATES"] = "1";
    const tplPath = join(tmpDir, "tpl.json");
    await writeFile(tplPath, "{}", "utf8");
    await writeFile(
      `${tplPath}.sigstore.json`,
      JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2" }),
      "utf8",
    );

    let sigstoreInstalled = false;
    try {
      // @ts-ignore -- intentional probe
      await import("sigstore");
      sigstoreInstalled = true;
    } catch {
      sigstoreInstalled = false;
    }

    const outcome = await verifyTemplateSignature(tplPath);
    if (sigstoreInstalled) {
      // Real sigstore rejects our fake bundle → 'failed' is also acceptable.
      expect(["failed", "verifier-unavailable"]).toContain(outcome.status);
    } else {
      expect(outcome.status).toBe("verifier-unavailable");
      if (outcome.status === "verifier-unavailable") {
        expect(outcome.reason).toContain("sigstore");
        expect(outcome.reason).toContain("npm install sigstore");
      }
    }
  });
});
