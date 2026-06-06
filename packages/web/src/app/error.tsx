"use client";

import { ErrorBoundaryUI } from "@/components/ui/ErrorBoundaryUI";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorBoundaryUI
      breadcrumb="sygil / error"
      title="Something went wrong."
      description="The page hit an unexpected error. You can try again, or copy the details below to include in a bug report."
      retryLabel="Retry rendering the page"
      error={error}
      reset={reset}
    />
  );
}
