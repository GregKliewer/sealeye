// scripts/library-check.js
// Read each platform library the server names (SEALEYE_LIBRARY_REPOS) as discovery's first
// node will (PHASE4-PLAN Step 5, api/discovery/library.js), and say what was read. No
// model is called and nothing is kept: the snapshot is removed before this ends.
//
// Run on the server by `deploy/server.sh library-check`, or locally with the same
// settings in the repo's .env. What it prints is the repository, the commit, how it was
// read, counts, the secret files held back by name, and each finding as file, line and
// rule: never a value, never a token.
import { libraryRepos, repoName } from "../api/discovery/github.js";
import { readLibrary } from "../api/discovery/library.js";

let repos;
try {
  repos = libraryRepos();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (!repos.length) {
  console.error("No library is named. Set SEALEYE_LIBRARY_REPOS to owner/repo, or several separated by commas.");
  process.exit(1);
}

let failed = false;
for (const target of repos) {
  const name = repoName(target);
  try {
    const s = await readLibrary(target);
    try {
      console.log(`${name} at ${s.commit} (read with the ${s.via === "app" ? "GitHub App" : "read-only token"})`);
      console.log(`  ${s.files} files read; gitleaks ${s.gitleaks}`);
      console.log(`  held back as names only: ${s.secretFiles.length ? s.secretFiles.join(", ") : "none"}`);
      if (!s.findings.length) console.log("  nothing that looks like a secret");
      for (const f of s.findings) console.log(`  ${f.whole ? "file emptied" : "line replaced"}: ${f.file}:${f.line} (${f.rule})`);
    } finally {
      s.remove();
    }
  } catch (err) {
    failed = true;
    console.log(`${name}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
