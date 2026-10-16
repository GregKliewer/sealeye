// cli/catalogs.js
// `sealeye catalog versions | test | approve | live` (PHASE4-PLAN Step 7): an
// organization's catalogs, the self-test, approving a draft and making a catalog live.
// A platform engineer's, as discovery is: the API refuses a team's token. The Discovery
// page on seaLeye.online does the same and says the same (core/discovery-words.js).
//
//   sealeye catalog versions      every catalog, and which is live
//   sealeye catalog test [v]      the self-test, run now (the newest draft without v)
//   sealeye catalog edit <v> <module> [<field> [words]]
//                                 a draft entry's words: shown, or changed (asked for
//                                 in a terminal when no words are given)
//   sealeye catalog approve <v>   approve a draft that passes
//   sealeye catalog live <v>      make an approved or retired catalog live
import { c, step } from "./brand.js";
import { approveCatalogVersion, catalogSelfTest, editCatalog, getCatalogVersion, listCatalogs, makeCatalogLive } from "./client.js";
import { editableFieldsOf, fieldOf } from "../core/catalog-edits.js";
import { commandLine } from "../core/operations.js";
import {
  approvedWords, catalogStatusWords, catalogSummaryWords, madeLiveWords, nextCatalogStep, selfTestSummary
} from "../core/discovery-words.js";

const userError = message => Object.assign(new Error(message), { userFacing: true });

/** The command line for a catalog's next step, or null. */
const nextLine = (status, version) => {
  const next = nextCatalogStep(status);
  return next ? commandLine(next === "approve" ? "catalog-approve" : "catalog-live", null, [String(version)]) : null;
};

/** A self-test's result: each check, what it refused and why, and anything worth knowing. */
export function printSelfTest(result, say) {
  console.log("");
  for (const check of result.checks) {
    console.log(check.passed ? c.ok(check.title) : c.fail(check.title));
    for (const p of check.problems) console.log(c.prompt(`    ${p}`));
  }
  if (result.refused?.length) {
    console.log("");
    console.log(c.fg("Never built from this catalog:"));
    for (const r of result.refused) console.log(step(`${r.id}: ${r.why}`));
  }
  for (const note of result.notes || []) say(note);
  console.log("");
  console.log(result.passed ? c.ok(selfTestSummary(result)) : c.fail(selfTestSummary(result)));
}

/** The version a command means: the one named, or the newest draft. */
async function versionFor({ apiBaseUrl, asked, verb }) {
  if (asked !== undefined) {
    if (!/^[1-9][0-9]*$/.test(String(asked))) throw userError(`A catalog is named by its number, as sealeye catalog versions lists it, not ${asked}.`);
    return Number(asked);
  }
  const { catalogs } = await listCatalogs({ apiBaseUrl });
  const draft = catalogs.find(x => x.status === "draft");
  if (!draft) throw userError(`No draft catalog to ${verb}. sealeye discover writes one.`);
  return draft.version;
}

/**
 * The catalog subcommands.
 * @param {{ apiBaseUrl: string, sub: string, args: string[], say: (line: string) => void, json: boolean }} p
 */
