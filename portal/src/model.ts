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

export type Tone = "phosphor" | "amber" | "neutral";

/** Each status in the words the terminal uses, and the brand's colour for it. */
export function statusOf(dep: DeploymentSummary): { label: string; tone: Tone } {
  if (dep.interrupted) return { label: "Interrupted", tone: "amber" };
  switch (dep.status) {
    case "succeeded": return { label: "Live", tone: "phosphor" };
    case "drafted": return { label: "Drafted", tone: "amber" };
    case "failed": return { label: "Failed", tone: "amber" };
    case "queued":
    case "packaging":
    case "running": return { label: "Building", tone: "neutral" };
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
