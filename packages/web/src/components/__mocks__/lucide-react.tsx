/**
 * Test-side factory for stubbing lucide-react icons.
 *
 * Each monitor test file has a near-identical `vi.mock("lucide-react", ...)`
 * block that wraps every used icon in a `<span data-testid="icon-<id>" />`.
 * This helper encapsulates the wrapping and leaves each test file listing
 * only the icons it uses.
 *
 * Usage:
 *   import { buildLucideIconMocks } from "../__mocks__/lucide-react";
 *   vi.mock("lucide-react", () => buildLucideIconMocks([
 *     ["CheckCircle2", "check-circle"],
 *     ["XCircle", "x-circle"],
 *   ]));
 */

type IconEntry = [componentName: string, testId: string];

export function buildLucideIconMocks(entries: IconEntry[]): Record<string, unknown> {
  const icon = (id: string) => {
    const Comp = (_props: Record<string, unknown>) => (
      <span data-testid={`icon-${id}`} />
    );
    Comp.displayName = id;
    return Comp;
  };
  const mocked: Record<string, unknown> = {};
  for (const [component, testId] of entries) {
    mocked[component] = icon(testId);
  }
  return mocked;
}
