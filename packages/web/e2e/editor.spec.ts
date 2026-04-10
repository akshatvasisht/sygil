import { test, expect } from "@playwright/test";

test.describe("Workflow Editor", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/editor");
    // Wait for React Flow to initialize
    await page.waitForSelector(".react-flow", { timeout: 10_000 });
  });

  test("renders the React Flow canvas", async ({ page }) => {
    // The canvas should be present
    await expect(page.locator(".react-flow")).toBeVisible();
    // The React Flow viewport wrapper should also be present
    await expect(page.locator(".react-flow__viewport")).toBeVisible();
  });

  test("shows the node palette", async ({ page }) => {
    // The palette should show the node archetypes
    await expect(page.getByText("Planner")).toBeVisible();
    await expect(page.getByText("Implementer")).toBeVisible();
    await expect(page.getByText("Reviewer")).toBeVisible();
  });

  test("clicking a node opens the property panel", async ({ page }) => {
    // The canvas starts empty — drag a node from the palette onto the canvas first
    const plannerEntry = page.locator(".react-flow").locator("..").locator("..").getByText("Planner").first();

    // Use the palette entry (draggable div) to drag onto the canvas
    const paletteItem = page
      .locator('[draggable="true"]')
      .filter({ hasText: "Planner" })
      .first();

    const canvas = page.locator(".react-flow__pane");

    // Perform drag-and-drop from palette to canvas
    const canvasBounds = await canvas.boundingBox();
    if (!canvasBounds) throw new Error("Canvas not found");

    await paletteItem.dragTo(canvas, {
      targetPosition: {
        x: canvasBounds.width / 2,
        y: canvasBounds.height / 2,
      },
    });

    // Wait for the node to appear
    await page.waitForSelector(".react-flow__node", { timeout: 5_000 });

    // Click the newly added node
    const firstNode = page.locator(".react-flow__node").first();
    await firstNode.click();

    // Property panel should appear — check for the "Adapter" field label
    await expect(page.getByText(/adapter/i)).toBeVisible({ timeout: 3_000 });
  });

  test("export button triggers a JSON download", async ({ page }) => {
    // Set up download listener before clicking
    const downloadPromise = page.waitForEvent("download");

    // Find and click the Export button in the toolbar
    await page.getByRole("button", { name: /export/i }).click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);

    // Read the downloaded file and verify it's valid JSON with expected structure
    const content = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const json = JSON.parse(Buffer.concat(chunks).toString());
    expect(json).toHaveProperty("nodes");
    expect(json).toHaveProperty("edges");
    expect(json).toHaveProperty("version");
  });

  test("undo/redo buttons are present in the toolbar", async ({ page }) => {
    // These buttons should be visible in the editor toolbar
    // They are icon-only buttons with title attributes
    await expect(
      page
        .locator("[aria-label='Undo'], [title='Undo'], [title='Undo (Ctrl+Z)'], button:has-text('Undo')")
        .first()
    ).toBeVisible();
  });
});
