// Every call the portal makes, and nothing else: the same API the command uses, at
// /api on this origin. The session cookie travels by itself; every request carries the
// portal's header, which the API requires of a change made with the cookie.

export class SignedOut extends Error {}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method || "GET",
    credentials: "same-origin",
    headers: {
      "x-sealeye-portal": "1",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {})
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/sessions") throw new SignedOut(body?.error?.message || "Signed out");
  if (!res.ok) throw new ApiError(body?.error?.message || `The platform answered ${res.status}`, res.status, body?.error?.code);
  return body as T;
}

// scope: "team" sees that team's environments, "org" every team's in the organization
// (DESIGN.md, "Each team sees its own environments").
export interface Person { email: string; name: string; org: string; team: string; scope?: "team" | "org"; organizationName?: string; auth?: "off" }

export interface RequestedBy { user?: string; name?: string; host?: string | null; verified?: string; surface?: string; at?: string }

export interface DeploymentSummary {
  deploymentId: string;
  app: { name?: string; type?: string } | null;
  status: string;
  outputs: Record<string, string>;
  stackName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
  interrupted: boolean;
  kind: string | null;
  profile: string | null;
  requestedBy: RequestedBy | null;
  surface: string;
  teamId?: string;
  destroyRequestedBy: RequestedBy | null;
  needs: number;
  // Whether its code was packaged and can be deployed again (PHASE2-PLAN Step 14), and
  // for one that was deployed again, whose code it ran.
  packaged?: boolean;
  fromDeployment?: string | null;
  packagedBy?: string | null;
}

export interface DeploymentRecord extends DeploymentSummary {
  stackStatus?: string | null;
  step?: string | null;
}

export interface Catalog {
  modules: { id: string; line: string; shortLine: string | null; availability: string; role: string }[];
  needs: { kind: string; line: string }[];
}

export interface NeedsLedger {
  apps: number;
  needs: { kind: string; line: string; count: number; apps: { name: string; team?: string; deploymentId: string | null; when: string | null }[]; firstSeen: string | null; lastSeen: string | null }[];
}

// An app's settings in the organization's store (PHASE2-PLAN Step 8): names, whether
// each is set, and who changed it. A value goes up once and never comes back.
export interface AppSetting {
  name: string;
  wanted: boolean;
  set: boolean;
  changedAt: string | null;
  changedBy: { name: string | null; email: string | null; surface: string; action: "set" | "removed" } | null;
}
export interface AppSettings { app: string; team: string; settings: AppSetting[] }

// GET /health: whether the platform answers, and the version it runs. No sign-in needed.
export interface Health { ok: boolean; version: string }

// POST /plans/validate (DESIGN.md, Oct 12): status and needs come only with a plan that
// meets the contract.
export interface ValidationError { code: string; message: string; path: string }
export interface Validation {
  valid: boolean;
  errors: ValidationError[];
  status?: "ready" | "drafted";
  needs?: { kind: string; line: string; evidence: { file: string; shows: string }[] }[];
}

// GET /deployments/{id}/evidence: the change record, the same object and file
// `sealeye evidence` reads. The object's shape is core/evidence-summary.js's business.
export interface Evidence { evidence: object; markdown: string }

const settingsPath = (app: string, team: string, name?: string) =>
  `/apps/${encodeURIComponent(app)}/settings${name ? `/${encodeURIComponent(name)}` : ""}?team=${encodeURIComponent(team)}`;

export const api = {
  signIn: (token: string) => request<Person & { expiresAt: string }>("/sessions", { method: "POST", body: { token } }),
  signOut: () => request<{ signedOut: boolean }>("/sessions", { method: "DELETE" }),
  whoami: () => request<Person>("/whoami"),
  deployments: () => request<{ deployments: DeploymentSummary[] }>("/deployments").then(r => r.deployments),
  deployment: (id: string) => request<DeploymentRecord>(`/deployments/${encodeURIComponent(id)}`),
  // POST /deployments with fromDeployment: the code that deployment packaged, again,
  // with its own plan or the one given. Nothing is uploaded; settings come from the store.
  deployAgain: (fromDeployment: string, plan?: unknown) =>
    request<DeploymentRecord>("/deployments", { method: "POST", body: { backend: "cloudformation", fromDeployment, ...(plan !== undefined ? { plan } : {}) } }),
  destroy: (id: string) => request<DeploymentRecord>(`/deployments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  health: () => request<Health>("/health"),
  validate: (plan: unknown) => request<Validation>("/plans/validate", { method: "POST", body: plan }),
  evidence: (id: string) => request<Evidence>(`/deployments/${encodeURIComponent(id)}/evidence`),
  catalog: () => request<Catalog>("/catalog"),
  needs: () => request<NeedsLedger>("/needs"),
  settings: (app: string, team: string) => request<AppSettings>(settingsPath(app, team)),
  setSetting: (app: string, team: string, name: string, value: string) =>
    request<{ set: boolean }>(settingsPath(app, team, name), { method: "PUT", body: { value } }),
  removeSetting: (app: string, team: string, name: string) =>
    request<{ set: boolean }>(settingsPath(app, team, name), { method: "DELETE" })
};
