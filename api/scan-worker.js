// api/scan-worker.js
// The shared rules over a folder, in a worker thread (api/secret-scan.js). The rules
// are linear, but a crafted upload can still take seconds to read, and the API is one
// process: off its event loop, a slow scan holds up only the request that sent it.
// Posts back file, line, rule and kind for each finding; never a value.
import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { scanText } from "../core/scan.js";

const found = [];
const walk = (abs, rel) => {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const childAbs = path.join(abs, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(childAbs, childRel);
    else if (entry.isFile()) {
      const data = fs.readFileSync(childAbs);
      found.push(...scanText(childRel, new Uint8Array(data.buffer, data.byteOffset, data.length)));
    }
  }
};
walk(workerData.root, "");
// Files read from elsewhere under their own name (a .gitleaksignore, kept from gitleaks).
for (const { abs, rel } of workerData.extra || []) {
  const data = fs.readFileSync(abs);
  found.push(...scanText(rel, new Uint8Array(data.buffer, data.byteOffset, data.length)));
}
parentPort.postMessage(found);
