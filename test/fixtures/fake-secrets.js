// test/fixtures/fake-secrets.js
// Values shaped like real secrets, for the scanner's tests. None is a real key. Each
// is put together at run time from pieces, so no file in this repository holds a
// string that matches a secret's shape: GitHub's push protection, gitleaks and
// seaLeye's own scanner would all, rightly, stop at one.
const join = (...parts) => parts.join("");

// Deterministic "random" characters, so a test that fails, fails the same way again.
function chars(n, alphabet, seed) {
  let x = seed;
  let out = "";
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[(x >>> 16) % alphabet.length];
  }
  return out;
}
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const FAKE = {
  privateKeyHeader: join("-----BEGIN ", "RSA PRIVATE", " KEY-----"),
  privateKeyFooter: join("-----END ", "RSA PRIVATE", " KEY-----"),
  cloudAccessKey: join("AK", "IA", chars(16, UPPER32, 7)),
  cloudSecret: chars(40, ALNUM + "+/", 11),
  githubToken: join("gh", "p_", chars(36, ALNUM, 13)),
  gitlabToken: join("gl", "pat-", chars(20, ALNUM, 17)),
  slackToken: join("xo", "xb-", chars(12, "0123456789", 19), "-", chars(24, ALNUM, 23)),
  stripeKey: join("sk", "_test_", chars(24, ALNUM, 29)),
  anthropicKey: join("sk-", "ant-", "api03-", chars(90, ALNUM + "_-", 31)),
  openaiKey: join("sk-", "proj-", chars(20, ALNUM, 37), "T3Blbk", "FJ", chars(20, ALNUM, 41)),
  googleKey: join("AI", "za", chars(35, ALNUM, 43)),
  npmToken: join("np", "m_", chars(36, ALNUM, 47)),
  sendgridKey: join("S", "G.", chars(22, ALNUM, 53), ".", chars(43, ALNUM, 59)),
  password: join("Tq9", chars(17, ALNUM, 61))
};
