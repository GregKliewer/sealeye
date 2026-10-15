// The portal against a real API with sample records (tests/test-api.mjs): sign-in,
// every page showing live data, tear down from the portal, and sign out.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

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
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: "payments-api" })).toContainText("Live");
  await expect(rows.filter({ hasText: "inventory-api" })).toContainText("Building");
  await expect(rows.filter({ hasText: "report-builder" })).toContainText("Failed");
  await expect(page.getByText("not-yours")).toHaveCount(0);
  await expect(page.getByText("another-teams-api")).toHaveCount(0);

  await page.getByLabel("Include drafted and torn down").check();
  await expect(rows).toHaveCount(7);
  await expect(rows.filter({ hasText: "ledger-sync" })).toContainText("Drafted");
  // A torn-down record keeps the address it had, and the list does not link to it.
  const gone = rows.filter({ hasText: "old-demo" });
  await expect(gone).toContainText("None, it was torn down");
  await expect(gone.getByRole("link", { name: /s3-website/ })).toHaveCount(0);

  await page.getByLabel("Search apps and people").fill("ana");
  await expect(rows).toHaveCount(3);
});

test("an organization-wide token sees every team's environments, each saying whose", async ({ page }) => {
  await page.goto("/");
  await page.fill("#token", `sl_${"z".repeat(43)}`);
  await page.click("button[type=submit]");
  await expect(page.getByTestId("person")).toHaveText("Lee Admin");
  await expect(page.getByText("built for every team in your organization")).toBeVisible();
  const rows = page.getByTestId("environment-row");
  const theirs = rows.filter({ hasText: "another-teams-api" });
  await expect(theirs).toHaveCount(1);
  await expect(theirs.getByTestId("team")).toHaveText("team payments");
  await expect(rows.filter({ hasText: "payments-api" }).first().getByTestId("team")).toHaveText("team default");
  await expect(page.getByText("not-yours")).toHaveCount(0);

  await theirs.getByRole("link").click();
  await expect(page.getByText("An API, designed for dev, team payments")).toBeVisible();
});

test("a setting can be stored from Control, and its value is never shown again", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "payments-api", exact: true }).click();
  const card = page.getByTestId("settings");
  await expect(card).toContainText("No settings are stored");
  await card.getByLabel("Setting name").fill("API_KEY");
  await card.getByLabel("Setting value").fill("a-value-for-the-portal-test");
  await card.getByRole("button", { name: "Store it" }).click();
  await expect(card.getByRole("status")).toContainText("API_KEY is stored");
  await expect(card.getByLabel("Setting value")).toHaveValue("", { timeout: 1000 });
  const row = card.getByTestId("setting-row").filter({ hasText: "API_KEY" });
  await expect(row).toContainText("Set");
  await expect(row).toContainText("by Greg Kliewer");
  expect(await page.content()).not.toContain("a-value-for-the-portal-test");

  await row.getByRole("button", { name: "Remove" }).click();
  await expect(card.getByRole("status")).toContainText("API_KEY is no longer stored");
});

test("Catalog shows the modules and what apps are waiting on", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Catalog" }).click();
  await expect(page.getByTestId("module-card")).toHaveCount(4);
  // Which catalog, in the words `sealeye catalog` says: every organization has the starter.
  await expect(page.getByTestId("catalog-version")).toHaveText(/^The starter catalog: the modules seaLeye builds on its own/);
  const rows = page.getByTestId("need-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("ledger-sync");
  // A need in the interview's own words is shown apart, as sealeye needs shows it.
  const unlisted = rows.filter({ hasText: "a search index over its records" });
  await expect(unlisted.getByTestId("unlisted")).toHaveText("Not in the list yet");
  await expect(rows.filter({ hasText: "a relational database" }).getByTestId("unlisted")).toHaveCount(0);
});

