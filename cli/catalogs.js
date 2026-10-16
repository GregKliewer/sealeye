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
//   sealeye catalog fix [v]       each field that blocks approval, one at a time, then
//                                 the self-test and an offer to approve (DESIGN.md,
//                                 "What blocks approval is fixed in one walk")
//   sealeye catalog approve <v>   approve a draft that passes; refused for words alone,
//                                 it offers the walk in a terminal
//   sealeye catalog live <v>      make an approved or retired catalog live
import { ask, c, step } from "./brand.js";
import { approveCatalogVersion, catalogSelfTest, editCatalog, getCatalogVersion, listCatalogs, makeCatalogLive } from "./client.js";
import { editableFieldsOf, fieldOf } from "../core/catalog-edits.js";
import { forbiddenWords } from "../core/developer-words.js";
import { commandLine } from "../core/operations.js";
import {
  approvedWords, avoidWords, catalogStatusWords, catalogSummaryWords, FIX_OFFER, fixableByEditing, fixedWords, fixPlaceWords,
  madeLiveWords, nextCatalogStep, notFixedByEditing, selfTestSummary, wordFixesOf
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

/** One line of words from a person, with `now` already typed for them to change. Null once they stop (Ctrl-C, Ctrl-D). */
async function askWords(rl, question, now = "") {
  try {
    const answer = rl.question(ask(question));
    if (now) rl.write(now);
    return (await answer).trim();
  } catch {
    return null;
  }
}

const terminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** The command that changes one field, as `catalog fix` points to it when it cannot ask. */
const editLine = (version, fix) => commandLine("catalog-edit", null, [String(version), fix.module, fix.field, "\"<words>\""]);

/** What no edit fixes, if anything, in lines. */
function sayNotFixed(result) {
  const lines = notFixedByEditing(result);
  if (!lines.length) return;
  console.log("");
  for (const l of lines) console.log(c.prompt(`  ${l}`));
}

/**
 * Walk each field the self-test says to change, one at a time: its words now, the words
 * to leave out, and a line to change them in, already holding them. Enter on the words
 * as they are leaves the field and moves on. Each change is an ordinary edit, kept with
 * who and when. Returns the self-test as it stands at the end.
 */
async function fixWalk({ apiBaseUrl, version, say, first }) {
  let result = first || await catalogSelfTest({ apiBaseUrl, version });
  const fixes = wordFixesOf(result);
  let changed = 0;
  let kept = 0;
  if (fixes.length) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let stopped = false;
    rl.on("SIGINT", () => { stopped = true; rl.close(); });
    try {
      for (const [i, fix] of fixes.entries()) {
        console.log("");
        console.log(`${c.dim(fixPlaceWords(i + 1, fixes.length))}  ${c.accent(fix.module)}  ${c.fg(fix.label)}`);
        console.log(step(fix.text));
        console.log(c.prompt(`  ${avoidWords(fix)}`));
        let prefill = fix.text;
        let warned = null;
        for (;;) {
          const text = await askWords(rl, "New words (Enter leaves them):", prefill);
          if (text === null || stopped) { stopped = true; break; }
          if (text.replace(/\s+/g, " ") === fix.text.replace(/\s+/g, " ").trim()) { kept += 1; break; }
          if (!text && fix.field === "line") { say("A module's line cannot be empty: it is what a developer reads of it."); continue; }
          const still = forbiddenWords(text).map(w => w.term);
          if (still.length && warned !== text) {
            say(`That still says ${still.join(", ")}. Change it, or press Enter to keep it as written.`);
            prefill = text;
            warned = text;
            continue;
          }
          try {
            result = (await editCatalog({ apiBaseUrl, version, module: fix.module, field: fix.field, text })).selfTest;
            changed += 1;
            console.log(c.ok(`${fix.module}: ${fix.label} is changed`));
          } catch (err) {
            console.log(c.fail(err.message));
          }
          break;
        }
        if (stopped) break;
      }
    } finally {
      rl.close();
    }
    if (stopped) {
      console.log("");
      say("Stopped. What you changed is kept.");
    }
  }
  // Read again: a late answer may have rewritten the draft while the walk went.
  result = await catalogSelfTest({ apiBaseUrl, version });
  printSelfTest(result, say);
  say(fixedWords({ changed, kept }));
  if (!result.passed) {
    sayNotFixed(result);
    if (wordFixesOf(result).length) say(`${commandLine("catalog-fix", null, [String(version)])} goes through what is left.`);
  }
  return result;
}

