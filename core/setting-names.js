// core/setting-names.js
// Which settings a plan asks the platform to pass to the app, by name, and which names a
// setting may have. The command, the API and seaLeye.online all need the same answer, so
// this imports nothing and runs in a browser too. core/settings.js re-exports it.

// The platform decides the port and tells the app what it is, so it is never a setting
// the plan gets to pass.
export const PLATFORM_OWNED = new Set(["PORT"]);
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Names the platform or the function's runtime owns, which a stored setting may never
// take: the start-up reader skips them (templates/sealeye-settings.mjs keeps its own copy
// of this rule, and test/settings-reader.test.js checks the two agree), and the API
// refuses to store them.
export const RESERVED_NAME = /^(PORT|NODE_OPTIONS|AWS_.*|LAMBDA_.*|_.*|SEALEYE_.*)$/;

/** The setting names the plan's config_basic module asks for, minus the platform's own. */
export function settingNamesFor(plan) {
  const module = (plan?.modules || []).find(m => m && m.enabled !== false && m.id === "config_basic");
  return Object.keys(module?.inputs?.variables || {}).filter(name => !PLATFORM_OWNED.has(name));
}
