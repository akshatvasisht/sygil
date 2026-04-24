"use client";

import { useEffect, useState } from "react";
import { SigilLogo } from "@/components/ui/SigilLogo";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
          <SigilLogo size={32} color="#e4e4e7" />
          <span className="font-mono text-sm uppercase tracking-wider text-dim">sygil / error</span>
        </div>
        <h1 className="text-lg font-sans">Something went wrong.</h1>
        <p className="text-body text-sm leading-relaxed">
          The page hit an unexpected error. You can try again, or copy the details below
          to include in a bug report.
        </p>
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
            aria-label="Retry rendering the page"
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
