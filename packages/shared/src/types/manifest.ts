import { z } from "zod";

export const SygilManifestSchema = z.object({
  sygilVersion: z.string().describe("Semver range this bundle targets; `^0.1` for current."),
  workflow: z.string().describe("Relative path to workflow.json inside the bundle."),
  adapters: z.array(z.string()).describe("Adapter types this bundle requires."),
  envVars: z.array(z.string()).optional().describe("Env vars the recipient should set."),
  assets: z.object({
    gates: z.array(z.string()).optional(),
    specs: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
  }).describe("Relative paths of assets included alongside workflow.json."),
  signed: z.boolean().optional().describe("Reserved — sigstore sidecar presence indicator."),
  createdAt: z.string().describe("ISO8601 timestamp of bundle creation."),
  createdBy: z.string().optional().describe("Optional human-readable creator attribution."),
});

export type SygilManifest = z.infer<typeof SygilManifestSchema>;
