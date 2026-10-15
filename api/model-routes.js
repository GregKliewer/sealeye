// api/model-routes.js
// The model gateway's named routes (PHASE4-PLAN Step 5, D5; PHASE3-PLAN Step 8). A
// discovery worker asks for "small", and the supervisor and the rule writer for
// "frontier", never for a model by name: which model serves a route is the gateway's
// to say (deploy/gateway.yaml), so a route can move, to Bedrock say, without a change
// to any caller.
//
// The API still needs to know each route's model, for two reasons: a run is priced
// from core/model-prices.js by the model that answers, and an API with no gateway (a
// laptop, a test) calls Anthropic directly, which knows no route names.
// test/gateway-config.test.js keeps this table and the gateway's the same.
import { priceFor } from "../core/model-prices.js";

export const ROUTES = Object.freeze({
  small: "claude-haiku-5-5",
  frontier: "claude-sonnet-5"
});

/** The model a route names. Throws on a route that is not one of ours. */
export function routeModel(route) {
  const model = ROUTES[route];
  if (!model) throw new Error(`no model route called ${route}`);
  return model;
}

/**
 * What to put in a request's `model` for a route: the route's own name through the
 * gateway, which chooses the model, or the model itself when calling Anthropic directly.
 *
 * @param {"small"|"frontier"} route
 * @param {{ gatewayKey?: string } | string | null} credential  what modelCredential() returned
 */
export function requestModel(route, credential) {
  const model = routeModel(route);
  return credential && typeof credential === "object" && credential.gatewayKey ? route : model;
}

/** A route's price entry, by the model it names: a run on a route cannot start unpriced. */
export const routePrice = route => priceFor(routeModel(route));
