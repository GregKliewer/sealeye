// deploy/start.mjs
// How the API starts on the server: its settings first (deploy/settings.mjs), then the
// API itself.
import { applyServerSettings } from "./settings.mjs";

applyServerSettings();
await import("../api/server.js");
