import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { startSygilRun } from "./helpers/sigil-runner";

// Fixture paths — relative to this spec file
const FIXTURES = resolve(__dirname, "../../cli/test-fixtures/workflows");

test.describe("Live monitor — real sygil subprocess", () => {
  // Give each test extra time: subprocess startup + browser connection + assertions
  test.setTimeout(30_000);

  test("displays workflow name and node status", async ({ page }) => {
    const workflowPath = resolve(FIXTURES, "single-node.json");
    // ECHO_DURATION_MS=3000 keeps the echo adapter alive long enough for the
    // browser to connect and observe at least the node_start event.
    const run = await startSygilRun(workflowPath, {
      env: { ECHO_DURATION_MS: "3000", ECHO_DELAY_MS: "200" },
    });

    try {
      const wsUrl = `ws://localhost:${run.wsPort}/?token=${run.authToken}`;
      await page.goto(
        `http://localhost:3000/monitor?ws=${encodeURIComponent(wsUrl)}&workflow=e2e-single-node`
      );

      // Workflow name appears in the sub-toolbar
      await expect(page.getByText("e2e-single-node")).toBeVisible({
        timeout: 10_000,
      });

      // The "greeter" node should appear in the timeline once execution starts
      await expect(page.getByText("greeter")).toBeVisible({ timeout: 10_000 });

      // Wait for the workflow to finish and show a completed state.
      // The sub-toolbar switches to showing completed node count e.g. "1/1 nodes".
      await expect(page.getByText(/1\/1 nodes/i)).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      run.kill();
    }
  });

  test("shows multiple nodes in diamond workflow", async ({ page }) => {
    const workflowPath = resolve(FIXTURES, "parallel-diamond.json");
    const run = await startSygilRun(workflowPath, {
      env: { ECHO_DURATION_MS: "2000", ECHO_DELAY_MS: "200" },
    });

    try {
      const wsUrl = `ws://localhost:${run.wsPort}/?token=${run.authToken}`;
      await page.goto(
        `http://localhost:3000/monitor?ws=${encodeURIComponent(wsUrl)}&workflow=e2e-diamond`
      );

      // All four node IDs must appear in the node timeline
      await expect(page.getByText("start")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("left")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("right")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("merge")).toBeVisible({ timeout: 10_000 });
    } finally {
      run.kill();
    }
  });

  test("event stream shows events as they arrive", async ({ page }) => {
    const workflowPath = resolve(FIXTURES, "linear-gate.json");
    const run = await startSygilRun(workflowPath, {
      env: { ECHO_DURATION_MS: "2000", ECHO_DELAY_MS: "200" },
    });

    try {
      const wsUrl = `ws://localhost:${run.wsPort}/?token=${run.authToken}`;
      await page.goto(
        `http://localhost:3000/monitor?ws=${encodeURIComponent(wsUrl)}&workflow=e2e-linear-gate`
      );

      // Wait for the workflow to start producing events
      await expect(page.getByText("writer")).toBeVisible({ timeout: 10_000 });

      // Open the event log drawer
      await page.getByText(/event log/i).click();

      // The event stream panel should now be visible
      const eventStream = page
        .locator("[data-testid='event-stream'], .event-stream")
        .or(page.getByText(/event stream/i))
        .first();
      await expect(eventStream).toBeVisible({ timeout: 5_000 });

      // At minimum the event count badge in the drawer toggle must be non-zero.
      // The toggle renders: "Event log (<count>)" — match any positive digit.
      await expect(
        page.getByText(/event log \([1-9]\d*\)/i)
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      run.kill();
    }
  });

  test("shows workflow completed state", async ({ page }) => {
    const workflowPath = resolve(FIXTURES, "single-node.json");
    // Shorter echo so the workflow finishes promptly and we verify the terminal state
    const run = await startSygilRun(workflowPath, {
      env: { ECHO_DURATION_MS: "1000", ECHO_DELAY_MS: "100" },
    });

    try {
      const wsUrl = `ws://localhost:${run.wsPort}/?token=${run.authToken}`;
      await page.goto(
        `http://localhost:3000/monitor?ws=${encodeURIComponent(wsUrl)}&workflow=e2e-single-node`
      );

      // Wait for the greeter node to appear so we know events are flowing
      await expect(page.getByText("greeter")).toBeVisible({ timeout: 10_000 });

      // After workflow_end the node counter shows "1/1 nodes"
      await expect(page.getByText(/1\/1 nodes/i)).toBeVisible({
        timeout: 15_000,
      });

      // The timeline entry for greeter should reach a completed visual state.
      // The NodeTimeline renders a green check icon or a "completed" class when done.
      // We test for the node still being present (it persists after completion).
      await expect(page.getByText("greeter")).toBeVisible({ timeout: 5_000 });
    } finally {
      run.kill();
    }
  });

  test("human review approval flow", async ({ page }) => {
    const workflowPath = resolve(FIXTURES, "human-review.json");
    // impl completes quickly; gate blocks until browser approves
    const run = await startSygilRun(workflowPath, {
      env: { ECHO_DURATION_MS: "500", ECHO_DELAY_MS: "50" },
    });

    try {
      // Include the auth token so control events (approve/reject) are accepted
      const wsUrl = `ws://localhost:${run.wsPort}/?token=${run.authToken}`;
      await page.goto(
        `http://localhost:3000/monitor?ws=${encodeURIComponent(wsUrl)}&workflow=e2e-human-review`
      );

      // impl node should appear as the first node executes
      await expect(page.getByText("impl")).toBeVisible({ timeout: 10_000 });

      // The human review modal should appear once the gate blocks
      await expect(
        page.getByRole("dialog", { name: /human review required/i })
      ).toBeVisible({ timeout: 15_000 });

      // The gate prompt text should be shown inside the dialog
      await expect(
        page.getByText(/does the implementation look correct/i)
      ).toBeVisible({ timeout: 5_000 });

      // Click Approve — this sends human_review_approve via the WebSocket
      await page.getByRole("button", { name: /approve/i }).click();

      // After approval the "done" node should execute and appear in the timeline
      await expect(page.getByText("done")).toBeVisible({ timeout: 15_000 });

      // Workflow completes: 2/2 nodes
      await expect(page.getByText(/2\/2 nodes/i)).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      run.kill();
    }
  });
});