test("an environment can be torn down from the portal, and the record says so", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "marketing-site", exact: true }).click();
  await expect(page.getByTestId("status")).toHaveText("Live");
  await expect(page.getByTestId("history-row")).toHaveCount(1);
  // The command line for the same thing, in the command's own word.
  await expect(page.getByTestId("teardown").getByTestId("command-hint")).toContainText("sealeye teardown marketing-site");

  await page.getByRole("button", { name: "Tear down" }).click();
  const confirm = page.getByRole("button", { name: "Tear it down" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type the app's name to confirm").fill("marketing-sit");
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type the app's name to confirm").fill("marketing-site");
  await confirm.click();

  await expect(page.getByText("Tear down asked by")).toBeVisible();
  await expect(page.getByText("Greg Kliewer from the portal", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText("Torn down", { timeout: 20_000 });
  // Gone, so no address to follow, though the record keeps the one it had.
  await expect(page.getByTestId("address")).toHaveText("None, it was torn down");
  await expect(page.getByTestId("address").getByRole("link")).toHaveCount(0);
});

test("a tear-down run from the command line shows on the open page without a refresh", async ({ page, request }) => {
  await signIn(page);
  await page.getByRole("link", { name: "cli-side-api", exact: true }).click();
  await expect(page.getByTestId("status")).toHaveText("Live");
  await expect(page.getByTestId("address").getByRole("link")).toHaveText("https://cli789.lambda-url.ca-central-1.on.aws/");
  // Marked, so a reload would show: the page must follow without one.
  await page.evaluate(() => { (window as unknown as { stayed: boolean }).stayed = true; });

  // What `sealeye teardown cli-side-api` sends: the token, straight to the API.
  const res = await request.delete("http://localhost:3999/deployments/dep_hhhhhhhhhhh1", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status()).toBe(202);

  await expect(page.getByTestId("status")).toHaveText(/Tearing down|Torn down/, { timeout: 5_000 });
  await expect(page.getByTestId("status")).toHaveText("Torn down", { timeout: 20_000 });
  await expect(page.getByText("Greg Kliewer from the command line", { exact: false }).last()).toBeVisible();
  await expect(page.getByTestId("address")).toHaveText("None, it was torn down");
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
});

test("Evidence reads the change record on request, in the command's words, with the file to download", async ({ page }) => {
  await signIn(page);
  // A drafted plan: nothing was built, so the record is read without asking AWS.
  await page.goto(`/environments/${encodeURIComponent("default:ledger-sync")}`);
  const card = page.getByTestId("evidence");
  await expect(card).toContainText("dep_ccccccccccc1 (the latest)");
  await expect(card.getByTestId("evidence-row")).toHaveCount(0);
  await card.getByRole("button", { name: "Read the evidence" }).click();
  await expect(card).toContainText("Change record for ledger-sync (no stack, profile dev)");
  const rows = card.getByTestId("evidence-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: "Approved plan" })).toContainText("two needs");
  await expect(rows.filter({ hasText: "Built" })).toContainText("nothing.");
  await expect(rows.filter({ hasText: "Checked now" })).toContainText("nothing to check");

  const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Download DEPLOYMENT_EVIDENCE.md" }).click()]);
  expect(download.suggestedFilename()).toBe("DEPLOYMENT_EVIDENCE.md");
  const fs = await import("node:fs");
  const text = fs.readFileSync(await download.path(), "utf8");
  expect(text).toContain("ledger-sync");
  await card.getByText("The whole record").click();
  await expect(card.getByTestId("evidence-markdown")).toContainText("ledger-sync");
});

test("Evidence can be read for an earlier deployment from the history", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "payments-api", exact: true }).click();
  const card = page.getByTestId("evidence");
  await expect(card).toContainText("dep_aaaaaaaaaaa1 (the latest)");
  await page.getByRole("button", { name: "Evidence for dep_aaaaaaaaaaa0" }).click();
  await expect(card).toContainText("dep_aaaaaaaaaaa0");
  await expect(card).not.toContainText("(the latest)");
});

