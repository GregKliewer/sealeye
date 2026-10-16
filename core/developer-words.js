// core/developer-words.js
// Words a developer must never read (principle 8), and how to say them instead. A
// discovered catalog's words come from a model reading a platform team's READMEs, which
// are written in the cloud's own terms, and the prompt asking for plain words is not
// enough (DESIGN.md, "What the first measured run changed"). So the self-test checks
// every word of a catalog a developer reads, and a catalog that holds one is not
// approved or made live (Greg, Oct 16, 2026).
//
// What counts (DESIGN.md, "What a platform term is", Greg, Oct 16, 2026, Q21):
// 1. A product or trademark name is refused, whoever owns it (Lambda, Terraform). The
//    exceptions are trademarks that became the everyday name on every cloud: Kubernetes
//    and Docker, which are allowed and so not listed here.
// 2. A concept every major cloud names the same way is allowed (subnet, region, bucket,
//    load balancer, queue). One cloud's own noun is refused (log group, security group).
// 3. An acronym is allowed only when the same line spells it out: "Virtual Private Cloud
//    (VPC)". Each line is read on its own, so each spells it out.
// 4. A size, a count or a configuration choice is said as what it does for the app:
//    "keeps running if one data centre fails", never "multi-AZ"; capacity is "set by a
//    load test", always.
//
// Runs in a browser: the portal may import it. No node: modules, no packages.

/**
 * Product and trademark names, and one cloud's own nouns. Each is [pattern, the term as a
 * finding names it]. Words every cloud uses ("subnet", "bucket", "queue", "region") are
 * not here: a line without them would be harder to read, not plainer.
 */
const TERMS = [
  // Amazon's
  [/\bAWS\b/, "AWS"],
  [/\bAmazon\b/, "Amazon"],
  [/\bLambda\b/, "Lambda"],
  [/\bCloud ?Formation\b/i, "CloudFormation"],
  [/\bCloud ?Watch\b/i, "CloudWatch"],
  [/\bCloud ?Front\b/i, "CloudFront"],
  [/\bCloud ?Trail\b/i, "CloudTrail"],
  [/\bS3\b/, "S3"],
  [/\bEC2\b/, "EC2"],
  [/\bECS\b/, "ECS"],
  [/\bEKS\b/, "EKS"],
  [/\bECR\b/, "ECR"],
  [/\bFargate\b/i, "Fargate"],
  [/\bRDS\b/, "RDS"],
  [/\bAurora\b/, "Aurora"],
  [/\bDynamo ?DB\b/i, "DynamoDB"],
  [/\bElasti ?Cache\b/i, "ElastiCache"],
  [/\bSQS\b/, "SQS"],
  [/\bSNS\b/, "SNS"],
  [/\bSES\b/, "SES"],
  [/\bKinesis\b/i, "Kinesis"],
  [/\bEvent ?Bridge\b/i, "EventBridge"],
  [/\bStep Functions\b/i, "Step Functions"],
  [/\bAPI Gateway\b/i, "API Gateway"],
  [/\bRoute ?53\b/i, "Route 53"],
  [/\bCognito\b/i, "Cognito"],
  [/\bIAM\b/, "IAM"],
  [/\bKMS\b/, "KMS"],
  [/\bARNs?\b/, "ARN"],
  [/\bsecurity groups?\b/i, "security group"],
  [/\b(?:ALB|NLB|ELB)s?\b/, "load balancer"],
  [/\bSecrets Manager\b/i, "Secrets Manager"],
  [/\bParameter Store\b/i, "Parameter Store"],
  [/\bSystems Manager\b|\bSSM\b/, "Systems Manager"],
  [/\blog groups?\b/i, "log group"],
  [/\blog streams?\b/i, "log stream"],
  [/\b(?:us|ca|eu|ap|sa|me|af)-(?:east|west|north|south|central|northeast|southeast|northwest|southwest)-\d\b/, "a region's name"],
  // The other clouds'
  [/\bAzure\b/, "Azure"],
  [/\bGCP\b|\bGoogle Cloud\b/, "Google Cloud"],
  // Tools: how the platform builds things, which is the platform's to know. Terraform is
  // HashiCorp's trademark (IBM's since 2025); OpenTofu is its fork.
  [/\bTerraform\b/i, "Terraform"],
  [/\btfvars\b|\.tf\b/, "Terraform"],
  [/\bHCL\b/, "Terraform"],
  [/\bOpen ?Tofu\b/i, "OpenTofu"]
];

