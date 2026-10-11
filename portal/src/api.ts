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

export const api = {
  signIn: (token: string) => request<Person & { expiresAt: string }>("/sessions", { method: "POST", body: { token } }),
  signOut: () => request<{ signedOut: boolean }>("/sessions", { method: "DELETE" }),
  whoami: () => request<Person>("/whoami"),
  deployments: () => request<{ deployments: DeploymentSummary[] }>("/deployments").then(r => r.deployments),
  deployment: (id: string) => request<DeploymentRecord>(`/deployments/${encodeURIComponent(id)}`),
  destroy: (id: string) => request<DeploymentRecord>(`/deployments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  catalog: () => request<Catalog>("/catalog"),
  needs: () => request<NeedsLedger>("/needs")
};