test("The plan and report for a deployment, and for an earlier one from the history, as sealeye plan writes them", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "payments-api", exact: true }).click();
  const card = page.getByTestId("plan-card");
  await expect(card).toContainText("dep_aaaaaaaaaaa1 (the latest)");
  // Made before the approved files were kept: written from its plan, and it says so.
  await expect(card.getByTestId("plan-file")).toContainText("Deployment Plan");
  await expect(card).toContainText("made before seaLeye kept the approved files");
  await expect(card.getByTestId("plan-file")).not.toContainText("No assumptions were needed");
  const [yaml] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Download sealeye.yaml" }).click()]);
  expect(yaml.suggestedFilename()).toBe("sealeye.yaml");

  await card.getByRole("button", { name: "The report" }).click();
  await expect(card.getByTestId("report-file")).toContainText("Your API is live at https://abc123.lambda-url.ca-central-1.on.aws/");
  const [report] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Download DEPLOYMENT_REPORT.md" }).click()]);
  expect(report.suggestedFilename()).toBe("DEPLOYMENT_REPORT.md");

  await page.getByRole("button", { name: "Plan and report for dep_aaaaaaaaaaa0" }).click();
  await expect(card).toContainText("dep_aaaaaaaaaaa0");
  await expect(card).not.toContainText("(the latest)");
  await card.getByRole("button", { name: "The report" }).click();
  await expect(card.getByTestId("no-report")).toContainText("This deployment has no report.");
});

test("A failed deployment's card says why it has no report", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "report-builder", exact: true }).click();
  const card = page.getByTestId("plan-card");
  await card.getByRole("button", { name: "The report" }).click();
  await expect(card.getByTestId("no-report")).toContainText("This deployment failed, so there is no report.");
  await expect(card.getByTestId("no-report")).toContainText("index.js was not in the folder");
});

test("Validate says whether a plan is ready, drafted, or cannot be deployed, as sealeye validate does", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Validate" }).click();
  const box = page.getByLabel("Plan", { exact: true });
  const result = page.getByTestId("validation");
  const ready = [
    "planVersion: \"0.4\"",
    "app: { name: checkout-api, type: api }",
    "profile: dev",
    "modules:",
    "  - id: http_api_serverless",
    "    inputs: { runtime: nodejs, entry_point: index.js, trigger: http }",
    "  - id: observability_basic",
    "    inputs: { target: auto, retention_days: 30 }",
    "outputs: [public_url, logs]"
  ].join("\n");

  await box.fill(ready);
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(result).toContainText("checkout-api: valid and ready to deploy");

  await box.fill(`${ready}\nneeds:\n  - kind: continuous_service\n    line: x\n    evidence:\n      - { file: worker.js, shows: reads a queue in a loop }`);
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(result).toContainText("it is drafted");
  await expect(result.getByTestId("validation-need")).toContainText("reads a queue in a loop (worker.js)");
  await expect(result).not.toContainText("ready to deploy");

  await box.fill("planVersion: \"0.4\"\napp: { name: x }\nmodules: []");
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(result).toContainText("cannot be deployed as written");

  await box.fill("app: [unclosed");
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(result.getByRole("alert")).toContainText("not a plan the platform can read");
});

test("Health shows what sealeye doctor checks, for this browser", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Health" }).click();
  const checks = page.getByTestId("health-check");
  await expect(checks.filter({ hasText: "answering" })).toContainText(/answering, version \d+\.\d+\.\d+/);
  await expect(checks.filter({ hasText: "Signed in" })).toContainText("Greg Kliewer (greg@example.com), team default");
  await expect(checks.filter({ hasText: "This page" })).toContainText("the same as the platform");
});

test("Deploy again sends the code an earlier deployment packaged, and the history says so", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "payments-api", exact: true }).click();
  const card = page.getByTestId("deploy-again");
  await expect(card.getByTestId("command-hint")).toContainText("sealeye deploy --again payments-api");
  const rows = page.getByTestId("history-row");
  const before = await rows.count();
  await card.getByRole("button", { name: "Deploy again" }).click();
  // What it does is said where it is asked.
  await expect(page.getByRole("dialog")).toContainText("dep_aaaaaaaaaaa1");
  await page.getByRole("button", { name: "Deploy it" }).click();
  await expect(rows).toHaveCount(before + 1);
  const newest = rows.first();
  await expect(newest).toContainText("again, with dep_aaaaaaaaaaa1's code");
  await expect(newest).toContainText("Portal");
  await expect(page.getByTestId("status")).toHaveText("Live", { timeout: 20_000 });
});

