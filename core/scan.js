// core/scan.js
// The secret scanner's shared rules (PHASE3-PLAN Step 2, D3): a value written into an
// app's code, not only a secret file, never reaches the model, a trace or a deploy.
// core/secrets.js decides by a file's name; this decides by what is in it.
//
// It imports nothing, so the command, the API and seaLeye.online's browser upload run
// the same rules (core/upload-rules.js calls it during the one walk both surfaces use).
// The API scans again what arrives, with these rules and with gitleaks
// (api/secret-scan.js), because it cannot trust the client that sent it.
//
// High confidence over coverage: a false finding stops a developer's deploy (D4), so
// every rule here is one that is almost never wrong. gitleaks, in the API, is the wider
// net. A finding is a file, a line, a rule and a kind in words, and never the value: no
// function here returns, logs or keeps what it matched.

export const ALLOW_FILE = ".sealeye-allow";

// Every byte of every file that travels is scanned, however big: the rules are linear,
// and an upload is capped (core/upload-rules.js). A key at the end of a large bundle is
// still a key (found in review: a cap here and in gitleaks let an 11 MB file through).

// The shapes of keys are matched token by token: the line is cut into runs of the
// characters a key can hold, and each run is matched whole against an anchored pattern
// with bounded parts. No pattern can then backtrack across the line: a review found a
// line of repeated "sk-" made an unanchored rule take minutes.
const TOKEN_CLASSES = {
  word: /[A-Za-z0-9_]+/g,       // gh..._, github_pat_, sk_live_, npm_
  dash: /[A-Za-z0-9_-]+/g,      // glpat-, xoxb-, sk-ant-, sk-...T3BlbkFJ, AIza
  dot: /[A-Za-z0-9_.-]+/g       // SG.x.y
};
const MAX_TOKEN = 512;

/** Does any token of this class match `pattern` (anchored at both ends)? Linear in the line. */
function anyToken(line, cls, pattern) {
  const re = TOKEN_CLASSES[cls];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[0].length <= MAX_TOKEN && pattern.test(m[0])) return true;
  }
  return false;
}

/**
 * Each rule: an id (stable; it is what .sealeye-allow and evidence name), the kind of
 * value in words a developer reads (no cloud provider's terms, principle 8), and a test
 * of one line. Every test is linear in the line.
 */
