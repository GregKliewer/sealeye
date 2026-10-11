// scripts/tokens.js
// Issue, revoke and list the tokens people call the API with (PHASE1-PLAN Step 13).
// Runs where the API's tokens are: on the server through `deploy/server.sh token ...`,
// which makes the token on your Mac and sends only its hash; or beside a laptop API.
//
//   node scripts/tokens.js add <email> <name> [--team <team>] [--org <org>] [--org-wide]
//   node scripts/tokens.js add-hash <base64 JSON: { tokenHash, email, name, org?, team?, scope? }>
//   node scripts/tokens.js revoke <email | tok_...>
//   node scripts/tokens.js list
//
// A token sees its own team's environments, or with --org-wide (scope "org") every
// team's in its organization (DESIGN.md, "Each team sees its own environments").
import { pathToFileURL } from "node:url";

import { closeDb, databaseUrl, migrate } from "../api/db.js";
import { addToken, hashToken, listTokens, newToken, revokeTokens } from "../api/tokens.js";

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** What a token sees, in words, for the lines the administrator reads. */
const sees = t => (t.scope === "org" ? `every team in ${t.org}` : `team ${t.team}`);

export async function main(argv) {
  const [command, ...args] = argv;
  if (databaseUrl()) await migrate();

  if (command === "add") {
    const [email, name] = args;
    const token = newToken();
    const scope = args.includes("--org-wide") ? "org" : "team";
    const added = await addToken({ tokenHash: hashToken(token), email, name, org: flag(args, "--org"), team: flag(args, "--team"), scope });
    console.log(`Issued ${added.tokenId} to ${added.name} (${added.email}), team ${added.team}. It sees ${sees(added)}.`);
    console.log("Their token, shown this once and kept nowhere:");
    console.log(`\n  ${token}\n`);
    return;
  }

  if (command === "add-hash") {
    const holder = JSON.parse(Buffer.from(String(args[0] || ""), "base64").toString("utf8"));
    const added = await addToken(holder);
    console.log(`Issued ${added.tokenId} to ${added.name} (${added.email}), team ${added.team}. It sees ${sees(added)}.`);
    return;
  }

  if (command === "revoke") {
    const n = await revokeTokens(args[0]);
    console.log(n ? `Revoked ${n} token${n === 1 ? "" : "s"} for ${args[0]}. ${n === 1 ? "It stops" : "They stop"} working now.` : `No live token for ${args[0]}.`);
    return;
  }

  if (command === "list") {
    const rows = await listTokens();
    if (!rows.length) return console.log("No tokens issued yet.");
    for (const t of rows) {
      const state = t.revokedAt ? `revoked ${t.revokedAt.slice(0, 10)}` : t.lastUsedAt ? `last used ${t.lastUsedAt.slice(0, 16).replace("T", " ")} UTC` : "not used yet";
      console.log(`${t.tokenId}  ${t.name} (${t.email})  team ${t.team}${t.scope === "org" ? " (sees every team)" : ""}  issued ${String(t.createdAt).slice(0, 10)}  ${state}`);
    }
    return;
  }

  throw new Error("usage: tokens.js add <email> <name> [--team <team>] [--org-wide] | revoke <email | tok_...> | list");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then(() => closeDb())
    .catch(async err => {
      console.error(err.message);
      await closeDb();
      process.exit(1);
    });
}