test("another team's environment offers no Deploy again, even to an organization-wide token", async ({ page }) => {
  await page.goto("/");
  await page.fill("#token", `sl_${"z".repeat(43)}`);
  await page.click("button[type=submit]");
  await page.getByRole("link", { name: "another-teams-api" }).click();
  await expect(page.getByText("team payments")).toBeVisible();
  await expect(page.getByTestId("deploy-again")).toHaveCount(0);
});

test("a ready plan can be deployed from Validate with the code the platform has for its app", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Validate" }).click();
  const ready = (name: string) => [
    "planVersion: \"0.4\"",
    `app: { name: ${name}, type: api }`,
    "profile: dev",
    "modules:",
    "  - id: http_api_serverless",
    "    inputs: { runtime: nodejs, entry_point: index.js, trigger: http }",
    "  - id: observability_basic",
    "    inputs: { target: auto, retention_days: 14 }",
    "outputs: [public_url, logs]"
  ].join("\n");

  await page.getByLabel("Plan", { exact: true }).fill(ready("checkout-api"));
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(page.getByTestId("deploy-plan")).toContainText("has no code for checkout-api yet");

  await page.getByLabel("Plan", { exact: true }).fill(ready("payments-api"));
  await page.getByRole("button", { name: "Check it" }).click();
  const deploy = page.getByTestId("deploy-plan");
  await expect(deploy).toContainText("packaged");
  await deploy.getByRole("button", { name: "Deploy this plan" }).click();
  await expect(page.getByRole("status")).toContainText("Deploying as dep_");
  await page.getByRole("link", { name: "Follow it in its environment" }).click();
  await expect(page.getByRole("heading", { name: "payments-api" })).toBeVisible();
  await expect(page.getByTestId("history-row").first()).toContainText("again, with dep_aaaaaaaaaaa1's code");
});

function appFolder(name: string, files: Record<string, string>): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sealeye-new-env-")), name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const SECRET = "sk-live-only-in-the-dotenv";

test("New environment holds the interview in the browser, stores what the plan needs, and deploys", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "New environment" }).click();
  const dir = appFolder("orders-api", {
    "package.json": JSON.stringify({ name: "orders-api", version: "1.0.0" }),
    "index.js": "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)",
    ".env": `GREETING=${SECRET}`,
    "node_modules/left-out/index.js": "never read"
  });
  await page.getByLabel("Choose your app's folder").setInputFiles(dir);
  await expect(page.getByTestId("choose-folder")).toContainText("Ready to read orders-api");
  await page.getByRole("button", { name: "Read my app" }).click();

  const lines = page.getByTestId("interview-lines");
  await expect(page.getByTestId("interview")).toContainText("Sent as names only: .env");
  await expect(lines).toContainText("Who calls this API?", { timeout: 20_000 });
  await page.getByLabel("Your answer").fill("Our checkout service");
  await page.getByRole("button", { name: "Answer" }).click();
  await expect(lines).toContainText("Our checkout service");

  const plan = page.getByTestId("plan");
  await expect(plan).toContainText("Ready", { timeout: 20_000 });
  await expect(plan).toContainText("http_api_serverless");
  const [download] = await Promise.all([page.waitForEvent("download"), plan.getByRole("button", { name: "Download sealeye.yaml" }).click()]);
  expect(fs.readFileSync(await download.path(), "utf8")).toContain("orders-api");
  await plan.getByText("The full plan").click();
  await expect(plan.getByTestId("plan-markdown")).toContainText("orders-api");

  await plan.getByRole("button", { name: "Yes, deploy it" }).click();
  const settings = page.getByTestId("store-settings");
  await expect(settings).toContainText("GREETING");
  await expect(settings.getByRole("button", { name: "Deploy it" })).toBeDisabled();
  await settings.getByLabel("Value for GREETING").fill("hello-from-the-portal");
  await settings.getByRole("button", { name: "Store it" }).click();
  await expect(settings.getByRole("status")).toHaveText("Every setting is stored.");
  await settings.getByRole("button", { name: "Deploy it" }).click();

  await expect(page.getByRole("heading", { name: "orders-api" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("history-row").first()).toContainText("Portal");
  expect(await page.content()).not.toContain(SECRET);
});

