// deploy/settings.mjs
// The pilot server's settings (DESIGN.md, "One small server in ca-central-1"), shared by
// deploy/start.mjs, which starts the API, and deploy/with-settings.mjs, which runs a
// one-off script such as the record importer with the same settings.
//
// 1. Read the API's settings from SSM Parameter Store, under SEALEYE_SSM_PATH
//    (default /sealeye/), with the server's own instance role. Each parameter's last
//    path segment is the variable's name: /sealeye/SEALEYE_GATEWAY_KEY becomes
//    SEALEYE_GATEWAY_KEY. Parameters under /sealeye/gateway/ are the model gateway's
//    and are left out (`apiSettings`). SecureStrings are decrypted here and live only in this
//    process's memory; nothing is written to disk and nothing is printed.
// 2. Point the API at its database: Postgres in the next container, with the password
//    from /sealeye/POSTGRES_PASSWORD, unless DATABASE_URL is given outright.
// 3. If SEALEYE_DEPLOY_ROLE_ARN is set, write an AWS config profile that assumes that
//    role from the instance's credentials, and make it the default for everything run
//    after this. So every `aws` the executor spawns acts through the team's
//    sealeye-deploy-* role, never the server's own, with no change to the executor.
//
// This is the one place outside api/executor/ that runs the AWS CLI: it is the server
// starting, not the platform acting.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SSM_PATH = process.env.SEALEYE_SSM_PATH || "/sealeye/";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readParameters() {
  const env = { ...process.env };
  // The server's own role reads the parameters, never the deploy role.
  delete env.AWS_PROFILE;
  delete env.AWS_CONFIG_FILE;

  const loaded = {};
  let token;
  do {
    const args = ["ssm", "get-parameters-by-path", "--path", SSM_PATH, "--recursive", "--with-decryption", "--output", "json"];
    if (token) args.push("--starting-token", token);
    const result = spawnSync("aws", args, { env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) {
      // The error names the path and the command's own reason, which never holds a value.
      throw new Error(`could not read settings from ${SSM_PATH}: ${(result.stderr || result.error?.message || "").trim()}`);
    }
    const page = JSON.parse(result.stdout || "{}");
    Object.assign(loaded, apiSettings(page.Parameters || []));
    token = page.NextToken;
  } while (token);
  return loaded;
}

/**
 * The parameters the API takes into its environment: each one's last path segment is
 * the name. Anything under the path's `gateway/` folder is the model gateway's, never
 * the API's: the model key lives there, so the API does not hold it (deploy/README.md,
 * "The model gateway"). update.sh hands those to the gateway instead.
 */
export function apiSettings(parameters, ssmPath = SSM_PATH) {
  const gatewayFolder = `${ssmPath.replace(/\/?$/, "/")}gateway/`;
  const loaded = {};
  for (const p of parameters) {
    if (String(p.Name).startsWith(gatewayFolder)) continue;
    const name = String(p.Name).split("/").pop();
    if (NAME.test(name)) loaded[name] = p.Value;
  }
  return loaded;
}

function useDeployRole(roleArn) {
  if (!/^arn:aws:iam::\d{12}:role\/sealeye-deploy-[A-Za-z0-9+=,.@_-]+$/.test(roleArn)) {
    throw new Error("SEALEYE_DEPLOY_ROLE_ARN must be the arn of a role named sealeye-deploy-*");
  }
  const file = path.join(os.tmpdir(), `sealeye-aws-config-${process.pid}`);
  fs.writeFileSync(
    file,
    [
      "[profile sealeye-deploy]",
      `role_arn = ${roleArn}`,
      "credential_source = Ec2InstanceMetadata",
      "role_session_name = sealeye-api",
      `region = ${process.env.AWS_REGION || "ca-central-1"}`,
      ""
    ].join("\n"),
    { mode: 0o600 }
  );
  process.env.AWS_CONFIG_FILE = file;
  process.env.AWS_PROFILE = "sealeye-deploy";
}

/** Read the server's settings into this process, then point it at its database and deploy role. */
export function applyServerSettings({ quiet = false } = {}) {
  const say = line => {
    if (!quiet) console.log(line);
  };

  if (process.env.SEALEYE_SKIP_SSM !== "1") {
    const loaded = readParameters();
    for (const [name, value] of Object.entries(loaded)) {
      // The environment the container was started with wins, as everywhere else.
      if (process.env[name] === undefined) process.env[name] = value;
    }
    say(`seaLeye API: ${Object.keys(loaded).length} settings read from ${SSM_PATH}: ${Object.keys(loaded).sort().join(", ") || "none"}`);
  }

  // The database: on the server, Postgres in the next container, with the password from
  // Parameter Store. A DATABASE_URL given outright wins.
  if (!process.env.DATABASE_URL && process.env.SEALEYE_DATABASE_HOST && process.env.POSTGRES_PASSWORD) {
    const password = encodeURIComponent(process.env.POSTGRES_PASSWORD);
    process.env.DATABASE_URL = `postgres://sealeye:${password}@${process.env.SEALEYE_DATABASE_HOST}:5432/sealeye`;
  }
  // The password has done its job once it is in the address; nothing else in the API,
  // or anything it starts, needs to see it on its own.
  delete process.env.POSTGRES_PASSWORD;
  if (process.env.DATABASE_URL) say("seaLeye API: records and interviews are kept in Postgres");

  if (process.env.SEALEYE_DEPLOY_ROLE_ARN) {
    useDeployRole(process.env.SEALEYE_DEPLOY_ROLE_ARN);
    say("seaLeye API: AWS actions go through the deploy role");
  }
}
