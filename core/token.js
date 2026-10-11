// core/token.js
// The shape of a seaLeye token, which the command (before it sends one) and the API
// (before it looks one up) must agree on. Issuing and checking tokens is the API's
// (api/tokens.js); this is only what one looks like.
export const TOKEN_PREFIX = "sl_";

/** Whether a string has the shape of a token at all: sl_ and 43 base64url characters. */
export function looksLikeToken(value) {
  return typeof value === "string" && /^sl_[A-Za-z0-9_-]{43}$/.test(value);
}