/**
 * Configuration choices, said as what they do for the app. Each is [pattern, the setting
 * as a finding names it, what a developer reads instead]. Read before the acronyms, so
 * "multi-AZ" is one finding, not two.
 */
const SETTINGS = [
  [/\bmulti-?regions?\b|\bcross-region\b|\b(?:two|three|several|multiple|\d+) regions\b/i, "multi-region", "must survive a regional disaster"],
  [/\bmulti-?AZ\b|\b(?:two|three|several|multiple|\d+) (?:availability zones|AZs)\b/i, "multi-AZ", "keeps running if one data centre fails"],
  [/\bread replicas?\b/i, "read replicas", "handles heavy reading"],
  [/\bauto-?scal(?:ing|es|ed|e)\b/i, "autoscaling", "grows and shrinks with traffic"],
  [/\binstance (?:class|type|size)(?:es|s)?\b|\bnode counts?\b|\bIOPS\b/i, "instance class, IOPS or node count", "set by a load test"],
  [/\bpoint-in-time (?:recovery|restore)\b|\bPITR\b/i, "point-in-time recovery", "can be restored to an earlier moment"],
  [/\bencrypt(?:ed|ion)? at rest\b/i, "encryption at rest", "encrypted when stored"],
  [/\bRPO\b/, "RPO", "how much data could be lost"],
  [/\bRTO\b/, "RTO", "how long it can be down"]
];

/**
 * Acronyms every cloud uses, allowed only when the same line spells them out. Each is
 * [the acronym as a pattern, what it stands for, the acronym]. Everyday web words (API,
 * URL, HTTPS, DNS) are not here: no developer needs them spelled out.
 */
const ACRONYMS = [
  [/\bVPCs?\b/, "Virtual Private Cloud", "VPC"],
  [/\bAZs?\b/, "Availability Zone", "AZ"],
  [/\bCDNs?\b/, "Content Delivery Network", "CDN"],
  [/\bNAT\b/, "Network Address Translation", "NAT"],
  [/\bWAF\b/, "Web Application Firewall", "WAF"]
];

/** A size, a count of machines or a capacity number: "set by a load test", always. */
const SIZES = [
  [/\b\d+(?:\.\d+)?\s*(?:[KMGTP]i?B|[KMGT]bps)\b/, "a size"],
  [/\b\d+(?:\.\d+)?\s*v?CPUs?\b|\b\d+\s*cores?\b/i, "a count of processors"],
  [/\b\d+\s*(?:replicas?|instances?|nodes?|shards?|containers?|tasks?|workers?)\b/i, "a count of machines"],
  [/\b\d[\d,]*\s*(?:IOPS|connections?|requests? (?:a|per) second|rps|tps)\b/i, "a capacity number"],
  // An instance class: db.t3.medium, cache.r6g.large, t3.micro
  [/\b(?:db\.|cache\.)?[a-z]\d[a-z]{0,2}\.(?:nano|micro|small|medium|large|xlarge|\d+xlarge)\b/i, "a machine size"]
];

/**
 * The first word in `text` a developer must never read, as { term, kind, found,
 * instead? }, or null. kind is "cloud" for a name, "setting" for a configuration choice,
 * "acronym" for one not spelled out, and "size" for sizes, counts and capacity numbers.
 */
export function forbiddenWord(text) {
  return forbiddenWords(text)[0] || null;
}

/**
 * Every such word in `text`, each once, so one fix finds them all: names first, then
 * settings, acronyms not spelled out, and sizes. `found` is the words as the text has
 * them ("2 replicas"), so a person can see which to change; `instead`, when there is one,
 * is what to write in their place. Each finding's words are set aside before the next
 * list is read, so "multi-AZ" is not found again as "AZ", nor "3000 IOPS" twice.
 */
