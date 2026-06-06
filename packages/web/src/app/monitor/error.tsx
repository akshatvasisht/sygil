"use client";

import { ErrorBoundaryUI } from "@/components/ui/ErrorBoundaryUI";

export default function MonitorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorBoundaryUI
      breadcrumb="sygil / monitor / error"
      title="The monitor hit an error."
      description="The workflow connection may have been interrupted. Retrying will reconnect the WebSocket; your run on the CLI side is unaffected."
      retryLabel="Reconnect the monitor"
      error={error}
      reset={reset}
    />
  );
}
