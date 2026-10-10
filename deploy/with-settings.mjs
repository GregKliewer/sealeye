// deploy/with-settings.mjs
// Run a one-off script on the server with the API's own settings (deploy/settings.mjs):
// its database, its keys, its deploy role. `deploy/server.sh import` runs the record
// importer this way.
//
//   node deploy/with-settings.mjs <script> [args...]
import path from "node:path";
import { pathToFileURL } from "node:url";

import { applyServerSettings } from "./settings.mjs";

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error("usage: node deploy/with-settings.mjs <script> [args...]");
  process.exit(1);
}
applyServerSettings({ quiet: true });
const resolved = path.resolve(script);
process.argv = [process.argv[0], resolved, ...args];
await import(pathToFileURL(resolved).href);
