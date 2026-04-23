import { test, expect } from "@playwright/test";

test.describe("Execution Monitor", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/monitor");
    // Wait for the page to load
    await page.waitForLoadState("networkidle");
  });

  test("monitor page loads without the retired demo-mode banner", async ({ page }) => {
    // Demo mode was retired — the banner must not appear on a fresh load.
    await expect(page.getByText(/demo mode/i)).toHaveCount(0);
    // The top bar still renders the sygil brand, confirming the shell loaded.
    await expect(page.getByText("sygil")).toBeVisible({ timeout: 5_000 });
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
