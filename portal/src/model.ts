// What the pages show, worked out from the API's records the same way `sealeye list`
// does (cli/bin/sealeye groupEnvironments), so the portal and the terminal say the same
// thing about the same environment.
import type { DeploymentSummary } from "./api";

export interface Environment {
  key: string;
  app: string;
  latest: DeploymentSummary;
  deploys: DeploymentSummary[];
}

export const PAST = new Set(["destroyed", "drafted"]);

export function groupEnvironments(deployments: DeploymentSummary[]): Environment[] {
  const groups = new Map<string, Environment>();
  for (const dep of deployments) {            // newest first, as the API lists them
    // A stack is one environment. A draft has no stack, so it is its team's app: two
    // teams' drafts of the same name are two (an organization-wide token sees both).
    const key = dep.stackName || dep.environment || (dep.app?.name ? `${dep.teamId || "default"}:${dep.app.name}` : dep.deploymentId);
    const group = groups.get(key);
    if (group) group.deploys.push(dep);
    else groups.set(key, { key, app: dep.app?.name || dep.deploymentId, latest: dep, deploys: [dep] });
  }
  return [...groups.values()];
}

export function publicUrl(dep: DeploymentSummary): string | null {
  return dep.outputs?.ApiUrl || dep.outputs?.WebsiteUrl || null;
}

/**
 * Where an environment answers: its latest deployment's address, or while a change is
 * under way, the address the last successful one still answers at.
 */
export function addressOf(env: Environment): string | null {
  return publicUrl(env.latest) ||
    (IN_FLIGHT.has(env.latest.status) ? env.deploys.filter(d => d.status === "succeeded").map(publicUrl).find(Boolean) || null : null);
}

export type Tone = "phosphor" | "amber" | "neutral";

/** Each status in the words the terminal uses, and the brand's colour for it. */
export function statusOf(dep: DeploymentSummary): { label: string; tone: Tone } {
  if (dep.interrupted) return { label: "Interrupted", tone: "amber" };
  switch (dep.status) {
    case "succeeded":
      // Its result stays its own, but a newer deploy is what the environment runs now.
      if (dep.replaced) return { label: "Replaced", tone: "neutral" };
      return dep.paused ? { label: "Paused", tone: "amber" } : { label: "Live", tone: "phosphor" };
    case "drafted": return { label: "Drafted", tone: "amber" };
    case "failed": return { label: "Failed", tone: "amber" };
    case "queued":
    case "packaging":
    case "running": return { label: "Building", tone: "phosphor" };
    case "destroying": return { label: "Tearing down", tone: "neutral" };
    case "destroyed": return { label: "Torn down", tone: "neutral" };
    default: return { label: dep.status, tone: "neutral" };
  }
}

export const IN_FLIGHT = new Set(["queued", "packaging", "running", "destroying"]);

export function who(by: { name?: string; user?: string } | null | undefined): string {
  if (!by) return "Not recorded";
  return by.name || by.user || "Not recorded";
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "Not recorded";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// A change still marked as under way after a day is not one: the API stops counting it
// too (api/busy.js), so the page stops locking for it.
const DAY_MS = 24 * 3600_000;

/** When the change under way began: a tear-down when it was asked for. */
export function changedAt(dep: DeploymentSummary): string | null {
  return (dep.status === "destroying" && dep.destroyRequestedBy?.at) || dep.startedAt;
}

/**
 * Whether a change to this environment is under way now, as the API decides it when it
 * refuses a second one (ENVIRONMENT_BUSY): queued, packaging, running or tearing down,
 * not interrupted, and begun within the last day.
 */
export function underWay(dep: DeploymentSummary | null | undefined, now = Date.now()): boolean {
  if (!dep || !IN_FLIGHT.has(dep.status) || dep.interrupted) return false;
  const at = Date.parse(changedAt(dep) || "");
  return Number.isFinite(at) && now - at < DAY_MS;
}

/** What is happening to it, in the words the banner and the locks use. */
export function doing(dep: DeploymentSummary): { title: string; verb: string } {
  switch (dep.status) {
    case "queued": return { title: "Waiting to start", verb: "waiting to start" };
    case "packaging": return { title: "Packaging your app", verb: "packaging" };
    case "destroying": return { title: "Tearing down", verb: "tearing down" };
    default: return { title: "Building", verb: "building" };
  }
}

/** The sentence on every card that would change the environment while it is changing. */
export function lockedWhile(dep: DeploymentSummary, now = Date.now()): string {
  return `Locked while ${doing(dep).verb}, started ${ago(changedAt(dep), now)}. One change at a time: this opens again when it finishes.`;
}

/** 4m 05s: how long a change has been under way, to the second. */
export function elapsed(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
