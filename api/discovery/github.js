// api/discovery/github.js
// How the API reads a platform library on GitHub (PHASE4-PLAN Step 5, D3): one commit of
// a named repository, fetched as an archive over GitHub's API, read-only. The model
// never chooses what is read, and nothing here can write to GitHub.
//
// Two ways in, both Greg's choice (Oct 15, 2026; DESIGN.md, "Reading the library"):
//
// - A GitHub App the organization installs on its library repositories
//   (SEALEYE_GITHUB_APP_ID and SEALEYE_GITHUB_APP_KEY, the app's private key). Each read
//   asks for a token that lasts an hour, narrowed to the one repository and to reading
//   its contents. This is the way an organization's own library is read.
// - A fine-grained personal token, read-only on the named repositories
//   (SEALEYE_GITHUB_READ_TOKEN). The pilot's way in until an app is installed.
//
// When both are set the app is used. No token, key or signed request is ever logged,
// put on a record or put in an error: errors name the repository and GitHub's status.
import crypto from "node:crypto";

import { setting, settingName } from "../../core/config.js";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "sealeye-discovery";
const TIMEOUT_MS = 60_000;

// What a repository and a ref may look like, by GitHub's own rules, before either is
// put in a URL.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._\/-]{1,200}$/;
const SHA = /^[0-9a-f]{40}$/;

/** The library could not be read, said in a sentence; never holds a credential. */
export class LibraryUnreadable extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "LibraryUnreadable";
    if (status) this.status = status;
  }
}

/**
 * The repositories the platform team named (SEALEYE_LIBRARY_REPOS): "owner/repo",
 * optionally "@ref" for a branch, tag or commit, separated by commas or spaces. Until
 * admin onboarding (PHASE4-PLAN, "Owed"), this setting is how they are named.
 *
 * @returns {{ owner: string, repo: string, ref: string|null }[]}
 * @throws Error naming the entry that is not a repository
 */
export function libraryRepos(value = setting("LIBRARY_REPOS")) {
  if (!value) return [];
  return String(value)
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(entry => {
      const parsed = parseRepo(entry);
      if (!parsed) throw new Error(`${settingName("LIBRARY_REPOS")} has ${JSON.stringify(entry)}, which is not owner/repo or owner/repo@ref`);
      return parsed;
    });
}

/** "owner/repo" or "owner/repo@ref", or null. */
export function parseRepo(entry) {
  const m = String(entry).match(/^([^/@]+)\/([^/@]+)(?:@(.+))?$/);
  if (!m || !OWNER.test(m[1]) || !REPO.test(m[2]) || /^\.+$/.test(m[2])) return null;
  if (m[3] !== undefined && !REF.test(m[3])) return null;
  return { owner: m[1], repo: m[2], ref: m[3] ?? null };
}

/** owner/repo, for messages. */
export const repoName = ({ owner, repo }) => `${owner}/${repo}`;

/** A private key from a setting: PEM as it is, or with its line breaks written as \n. */
function readKey(value) {
  const pem = String(value).includes("\\n") && !String(value).includes("\n") ? String(value).replace(/\\n/g, "\n") : String(value);
  try {
    return crypto.createPrivateKey(pem);
  } catch {
    throw new LibraryUnreadable(`${settingName("GITHUB_APP_KEY")} is not a private key seaLeye can read`);
  }
}

const b64url = data => Buffer.from(data).toString("base64url");

/** The app's own signed statement that it is the app, for ten minutes at most. */
export function appJwt(appId, key, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;   // GitHub's advice: allow for clock drift
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) }));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

/**
 * Which way in this API has, from its settings. Null when it has none.
 *
 * @returns {{ kind: "app", appId: string, key: crypto.KeyObject } | { kind: "token", token: string } | null}
 */
export function githubCredential() {
  const appId = setting("GITHUB_APP_ID");
  const appKey = setting("GITHUB_APP_KEY");
  if (appId || appKey) {
    if (!appId || !appKey) {
      throw new LibraryUnreadable(`${settingName(appId ? "GITHUB_APP_KEY" : "GITHUB_APP_ID")} is not set, so the GitHub App cannot be used`);
    }
    if (!/^(?:\d{1,12}|Iv[0-9A-Za-z.]{4,40})$/.test(appId)) throw new LibraryUnreadable(`${settingName("GITHUB_APP_ID")} is not a GitHub App's id`);
    return { kind: "app", appId, key: readKey(appKey) };
  }
  const token = setting("GITHUB_READ_TOKEN");
  if (token) return { kind: "token", token };
  return null;
}

/**
 * A reader for one repository: the token it reads with, and the two reads discovery
 * makes. `fetch` is handed in so tests can stand in for GitHub.
 */
