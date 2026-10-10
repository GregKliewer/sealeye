// core/secrets.js
// Which files hold secret values (principle 6). Both sides need the same answer: the
// interview's read_file refuses them (api/), and the CLI leaves their contents out of
// the folder it uploads, so they never leave the developer's machine (cli/).
import path from "node:path";

// Files that hold secret values. list_files still shows their names, because knowing a
// .env exists tells the model the app reads settings, but read_file never returns their
// contents (principle 6). Matched on the file's own name, case-insensitively, since
// macOS and Windows folders treat .ENV and .env as the same file.
const ENV_EXAMPLES = new Set([".env.example", ".env.sample"]);
// Widened on Oct 10, 2026, when the whole folder began to travel to the API rather
// than only the files the model chose to read (DESIGN.md, "The interview runs in the
// API"): the usual homes of tokens and passwords for git, package managers, databases,
// Docker, Terraform and cloud service accounts.
const CREDENTIAL_NAMES = new Set([
  ".npmrc", "credentials", ".envrc",
  ".netrc", "_netrc", ".git-credentials", ".pgpass", ".yarnrc.yml", ".pypirc", ".dockercfg"
]);
const CREDENTIAL_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".tfvars", ".tfstate", ".tfstate.backup"];
// GCP and similar service-account keys are JSON files named for what they are.
const CREDENTIAL_PATTERNS = [/service[-_]?account.*\.json$/, /^gcp[-_].*key.*\.json$/];
const SSH_KEY_PREFIXES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

/**
 * Why a file name may not be read, or null when it may. The reason is written for the
 * model: it says what to read instead.
 */
export function secretFileReason(fileName) {
  const name = path.basename(fileName).toLowerCase();
  if (ENV_EXAMPLES.has(name)) return null;
  if (name === ".env" || name.startsWith(".env.")) {
    return `${path.basename(fileName)} holds secret values; read .env.example instead, if there is one`;
  }
  if (
    CREDENTIAL_NAMES.has(name) ||
    CREDENTIAL_EXTENSIONS.some(ext => name.endsWith(ext)) ||
    CREDENTIAL_PATTERNS.some(pattern => pattern.test(name)) ||
    SSH_KEY_PREFIXES.some(prefix => name.startsWith(prefix))
  ) {
    return `${path.basename(fileName)} is a credential file; its contents are never read`;
  }
  return null;
}