// A value shaped like a Stripe key, put together here so no file holds one.
const FAKE_KEY = ["sk", "_live_", "Q7rT2vX9mK4pL8wN3bZ6cF1h"].join("");

test("a key written into the code is never sent, the rest of its file is read, and its deploy is refused, as sealeye run says", async ({ page }) => {
  await signIn(page);
  await page.goto("/new");
  const dir = appFolder("orders-api", {
    "package.json": JSON.stringify({ name: "orders-api", version: "1.0.0" }),
    "index.js": `const http = require('http');\nconst stripe = require('stripe')('${FAKE_KEY}');\nhttp.createServer((q, s) => s.end('ok')).listen(process.env.PORT);\n`
  });
  await page.getByLabel("Choose your app's folder").setInputFiles(dir);
  await page.getByRole("button", { name: "Read my app" }).click();

  // Before anything else: which file, which line, what kind, and what happens next.
  const note = page.getByTestId("secret-findings");
  await expect(note).toContainText("index.js, line 2, looks like it holds a Stripe key.");
  await expect(note).toContainText("That line was not sent: the interview reads the rest of the file without it.");

  // The model reads the file, with that line replaced by one that says why.
  const lines = page.getByTestId("interview-lines");
  await expect(lines).toContainText("Reading index.js", { timeout: 20_000 });
  await expect(lines).toContainText("Who calls this API?", { timeout: 20_000 });
  await page.getByLabel("Your answer").fill("Our checkout service");
  await page.getByRole("button", { name: "Answer" }).click();
  const plan = page.getByTestId("plan");
  await expect(plan).toContainText("Ready", { timeout: 20_000 });

  await plan.getByRole("button", { name: "Yes, deploy it" }).click();
  // GREETING may already be in the store from the test before; if not, store it.
  const settings = page.getByTestId("store-settings");
  const refusal = page.getByTestId("secrets-refusal");
  await expect(settings.or(refusal)).toBeVisible();
  if (await settings.isVisible()) {
    await settings.getByLabel("Value for GREETING").fill("hello-from-the-portal");
    await settings.getByRole("button", { name: "Store it" }).click();
    await expect(settings.getByRole("status")).toHaveText("Every setting is stored.");
    await settings.getByRole("button", { name: "Deploy it" }).click();
  }

  // Refused here, before the folder was sent, in the command's words.
  await expect(refusal).toContainText("Nothing was deployed: your code looks like it holds a secret.");
  await expect(refusal).toContainText("index.js, line 2, looks like it holds a Stripe key.");
  await expect(refusal).toContainText("sealeye settings set NAME, or Settings in seaLeye.online");
  await expect(refusal.locator("pre")).toHaveText("index.js:2:stripe-key");
  expect(await page.content()).not.toContain(FAKE_KEY);
});