export async function githubReader(target, { credential = githubCredential(), fetch = globalThis.fetch, now = Date.now } = {}) {
  const name = repoName(target);
  if (!credential) {
    throw new LibraryUnreadable(`seaLeye has no way to read ${name}: set ${settingName("GITHUB_APP_ID")} and ${settingName("GITHUB_APP_KEY")} for the GitHub App, or ${settingName("GITHUB_READ_TOKEN")} for a read-only token`);
  }
  const call = async (path, { bearer, method = "GET", body, accept = "application/vnd.github+json", redirect = "follow" } = {}) => {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        redirect,
        headers: {
          accept,
          authorization: `Bearer ${bearer}`,
          "x-github-api-version": API_VERSION,
          "user-agent": USER_AGENT,
          ...(body ? { "content-type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch {
      throw new LibraryUnreadable(`seaLeye could not reach GitHub to read ${name}`);
    }
    return res;
  };
  // A body read as JSON, or a plain refusal: a parse error would quote the body, which
  // for the token request is the token.
  const jsonOf = async (res, what) => {
    try {
      return await res.json();
    } catch {
      throw new LibraryUnreadable(`seaLeye could not ${what} ${name}: GitHub's answer was not what it expected`);
    }
  };
  const refused = (res, what) => {
    const why = res.status === 401 ? "the credential seaLeye reads with was not accepted"
      : res.status === 403 ? "GitHub refused it, or its rate limit was reached"
      : res.status === 404 ? "the repository is not there, or the credential cannot see it"
      : res.status === 422 ? "GitHub could not read what was asked for"
      : `GitHub answered ${res.status}`;
    return new LibraryUnreadable(`seaLeye could not ${what} ${name}: ${why}`, { status: res.status });
  };

  let token = credential.token;
  if (credential.kind === "app") {
    const jwt = appJwt(credential.appId, credential.key, now());
    const found = await call(`/repos/${target.owner}/${target.repo}/installation`, { bearer: jwt });
    if (!found.ok) throw refused(found, "find the GitHub App's installation on");
    const { id } = await jsonOf(found, "find the GitHub App's installation on");
    if (!Number.isSafeInteger(id)) throw new LibraryUnreadable(`seaLeye could not find the GitHub App's installation on ${name}`);
    // Narrowed to the one repository, and to reading it.
    const issued = await call(`/app/installations/${id}/access_tokens`, {
      bearer: jwt,
      method: "POST",
      body: { repositories: [target.repo], permissions: { contents: "read" } }
    });
    if (!issued.ok) throw refused(issued, "get a token from the GitHub App to read");
    token = (await jsonOf(issued, "get a token from the GitHub App to read")).token;
    if (typeof token !== "string" || !token) throw new LibraryUnreadable(`seaLeye could not get a token from the GitHub App to read ${name}`);
  }

  return {
    via: credential.kind,

    /**
     * Done reading: an app's token is revoked at once rather than left live for its
     * hour. Best effort; a personal token is the platform team's and is left alone.
     */
    async close() {
      if (credential.kind !== "app") return;
      try {
        await call("/installation/token", { bearer: token, method: "DELETE" });
      } catch {}
    },

    /** The full commit a ref names now, or the default branch's when there is none. */
    async commitOf(ref) {
      let wanted = ref;
      if (!wanted) {
        const res = await call(`/repos/${target.owner}/${target.repo}`, { bearer: token });
        if (!res.ok) throw refused(res, "read");
        wanted = (await jsonOf(res, "read")).default_branch;
        if (typeof wanted !== "string" || !REF.test(wanted)) throw new LibraryUnreadable(`seaLeye could not find ${name}'s default branch`);
      }
      // Each segment encoded and the slashes kept, as a branch like release/2026 is written.
      const res = await call(`/repos/${target.owner}/${target.repo}/commits/${wanted.split("/").map(encodeURIComponent).join("/")}`, { bearer: token, accept: "application/vnd.github.sha" });
      if (!res.ok) throw refused(res, `find ${JSON.stringify(wanted)} in`);
      const sha = (await res.text()).trim();
      if (!SHA.test(sha)) throw new LibraryUnreadable(`seaLeye could not find ${JSON.stringify(wanted)} in ${name}`);
      return sha;
    },

    /**
     * One commit as a gzipped tar, at most `maxBytes` of it. GitHub answers with a link
     * to a download that carries its own short-lived permission, which is fetched
     * without the token: the credential goes to api.github.com and nowhere else.
     */
    async archive(sha, { maxBytes }) {
      if (!SHA.test(sha)) throw new LibraryUnreadable(`seaLeye reads a library at a full commit, not ${JSON.stringify(sha)}`);
      const res = await call(`/repos/${target.owner}/${target.repo}/tarball/${sha}`, { bearer: token, redirect: "manual" });
      let download = res;
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        let url;
        try {
          url = new URL(location);
        } catch {
          throw new LibraryUnreadable(`seaLeye could not download ${name}: GitHub gave no download link`);
        }
        if (url.protocol !== "https:" || url.hostname !== "codeload.github.com") {
          throw new LibraryUnreadable(`seaLeye could not download ${name}: GitHub's download link is not GitHub's`);
        }
        try {
          download = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS * 5) });
        } catch {
          throw new LibraryUnreadable(`seaLeye could not download ${name}`);
        }
      }
      if (!download.ok) throw refused(download, "download");
      return readCapped(download, maxBytes, name);
    }
  };
}

/** A response's body, refused as soon as it passes `maxBytes`. */
async function readCapped(res, maxBytes, name) {
  const stated = Number(res.headers.get("content-length"));
  if (stated > maxBytes) throw new LibraryUnreadable(`${name} is bigger than discovery reads`);
  const chunks = [];
  let total = 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new LibraryUnreadable(`${name} is bigger than discovery reads`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
