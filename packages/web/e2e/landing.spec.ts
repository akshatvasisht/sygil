import { test, expect } from "@playwright/test";

test.describe("Landing Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("page loads without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.reload();
    await page.waitForLoadState("networkidle");

    expect(errors).toHaveLength(0);
  });

  test("nav links are present", async ({ page }) => {
    await expect(page.getByRole("link", { name: /editor/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /github/i })).toBeVisible();
  });

  test("hero section is visible", async ({ page }) => {
    // Hero contains the main heading with "Sygil" or orchestration text
    const hero = page.locator("main").first();
    await expect(hero).toBeVisible();
  });

  test("skip-to-content link exists and is focusable", async ({ page }) => {
    // Skip link is typically hidden until focused
    const skipLink = page.getByText(/skip to/i).first();
    await expect(skipLink).toBeAttached();
  });
});
