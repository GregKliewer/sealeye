// scripts/standing-environments.js
// Every environment that may still be standing in AWS, in every organization, for
// `deploy/server.sh park` (DESIGN.md, "Parking the pilot between bursts of work"): a
// pilot parked with an environment left up keeps paying for it, unseen. Read from the
// records, the newest of each environment.
//
// Standing: its newest record is live or a change is under way; or it failed, and
// something may be left: a Terraform build stops part-built, and a failed update of a
// stack that was up leaves the stack as it was. Not standing: torn down, a drafted plan
// (nothing was built), or a first CloudFormation create that failed (seaLeye deletes it).
//
//   node scripts/standing-environments.js        exits 3 when any is standing
import { pathToFileURL } from "node:url";

import { closeDb, databaseUrl, db } from "../api/db.js";
import { readStoreFile, storeFile } from "../api/store.js";

const UP = new Set(["succeeded", "running", "queued", "packaging", "destroying"]);

/** The environments that may be standing, newest record of each, by organization. */
export function standing(records) {
  const byEnvironment = new Map();
  const newestFirst = [...records].sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  for (const r of newestFirst) {
    const key = r.stackName || r.environment;
    if (!key) continue;
    if (!byEnvironment.has(key)) byEnvironment.set(key, []);
    byEnvironment.get(key).push(r);
  }
  const out = [];
  for (const [environment, [newest, ...older]] of byEnvironment) {
    const failedButLeft = newest.status === "failed" &&
      (newest.backend === "terraform" || newest.cleaningUp === true || older.some(o => o.status === "succeeded"));
    if (!UP.has(newest.status) && !failedButLeft) continue;
    out.push({
      org: newest.orgId || "default",
      team: newest.teamId || "default",
      app: newest.app?.name || environment,
      environment,
      status: newest.status,
      deploymentId: newest.deploymentId,
      address: newest.outputs?.ApiUrl || newest.outputs?.WebsiteUrl || null
    });
  }
  return out.sort((a, b) => `${a.org} ${a.team} ${a.app}`.localeCompare(`${b.org} ${b.team} ${b.app}`));
}

export async function main() {
  const records = databaseUrl()
    ? (await db().query("SELECT record FROM deployments")).rows.map(x => x.record)
    : readStoreFile(storeFile);
  const rows = standing(records);
  if (!rows.length) {
    console.log("No environment is standing, in any organization.");
    return 0;
  }
  console.log(`${rows.length} environment${rows.length === 1 ? " is" : "s are"} still standing:`);
  for (const r of rows) {
    console.log(`  ${r.org} / ${r.team} / ${r.app}  ${r.status}  ${r.deploymentId}${r.address ? `  ${r.address}` : ""}`);
  }
  console.log("Tear each down first, with a token of its organization: sealeye teardown <app>");
  return 3;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(async code => { await closeDb(); process.exitCode = code; })
    .catch(async err => { console.error(err.message); await closeDb(); process.exit(1); });
}
