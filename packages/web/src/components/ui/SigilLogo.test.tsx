import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SigilLogo } from "./SigilLogo";

describe("SigilLogo", () => {
  it("renders an SVG element", () => {
    const { container } = render(<SigilLogo />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("applies default size of 24", () => {
    const { container } = render(<SigilLogo />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("height")).toBe("24");
  });

  it("applies custom size", () => {
    const { container } = render(<SigilLogo size={48} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("48");
    expect(svg.getAttribute("height")).toBe("48");
  });

  it("applies default color #e0e0e0", () => {
    const { container } = render(<SigilLogo />);
    const rects = container.querySelectorAll("rect");
    expect(rects.length).toBe(4);
    rects.forEach((rect) => {
      expect(rect.getAttribute("fill")).toBe("#e0e0e0");
    });
  });

  it("applies custom color", () => {
    const { container } = render(<SigilLogo color="#888888" />);
    const rects = container.querySelectorAll("rect");
    rects.forEach((rect) => {
      expect(rect.getAttribute("fill")).toBe("#888888");
    });
  });

  it("renders 3 lines (edges) and 4 rects (nodes)", () => {
    const { container } = render(<SigilLogo />);
    expect(container.querySelectorAll("line")).toHaveLength(3);
    expect(container.querySelectorAll("rect")).toHaveLength(4);
  });

  it("is aria-hidden for accessibility", () => {
    const { container } = render(<SigilLogo />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("applies className prop", () => {
    const { container } = render(<SigilLogo className="my-class" />);
    const svg = container.querySelector("svg")!;
    expect(svg.classList.contains("my-class")).toBe(true);
  });

  it("applies -18 degree rotation transform", () => {
    const { container } = render(<SigilLogo />);
    const g = container.querySelector("g")!;
    expect(g.getAttribute("transform")).toBe("rotate(-18 256 256)");
  });
});
