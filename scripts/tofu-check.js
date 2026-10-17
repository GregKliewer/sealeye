// scripts/tofu-check.js
// The root modules seaLeye writes, checked by real OpenTofu (PHASE4-PLAN Step 9). For
// each module in test/fixtures/tofu/modules: discovery's code reads it (its inputs,
// outputs, how it takes an app, what it would run), the executor's code decides it is
// buildable and writes the root module it would build from, and OpenTofu runs `init`,
// `validate` and `plan` on that root, building nothing. GitHub Actions runs it
// (.github/workflows/tofu.yml), with OpenTofu and the AWS provider fetched there.
//
// `validate` reads the root exactly as written. `plan` needs a backend and credentials,
// so for it alone an override file puts the state in a local file and tells the
// provider not to ask AWS who is calling; nothing reaches AWS.
//
//   node scripts/tofu-check.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { deliversOf, idFor, listModules, moduleInputs, moduleOutputs, moduleRuns } from "../api/discovery/terraform.js";
import { terraformBuilds } from "../core/terraform-modules.js";
import { moduleName } from "../core/names.js";
import { inputsFor, outputsWanted, rootModule, stateKeyFor, writeRoot } from "../api/executor/terraform/root.js";
import { changeSummary, firstError, homeFor, runTofu } from "../api/executor/terraform/tofu.js";

const root = path.resolve(import.meta.dirname, "..");
const LIBRARY = path.join(root, "test", "fixtures", "tofu");
const PLATFORM = { permissions_boundary_arn: "arn:aws:iam::123456789012:policy/sealeye-function-boundary-terraform-ci" };
// A zip with nothing in it: what the function module reads the checksum of.
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

const CI_OVERRIDE = {
  terraform: { backend: { local: { path: "ci.tfstate" } } },
  provider: { aws: [{ region: "ca-central-1", access_key: "ci", secret_key: "ci", skip_credentials_validation: true, skip_requesting_account_id: true, skip_metadata_api_check: true }] }
};

async function check(source) {
  const dir = path.join(LIBRARY, source);
  const inputs = moduleInputs(dir);
  const outputs = moduleOutputs(dir);
  const entry = { id: idFor(source), source, builds_with: "terraform", availability: "available", inputs, outputs, delivers: deliversOf(inputs, outputs), runs: moduleRuns(LIBRARY, source) };
  const built = terraformBuilds(entry, { names: Object.keys(PLATFORM) });
  if (!built.builds) throw new Error(`${source}: not buildable (${built.why})`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `sealeye-tofu-check-${entry.id}-`));
  const pkg = path.join(work, "package.zip");
  fs.writeFileSync(pkg, EMPTY_ZIP);
  const name = moduleName({ org: "ci", team: "ci", app: entry.id.replace(/_/g, "-") });
  const tags = { "sealeye:app": entry.id, "sealeye:team": "ci", "sealeye:environment": `sealeye-ci-${entry.id}` };
  const given = inputsFor({ entry, planModule: { id: entry.id, inputs: {} }, name, tags, platform: PLATFORM, code: { package: pkg } });
  const rootJson = rootModule({
    moduleSource: `./library/${source}`,
    inputs: given.inputs,
    outputs: outputsWanted(entry),
    state: { bucket: "ci-bucket", key: stateKeyFor({ org: "ci", environment: `sealeye-ci-${entry.id}` }) },
    tags
  });
  writeRoot(work, { root: rootJson, libraryDir: LIBRARY });
  const home = homeFor(work);

  const inited = await runTofu(["init", "-backend=false", "-input=false", "-no-color"], { cwd: work, home });
  if (!inited.ok) throw new Error(`${source}: init failed: ${firstError(inited)}\n${inited.stdout}\n${inited.stderr}`);
  // `validate -json` says whether the root is valid in its answer.
  const validated = await runTofu(["validate", "-no-color", "-json"], { cwd: work, home });
  const verdict = JSON.parse(validated.stdout || "{}");
  if (!verdict.valid) throw new Error(`${source}: not valid: ${JSON.stringify(verdict.diagnostics)}`);

  fs.writeFileSync(path.join(work, "ci_override.tf.json"), JSON.stringify(CI_OVERRIDE, null, 2));
  const reinit = await runTofu(["init", "-reconfigure", "-input=false", "-no-color"], { cwd: work, home });
  if (!reinit.ok) throw new Error(`${source}: init for the plan failed: ${firstError(reinit)}\n${reinit.stderr}`);
  const planned = await runTofu(["plan", "-input=false", "-no-color", "-json", "-lock=false"], { cwd: work, home });
  if (!planned.ok) throw new Error(`${source}: plan failed: ${firstError(planned)}`);
  const summary = changeSummary(planned.messages);
  if (!summary || summary.add < 1) throw new Error(`${source}: the plan would create nothing (${JSON.stringify(summary)})`);
  return { source, delivers: entry.delivers.kind, inputs: given.sources.map(s => `${s.name} (${s.source})`), plan: summary };
}

export async function main() {
  const version = await runTofu(["version", "-json"], { cwd: root });
  if (!version.ok) throw new Error(`OpenTofu is not here to run: ${firstError(version)}`);
  console.log(`OpenTofu ${JSON.parse(version.stdout).terraform_version}`);
  for (const source of listModules(LIBRARY)) {
    const r = await check(source);
    console.log(`ok  ${r.source}: takes ${r.delivers}; plan creates ${r.plan.add}; inputs ${r.inputs.join(", ")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