export const RULES = [
  {
    id: "private-key",
    kind: "a private key",
    test: line => line.includes("PRIVATE KEY") && /-----BEGIN (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----/.test(line)
  },
  {
    // Access key ids for long-lived users and temporary sessions. The secret half has
    // no shape of its own; the assignment rule below finds it by its name.
    id: "cloud-access-key",
    kind: "a cloud access key",
    test: line => anyToken(line, "word", /^(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}$/)
  },
  {
    id: "github-token",
    kind: "a GitHub token",
    test: line => anyToken(line, "word", /^(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{80,255})$/)
  },
  {
    id: "gitlab-token",
    kind: "a GitLab token",
    test: line => anyToken(line, "dash", /^glpat-[A-Za-z0-9_-]{20,255}$/)
  },
  {
    id: "slack-token",
    kind: "a Slack token",
    test: line => anyToken(line, "dash", /^xox[abposr]-[A-Za-z0-9-]{10,255}$/) ||
      (line.includes("hooks.slack.com") && /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{1,32}\/B[A-Z0-9]{1,32}\/[A-Za-z0-9]{20,64}/.test(line))
  },
  {
    // Secret and restricted keys; publishable keys (pk_) are meant to be public.
    id: "stripe-key",
    kind: "a Stripe key",
    test: line => anyToken(line, "word", /^[sr]k_(?:live|test)_[A-Za-z0-9]{20,255}$/)
  },
  {
    id: "anthropic-key",
    kind: "an Anthropic key",
    test: line => anyToken(line, "dash", /^sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{40,255}$/)
  },
  {
    // OpenAI's keys carry this marker in the middle, which is what makes the rule sure.
    id: "openai-key",
    kind: "an OpenAI key",
    test: line => line.includes("T3BlbkFJ") && anyToken(line, "dash", /^sk-[A-Za-z0-9_-]{8,200}T3BlbkFJ[A-Za-z0-9_-]{8,200}$/)
  },
  {
    id: "google-api-key",
    kind: "a Google API key",
    test: line => anyToken(line, "dash", /^AIza[0-9A-Za-z_-]{35}$/)
  },
  {
    id: "npm-token",
    kind: "an npm token",
    test: line => anyToken(line, "word", /^npm_[A-Za-z0-9]{36}$/)
  },
  {
    id: "sendgrid-key",
    kind: "a SendGrid key",
    test: line => anyToken(line, "dot", /^SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
  },
  {
    id: "url-password",
    kind: "a password in a connection address",
    inText: true,
    test: line => urlPassword(line)
  },
  {
    // A long, random-looking value given to a name that says it is a secret:
    //   password = "...", API_KEY: ..., "clientSecret": "...", DB_PASSWORD=...
    id: "assigned-secret",
    kind: "a password or token",
    inText: true,
    test: line => assignedSecret(line)
  }
];

const RULE_IDS = new Set(RULES.map(r => r.id));

// The name has to END in what says secret, so tokenUrl, passwordField and
// secretsManagerRegion are not taken for one: right after the word comes a quote, a
// bracket, a space or the assignment itself. Found in two steps, each linear in the
// line, so no line, however long or strange, can make the scan slow: a regex that let
// the name start anywhere took seconds on a crafted 40 KB line (found in review).
const ASSIGNED = /(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key)["'\]]{0,2}[ \t]{0,8}(?::=|=>|=|:)[ \t]{0,8}/gi;
const MAX_VALUE = 200;

// Values that are obviously not a real secret: a placeholder, a reference to one kept
// elsewhere, or a word a template leaves for the developer to fill in.
const PLACEHOLDER = /example|placeholder|changeme|change_me|change-me|your[_-]|xxxx|redacted|dummy|sample|<[^>]*>|\$\{|\{\{|%\(|process\.env|os\.environ|getenv|env\(|import\.meta|secretsmanager|ssm:|arn:/i;
// What a value may hold: any visible character but a quote. Passwords have symbols.
const VALUE_CHARS = /^[\x21-\x7e]+$/;
const UNQUOTED_END = new Set([" ", "\t", '"', "'", "`", ",", ";", ")", "}", "]", "&"]);
// A bare value is an .env's or a YAML file's: no brackets or other code around it.
const BARE_CHARS = /^[A-Za-z0-9+/=_.~:!@#$%^*-]+$/;

/** The value that starts at `at`: quoted, up to its closing quote, or bare, up to a space or punctuation. */
function valueAt(line, at) {
  const q = line[at];
  if (q === '"' || q === "'" || q === "`") {
    const close = line.indexOf(q, at + 1);
    if (close === -1 || close - at - 1 > MAX_VALUE) return null;
    return { value: line.slice(at + 1, close), quoted: true, next: line[close + 1] };
  }
  let end = at;
  while (end < line.length && end - at <= MAX_VALUE && !UNQUOTED_END.has(line[end])) end++;
  if (end - at > MAX_VALUE) return null;
  return { value: line.slice(at, end), quoted: false, next: line[end] };
}

/** The name the assignment is to, read back from where the secret word ends. */
function nameBefore(line, end) {
  let start = end;
  while (start > 0 && end - start < 100 && /[A-Za-z0-9_.-]/.test(line[start - 1])) start--;
  return line.slice(start, end);
}

/** Bits of entropy per character: random keys sit near 4 and above, words and names lower. */
function entropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assignedSecret(line) {
  // Documentation of what a value looks like, and resource names, are not values.
  if (/@example|\barn:aws/.test(line)) return false;
  ASSIGNED.lastIndex = 0;
  let m;
  while ((m = ASSIGNED.exec(line)) !== null) {
    const nameEnd = m.index + m[0].search(/["'\]\s:=]/);
    const name = nameBefore(line, nameEnd);
    const read = valueAt(line, m.index + m[0].length);
    if (!read) continue;
    const { value, quoted, next } = read;
    if (value.length < 16 || !VALUE_CHARS.test(value)) continue;
    if (PLACEHOLDER.test(value)) continue;
    // Percent-encoded is a fragment of an address or a query, not a value of its own.
    if (/%[0-9A-Fa-f]{2}/.test(value)) continue;
    // Unquoted and followed by `;`, `,` or a bracket is code naming another thing
    // (`x = otherThing;`, `secretKey: SomeType;`, `f(password=PASSWORD_VAR,`);
    // unquoted values are an .env's or a YAML file's, which end the line instead. A
    // bare value starting with $ is a shell variable.
    if (!quoted && (/[;,)}\]]/.test(next || "") || value.startsWith("$") || !BARE_CHARS.test(value))) continue;
    if (value.toLowerCase() === name.toLowerCase()) continue;
    // Something.like.this or a path is a reference in code, not a value.
    if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value)) continue;
    if (/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(value) || /\/[^/]*\.[a-z]{1,5}$/i.test(value)) continue;
    // An id, not a secret: a UUID is how most systems name a thing.
    if (UUID.test(value)) continue;
    // Random keys and real passwords of this length almost always have a digit; names
    // and words do not.
    if (!/[0-9]/.test(value)) continue;
    const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(value)).length;
    if (kinds < 2) continue;
    if (entropy(value) < 3.5) continue;
    return true;
  }
  return false;
}

// A password in a connection address: postgres://user:password@db.example.com. Bounded
// at every step, so linear in the line. Local development addresses, a password that
// is the user's name or a common default, and a host with no dot (a compose service
// such as db) are not taken for one.
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:@\/"'`]{1,64}):([^\s@\/"'`]{8,128})@([A-Za-z0-9.-]{1,253})/gi;
const DEFAULT_PASSWORDS = /^(?:password|passw0rd|postgres|root|admin|secret|changeme|pass|test|guest|example|mysql|redis)\d*$/i;

function urlPassword(line) {
  URL_PASSWORD.lastIndex = 0;
  let m;
  while ((m = URL_PASSWORD.exec(line)) !== null) {
    const [, user, password, host] = m;
    if (!host.includes(".") || /^(?:127\.|0\.0\.0\.0|localhost)/i.test(host) || host === "host.docker.internal") continue;
    if (password === user || DEFAULT_PASSWORDS.test(password) || PLACEHOLDER.test(password) || password.startsWith("$")) continue;
    if ([/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(password)).length < 2) continue;
    if (entropy(password) < 3) continue;
    return true;
  }
  return false;
}

/** A NUL byte near the start: a compiled or binary file, not text. */
export function looksBinary(bytes) {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Scan one file's contents. Returns its findings, in line order, one per rule per line:
 * { file, line, rule, kind }. Never the value.
 *
 * @param {string} file          the path inside the app folder, "/"-separated
 * @param {Uint8Array|string} contents
 */
export function scanText(file, contents) {
  // A binary file is scanned too: a NUL byte near the start must not hide a key further
  // on (found in review). Only for the shapes of keys, though: the rules that read a
  // name and a value (inText) are for text, and in compiled files they mistake
  // fragments for values. The interview never reads a binary file (api/interview/tools.js).
  const bytes = typeof contents === "string" ? null : contents instanceof Uint8Array ? contents : new Uint8Array(contents || []);
  const binary = bytes ? looksBinary(bytes) : false;
  const text = bytes ? decoder.decode(bytes) : contents;
  const rules = binary ? RULES.filter(r => !r.inText) : RULES;

  const findings = [];
  // Lines end at \n, as gitleaks counts them, so both scanners name the same line.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 16) continue;
    for (const rule of rules) {
      if (rule.test(line)) findings.push({ file, line: i + 1, rule: rule.id, kind: rule.kind });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------
// .sealeye-allow: the developer's own word that a line is not a secret (D4). One entry
// per line, `file:line:rule`, the same shape the refusal tells them to add; `#` starts a
// comment. A line is allowed for every rule on it, so the shared rules and gitleaks,
// which name the same value differently, agree.

/**
 * Parse an allow file. Lines that are not `file:line:rule` are ignored and counted, so
 * a typo allows nothing rather than everything.
 *
 * @returns {{ entries: {file, line, rule}[], ignored: number }}
 */
export function parseAllowFile(text) {
  const entries = [];
  let ignored = 0;
  for (const raw of String(text || "").split(/\r\n|\n|\r/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^(.+):(\d+):([A-Za-z0-9_.-]+)$/.exec(line);
    if (!m || m[1].includes("..") || m[1].startsWith("/")) {
      ignored++;
      continue;
    }
    entries.push({ file: m[1].replace(/^\.\//, ""), line: Number(m[2]), rule: m[3] });
  }
  return { entries, ignored };
}

/**
 * Split findings into those that stand and those the allow file excuses.
 *
 * @returns {{ found: object[], allowed: object[] }}
 */
export function applyAllow(findings, allowEntries = []) {
  const allowedLines = new Set(allowEntries.map(e => `${e.file}\n${e.line}`));
  const found = [];
  const allowed = [];
  for (const f of findings) (allowedLines.has(`${f.file}\n${f.line}`) ? allowed : found).push(f);
  return { found, allowed };
}

/** One finding per file, line and rule, in file then line order. */
export function uniqueFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.file}\n${f.line}\n${f.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/**
 * One finding per file and line, for a person to read: the shared rules and gitleaks
 * often name the same value, and the allow file excuses a line, not a rule. The shared
 * rule's name is kept where both found it, so the words match what the developer's own
 * machine said.
 */
export function onePerLine(findings) {
  const byLine = new Map();
  for (const f of uniqueFindings(findings)) {
    const key = `${f.file}\n${f.line}`;
    const had = byLine.get(key);
    if (!had || (!RULE_IDS.has(had.rule) && RULE_IDS.has(f.rule))) byLine.set(key, f);
  }
  return uniqueFindings([...byLine.values()]);
}

/**
 * A finding as it may travel to the API or be stored on a record: only these four
 * fields, each checked. Anything else, from a client the API cannot trust, is dropped.
 */
export function cleanFinding(f) {
  if (!f || typeof f !== "object") return null;
  const file = typeof f.file === "string" ? f.file : "";
  if (!file || file.length > 500 || file.includes("..") || file.startsWith("/") || /[\0-\x1f\\]/.test(file)) return null;
  const line = Number(f.line);
  if (!Number.isInteger(line) || line < 1 || line > 10_000_000) return null;
  const rule = typeof f.rule === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(f.rule) ? f.rule : null;
  if (!rule) return null;
  return { file, line, rule, kind: kindOf(rule) };
}

// gitleaks' rule ids, for the kinds a developer reads. Anything else is "a secret".
const GITLEAKS_KINDS = [
  [/private-key/, "a private key"],
  [/^aws/, "a cloud access key"],
  [/^github/, "a GitHub token"],
  [/^gitlab/, "a GitLab token"],
  [/^slack/, "a Slack token"],
  [/^stripe/, "a Stripe key"],
  [/^anthropic/, "an Anthropic key"],
  [/^openai/, "an OpenAI key"],
  [/^gcp|^google/, "a Google key"],
  [/^npm/, "an npm token"],
  [/^sendgrid/, "a SendGrid key"],
  [/^jwt/, "a signed token"],
  [/password/, "a password"]
];

/** The kind of value a rule finds, in words, for this scanner's rules and gitleaks'. */
export function kindOf(rule) {
  const own = RULES.find(r => r.id === rule);
  if (own) return own.kind;
  for (const [pattern, kind] of GITLEAKS_KINDS) if (pattern.test(rule)) return kind;
  return "a secret";
}

// ---------------------------------------------------------------------------------
// The words. Both surfaces say exactly these (PHASE3-PLAN Step 2: "the words live in
// core/ so both surfaces say the same thing"). No value, ever: a file, a line and a kind.

/** "config.js, line 12, looks like it holds a cloud access key." */
export function findingSentence(f) {
  return `${f.file}, line ${f.line}, looks like it holds ${f.kind || kindOf(f.rule)}.`;
}

/** The line a developer adds to .sealeye-allow when a finding is not a secret. */
export const allowLine = f => `${f.file}:${f.line}:${f.rule}`;

/** What an interview did with files that hold something like a secret. */
export function interviewFindingWords(findings) {
  if (!findings.length) return [];
  const whole = [...new Set(findings.filter(f => f.whole).map(f => f.file))];
  const partly = findings.some(f => !f.whole);
  return [
    ...findings.map(findingSentence),
    ...(partly ? [`${findings.filter(f => !f.whole).length === 1 ? "That line was" : "Those lines were"} not sent: the interview reads the rest of the file without ${findings.filter(f => !f.whole).length === 1 ? "it" : "them"}.`] : []),
    ...(whole.length ? [`${whole.join(", ")} ${whole.length === 1 ? "was" : "were"} sent as ${whole.length === 1 ? "a name" : "names"} only, since a private key runs over many lines.`] : []),
    "A deploy will be refused until each value moves into a setting."
  ];
}

// ---------------------------------------------------------------------------------
// What an interview sends of a file with a finding: the file, with each flagged line
// replaced by a line that says why (so the model reads the rest, and line numbers
// stay true), or, where a value runs over many lines (a private key) or the file is
// not text, nothing but its name.

const MARKER = "[seaLeye: this line was not sent";

/** The line sent in place of one that looks like it holds a secret. Never the value. */
export const redactedLine = kind => `${MARKER}: it looks like it holds ${kind}]`;

/** Is this line one seaLeye wrote in place of a secret? */
export const isRedactedLine = line => String(line).trimStart().startsWith(MARKER);

/** A rule whose value runs over many lines, so blanking one line would not hide it. */
export const wholeFileRule = rule => /private[-_]?key/i.test(String(rule));

/**
 * Mark which findings mean the whole file is withheld: a private key, a value gitleaks
 * found over several lines (`wholeFiles`), or a file that is not text.
 */
export function markWhole(findings, { wholeFiles = [], binaryFiles = [] } = {}) {
  const whole = new Set([...wholeFiles, ...binaryFiles, ...findings.filter(f => wholeFileRule(f.rule)).map(f => f.file)]);
  return findings.map(f => (whole.has(f.file) ? { ...f, whole: true } : { ...f }));
}

const encoder = new TextEncoder();

/**
 * A file's contents with each given line replaced by redactedLine(kind). Lines are
 * counted as scanText counts them (ending at \n), and a \r before the \n is kept.
 *
 * @param {Uint8Array|string} contents
 * @param {Map<number, string>} kinds line number to the kind of value on it
 * @returns {Uint8Array}
 */
export function redactLines(contents, kinds) {
  const text = typeof contents === "string" ? contents : decoder.decode(contents);
  const lines = text.split("\n");
  for (const [number, kind] of kinds) {
    const i = number - 1;
    if (i < 0 || i >= lines.length) continue;
    lines[i] = redactedLine(kind) + (lines[i].endsWith("\r") ? "\r" : "");
  }
  return encoder.encode(lines.join("\n"));
}

/** For each file with findings that are not whole, its lines and their kinds. */
export function linesByFile(findings) {
  const out = new Map();
  for (const f of findings) {
    if (f.whole) continue;
    if (!out.has(f.file)) out.set(f.file, new Map());
    out.get(f.file).set(f.line, f.kind || kindOf(f.rule));
  }
  return out;
}

/**
 * Why a deploy was refused, and what to do: move the value into a setting, or, if it
 * is not a secret, allow the line. `command` is the command's name, for the words.
 */
export function deployRefusalWords(findings, { command = "sealeye" } = {}) {
  return [
    "Nothing was deployed: your code looks like it holds a secret.",
    ...findings.map(findingSentence),
    `Move each value into a setting (${command} settings set NAME, or Settings in seaLeye.online) and have the app read it from its environment, then deploy again.`,
    `If a value is not a secret, a test key say, add its line to ${ALLOW_FILE} at the top of your app folder:`,
    ...findings.map(f => `  ${allowLine(f)}`)
  ];
}

/** The refusal as one message, for an error a client shows as it is. */
export const deployRefusalMessage = (findings, options) => deployRefusalWords(findings, options).join("\n");
