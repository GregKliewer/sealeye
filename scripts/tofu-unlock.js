// scripts/tofu-unlock.js
// Release a Terraform environment's state lock, once a person has looked (PHASE4-PLAN
// Step 9; DESIGN.md, "A Terraform environment's names, status and operations"). A build
// the API was in the middle of when it restarted is failed and keeps its lock, since
// OpenTofu stopped with the API and the environment may be part-built. This says what
// holds the lock, and with --release removes it, so the next deploy or tear-down
// finishes the job. `deploy/server.sh tofu-unlock <deployment> [--release]` runs it on
// the server. It reads records and changes none.
//
//   node scripts/tofu-unlock.js dep_0123456789ab [--release]
import { pathToFileURL } from "node:url";

import { requireSetting } from "../core/config.js";
import { closeDb, databaseUrl, db } from "../api/db.js";
import { readStoreFile, storeFile } from "../api/store.js";
import { releaseStateLock, stateLock } from "../api/executor/cfn.js";
import { terraformProfile } from "../api/executor/terraform/tofu.js";
import { UNDER_WAY } from "../api/busy.js";

export async function main(argv = process.argv.slice(2)) {
  const id = argv.find(a => /^dep_[0-9a-f]+$/.test(a));
  if (!id) throw new Error("Name the deployment: node scripts/tofu-unlock.js dep_... [--release]");
  const records = databaseUrl()
    ? (await db().query("SELECT record FROM deployments")).rows.map(x => x.record)
    : readStoreFile(storeFile);
  const record = records.find(r => r.deploymentId === id);
  if (!record) throw new Error(`No deployment ${id}.`);
  if (record.backend !== "terraform" || !record.terraform?.stateKey) throw new Error(`${id} was not built from an organization's module, so it has no state lock.`);
  const environment = record.stackName || record.environment;
  const going = records.find(r => (r.stackName || r.environment) === environment && UNDER_WAY.has(r.status) && !r.interrupted);
  if (going) throw new Error(`${going.deploymentId} is ${going.status} on ${environment} now, and holds its lock for a reason. Wait for it to finish.`);

  const bucket = requireSetting("BUCKET");
  const key = record.terraform.stateKey;
  const profile = terraformProfile();
  const held = await stateLock(bucket, key, { profile });
  if (!held.ok) throw new Error(`Could not read the lock on ${environment}: ${held.error}`);
  if (!held.lock) return console.log(`Nothing holds ${environment}'s lock. Deploy again or tear it down.`);
  const l = held.lock;
  console.log(`${environment}'s lock is held: ${l.Operation || "an operation"} by ${l.Who || "someone"} since ${l.Created || "a time not recorded"} (lock ${l.ID || "without an id"}).`);
  if (!argv.includes("--release")) return console.log("Run this again with --release to release it, once nothing is changing the environment.");
  const released = await releaseStateLock(bucket, key, { profile });
  if (!released.ok) throw new Error(`Could not release the lock: ${released.error}`);
  console.log(`Released. ${record.app?.name || "The app"}'s next deploy, or a tear-down, finishes what the interrupted build left.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => closeDb().catch(() => {}));
}
