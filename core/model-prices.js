// core/model-prices.js
// What each model costs, for the cap on a run (PHASE3-PLAN Step 3; DESIGN.md, "A run's
// cap is close, not exact"). This table is the only thing the cap prices from: never
// LangFuse, which is optional and learns a cost after the fact, and never a network
// call. LangFuse's cost and the providers' bills are how this table is checked.
//
// US dollars per million tokens, from Anthropic's pricing page
// (https://platform.claude.com/docs/en/about-claude/pricing). `cacheWrite` is the
// five-minute write, the only kind the interview makes. A model priced in tiers by
// prompt length lists them; a request is priced by its own prompt (input, cache reads
// and cache writes together), as Anthropic prices it.
//
// When a price changes, or a model is added, update the table and `checkedOn` in the
// same commit, and say where the price was read. release.sh warns when `checkedOn` is
// more than 90 days old (deploy/README.md, "Model prices").

import { setting, settingName } from "./config.js";

/** The cap on one run, in US dollars, when SEALEYE_RUN_CAP does not say (DESIGN.md, "What a run costs, and a cap of a dollar"). */
export const DEFAULT_RUN_CAP = 1.0;

/** The cap on one run: SEALEYE_RUN_CAP, in US dollars, or the default. */
export function runCap(value = setting("RUN_CAP")) {
  if (value === undefined || value === null || value === "") return DEFAULT_RUN_CAP;
  const cap = Number(value);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(`${settingName("RUN_CAP")} must be an amount in US dollars above zero, such as 1.00; it is ${JSON.stringify(String(value))}.`);
  }
  return cap;
}

/**
 * What a developer reads when a run stops at its cap, on both surfaces. No amount and
 * no count (principle 8): the limit is the platform's, and what to do is the point.
 */
export const spendingLimitWords = (command = "sealeye") =>
  `This run reached its spending limit before it had a plan, so it stopped there. Nothing was written to your folder and nothing was built. Run ${command} run again; if it stops at the limit again, your app needs more reading than one run allows, so tell your platform team.`;

export const PRICES = {
  checkedOn: "2026-10-14",
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  models: {
    "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
    "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    "claude-haiku-5-5": {
      tiers: [
        { upToPromptTokens: 100_000, input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
        { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 }
      ]
    }
  }
};

/** Days since the prices were last checked against the provider's page. */
export function pricesAgeDays(now = Date.now(), prices = PRICES) {
  return Math.floor((now - Date.parse(`${prices.checkedOn}T00:00:00Z`)) / 86_400_000);
}

/** The price entry for a model, or null when the table has none. */
export function priceFor(model, prices = PRICES) {
  return prices.models[String(model || "")] || null;
}

/** A run cannot be capped on a model the table cannot price, so it does not start. */
export class ModelNotPriced extends Error {
  constructor(model) {
    super(`seaLeye has no price for the model ${model}, so it cannot keep a run on it within its spending limit. Ask your platform team to add the model's price.`);
    this.name = "ModelNotPriced";
    this.model = model;
  }
}

const n = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/**
 * One model response's usage, as Anthropic reports it, in tokens and US dollars.
 * `input_tokens` excludes what was read from or written to the cache.
 *
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number, cost: number }}
 * @throws ModelNotPriced
 */
export function priceUsage(model, usage = {}, prices = PRICES) {
  const entry = priceFor(model, prices);
  if (!entry) throw new ModelNotPriced(model);
  const tokens = {
    input: n(usage.input_tokens),
    output: n(usage.output_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
    cacheWrite: n(usage.cache_creation_input_tokens)
  };
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const rate = entry.tiers ? entry.tiers.find(t => !t.upToPromptTokens || prompt <= t.upToPromptTokens) : entry;
  const cost =
    (tokens.input * rate.input + tokens.output * rate.output + tokens.cacheRead * rate.cacheRead + tokens.cacheWrite * rate.cacheWrite) / 1_000_000;
  return { ...tokens, cost };
}

/** Two spends added together. */
export function addSpend(a = {}, b = {}) {
  return {
    input: n(a.input) + n(b.input),
    output: n(a.output) + n(b.output),
    cacheRead: n(a.cacheRead) + n(b.cacheRead),
    cacheWrite: n(a.cacheWrite) + n(b.cacheWrite),
    cost: n(a.cost) + n(b.cost)
  };
}
