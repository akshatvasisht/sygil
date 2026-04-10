/**
 * AbortTree tests — structured concurrency via AbortController.
 *
 * Tests the tree of AbortControllers where a root signal cascades to all
 * children, and individual children can be aborted independently.
 */

import { describe, it, expect } from "vitest";
import { AbortTree } from "./abort-tree.js";

describe("AbortTree", () => {
  // -------------------------------------------------------------------------
  // Root abort cascades to all children
  // -------------------------------------------------------------------------

  it("root abort signals all children", () => {
    const tree = new AbortTree();
    const childA = tree.createChild("nodeA");
    const childB = tree.createChild("nodeB");

    expect(childA.aborted).toBe(false);
    expect(childB.aborted).toBe(false);

    tree.abortAll();

    expect(tree.signal.aborted).toBe(true);
    expect(childA.aborted).toBe(true);
    expect(childB.aborted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Child abort is isolated — does not affect siblings or root
  // -------------------------------------------------------------------------

  it("child abort only affects that child, not siblings or root", () => {
    const tree = new AbortTree();
    const childA = tree.createChild("nodeA");
    const childB = tree.createChild("nodeB");

    tree.abortChild("nodeA");

    expect(childA.aborted).toBe(true);
    expect(childB.aborted).toBe(false);
    expect(tree.signal.aborted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Creating a child after root is aborted returns pre-aborted signal
  // -------------------------------------------------------------------------

  it("creating a child after root is aborted returns pre-aborted signal", () => {
    const tree = new AbortTree();
    tree.abortAll();

    const childSignal = tree.createChild("lateNode");
    expect(childSignal.aborted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // dispose() cleans up listeners and state
  // -------------------------------------------------------------------------

  it("dispose() cleans up children map", () => {
    const tree = new AbortTree();
    tree.createChild("nodeA");
    tree.createChild("nodeB");

    tree.dispose();

    // After dispose, aborting a child should be a no-op (no error thrown)
    // and creating new children should still work (fresh state)
    expect(() => tree.abortChild("nodeA")).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Aborting a non-existent child is a no-op
  // -------------------------------------------------------------------------

  it("aborting a non-existent child is a no-op", () => {
    const tree = new AbortTree();
    expect(() => tree.abortChild("doesNotExist")).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Creating duplicate children replaces the previous one
  // -------------------------------------------------------------------------

  it("creating a child with the same nodeId replaces the previous one", () => {
    const tree = new AbortTree();
    const first = tree.createChild("nodeA");
    const second = tree.createChild("nodeA");

    // The two signals should be different references
    expect(first).not.toBe(second);

    // Aborting the child should abort the new signal
    tree.abortChild("nodeA");
    expect(second.aborted).toBe(true);
    // The first signal was linked to root — not independently managed anymore
    // (it may or may not be aborted depending on implementation, but the tree
    //  should track the latest one)
  });

  // -------------------------------------------------------------------------
  // abort reason is propagated
  // -------------------------------------------------------------------------

  it("abort reason is propagated via abortAll", () => {
    const tree = new AbortTree();
    const child = tree.createChild("nodeA");

    tree.abortAll("workflow cancelled");

    expect(tree.signal.reason).toBe("workflow cancelled");
    expect(child.aborted).toBe(true);
  });
});