export async function catalogs({ apiBaseUrl, sub, args, say, json = false }) {
  const [asked] = args;

  if (sub === "versions") {
    const list = await listCatalogs({ apiBaseUrl });
    if (json) return console.log(JSON.stringify(list, null, 2));
    console.log("");
    say(list.live.source === "starter"
      ? "Your organization plans against the starter catalog: seaLeye's own modules. None of its own is live."
      : `Your organization plans against catalog ${list.live.version}.`);
    if (!list.catalogs.length) return say("It has no catalog of its own yet. sealeye discover writes a draft from your platform library.");
    console.log("");
    for (const x of list.catalogs) {
      const status = catalogStatusWords(x.status).padEnd(19);
      console.log(`  ${c.accent(String(x.version).padStart(3))}  ${x.status === "live" ? c.accent(status) : c.fg(status)}  ${c.dim(catalogSummaryWords(x))}`);
    }
    const draft = list.catalogs.find(x => x.status === "draft");
    if (draft) {
      console.log("");
      say(`${commandLine("catalog-test", null, [String(draft.version)])} runs its self-test; ${nextLine("draft", draft.version)} approves it.`);
    }
    return;
  }

  if (sub === "test") {
    const version = await versionFor({ apiBaseUrl, asked, verb: "test" });
    const result = await catalogSelfTest({ apiBaseUrl, version });
    if (json) return console.log(JSON.stringify(result, null, 2));
    printSelfTest(result, say);
    if (!result.passed) process.exitCode = 1;
    return;
  }

  if (sub === "approve" || sub === "live") {
    if (sub === "live" && asked === undefined) {
      throw userError(`Name the catalog to make live: ${commandLine("catalog-live", null, ["<number>"])}. ${commandLine("catalogs")} lists them.`);
    }
    // Named, so what is approved is the catalog that was tested, never one written since.
    if (sub === "approve" && asked === undefined) {
      const newest = await versionFor({ apiBaseUrl, asked, verb: "approve" });
      throw userError(`Name the catalog to approve: ${commandLine("catalog-approve", null, [String(newest)])} for the newest draft. ${commandLine("catalogs")} lists them.`);
    }
    const version = await versionFor({ apiBaseUrl, asked, verb: "approve" });
    const act = sub === "approve" ? approveCatalogVersion : makeCatalogLive;
    let done;
    try {
      done = await act({ apiBaseUrl, version });
    } catch (err) {
      if (json && err.more) {
        console.log(JSON.stringify({ error: { code: err.code, message: err.message, details: err.more } }, null, 2));
        process.exitCode = 1;
        return;
      }
      if (err.code === "SELF_TEST_FAILED" && err.more?.selfTest) {
        printSelfTest(err.more.selfTest, say);
        console.log("");
        throw userError(err.message);
      }
      throw err;
    }
    if (json) return console.log(JSON.stringify(done, null, 2));
    printSelfTest(done.selfTest, say);
    console.log("");
    if (sub === "approve") {
      console.log(c.ok(approvedWords(version)));
      say(`${nextLine("approved", version)} makes it live.`);
    } else {
      console.log(c.ok(madeLiveWords(version)));
    }
    return;
  }

  if (sub === "edit") {
    const [, module, field, ...rest] = args;
    if (asked === undefined || !module) throw userError(`Name the catalog and the module: ${commandLine("catalog-edit", null, ["<number>", "<module>", "[<field>", "[words]]"])}.`);
    const version = await versionFor({ apiBaseUrl, asked, verb: "edit" });
    const { document } = await getCatalogVersion({ apiBaseUrl, version });
    const entry = (document?.modules || []).find(m => m.id === module);
    if (!entry) throw userError(`Catalog ${version} has no module ${module}. ${commandLine("catalog-test", null, [String(version)])} lists what it holds.`);
    if (!field) {
      // What can be changed, and its words now.
      console.log("");
      say(`${module} in catalog ${version}. Change one with ${commandLine("catalog-edit", null, [String(version), module, "<field>", "<words>"])}.`);
      console.log("");
      for (const f of editableFieldsOf(entry)) {
        const mark = entry.edited?.[f.field] ? c.dim(`  (edited by ${entry.edited[f.field].by})`) : "";
        console.log(`  ${c.accent(f.field.padEnd(20))} ${c.dim(f.label.padEnd(26))} ${f.text || c.dim("(none)")}${mark}`);
      }
      return;
    }
    const where = fieldOf(field);
    if (!where) throw userError(`${field} is not something whose words can be changed: line, short-line, when, skip-line, guidance, or input:<name>.`);
    let text = rest.join(" ");
    if (!text) {
      if (!process.stdin.isTTY) throw userError("Give the new words after the field, or run this in a terminal to be asked for them.");
      const now = editableFieldsOf(entry).find(f => f.field === where.field)?.text || "";
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = rl.question(`${c.prompt("?")} ${module}, ${where.label}: `);
        rl.write(now);
        text = (await answer).trim();
      } finally {
        rl.close();
      }
    }
    const done = await editCatalog({ apiBaseUrl, version, module, field: where.field, text });
    if (json) return console.log(JSON.stringify(done, null, 2));
    console.log("");
    console.log(c.ok(`${module}: ${where.label} is now: ${text.replace(/\s+/g, " ").trim()}`));
    printSelfTest(done.selfTest, say);
    if (done.selfTest.passed) say(`${nextLine("draft", version)} approves it.`);
    return;
  }

  throw userError(`sealeye catalog takes versions, test, edit, approve or live, not ${sub}.`);
}