test("a run that reaches its spending limit stops, and says so in the command's words", async ({ page }) => {
  await signIn(page);
  await page.goto("/new");
  const dir = appFolder("looping-api", { "package.json": JSON.stringify({ name: "looping-api" }), "index.js": "x" });
  await page.getByLabel("Choose your app's folder").setInputFiles(dir);
  await page.getByRole("button", { name: "Read my app" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("This run reached its spending limit before it had a plan, so it stopped there.", { timeout: 20_000 });
  await expect(alert).toContainText("Run sealeye run again");
  await expect(alert).not.toContainText("$");
});

test("a drafted plan from New environment is saved, and says what it needs", async ({ page }) => {
  await signIn(page);
  await page.goto("/new");
  const dir = appFolder("ledger-worker", {
    "package.json": JSON.stringify({ name: "ledger-worker" }),
    "index.js": "require('./worker')",
    "worker.js": "for (;;) { /* read the queue */ }"
  });
  await page.getByLabel("Choose your app's folder").setInputFiles(dir);
  await page.getByRole("button", { name: "Read my app" }).click();
  const plan = page.getByTestId("plan");
  await expect(plan).toContainText("Drafted", { timeout: 20_000 });
  await expect(plan.getByTestId("plan-need")).toContainText("reads a queue in a loop (worker.js)");
  await plan.getByRole("button", { name: "Yes, deploy it" }).click();
  const refusal = page.getByTestId("refusal");
  await expect(refusal).toContainText("Nothing was built. Your plan is drafted and saved as dep_");
  await expect(refusal).toContainText("Northwind Payments's Platform Library");
});

test("saying not now keeps the plan to download and deploys nothing", async ({ page }) => {
  await signIn(page);
  await page.goto("/new");
  const dir = appFolder("orders-api", { "package.json": JSON.stringify({ name: "orders-api" }), "index.js": "" });
  await page.getByLabel("Choose your app's folder").setInputFiles(dir);
  await page.getByRole("button", { name: "Read my app" }).click();
  await page.getByLabel("Your answer").fill("Nobody yet", { timeout: 20_000 });
  await page.getByRole("button", { name: "Answer" }).click();
  const plan = page.getByTestId("plan");
  await plan.getByRole("button", { name: "Not now" }).click({ timeout: 20_000 });
  await expect(plan.getByRole("status")).toContainText("Nothing was deployed");
  await expect(plan.getByRole("button", { name: "Download DEPLOYMENT_PLAN.md" })).toBeVisible();
});

test("Logs shows what the app wrote, newest first, with secrets taken out", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "payments-api", exact: true }).click();
  const card = page.getByTestId("logs");
  await card.getByRole("button", { name: "15 minutes" }).click();
  await card.getByRole("button", { name: "Show logs" }).click();
  const lines = card.getByTestId("log-lines").locator("li");
  await expect(lines).toHaveCount(2);
  await expect(lines.first()).toContainText("GET /orders with Bearer [value redacted]");
  await expect(lines.last()).toContainText("listening on 8080");
  expect(await page.content()).not.toContain("abcdefghijklmnop");
});

test("a static site has no Logs card", async ({ page }) => {
  await signIn(page);
  await page.goto(`/environments/${encodeURIComponent("sealeye-old-demo")}`);
  await expect(page.getByRole("heading", { name: "old-demo" })).toBeVisible();
  await expect(page.getByTestId("logs")).toHaveCount(0);
});

test("Pause stops an API taking requests and Resume starts it again, read back each time", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "payments-api", exact: true }).click();
  const card = page.getByTestId("pause");
  await expect(card.getByTestId("pause-state")).toHaveText("Taking requests");
  await expect(card.getByTestId("command-hint")).toContainText("sealeye pause");
  await card.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Nothing is removed");
  await page.getByRole("button", { name: "Pause it" }).click();
  await expect(card.getByTestId("pause-state")).toHaveText("Paused");
  await expect(card.getByTestId("command-hint")).toContainText("sealeye resume");
  await expect(card).toContainText("Paused by Greg Kliewer from the portal");
  await expect(page.getByTestId("status")).toHaveText("Paused");
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(card.getByTestId("pause-state")).toHaveText("Taking requests");
  await expect(page.getByTestId("status")).toHaveText("Live");
});

test("Configure changes how long logs are kept, as a deploy of the same code again", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "payments-api", exact: true }).click();
  const card = page.getByTestId("configure");
  // An earlier test deployed this app's plan with 14 days.
  await expect(card).toContainText("Logs are kept for 14 days");
  await expect(card.getByRole("button", { name: "Deploy with this" })).toBeDisabled();
  await card.getByLabel("Keep logs for").selectOption("60");
  await card.getByRole("button", { name: "Deploy with this" }).click();
  await expect(card.getByRole("status")).toContainText("with logs kept for 60 days");
  await expect(page.getByTestId("history-row").first()).toContainText("again, with dep_aaaaaaaaaaa1's code");
});

test("Team lists the people with tokens on your team, and never a token", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Team" }).click();
  const rows = page.getByTestId("person-row");
  // Lee's organization-wide token is on team default too.
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Greg Kliewer" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Lee Admin" })).toContainText("every team");
  await expect(page.getByText("Everyone on team default")).toBeVisible();
  expect(await page.content()).not.toMatch(/sl_[a-z]{20}/);
});

