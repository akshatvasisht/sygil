"use client";

import { useEffect, useState } from "react";
import { SygilLogo } from "@/components/ui/SygilLogo";

interface ErrorBoundaryUIProps {
  /** Breadcrumb shown next to the logo, e.g. "sygil / monitor / error". */
  breadcrumb: string;
  /** Heading describing what went wrong. */
  title: string;
  /** Supporting copy explaining recovery / next steps. */
  description: string;
  /** Accessible label for the retry button. */
  retryLabel: string;
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Shared visual shell for Next.js route-level `error.tsx` boundaries.
 * Owns the logo/breadcrumb header, error detail block, and the
 * "Try again" / "Copy error" actions. Per-route boundaries supply only
 * the breadcrumb, title, description, and retry aria-label.
 */
export function ErrorBoundaryUI({
  breadcrumb,
  title,
  description,
  retryLabel,
  error,
  reset,
}: ErrorBoundaryUIProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    console.error(error);
  }, [error]);

  const copyError = async () => {
    const payload = [
      `message: ${error.message}`,
      error.digest ? `digest: ${error.digest}` : "",
      error.stack ? `stack:\n${error.stack}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-canvas text-bright px-6">
      <div className="max-w-md w-full card-glow-accent rounded-lg bg-panel border border-border p-8 flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <SygilLogo size={32} color="#e4e4e7" />
          <span className="font-mono text-sm uppercase tracking-wider text-dim">{breadcrumb}</span>
        </div>
        <h1 className="text-lg font-sans">{title}</h1>
        <p className="text-body text-sm leading-relaxed">{description}</p>
        <pre className="font-mono text-xs text-dim bg-surface border border-border rounded p-3 overflow-x-auto">
          {process.env.NODE_ENV === "production"
            ? (error.digest ?? "An unexpected error occurred.")
            : error.message}
        </pre>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={reset}
            className="min-h-[44px] px-4 rounded bg-accent text-canvas font-mono uppercase text-xs tracking-wider hover:bg-accent-hover transition-colors"
            aria-label={retryLabel}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={copyError}
            className="min-h-[44px] px-4 rounded bg-surface border border-border text-bright font-mono uppercase text-xs tracking-wider hover:border-border-bright transition-colors"
            aria-label="Copy error details to clipboard"
            aria-live="polite"
          >
            {copied ? "Copied" : "Copy error"}
          </button>
        </div>
      </div>
    </main>
  );
}
