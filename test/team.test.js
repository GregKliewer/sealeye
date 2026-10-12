// The people on your team (PHASE2-PLAN Step 19): from the tokens in use, by person, with
// no token or hash anywhere. A team's token sees its team; an organization-wide token
// sees every team in its organization.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startApi, token } from "./helpers/api-with-aws.js";

const root = path.resolve(import.meta.dirname, "..");
const ANA = token("a");
const BEN = token("b");
const PAT = token("p");
const LEE = token("l");
const OLD = token("o");
let api;

before(async () => {
  api = await startApi({
    tokens: [
      { token: ANA, id: "ana", team: "default", name: "Ana Pereira" },
      { token: BEN, id: "ben", team: "default", name: "Ben Ng" },
      { token: PAT, id: "pat", team: "payments", name: "Pat Other" },
      { token: LEE, id: "lee", team: "platform", scope: "org", name: "Lee Admin" },
      { token: OLD, id: "old", team: "default", name: "Gone Person" }
    ],
    records: [],
    aws: ""
  });
  // A revoked token's person is not on the team.
  const file = path.join(api.home, "tokens.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  rows.find(r => r.tokenId === "old").revokedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(rows));
});

after(() => api?.stop());

test("a team's token sees its own team, by person, and never a token", async () => {
  const { status, body } = await api.call("/team", { token: ANA });
  assert.equal(status, 200);
  assert.equal(body.team, "default");
  assert.deepEqual(body.people.map(p => p.name), ["Ana Pereira", "Ben Ng"]);
  assert.ok(body.people[0].issuedAt);
  const all = JSON.stringify(body);
  assert.ok(!/tokenHash|token_hash|tokenId|sl_/.test(all), "no tokens, hashes or token ids");
});

test("an organization-wide token sees every team, each row saying whose", async () => {
  const { body } = await api.call("/team", { token: LEE });
  assert.equal(body.everyTeam, true);
  assert.deepEqual(body.people.map(p => `${p.team}:${p.name}`), ["default:Ana Pereira", "default:Ben Ng", "payments:Pat Other", "platform:Lee Admin"]);
  assert.equal(body.people.find(p => p.name === "Lee Admin").scope, "org");
});

test("sealeye team lists them, with when each last used seaLeye", async () => {
  await api.call("/team", { token: BEN });   // Ben has used it
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "cli/bin/sealeye"), "team", "--api", api.api], {
    cwd: api.home, env: { ...process.env, HOME: api.home, SEALEYE_HOME: api.home, SEALEYE_TOKEN: ANA, NO_COLOR: "1" }
  });
  assert.match(stdout, /NAME\s+EMAIL\s+LAST USED/);
  assert.match(stdout, /Ana Pereira\s+ana@example\.com/);
  assert.doesNotMatch(stdout, /Gone Person|Pat Other/);
});
