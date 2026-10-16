// Every operation the two surfaces share, with the command's words and the portal's.
// seaLeye.run and seaLeye.online are two clients of one API (CLAUDE.md, Parity), and
// left alone their words drift: `sealeye destroy` beside a "Tear down" button reads as
// two different things. So both read their words from here. The command takes its
// word and its aliases; the portal takes its label, and the line it shows for doing
// the same thing from the command line. test/operations.test.js holds both to it.
//
// Runs in a browser: the portal imports it. No node: modules, no packages.

const PRODUCT = "sealeye";

/**
 * id:      how code names the operation.
 * command: what follows `sealeye` to do it.
 * aliases: other words the command also takes, never shown in help.
 * label:   what the portal calls it, or null where the portal has nothing to show
 *          (`online` opens the portal itself).
 * target:  how the command names what it acts on, when it acts on one environment.
 *
 * A label and a command may differ only where one names a page and the other an
 * action (Environments and `list`, Health and `doctor`). A button is a verb, and its
 * command is the same verb (DESIGN.md, "One list of words for both surfaces").
 */
export const OPERATIONS = Object.freeze([
  { id: "run", command: "run", aliases: ["init"], label: "New environment" },
  { id: "deploy", command: "deploy -f sealeye.yaml", aliases: [], label: "Deploy" },
  { id: "deploy-again", command: "deploy --again", aliases: [], label: "Deploy again", target: "app" },
  { id: "validate", command: "validate -f sealeye.yaml", aliases: [], label: "Validate" },
  { id: "list", command: "list", aliases: [], label: "Environments" },
  { id: "status", command: "status", aliases: [], label: "State", target: "app" },
  { id: "watch", command: "watch", aliases: [], label: "Under way", target: "app" },
  { id: "teardown", command: "teardown", aliases: ["destroy"], label: "Tear down", target: "app" },
  { id: "pause", command: "pause", aliases: [], label: "Pause", target: "app" },
  { id: "resume", command: "resume", aliases: [], label: "Resume", target: "app" },
  { id: "config", command: "config", aliases: [], label: "Configure", target: "app" },
  { id: "settings", command: "settings", aliases: [], label: "Settings" },
  { id: "logs", command: "logs", aliases: [], label: "Logs", target: "app" },
  { id: "perf", command: "perf", aliases: [], label: "Performance", target: "app" },
  { id: "evidence", command: "evidence", aliases: [], label: "Evidence", target: "app" },
  { id: "plan", command: "plan", aliases: [], label: "Plan and report", target: "app" },
  { id: "catalog", command: "catalog", aliases: [], label: "Catalog" },
  { id: "catalogs", command: "catalog versions", aliases: [], label: "Catalogs" },
  { id: "catalog-test", command: "catalog test", aliases: [], label: "Self-test" },
  { id: "catalog-edit", command: "catalog edit", aliases: [], label: "Edit words" },
  { id: "catalog-fix", command: "catalog fix", aliases: [], label: "Fix what blocks approval" },
  { id: "catalog-approve", command: "catalog approve", aliases: [], label: "Approve" },
  { id: "catalog-live", command: "catalog live", aliases: [], label: "Make live" },
  { id: "discover", command: "discover", aliases: [], label: "Discovery" },
  { id: "needs", command: "needs", aliases: [], label: "Needs" },
  { id: "costs", command: "costs", aliases: [], label: "Costs" },
  { id: "team", command: "team", aliases: [], label: "Team" },
  { id: "doctor", command: "doctor", aliases: [], label: "Health" },
  { id: "login", command: "login", aliases: [], label: "Sign in" },
  { id: "online", command: "online", aliases: ["portal", "open"], label: null, target: "app" }
]);

const BY_ID = new Map(OPERATIONS.map(op => [op.id, op]));

/** The operation called `id`. An id not in the list is a mistake in our code, not input. */
export function operation(id) {
  const op = BY_ID.get(id);
  if (!op) throw new Error(`No operation called ${id}`);
  return op;
}

/** What the portal calls it. */
export function label(id) {
  return operation(id).label;
}

/**
 * The whole line a developer types: `sealeye teardown shop-api`. The target is the
 * app's name or a deployment id, and left out when the command acts on the folder or
 * on nothing. Flags, when there are any, come last (`sealeye plan dep_... --report`).
 */
export function commandLine(id, target, flags = []) {
  const op = operation(id);
  return [PRODUCT, op.command, op.target && target ? target : null, ...flags].filter(Boolean).join(" ");
}

/**
 * The command a typed word means: an alias becomes its command's own word, so the
 * command line handles each operation in one place. Anything else comes back as typed.
 */
export function commandFor(word) {
  if (!word) return word;
  for (const op of OPERATIONS) {
    const first = op.command.split(" ")[0];
    if (op.aliases.includes(word)) return first;
  }
  return word;
}

/** Every word that reaches one command: its own and its aliases. */
export function wordsFor(id) {
  const op = operation(id);
  return [op.command.split(" ")[0], ...op.aliases];
}