test("Performance shows readings, in tiles, a chart and a table, never a capacity", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "payments-api", exact: true }).click();
  const card = page.getByTestId("performance");
  await card.getByRole("button", { name: "Show readings" }).click();
  await expect(card.getByTestId("stat").first()).toContainText("Requests");
  await expect(card.getByTestId("stat").nth(2)).toContainText("96 ms");
  await expect(card).toContainText("95 in 100 within 310 ms");
  await card.locator("svg g").nth(12).hover();
  await expect(card.getByTestId("chart-readout")).toContainText("requests");
  await card.getByRole("button", { name: "Show as a table" }).click();
  await expect(card.getByTestId("period-table").locator("tbody tr")).toHaveCount(24);
  await card.getByRole("button", { name: "7 days" }).click();
  await expect(card.getByTestId("period-table").locator("tbody tr")).toHaveCount(28);
});

test("Costs lists what each app has cost, says it is a day behind, and what is counted", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Costs" }).click();
  const rows = page.getByTestId("cost-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("payments-api");
  await expect(rows.first()).toContainText("3.40 USD");
  await expect(page.getByTestId("cost-total")).toHaveText("3.52 USD");
  await expect(page.getByText("about a day behind")).toBeVisible();
  await page.getByRole("button", { name: "7 days" }).click();
  await expect(rows).toHaveCount(2);
});

test("an interview started elsewhere can be finished on New environment", async ({ page, request }) => {
  // Started the way the command starts one: the same person's token, a zipped folder.
  const zip = Buffer.from(zipSync({ "package.json": strToU8(JSON.stringify({ name: "orders-api" })), "index.js": strToU8("") })).toString("base64");
  const started = await request.post("/api/interviews", { headers: { authorization: `Bearer ${TOKEN}` }, data: { app: "orders-api", zip } });
  expect(started.ok()).toBeTruthy();

  await signIn(page);
  await page.goto("/new");
  const open = page.getByTestId("open-interview").filter({ hasText: "orders-api" });
  await expect(open.first()).toBeVisible();
  await open.first().getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Your answer").fill("Picked up in the portal", { timeout: 20_000 });
  await page.getByRole("button", { name: "Answer" }).click();
  await page.getByTestId("plan").getByRole("button", { name: "Yes, deploy it" }).click({ timeout: 20_000 });
  // GREETING was stored by an earlier test, so the next thing asked for is the folder.
  const need = page.getByTestId("need-folder");
  await expect(need).toBeVisible();
  await need.getByLabel("Choose the folder to package").setInputFiles(appFolder("orders-api", { "package.json": JSON.stringify({ name: "orders-api" }), "index.js": "" }));
  await expect(page.getByRole("heading", { name: "orders-api" })).toBeVisible({ timeout: 20_000 });
});

test("signing out ends the session: the pages ask for sign-in again", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText("You are signed out.")).toBeVisible();
  await page.goto("/catalog");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("signing in comes back to the page asked for, as sealeye online <app> opens it", async ({ page }) => {
  await page.goto("/environments/sealeye-payments-api");
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.fill("#token", TOKEN);
  await page.click("button[type=submit]");
  await expect(page).toHaveURL(/\/environments\/sealeye-payments-api$/);
  await expect(page.getByRole("heading", { name: "payments-api" })).toBeVisible();
});

