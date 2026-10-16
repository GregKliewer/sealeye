// core/developer-words.js
// Words a developer must never read (principle 8): the cloud's own names for things, and
// sizes, counts and capacity numbers. A discovered catalog's words come from a model
// reading a platform team's READMEs, which are written in exactly those terms, and the
// prompt asking for plain words is not enough (DESIGN.md, "What the first measured run
// changed"). So the self-test checks every word of a catalog a developer reads, and a
// catalog that holds one is not approved or made live (Greg, Oct 16, 2026).
//
// Runs in a browser: the portal may import it. No node: modules, no packages.

/**
 * The cloud's names for things. Each is [pattern, the term as a finding names it]. Product
 * names and the cloud's own nouns only: ordinary words with a plain meaning a developer
 * already uses ("queue", "stack", "topic", "database") are not here, since a line
 * without them would be harder to read, not plainer.
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
  [/\bVPCs?\b/i, "VPC"],
  [/\bsubnets?\b/i, "subnet"],
  [/\bsecurity groups?\b/i, "security group"],
  [/\b(?:ALB|NLB|ELB)s?\b/, "load balancer"],
  [/\bSecrets Manager\b/i, "Secrets Manager"],
  [/\bParameter Store\b/i, "Parameter Store"],
  [/\bSystems Manager\b|\bSSM\b/, "Systems Manager"],
  [/\blog groups?\b/i, "log group"],
  [/\blog streams?\b/i, "log stream"],
  [/\b(?:S3 )?buckets?\b/i, "bucket"],
  [/\bavailability zones?\b|\bmulti-AZ\b|\bAZs?\b/i, "availability zone"],
  [/\b(?:us|ca|eu|ap|sa|me|af)-(?:east|west|north|south|central|northeast|southeast|northwest|southwest)-\d\b/, "a region's name"],
  // The other clouds'
  [/\bAzure\b/, "Azure"],
  [/\bGCP\b|\bGoogle Cloud\b/, "Google Cloud"],
  // How the platform builds things, which is the platform's to know
  [/\bTerraform\b/i, "Terraform"],
  [/\btfvars\b|\.tf\b/, "Terraform"],
  [/\bHCL\b/, "Terraform"]
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
 * The first word in `text` a developer must never read, as { term, kind }, or null.
 * kind is "cloud" for the cloud's names, "size" for sizes, counts and capacity numbers.
 */
export function forbiddenWord(text) {
  return forbiddenWords(text)[0] || null;
}

/**
 * Every such word in `text`, each once, cloud terms first: so one fix finds them all.
 * `found` is the words as the text has them ("2 replicas"), so a person can see which
 * to change.
 */
export function forbiddenWords(text) {
  const s = String(text ?? "");
  const hits = list => list.map(([re, term]) => [s.match(re), term]).filter(([m]) => m);
  const found = [
    ...hits(TERMS).map(([m, term]) => ({ term, kind: "cloud", found: m[0] })),
    ...hits(SIZES).map(([m, term]) => ({ term, kind: "size", found: m[0] }))
  ];
  return found.filter((f, i) => found.findIndex(g => g.term === f.term) === i);
}

/**
 * One such word as a person is told it: the words as the text has them, in quotes, and
 * what they are after, when that says more ("ca-central-1" (a region's name), "2
 * replicas" (a count of machines), "Terraform"). In quotes is what to change; outside
 * them, a description (Greg, Oct 16, 2026: "a count of machines" alone did not say which
 * words to change).
 */
export function shownWord(w) {
  if (!w?.found) return w?.term || "";
  const says = w.found.toLowerCase().includes(String(w.term).toLowerCase());
  return says ? `"${w.found}"` : `"${w.found}" (${w.term})`;
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
 * { where, module?, term, kind, found }, one for each word in each place. Empty when there is none.
 */
export function developerWordProblems(doc) {
  return developerTexts(doc).flatMap(({ where, module, text }) =>
    forbiddenWords(text).map(found => ({ where, ...(module ? { module } : {}), term: found.term, kind: found.kind, found: found.found })));
}
