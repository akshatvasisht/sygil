"use client";

import { ErrorBoundaryUI } from "@/components/ui/ErrorBoundaryUI";

export default function EditorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorBoundaryUI
      breadcrumb="sygil / editor / error"
      title="The editor hit an error."
      description="Your unsaved changes may be lost. Try again, or copy the details below to include in a bug report."
      retryLabel="Reload the editor"
      error={error}
      reset={reset}
    />
  );
}
