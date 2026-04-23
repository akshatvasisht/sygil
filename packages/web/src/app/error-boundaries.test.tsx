import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RootError from "./error";
import EditorError from "./editor/error";
import MonitorError from "./monitor/error";
import RootLoading from "./loading";
import EditorLoading from "./editor/loading";
import MonitorLoading from "./monitor/loading";

describe("Next.js error/loading boundaries", () => {
  const makeError = () => Object.assign(new Error("kaboom"), { digest: "abc123" });

  it.each([
    ["root", RootError],
    ["editor", EditorError],
    ["monitor", MonitorError],
  ])("%s error boundary renders message + reset button + copy button", (_label, Boundary) => {
    const reset = vi.fn();
    render(<Boundary error={makeError()} reset={reset} />);
    expect(screen.getByText("kaboom")).toBeInTheDocument();
    const tryAgain = screen.getByRole("button", { name: /reload|reconnect|retry/i });
    fireEvent.click(tryAgain);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /copy error/i })).toBeInTheDocument();
  });

  it("copy button writes the error payload to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<RootError error={makeError()} reset={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /copy error/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const payload = writeText.mock.calls[0]?.[0] as string;
    expect(payload).toContain("message: kaboom");
    expect(payload).toContain("digest: abc123");
  });

  it.each([
    ["root", RootLoading, /loading…/i],
    ["editor", EditorLoading, /loading canvas/i],
    ["monitor", MonitorLoading, /^sygil$/i],
  ])("%s loading boundary marks aria-busy and shows text", (_label, Loading, textPattern) => {
    const { container } = render(<Loading />);
    const main = container.querySelector("main");
    expect(main?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText(textPattern)).toBeInTheDocument();
  });
});
