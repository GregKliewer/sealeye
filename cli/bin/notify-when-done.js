#!/usr/bin/env node
// cli/bin/notify-when-done.js
//
// The detached watcher `cli/bin/sealeye` spawns once it has handed the terminal back.
// It has no terminal of its own and nobody is reading its stdout: it polls the
// platform the same way runWatch's live panel does, and when the deployment reaches
// succeeded or failed, it fires one macOS notification and exits. With --teardown it
// follows a tear-down instead, which ends at destroyed or failed (added Oct 17, 2026).
//
// It never writes to deployments.json. The server's own executor is the only writer,
// exactly as it is for the live panel; this file only reads GET /deployments/:id,
// the same route the panel polls.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { getDeployment } from "../client.js";
import { DEFAULT_API, setting } from "../../core/config.js";
import { scoreDeploymentOutcome, flushScores } from "../../core/tracing.js";

// Tests shorten the wait (test/teardown-background.test.js); nothing else sets it.
const POLL_MS = Number(process.env.SEALEYE_TEST_NOTIFY_POLL_MS) || 5000;
// An hour of five-second polls, then stop rather than keep a process alive forever
// for a deployment that was destroyed, or a demo machine left running overnight.
const MAX_TICKS = 720;

function getArg(longFlag, shortFlag) {
  const argv = process.argv;
  const iLong = argv.indexOf(longFlag);
  if (iLong !== -1) return argv[iLong + 1];
  if (shortFlag) {
    const iShort = argv.indexOf(shortFlag);
    if (iShort !== -1) return argv[iShort + 1];
  }
  return undefined;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// The one URL a developer asked for. Copied from cli/bin/sealeye rather than imported
// from it: cli/bin/sealeye is the CLI entrypoint, not a library this file should depend on.
function publicUrl(dep) {
  return dep.outputs?.ApiUrl || dep.outputs?.WebsiteUrl || null;
}

// Why the deployment failed, in one sentence. Copied from cli/bin/sealeye for the same
// reason: CloudFormation reasons arrive with newlines and double spaces in them, and
// left alone they read like a stack trace rather than a notification.
function failureSentence(dep) {
  const reason = (dep.failureReason || "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return reason
    ? `Your environment was not created: ${reason}.`
    : "Your environment was not created, and AWS did not say why.";
}

// CLAUDE.md is explicit: the CLI writes DEPLOYMENT_REPORT.md into the app folder on
// succeeded, and nothing else writes there. runWatch and runBackground both honour
// that when they are the ones to see the deployment finish; this is the same thing
// for when this process is the one that sees it finish instead. Written to the app
// path passed on the command line, never to this process's own cwd, since a detached
// process should not depend on inheriting one.
function writeReport(dep, appPath) {
  if (!dep.report || !appPath) return;

  try {
    fs.writeFileSync(path.join(appPath, "DEPLOYMENT_REPORT.md"), dep.report);
  } catch {
    // Nobody is watching this terminal to read why the write failed. The
    // notification still fires either way.
  }
}

// AppleScript's own string escaping: a backslash, then a double quote. Not the same
// rules as JSON or a shell, and this is the one place that matters, because the
// message can carry a URL or a CloudFormation reason neither of us chose the wording of.
function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Fire the notification with terminal-notifier first, because it registers its own
 * identity with the OS rather than having the permission attributed to whatever ran
 * the AppleScript (in practice Script Editor, not Terminal), so it can survive a
 * Focus mode's allowed-apps list in a way osascript cannot. But a Homebrew install of
 * it is commonly only ad hoc signed and not notarized, and Gatekeeper can refuse it
 * notification permission outright on a current macOS, which fails as a normal exit
 * code, not a missing binary. So the fallback to osascript is not narrowed to "not
 * found": it is anything terminal-notifier did not actually deliver, found or not,
 * permitted or not.
 *
 * Every argument goes through spawn's own argument array, never a shell string, so a
 * URL or a failure reason already in the message is never read as shell syntax.
 *
 * Never throws: a missing binary, a disallowed notification or a machine that is not
 * a Mac all resolve to false rather than reject, because there is no terminal here to
 * catch anything thrown at it.
 */
function notify({ title, subtitle, message, sound }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const fallback = () => notifyWithOsascript({ title, subtitle, message, sound }).then(finish);

    const child = spawn(
      "terminal-notifier",
      ["-title", title, "-subtitle", subtitle, "-message", message, "-sound", sound],
      { stdio: "ignore" }
    );

    child.on("error", fallback);
    child.on("exit", code => (code === 0 ? finish(true) : fallback()));
  });
}

function notifyWithOsascript({ title, subtitle, message, sound }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const script =
      `display notification ${appleScriptString(message)} ` +
      `with title ${appleScriptString(title)} ` +
      `subtitle ${appleScriptString(subtitle)} ` +
      `sound name ${appleScriptString(sound)}`;

    const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
    child.on("error", () => finish(false));
    child.on("exit", code => finish(code === 0));
  });
}

// A tear-down's end, in the words `sealeye teardown` prints when it sees it itself.
function teardownMessage(dep, appName) {
  if (dep.status === "destroyed") return `Everything seaLeye.run created for ${appName} is gone.`;
  const reason = (dep.failureReason || "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return reason ? `Tear-down failed: ${reason}.` : "Tear-down failed, and no reason was reported.";
}

async function main() {
  const deploymentId = getArg("--deployment-id");
  const apiBaseUrl = getArg("--api") || setting("API") || DEFAULT_API;
  const appPath = getArg("--app");
  const appNameArg = getArg("--app-name");
  const fallbackAppName = appNameArg || appPath?.split("/").filter(Boolean).pop();
  const teardown = process.argv.includes("--teardown");

  if (!deploymentId) return;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    let dep = null;

    try {
      dep = await getDeployment({ apiBaseUrl, deploymentId });
    } catch {
      // The platform not answering on this one poll is not this process's problem to
      // solve. Try again on the next tick rather than giving up on one bad request.
    }

    if (teardown && dep && (dep.status === "destroyed" || dep.status === "failed")) {
      // Never scored, and no report written: a tear-down says nothing about whether the
      // interview's plan built, and leaves nothing in the developer's folder.
      const appName = dep.app?.name || fallbackAppName || "your app";
      await notify({
        title: "seaLeye.run",
        subtitle: `${appName} · ${deploymentId}`,
        message: teardownMessage(dep, appName),
        sound: dep.status === "destroyed" ? "Glass" : "Basso"
      });
      return;
    }

    if (!teardown && dep && (dep.status === "succeeded" || dep.status === "failed")) {
      if (dep.status === "succeeded") writeReport(dep, appPath);

      // The outcome, against the interview that produced it. This is where most runs
      // end, so without it most deployments would never be scored.
      scoreDeploymentOutcome(dep);
      await flushScores();

      const appName = dep.app?.name || fallbackAppName || "your app";
      const subtitle = `${appName} · ${deploymentId}`;

      const message =
        dep.status === "succeeded"
          ? (publicUrl(dep) ? `Your app is live at ${publicUrl(dep)}` : "Your environment is ready")
          : failureSentence(dep);

      await notify({
        title: "seaLeye.run",
        subtitle,
        message,
        sound: dep.status === "succeeded" ? "Glass" : "Basso"
      });

      return;
    }

    await sleep(POLL_MS);
  }
}

main().catch(() => {
  // Nobody is watching this terminal. A missed notification is recoverable with
  // `sealeye status`; a crash trace nobody sees never is.
});
