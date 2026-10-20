// scripts/gateway-key-id.js
// Prints the id of the key the API signs model calls with, or "none". The id is public:
// it is the first 16 hex characters of the SHA-256 of the key's public half. Run on the
// server through deploy/with-settings.mjs, so it reads the same settings the API does;
// deploy/gateway.sh compares it with the key set the gateway checks tokens against.
import { signerFromSettings } from "../api/gateway-token.js";

try {
  console.log(signerFromSettings()?.kid || "none");
} catch {
  console.log("unreadable");
}
