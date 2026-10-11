// The portal against a real API with sample records (tests/test-api.mjs): sign-in,
// every page showing live data, tear down from the portal, and sign out.
import { expect, test, type Page } from "@playwright/test";

const TOKEN = `sl_${"t".repeat(43)}`;

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.fill("#token", TOKEN);
  await page.click("button[type=submit]");
  await expect(page.getByTestId("person")).toHaveText("Greg Kliewer");
}

test("a wrong token is refused and nothing is kept", async ({ page }) => {
  await page.goto("/sign-in");
  await page.fill("#token", `sl_${"w".repeat(43)}`);
  await page.click("button[type=submit]");
  await expect(page.getByRole("alert")).toContainText("does not accept this token");
  await page.fill("#token", "not a token");
  await page.click("button[type=submit]");
  await expect(page.getByRole("alert")).toContainText("not a seaLeye token");
});

test("signing in keeps a session the page cannot read, never the token", async ({ page }) => {
  await signIn(page);
  expect(await page.evaluate(() => document.cookie)).toBe("");
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain("sl_");
  const cookies = await page.context().cookies();
  const session = cookies.find(c => c.name === "__Host-sealeye_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Strict");
});

test("Environments shows your team's environments, read live from the API", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Environments" })).toBeVisible();
  await expect(page.getByText("built for your team, default")).toBeVisible();
  await expect(page.getByText("Northwind Payments")).toBeVisible();
  const rows = page.getByTestId("environment-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "payments-api" })).toContainText("Live");
  await expect(rows.filter({ hasText: "report-builder" })).toContainText("Failed");
  await expect(page.getByText("not-yours")).toHaveCount(0);
  await expect(page.getByText("another-teams-api")).toHaveCount(0);

  await page.getByLabel("Include drafted and torn down").check();
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: "ledger-sync" })).toContainText("Drafted");

  await page.getByLabel("Search apps and people").fill("ana");
  await expect(rows).toHaveCount(2);
});

test("Catalog shows the modules and what apps are waiting on", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Catalog" }).click();
  await expect(page.getByTestId("module-card")).toHaveCount(4);
  await expect(page.getByTestId("need-row")).toHaveCount(1);
  await expect(page.getByTestId("need-row")).toContainText("ledger-sync");
});

test("an environment can be torn down from the portal, and the record says so", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "marketing-site", exact: true }).click();
  await expect(page.getByTestId("status")).toHaveText("Live");
  await expect(page.getByTestId("history-row")).toHaveCount(1);

  await page.getByRole("button", { name: "Tear down" }).click();
  const confirm = page.getByRole("button", { name: "Tear it down" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type the app's name to confirm").fill("marketing-sit");
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type the app's name to confirm").fill("marketing-site");
  await confirm.click();

  await expect(page.getByText("Tear down asked by")).toBeVisible();
  await expect(page.getByText("Greg Kliewer from the portal")).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText("Torn down", { timeout: 20_000 });
});

test("signing out ends the session: the pages ask for sign-in again", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText("You are signed out.")).toBeVisible();
  await page.goto("/catalog");
  await expect(page).toHaveURL(/\/sign-in$/);
});
