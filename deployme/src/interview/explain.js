// src/interview/explain.js
// Contract validation errors, in the developer's language.
//
// The API answers with what the schema said: "/modules/0 must NOT have additional
// properties". True, and useless to somebody who has never read the schema. This
// turns each one into a sentence about their plan, and where the contract fixes the
// allowed values it names them, because the developer cannot look them up.
import { planSchema } from "../schema.js";

const TYPE_WORDS = {
  string: "text",
  number: "a number",
  integer: "a whole number",
  boolean: "yes or no",
  array: "a list",
  object: "a set of settings"
};

const RULES = [
  [/^must have required property '(.+)'$/, m => `has no ${m[1]}`],
  [/^must NOT have additional properties$/, () => "has a field the contract does not have"],
  [/^must be equal to constant$/, () => "is not the value the contract fixes"],
  [/^must be equal to one of the allowed values$/, () => "is not one of the values the contract allows"],
  [/^must be (string|number|integer|boolean|array|object)$/, m => `has to be ${TYPE_WORDS[m[1]]}`],
  [/^must NOT have fewer than (\d+) items$/, m => `needs at least ${m[1]}`],
  [/^must NOT have more than (\d+) items$/, m => `allows at most ${m[1]}`],
  [/^must NOT have fewer than \d+ characters$/, () => "cannot be empty"]
];

/** "/modules/0/id" -> "modules item 1, id". "/app/type" -> "app.type". "/" -> "The plan". */
function subjectOf(pathString) {
  const segments = String(pathString || "/").split("/").filter(Boolean);
  if (!segments.length) return "The plan";

  // Nested field names read as one name (app.type); a list index reads as a position
  // and starts a new clause (modules item 1, id).
  let subject = "";
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      subject = subject ? `${subject} item ${Number(segment) + 1}` : `item ${Number(segment) + 1}`;
      continue;
    }
    if (!subject) subject = segment;
    else subject += /item \d+$/.test(subject) ? `, ${segment}` : `.${segment}`;
  }

  return subject;
}

/** Walk the frozen contract to the field the error is about, so its values can be named. */
function schemaAt(pathString) {
  const segments = String(pathString || "/").split("/").filter(Boolean);
  let node = planSchema;

  for (const segment of segments) {
    if (!node) return null;
    node = /^\d+$/.test(segment) ? node.items : node.properties?.[segment];
  }

  return node || null;
}

function allowedValues(pathString) {
  const node = schemaAt(pathString);
  if (!node) return null;
  if (Array.isArray(node.enum)) return node.enum.join(", ");
  if (node.const !== undefined) return String(node.const);
  return null;
}

/** One validation error as one plain sentence. */
export function plainValidationError(error) {
  const path = error?.path || "/";
  const raw = String(error?.message || "").trim();

  // The API prefixes the message with the path; the path is the subject instead.
  const rule = raw.startsWith(path) ? raw.slice(path.length).trim() : raw;
  const subject = subjectOf(path);

  const matched = RULES.find(([pattern]) => pattern.test(rule));
  const phrase = matched ? matched[1](matched[0].exec(rule)) : rule;

  const values = /the contract allows|the contract fixes/.test(phrase)
    ? allowedValues(path)
    : null;

  return values ? `${subject} ${phrase}: ${values}.` : `${subject} ${phrase}.`;
}

export function plainValidationErrors(errors = []) {
  return errors.map(plainValidationError);
}