/** A yes from a person at a terminal, to one [y/N] question. */
async function yes(question) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => rl.close());
  try {
    return (await askWords(rl, `${question} [y/N]`))?.toLowerCase() === "y";
  } finally {
    rl.close();
  }
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
    if (!result.passed) {
      process.exitCode = 1;
      sayNotFixed(result);
      if (wordFixesOf(result).length) {
        console.log("");
        say(`${commandLine("catalog-fix", null, [String(version)])} goes through each field to change, one at a time.`);
      }
    }
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
      if (err.code !== "SELF_TEST_FAILED" || !err.more?.selfTest) throw err;
      const refused = err.more.selfTest;
      printSelfTest(refused, say);
      console.log("");
      // Refused for words alone: the walk fixes them, then the approval is tried again,
      // behind the self-test as always. Anything else is said, and refused as it was.
      if (sub === "approve" && fixableByEditing(refused)) {
        console.log(c.fail(err.message));
        if (!terminal()) throw userError(`${commandLine("catalog-fix", null, [String(version)])} goes through each field to change.`);
        if (!(await yes(FIX_OFFER))) throw userError(`Not approved. ${commandLine("catalog-fix", null, [String(version)])} goes through them when you are ready.`);
        const walked = await fixWalk({ apiBaseUrl, version, say, first: refused });
        if (!walked.passed) throw userError(`Catalog ${version} is not approved: its self-test still fails.`);
        console.log("");
        done = await act({ apiBaseUrl, version });
      } else {
        sayNotFixed(refused);
        console.log("");
        throw userError(err.message);
      }
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

  if (sub === "fix") {
    const version = await versionFor({ apiBaseUrl, asked, verb: "fix" });
    const result = await catalogSelfTest({ apiBaseUrl, version });
    if (json) {
      console.log(JSON.stringify({ version, passed: result.passed, fixes: wordFixesOf(result), notFixedByEditing: notFixedByEditing(result) }, null, 2));
      if (!result.passed) process.exitCode = 1;
      return;
    }
    if (result.passed) {
      console.log("");
      console.log(c.ok(selfTestSummary(result)));
      say(`Nothing blocks its approval. ${nextLine("draft", version)} approves it.`);
      return;
    }
    const fixes = wordFixesOf(result);
    console.log("");
    say(fixes.length
      ? `Catalog ${version}: ${fixes.length === 1 ? "one field says" : `${fixes.length} fields say`} words a developer never reads.`
      : `Catalog ${version}: no edit fixes what blocks its approval.`);
    if (!terminal()) {
      // No one to ask: each field, and the command that changes it.
      for (const fix of fixes) {
        console.log(`  ${c.accent(fix.module)}  ${c.fg(fix.label)}  ${c.prompt(avoidWords(fix))}`);
        console.log(step(`  ${editLine(version, fix)}`));
      }
      sayNotFixed(result);
      process.exitCode = 1;
      return;
    }
    sayNotFixed(result);
    const walked = await fixWalk({ apiBaseUrl, version, say, first: result });
    if (!walked.passed) { process.exitCode = 1; return; }
    console.log("");
    if (!(await yes(`Approve catalog ${version} now?`))) return say(`${nextLine("draft", version)} approves it when you are ready.`);
    const done = await approveCatalogVersion({ apiBaseUrl, version });
    printSelfTest(done.selfTest, say);
    console.log("");
    console.log(c.ok(approvedWords(version)));
    say(`${nextLine("approved", version)} makes it live.`);
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
      // What can be changed, its words now, and which the self-test says to change.
      const failing = new Map();
      try {
        for (const fix of wordFixesOf(await catalogSelfTest({ apiBaseUrl, version }))) if (fix.module === module) failing.set(fix.field, fix);
      } catch { /* the words are still worth showing without the marks */ }
      console.log("");
      say(`${module} in catalog ${version}. Change one with ${commandLine("catalog-edit", null, [String(version), module, "<field>", "<words>"])}.`);
      console.log("");
      for (const f of editableFieldsOf(entry)) {
        const mark = entry.edited?.[f.field] ? c.dim(`  (edited by ${entry.edited[f.field].by})`) : "";
        const fails = failing.get(f.field);
        console.log(`${fails ? c.fail("✗") : " "} ${c.accent(f.field.padEnd(20))} ${c.dim(f.label.padEnd(26))} ${f.text || c.dim("(none)")}${mark}`);
        if (fails) console.log(c.prompt(`  ${"".padEnd(20)} ${"".padEnd(26)} ${avoidWords(fails)}`));
      }
      if (failing.size) {
        console.log("");
        say(`${commandLine("catalog-fix", null, [String(version)])} goes through each field to change, in every module.`);
      }
      return;
    }
    const where = fieldOf(field);
    if (!where) throw userError(`${field} is not something whose words can be changed: line, short-line, when, skip-line, guidance, or input:<name>.`);
    // --clear empties a field (not a line, which a module must have), as an empty box does on the page.
    const clearing = process.argv.includes("--clear");
    let text = clearing ? "" : rest.join(" ");
    if (!text && !clearing) {
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
    console.log(c.ok(clearing ? `${module}: ${where.label} is cleared` : `${module}: ${where.label} is now: ${text.replace(/\s+/g, " ").trim()}`));
    printSelfTest(done.selfTest, say);
    if (done.selfTest.passed) say(`${nextLine("draft", version)} approves it.`);
    return;
  }

  throw userError(`sealeye catalog takes versions, test, edit, fix, approve or live, not ${sub}.`);
}
