import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // The create-profile form's wallet field is a plain Stellar public-key
  // input (no real Freighter/Albedo popup on this page), but the app shell's
  // nav tries to resolve a connected wallet on mount. Seed localStorage so
  // that lookup resolves deterministically instead of depending on a real
  // browser extension being installed in CI.
  await page.addInitScript(() => {
    window.localStorage.setItem("walletId", "freighter");
  });
});

test("create profile page loads its form", async ({ page }) => {
  await page.goto("/create");
  await expect(page.getByRole("heading", { name: /create your/i })).toBeVisible();
  await expect(page.getByPlaceholder(/star voyager/i)).toBeVisible();
});
