// cli/store-offer.js
// Moving an app's settings over to the organization's store (PHASE2-PLAN Step 11, D5).
// Nothing moves by itself. When the folder's .env holds values the plan asks for:
//
// - those already in the store come from there, which `sealeye run` says once, in one
//   line, so editing .env is not mistaken for changing the deployed app;
// - for the rest, once per app and team on this machine, it offers to store them,
//   naming them and never showing a value. A no is remembered in
//   ~/.sealeye/store-offers.json and not asked again; `sealeye settings set NAME`
//   stores one any time.
//
// It asks nothing when it is not interactive (--answers, or no terminal). A store it
// cannot reach changes nothing: the deploy sends the .env values as before.
import fs from "node:fs";
import path from "node:path";

import { sealeyeHome } from "../core/config.js";
import { envValuesFor } from "../core/settings.js";
import { getSettings, putSetting } from "./client.js";

/**
 * @param {object} o
 * @param {string} o.apiBaseUrl
 * @param {object} o.plan
 * @param {string} o.appPath           the folder whose .env is read
 * @param {string} o.app               the app's name, as its environment is named
 * @param {boolean} o.interactive      whether a question may be asked
 * @param {(q: string) => Promise<string>} o.prompt
 * @param {(line: string) => void} o.say
 * @param {(line: string) => void} [o.done]
 * @param {(line: string) => void} [o.debug]
 * @returns {Promise<string[]>} the names the app now reads from the store
 */
export async function settingsFromTheStore({ apiBaseUrl, plan, appPath, app, interactive, prompt, say, done = say, debug = () => {} }) {
  const values = envValuesFor(plan, appPath);
  const names = Object.keys(values);
  if (!names.length) return [];

  let listed;
  try {
    listed = await getSettings({ apiBaseUrl, app });
  } catch (err) {
    debug(`could not ask the settings store: ${err.message}`);
    return [];
  }
  const stored = new Set(listed.settings.filter(x => x.set).map(x => x.name));
  const already = names.filter(n => stored.has(n));
  const missing = names.filter(n => !stored.has(n));

  const offers = path.join(sealeyeHome(), "store-offers.json");
  const key = `${apiBaseUrl} ${listed.team}/${listed.app}`;
  let declined = {};
  try { declined = JSON.parse(fs.readFileSync(offers, "utf8")) || {}; } catch {}

  if (missing.length && interactive && !declined[key]) {
    say(`Your .env has values for ${missing.join(", ")}.`);
    say("Your organization's settings store can keep them, encrypted, and your environment then reads them from there instead of from this .env with each deploy.");
    const reply = String(await prompt("Store them there? [y/N]")).trim().toLowerCase();
    if (reply === "y") {
      const storedNow = [];
      for (const name of missing) {
        try {
          await putSetting({ apiBaseUrl, app: listed.app, name, value: values[name] });
          storedNow.push(name);
          already.push(name);
        } catch (err) {
          // The rest still go with this deploy from .env, as before.
          say(`${name} could not be stored (${err.message}); it goes with this deploy from your .env.`);
        }
      }
      if (storedNow.length) done(`✓ Stored ${storedNow.join(", ")} for ${listed.app}, team ${listed.team}`);
    } else {
      declined[key] = new Date().toISOString();
      try {
        fs.mkdirSync(path.dirname(offers), { recursive: true });
        fs.writeFileSync(offers, JSON.stringify(declined, null, 2), { mode: 0o600 });
      } catch (err) {
        debug(`could not remember the answer: ${err.message}`);
      }
      say("Kept as before: they go with each deploy from your .env. sealeye settings set NAME stores one later.");
    }
  }

  if (already.length) {
    say(`Your environment reads ${already.join(", ")} from your organization's store, not from your .env. sealeye settings shows them.`);
  }
  return already;
}