test("an environment being built says so everywhere, and locks what would change it", async ({ page }) => {
  await signIn(page);
  const row = page.getByTestId("environment-row").filter({ hasText: "inventory-api" });
  await expect(row.getByTestId("environment-step")).toContainText("Creating your AWS environment");
  await expect(row).toContainText("Building");

  await row.getByRole("link", { name: "inventory-api" }).click();
  const banner = page.getByTestId("under-way");
  await expect(banner).toContainText("Building inventory-api");
  await expect(banner.getByTestId("under-way-step")).toContainText("Creating your AWS environment");
  await expect(banner).toContainText("dep_ggggggggggg1, started by Ana Pereira from the portal");
  await expect(banner.getByTestId("under-way-elapsed")).toHaveText(/^\d+m \d\ds$/);
  await expect(page).toHaveTitle("Building · inventory-api");

  // Every card that would change it is locked, and says why: the actions once, for all three.
  for (const id of ["actions", "configure"]) {
    await expect(page.getByTestId(id).getByTestId("locked")).toContainText(/Locked while building, started \d+m ago/);
  }
  await expect(page.getByRole("button", { name: "Tear down" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deploy again" })).toBeDisabled();
  await expect(page.getByTestId("pause").getByRole("button", { name: "Pause", exact: true })).toBeDisabled();
  await expect(page.getByTestId("settings-while-moving")).toBeVisible();

  // The history: the build under way stands out with its step; the earlier deploy is
  // replaced only once a newer one has succeeded, so it is still what answers now.
  const rows = page.getByTestId("history-row");
  await expect(rows.first()).toHaveAttribute("data-under-way", "");
  await expect(rows.first().getByTestId("history-step")).toContainText("Creating your AWS environment");
  await expect(rows.nth(1)).toContainText("Live");
});

test("the platform refuses a second change while one is under way, in words", async ({ request }) => {
  const res = await request.delete("/api/deployments/dep_ggggggggggg0", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.error.code).toBe("ENVIRONMENT_BUSY");
  expect(body.error.message).toContain("inventory-api is being built right now (dep_ggggggggggg1");
});

test("an earlier deploy a newer one replaced says so, and only the newest is Live", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "payments-api", exact: true }).click();
  const rows = page.getByTestId("history-row");
  await expect(rows.first()).toContainText("Live");
  const older = rows.filter({ hasText: "dep_aaaaaaaaaaa0" });
  await expect(older).toContainText("Replaced");
  await expect(older.getByTestId("replaced-by")).toContainText("by dep_");
  await expect(rows.filter({ hasText: "Live" })).toHaveCount(1);
});

// Discovery (PHASE4-PLAN Step 6b): a platform engineer's page, for an organization-wide
// token only, as `sealeye discover` is.
async function signInOrgWide(page: Page) {
  await page.goto("/sign-in");
  await page.fill("#token", `sl_${"z".repeat(43)}`);
  await page.click("button[type=submit]");
  await expect(page.getByTestId("person")).toHaveText("Lee Admin");
}

test("a team's token sees no Discovery page, and is sent home from its address", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("navigation", { name: "Sections" })).not.toContainText("Discovery");
  await page.goto("/discovery");
  await expect(page).toHaveURL(/\/$/);
});

test("Discovery shows the run, its open question, and the draft resting on it; an answer is taken", async ({ page }) => {
  await signInOrgWide(page);
  await page.getByRole("navigation", { name: "Sections" }).getByText("Discovery").click();
  await expect(page.getByTestId("run")).toContainText("Finished, draft catalog 1");
  await expect(page.getByTestId("run")).toContainText("northwind/platform-library at 5e63aa5");
  await expect(page.getByTestId("command-hint").first()).toContainText("sealeye discover");

  const q = page.getByTestId("open-question");
  await expect(q).toHaveCount(1);
  await expect(q).toContainText("Does cache-valkey replace cache-redis for new apps?");
  await expect(q).toContainText("the run's guess");
  await expect(q).toContainText("modules/cache-redis/README.md:3");
  await expect(page.getByTestId("draft-module")).toHaveCount(3);
  await expect(page.getByTestId("rests-on-question")).toHaveCount(1);
  await expect(page.getByTestId("answered-question")).toContainText("postgres-cluster");

  // An answer of one's own, in words.
  await q.getByLabel("Something else").check();
  await q.getByLabel("Your own answer").fill("Only the payments and lending teams, until the trial ends");
  await q.getByRole("button", { name: "Answer" }).click();
  await expect(page.getByTestId("open-question")).toHaveCount(0);
  await expect(page.getByTestId("answered-question").filter({ hasText: "trial ends" })).toContainText("lead@example.com");
  // Written into the draft by the stand-in supervisor: nothing rests on a question now.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("rests-on-question")).toHaveCount(0);
    await expect(page.getByTestId("answered-question").filter({ hasText: "trial ends" })).toContainText("in the draft");
  }).toPass({ timeout: 10_000 });
});

test("starting a run with no library named says so in words", async ({ page }) => {
  await signInOrgWide(page);
  await page.goto("/discovery");
  await page.getByTestId("start-discovery").click();
  await expect(page.getByRole("alert")).toContainText("No platform library is named for discovery yet");
});
