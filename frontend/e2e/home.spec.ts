import { test, expect } from "@playwright/test";

const PROFILES = {
  profiles: [
    {
      id: "p1",
      username: "stellar-dev",
      displayName: "Stellar Dev",
      bio: "Building open-source tooling on Stellar.",
      avatarUrl: null,
      acceptedAssets: [{ code: "XLM", issuer: null }],
    },
  ],
};

test.beforeEach(async ({ page }) => {
  // Frontend CI runs without a backend, so serve the profile list from a
  // fixture. This keeps the walkthrough deterministic rather than depending
  // on whatever data a live API happens to hold.
  await page.route("**/profiles*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PROFILES),
    });
  });
});

test("home page loads and renders the creator list", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();

  await page.getByRole("link", { name: /explore creators/i }).click();
  await expect(page).toHaveURL(/\/explore/);
  await expect(page.getByRole("heading", { name: /explore creators/i })).toBeVisible();

  const creatorCards = page.locator('a[href^="/profile/"]');
  await expect(creatorCards.first()).toBeVisible();
});
