import { test, expect } from "@playwright/test";

test.describe("Execution Monitor", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/monitor");
    // Wait for the page to load
    await page.waitForLoadState("networkidle");
  });

  test("shows demo mode banner when no ws param is provided", async ({ page }) => {
    // The connection banner shows "Demo mode" text when no ?ws= param is present
    await expect(page.getByText(/demo mode/i)).toBeVisible({ timeout: 5_000 });
  });

  test("renders the React Flow canvas in monitor mode", async ({ page }) => {
    // The unified surface renders WorkflowEditor in monitor mode once the mock
    // workflow graph is available — wait for React Flow to initialise
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 10_000 });
    // Monitor mode pre-populates nodes from MOCK_WORKFLOW_GRAPH (planner /
    // implementer / reviewer), so there must be at least one node card
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("renders the NodeTimeline left pane", async ({ page }) => {
    // The NodeTimeline header renders the static label "Node timeline".
    // The pane itself has no data-testid so we locate it via the header text.
    const timelineHeader = page
      .locator(
        "[data-testid='node-timeline'], .node-timeline, [class*='node-timeline']"
      )
      .or(page.getByText(/node timeline/i))
      .first();

    await expect(timelineHeader).toBeVisible({ timeout: 5_000 });

    // The mock data has three nodes: planner, implementer, reviewer.
    // At least one of them should appear in the timeline pane.
    await expect(
      page
        .getByText("planner")
        .or(page.getByText("implementer"))
        .or(page.getByText("reviewer"))
        .first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("shows the event log drawer toggle", async ({ page }) => {
    // The collapsible drawer tab button contains the text "Event log"
    // (rendered as `Event log (<count>)` inside the button)
    await expect(page.getByText(/event log/i)).toBeVisible({ timeout: 5_000 });
  });

  test("event log drawer opens when clicked", async ({ page }) => {
    // Click the "Event log" toggle button to open the drawer
    await page.getByText(/event log/i).click();

    // After opening, the EventStream component renders a header labelled
    // "Event stream" and a scrollable list of event rows.  We accept either
    // a data-testid attribute (future-proofing) or the header text itself.
    const eventStream = page
      .locator("[data-testid='event-stream'], .event-stream")
      .or(page.getByText(/event stream/i))
      .first();

    await expect(eventStream).toBeVisible({ timeout: 3_000 });
  });

  test("monitor page has a copy URL button", async ({ page }) => {
    // The top bar in page.tsx renders a button labelled "Copy URL"
    await expect(
      page.getByRole("button", { name: /copy url/i })
    ).toBeVisible({ timeout: 5_000 });
  });
});
