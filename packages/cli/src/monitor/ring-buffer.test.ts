import { describe, it, expect } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("push and drain returns items in order", () => {
    const buf = new RingBuffer<string>(8);
    buf.push("a");
    buf.push("b");
    buf.push("c");

    expect(buf.drain()).toEqual(["a", "b", "c"]);
  });

  it("push beyond capacity drops oldest items", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // drops 1
    buf.push(5); // drops 2

    expect(buf.drain()).toEqual([3, 4, 5]);
  });

  it("dropped count is accurate", () => {
    const buf = new RingBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    expect(buf.dropped).toBe(0);

    buf.push(3); // drops 1
    buf.push(4); // drops 2
    buf.push(5); // drops 3

    expect(buf.dropped).toBe(3);
  });

  it("drain clears the buffer", () => {
    const buf = new RingBuffer<string>(4);
    buf.push("x");
    buf.push("y");

    expect(buf.drain()).toEqual(["x", "y"]);
    expect(buf.length).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  it("empty drain returns empty array", () => {
    const buf = new RingBuffer<string>(4);
    expect(buf.drain()).toEqual([]);
    expect(buf.length).toBe(0);
  });

  it("length reflects current item count", () => {
    const buf = new RingBuffer<number>(4);
    expect(buf.length).toBe(0);

    buf.push(1);
    buf.push(2);
    expect(buf.length).toBe(2);

    buf.push(3);
    buf.push(4);
    buf.push(5); // overflow, drops 1
    expect(buf.length).toBe(4);
  });

  it("clear resets buffer and length but preserves dropped count", () => {
    const buf = new RingBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    buf.push(3); // drops 1

    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.drain()).toEqual([]);
    expect(buf.dropped).toBe(1);
  });

  it("works correctly after drain and re-fill", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.drain();

    buf.push(10);
    buf.push(20);
    expect(buf.drain()).toEqual([10, 20]);
  });

  it("throws RangeError when capacity is 0", () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError);
  });

  it("throws RangeError when capacity is negative", () => {
    expect(() => new RingBuffer<number>(-1)).toThrow(RangeError);
  });

  it("works with capacity of 1", () => {
    const buf = new RingBuffer<string>(1);
    buf.push("a");
    expect(buf.length).toBe(1);
    expect(buf.drain()).toEqual(["a"]);

    buf.push("b");
    buf.push("c"); // drops "b"
    expect(buf.dropped).toBe(1);
    expect(buf.drain()).toEqual(["c"]);
  });

  it("maintains correct order after multiple drain/refill cycles with overflow", () => {
    const buf = new RingBuffer<number>(3);

    // Cycle 1: fill and drain
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.drain()).toEqual([1, 2, 3]);

    // Cycle 2: partial fill, overflow, drain
    buf.push(10);
    buf.push(20);
    buf.push(30);
    buf.push(40); // drops 10
    expect(buf.drain()).toEqual([20, 30, 40]);

    // Cycle 3: partial fill
    buf.push(100);
    expect(buf.drain()).toEqual([100]);
  });

  it("clear after overflow allows correct subsequent usage", () => {
    const buf = new RingBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    buf.push(3); // drops 1
    buf.clear();

    buf.push(10);
    buf.push(20);
    expect(buf.drain()).toEqual([10, 20]);
    expect(buf.dropped).toBe(1); // preserved from before clear
  });
});