export function forbiddenWords(text) {
  let s = String(text ?? "");
  const original = s;
  const found = [];
  const take = (re, finding) => {
    const m = s.match(re);
    if (!m) return;
    found.push({ ...finding, found: original.slice(m.index, m.index + m[0].length) });
    s = s.slice(0, m.index) + " ".repeat(m[0].length) + s.slice(m.index + m[0].length);
  };
  for (const [re, term] of TERMS) take(re, { term, kind: "cloud" });
  // Sizes before settings, so "3000 IOPS" is a capacity number and bare "IOPS" a setting.
  for (const [re, term] of SIZES) take(re, { term, kind: "size" });
  for (const [re, term, instead] of SETTINGS) take(re, { term, kind: "setting", instead });
  for (const [re, spelled, short] of ACRONYMS) {
    if (new RegExp(`\\b${spelled}`, "i").test(original)) continue;
    take(re, { term: short, kind: "acronym", instead: `${spelled} (${short})` });
  }
  const order = ["cloud", "setting", "acronym", "size"];
  return found
    .filter((f, i) => found.findIndex(g => g.term === f.term) === i)
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/**
 * One such word as a person is told it: the words as the text has them, in quotes, and
 * after them what to write instead, or what they are when that says more ("multi-AZ"
 * (write "keeps running if one data centre fails"), "VPC" (write "Virtual Private Cloud
 * (VPC)"), "2 replicas" (a count of machines), "Terraform"). In quotes is what to change;
 * outside them, a description (Greg, Oct 16, 2026: "a count of machines" alone did not
 * say which words to change).
 */
export function shownWord(w) {
  if (!w?.found) return w?.term || "";
  if (w.instead) return `"${w.found}" (write "${w.instead}")`;
  const says = w.found.toLowerCase().includes(String(w.term).toLowerCase());
  return says ? `"${w.found}"` : `"${w.found}" (${w.term})`;
}

/**
 * The rule, as a model writing a developer's words is told it: the discovery workers and
 * the supervisor, so a first draft is written to the rule the self-test checks.
 */
export function plainWordsRule() {
  return [
    "- Never a product or trademark name, of any cloud or tool (Lambda, CloudFormation, Terraform, Azure), nor one cloud's own noun for a thing (log group, security group). Kubernetes and Docker are fine.",
    "- Words every cloud uses the same way are fine: subnet, region, availability zone, bucket, load balancer, queue.",
    `- Spell an acronym out in the same line: ${ACRONYMS.map(([, spelled, short]) => `"${spelled} (${short})"`).join(", ")}.`,
    "- Say a configuration choice as what it does for the app:",
    ...SETTINGS.map(([, term, instead]) => `  - ${term}: "${instead}"`),
    '- No sizes, counts or capacity numbers: capacity is "set by a load test", always. No em dashes.'
  ].join("\n");
}

/**
 * Where in a catalog a developer reads its words, or hears them through the interview:
 * each module's line, short line, when and skip line, and each input's line; each need
 * kind's line and what each profile expects of it; each profile's line, and what its
 * patterns say. Not a module's signals (they describe code, which may well say
 * Terraform), its guidance (the planner's, in the library's own terms on purpose: a
 * rule keeps the names the platform team uses), nor a rule's own words (for whoever
 * approves the catalog, with where they were found).
 *
 * @returns {{ where: string, module?: string, text: string }[]}
 */
export function developerTexts(doc) {
  const out = [];
  const add = (where, text, module) => {
    if (typeof text === "string" && text.trim()) out.push({ where, ...(module ? { module } : {}), text });
  };
  for (const m of Array.isArray(doc?.modules) ? doc.modules : []) {
    if (!m || typeof m.id !== "string") continue;
    for (const field of ["line", "short_line", "when", "skip_line"]) add(`${m.id}: ${field.replace("_", " ")}`, m[field], m.id);
    for (const [name, spec] of Object.entries(m.inputs || {})) add(`${m.id}: input ${name}`, spec?.line, m.id);
  }
  for (const n of Array.isArray(doc?.need_kinds) ? doc.need_kinds : []) {
    if (!n || typeof n.key !== "string") continue;
    add(`need ${n.key}`, n.line);
    for (const [profile, text] of Object.entries(n.profile_expects || {})) add(`need ${n.key}: what ${profile} expects`, text);
  }
  for (const p of Array.isArray(doc?.profiles) ? doc.profiles : []) if (p?.id) add(`profile ${p.id}`, p.line);
  for (const [profile, block] of Object.entries(doc?.patterns && typeof doc.patterns === "object" ? doc.patterns : {})) {
    add(`patterns for ${profile}`, block?.line);
    for (const [id, text] of Object.entries(block?.modules || {})) add(`patterns for ${profile}: ${id}`, text, id);
  }
  return out;
}

/**
 * Every word in a catalog a developer must never read, with where it is:
 * { where, module?, term, kind, found, instead? }, one for each word in each place. Empty when there is none.
 */
export function developerWordProblems(doc) {
  return developerTexts(doc).flatMap(({ where, module, text }) =>
    forbiddenWords(text).map(found => ({ where, ...(module ? { module } : {}), term: found.term, kind: found.kind, found: found.found, ...(found.instead ? { instead: found.instead } : {}) })));
}
