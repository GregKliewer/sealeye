// core/retention.js
// How long an app's logs are kept: the choices both surfaces offer for Configure
// (PHASE2-PLAN Step 18), and the plan with a new choice in it. Changing it is a deploy
// again with that plan, so the record says who changed it and when. Imports nothing,
// so it runs in a browser too.

// Days CloudWatch keeps a log group for, of the ones it allows, that a dev environment
// has a use for.
export const RETENTION_CHOICES = [1, 3, 7, 14, 30, 60, 90, 180, 365];
export const DEFAULT_RETENTION_DAYS = 30;
// Every value CloudWatch accepts, for a plan written by hand.
export const RETENTION_ALLOWED = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

/** The days a plan keeps logs for: observability_basic's retention_days, else 30. */
export function retentionOf(plan) {
  const obs = (plan?.modules || []).find(m => m && m.enabled !== false && m.id === "observability_basic");
  const value = Number(obs?.inputs?.retention_days);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
}

/**
 * The plan with logs kept for `days`, nothing else changed. A plan without
 * observability_basic gets it, as every plan the interview writes has it.
 */
export function withRetention(plan, days) {
  if (!RETENTION_CHOICES.includes(days)) throw new Error(`logs can be kept for ${RETENTION_CHOICES.join(", ")} days`);
  const modules = Array.isArray(plan?.modules) ? plan.modules : [];
  const has = modules.some(m => m && m.id === "observability_basic");
  const next = has
    ? modules.map(m => (m && m.id === "observability_basic"
      ? { ...m, ...(m.enabled === false ? { enabled: true } : {}), inputs: { ...(m.inputs || {}), retention_days: days } }
      : m))
    : [...modules, { id: "observability_basic", inputs: { target: "auto", retention_days: days } }];
  return { ...plan, modules: next };
}
