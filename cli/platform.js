// cli/platform.js
// `sealeye platform` (PHASE4-PLAN Step 9; DESIGN.md, "An organization's platform values"):
// what only the platform team can give a module, by stage, such as the subnets and the
// permissions boundary an environment is built with. A platform engineer's, with an
// organization-wide token, as discovery is; the Platform page on seaLeye.online does the
// same and says the same.
//
//   sealeye platform [--stage <stage>]              the values, and what each module still needs
//   sealeye platform set <name> <word> [<word>...]  set one: one word, or several for a list
//                    [--list] [--stage <stage>]     (--list keeps a single word a list)
//   sealeye platform unset <name> [--stage <stage>] remove one
//
// A name is an input's (subnet_ids), or a module's id, a dot and the input
// (postgres.security_group_ids), which fills only that module's.
import { c, step } from "./brand.js";
import { getPlatform, removePlatformValue, setPlatformValue } from "./client.js";
import { commandLine } from "../core/operations.js";
import { withVersion } from "../core/discovery-words.js";

const userError = message => Object.assign(new Error(message), { userFacing: true });

const shown = value => (Array.isArray(value) ? value.join(", ") : String(value));

/** The values at a stage, and each Terraform module's inputs only the platform gives. */
export function printPlatform(body, say) {
  say(`Platform values for ${body.stage}${body.stage === body.developerStage ? ", the stage developers' environments are built as" : ""}:`);
  if (!body.values.length) console.log(step("none yet"));
  for (const v of body.values) console.log(`  ${c.accent(v.name)}  ${shown(v.value)}${v.setBy ? c.dim(`  (${v.setBy}, ${v.setAt?.slice(0, 10)})`) : ""}`);
  if (!body.wanted?.length) return;
  console.log("");
  say(`What each module in catalog ${body.catalog?.version} still needs from the platform:`);
  for (const w of body.wanted) {
    const named = withVersion(w.module, w.version);
    console.log(`  ${w.builds ? c.ok(named) : c.prompt(named)}${w.builds ? c.dim("  built") : c.dim(`  not built: ${w.why}`)}`);
    for (const i of w.inputs) {
      const fill = i.filledBy ? c.dim(`from ${i.filledBy}`) : i.required ? c.prompt("no value") : c.dim("no value, optional");
      console.log(`      ${i.input}  ${fill}`);
    }
  }
  // The value a module waits on and nothing else, first: setting it builds the module.
  const waiting = body.wanted.filter(w => !w.builds && /^the platform has no value/.test(w.why || ""));
  const missing = (waiting.length ? waiting : body.wanted).flatMap(w => w.inputs.filter(i => i.required && !i.filledBy).map(i => i.input));
  if (missing.length) {
    console.log("");
    console.log(step(`Set one with: ${commandLine("platform", null, ["set", missing[0], "<value>"])}`));
  }
}

/**
 * @param {object} p
 * @param {string} p.apiBaseUrl
 * @param {string[]} p.args   the words after `platform`, flags taken out
 * @param {string|null} p.stage
 * @param {boolean} p.list    --list: keep a single word a list
 */
export async function platform({ apiBaseUrl, args, stage = null, list = false, say, json = false }) {
  const [sub, name, ...words] = args;
  if (!sub) {
    const body = await getPlatform({ apiBaseUrl, stage });
    if (json) return console.log(JSON.stringify(body, null, 2));
    return printPlatform(body, say);
  }
  if (sub === "set") {
    if (!name || !words.length) throw userError(`Name the value and give it: ${commandLine("platform", null, ["set", "<name>", "<word>", "[<word> ...]"])}`);
    const value = words.length > 1 || list ? words : words[0];
    const kept = await setPlatformValue({ apiBaseUrl, name, value, stage });
    if (json) return console.log(JSON.stringify(kept, null, 2));
    return say(`${kept.name} is set for ${kept.stage}${kept.organization ? ` in ${kept.organization}` : ""}: ${shown(kept.value)}.`);
  }
  if (sub === "unset") {
    if (!name) throw userError(`Name the value to remove: ${commandLine("platform", null, ["unset", "<name>"])}`);
    const removed = await removePlatformValue({ apiBaseUrl, name, stage });
    if (json) return console.log(JSON.stringify(removed, null, 2));
    const where = removed.organization ? ` in ${removed.organization}` : "";
    return say(removed.removed ? `${removed.name} is removed for ${removed.stage}${where}.` : `${removed.name} was not set for ${removed.stage}${where}, so nothing changed.`);
  }
  throw userError(`sealeye platform takes set or unset, or nothing to list the values, not ${sub}.`);
}
