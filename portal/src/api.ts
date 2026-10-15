// Every call the portal makes, and nothing else: the same API the command uses, at
// /api on this origin. The session cookie travels by itself; every request carries the
// portal's header, which the API requires of a change made with the cookie.

export class SignedOut extends Error {}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public details?: unknown) {
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
  if (!res.ok) throw new ApiError(body?.error?.message || `The platform answered ${res.status}`, res.status, body?.error?.code, body?.error?.details);
  return body as T;
}

// scope: "team" sees that team's environments, "org" every team's in the organization
// (DESIGN.md, "Each team sees its own environments").
export interface Person { email: string; name: string; org: string; team: string; scope?: "team" | "org"; organizationName?: string; auth?: "off" }

// Discovery (PHASE4-PLAN Step 6): a run over the organization's platform library, the
// questions it asks, and the draft catalog it writes.
export interface DiscoveryQuestion {
  id: string; kind: string; question: string; options: string[]; guess: string; touches: string[];
  evidence: { file: string; line?: number; shows: string }[];
  answer: string | null; answeredBy: string | null; answeredAt: string | null; usedAt: string | null;
}
export interface DiscoverySummary {
  discoveryId: string; org: string; status: "running" | "finished" | "stopped" | "failed"; reason?: string; message?: string;
  startedBy: string | null; surface: string; repos: { repo: string; commit: string | null }[];
  modules: { source: string; id: string; status: string }[]; catalog: { version: number } | null; spent: number;
  createdAt: string; finishedAt: string | null;
}
export interface DiscoveryRun extends DiscoverySummary { questions: DiscoveryQuestion[] }
export interface DiscoveryEvent { seq: number; type: string; [key: string]: unknown }
export interface DraftModule {
  id: string; source: string; availability: string; line: string; when?: string; guidance?: string;
  inputs?: Record<string, { required: boolean; line?: string }>; open?: string[]; not_read?: string;
}
export interface DraftCatalog { modules: DraftModule[]; discovery?: { open?: string[] } }

export interface RequestedBy { user?: string; name?: string; host?: string | null; verified?: string; surface?: string; at?: string }

export interface DeploymentSummary {
  deploymentId: string;
  app: { name?: string; type?: string } | null;
  status: string;
  outputs: Record<string, string>;
  stackName: string | null;
  environment?: string | null;
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
  // Paused as of the last pause or resume made here (PHASE2-PLAN Step 17).
  paused?: boolean;
  pauses?: { action: "paused" | "resumed"; by: { name?: string; user?: string } | null; surface: string; at: string }[];
  fromDeployment?: string | null;
  packagedBy?: string | null;
  // What the platform is doing for it now, in a line, while it is under way.
  step?: string | null;
  // A failed first create whose remains are being removed (DESIGN.md).
  cleaningUp?: boolean;
  cleanupStartedAt?: string | null;
  // A successful deploy a newer one has since replaced; replacedBy names it when this
  // reader can see it.
  replaced?: boolean;
  replacedBy?: string | null;
}

export interface DeploymentRecord extends DeploymentSummary {
  plan?: Record<string, unknown>;
  stackStatus?: string | null;
}

export interface Catalog {
  // Which catalog this is (planVersion 0.5): the starter, or one of the organization's.
  catalog?: { version: number | "starter"; source: "starter" | "organization"; approvedBy: string | null; approvedAt: string | null; live?: boolean };
  modules: { id: string; line: string; shortLine: string | null; availability: string; role: string }[];
  needs: { kind: string; line: string }[];
}

export interface NeedsLedger {
  apps: number;
  needs: { kind: string; listed?: boolean; line: string; count: number; apps: { name: string; team?: string; deploymentId: string | null; when: string | null }[]; firstSeen: string | null; lastSeen: string | null }[];
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

// GET /deployments/{id}/plan: the plan a deployment was approved with, as the two files
// `sealeye run` writes (DEPLOYMENT_PLAN.md and sealeye.yaml), and its DEPLOYMENT_REPORT.md
// when it has one. `rebuilt` is a record from before plans were kept: its files are
// written from its plan, and the interview's notes are not in them.
export interface DeploymentPlan {
  deploymentId: string;
  app: string | null;
  status: string;
  failureReason: string | null;
  planSource: string | null;
  files: Record<string, string> | null;
  filesError?: string;
  notesKept?: boolean;
  rebuilt: boolean;
  report: string | null;
  reportError?: string;
}

// The interview (POST /interviews, its answers and its events), as `sealeye run` drives it.
export interface InterviewEvent {
  seq: number;
  type: "started" | "step" | "question" | "answered" | "plan" | "finished" | "failed";
  line?: string;
  question?: string;
  lead?: string[];
  number?: number;
  status?: string;
  plan?: Record<string, unknown> & { app?: { name?: string }; needs?: { kind: string; line: string; evidence: { file: string; shows: string }[] }[] };
  summary?: string;
  assumptions?: string[];
  questions?: number;
  traceId?: string;
  files?: Record<string, string>;
  filesError?: string;
  errors?: ValidationError[];
  message?: string;
}

// GET /deployments/{id}/logs: an environment's recent lines, newest first, masked.
export interface Logs { app: string | null; since: string; more: boolean; note?: string; lines: { at: string; message: string }[] }

// GET /team: the people on your team, from the tokens in use. Never a token.
export interface Team {
  team: string | null;
  everyTeam?: boolean;
  note?: string;
  people: { name: string | null; email: string; team: string; scope: "team" | "org"; issuedAt: string | null; lastUsedAt: string | null }[];
}

// GET /deployments/{id}/performance: readings over a window, per period and in total.
export interface Period { at: string; requests: number; errors: number; refused: number; averageMs: number | null; slowestMs: number | null }
export interface Performance {
  app: string | null; since: string; from: string; to: string; periodMinutes: number;
  totals: { requests: number; errors: number; refused: number; averageMs: number | null; slowestMs: number | null };
  periods: Period[];
}

// GET /costs: what each app has cost, by tag, about a day behind.
export interface Costs {
  since: string; from: string; to: string; unit: string; everyTeam: boolean; team: string | null;
  total: number; apps: { app: string; team: string; amount: number }[]; note: string; readAt: string;
}

// GET /interviews: this person's interviews still open, from either surface.
export interface OpenInterview { interviewId: string; app: string; status: "running" | "waiting"; waitingFor: string | null; startedAt: string; mode: string }

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
  openInterviews: () => request<{ interviews: OpenInterview[] }>("/interviews").then(r => r.interviews),
  // The findings go as file, line and rule, so the platform can say why those files
  // arrived empty; it scans again and answers with its own and these together.
  // Archives and files that are not text went as names only; the list says which.
  startInterview: (app: string, zip: string, deployed?: unknown, findings: { file: string; line: number; rule: string }[] = [], unread: string[] = []) =>
    request<{ interviewId: string; status: string; withheld?: string[]; findings?: { file: string; line: number; rule: string; kind: string }[] }>("/interviews", {
      method: "POST",
      body: { app, zip, ...(deployed ? { deployed } : {}), ...(findings.length ? { findings: findings.map(({ file, line, rule }) => ({ file, line, rule })) } : {}), ...(unread.length ? { unread } : {}) }
    }),
  answerInterview: (id: string, answer: string) =>
    request<{ status: string }>(`/interviews/${encodeURIComponent(id)}/answers`, { method: "POST", body: { answer } }),
  abandonInterview: (id: string) => request<{ removed: boolean }>(`/interviews/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Every event so far, then each as it comes, until the interview ends. */
  interviewEvents: (id: string, onEvent: (e: InterviewEvent) => void, onLost: () => void) => {
    const source = new EventSource(`/api/interviews/${encodeURIComponent(id)}/events`);
    for (const type of ["started", "step", "question", "answered", "plan", "finished", "failed"]) {
      source.addEventListener(type, ev => {
        const event = JSON.parse((ev as MessageEvent).data) as InterviewEvent;
        onEvent(event);
        if (type === "finished" || type === "failed") source.close();
      });
    }
    // The browser reconnects by itself, carrying the last event's id, and the API
    // replays what was missed. Only a stream that is closed for good is lost.
    source.onerror = () => { if (source.readyState === EventSource.CLOSED) onLost(); };
    return () => source.close();
  },
  // POST /deployments with an uploaded copy, as `sealeye run` sends it after a yes.
  deploy: (body: { plan: unknown; appPath: string; zip: string; expectStored: string[]; origin: unknown }) =>
    request<DeploymentRecord>("/deployments", { method: "POST", body: { backend: "cloudformation", ...body } }),
  destroy: (id: string) => request<DeploymentRecord>(`/deployments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  health: () => request<Health>("/health"),
  validate: (plan: unknown) => request<Validation>("/plans/validate", { method: "POST", body: plan }),
  paused: (id: string) => request<{ app: string | null; paused: boolean }>(`/deployments/${encodeURIComponent(id)}/paused`),
  setPaused: (id: string, paused: boolean) =>
    request<{ app: string | null; paused: boolean }>(`/deployments/${encodeURIComponent(id)}/${paused ? "pause" : "resume"}`, { method: "POST" }),
  logs: (id: string, since: string) => request<Logs>(`/deployments/${encodeURIComponent(id)}/logs?since=${encodeURIComponent(since)}`),
  evidence: (id: string) => request<Evidence>(`/deployments/${encodeURIComponent(id)}/evidence`),
  plan: (id: string) => request<DeploymentPlan>(`/deployments/${encodeURIComponent(id)}/plan`),
  team: () => request<Team>("/team"),
  costs: (since: string) => request<Costs>(`/costs?since=${encodeURIComponent(since)}`),
  performance: (id: string, since: string) => request<Performance>(`/deployments/${encodeURIComponent(id)}/performance?since=${encodeURIComponent(since)}`),
  catalog: () => request<Catalog>("/catalog"),
  // Discovery (PHASE4-PLAN Step 6b), as `sealeye discover` drives it. An
  // organization-wide token's only; the API refuses anyone else.
  discoveries: () => request<{ discoveries: DiscoverySummary[] }>("/discoveries").then(r => r.discoveries),
  discovery: (id: string) => request<DiscoveryRun>(`/discoveries/${encodeURIComponent(id)}`),
  discoveryDraft: (id: string) => request<{ version: number; document: DraftCatalog }>(`/discoveries/${encodeURIComponent(id)}/catalog`),
  startDiscovery: () => request<DiscoverySummary>("/discoveries", { method: "POST", body: {} }),
  answerDiscovery: (id: string, question: string, answer: string) =>
    request<{ question: DiscoveryQuestion }>(`/discoveries/${encodeURIComponent(id)}/answers`, { method: "POST", body: { question, answer } }).then(r => r.question),
  /** Every event so far, then each as it comes, until the run ends. */
  discoveryEvents: (id: string, onEvent: (e: DiscoveryEvent) => void, onEnd: () => void) => {
    const source = new EventSource(`/api/discoveries/${encodeURIComponent(id)}/events`);
    const types = ["started", "library", "modules", "reading", "read", "not_read", "question", "answered", "writing", "draft", "answers_used", "answer_not_used", "finished", "stopped", "failed"];
    for (const type of types) {
      source.addEventListener(type, ev => {
        onEvent(JSON.parse((ev as MessageEvent).data) as DiscoveryEvent);
        if (type === "finished" || type === "stopped" || type === "failed") { source.close(); onEnd(); }
      });
    }
    // The browser reconnects by itself through a blip, carrying the last event's id, and
    // the API replays what was missed. Either way the page reads the run again: one that
    // is over (a restart stops it) stops being followed, one still going is picked up.
    source.onerror = () => onEnd();
    return () => source.close();
  },
  needs: () => request<NeedsLedger>("/needs"),
  settings: (app: string, team: string) => request<AppSettings>(settingsPath(app, team)),
  setSetting: (app: string, team: string, name: string, value: string) =>
    request<{ set: boolean }>(settingsPath(app, team, name), { method: "PUT", body: { value } }),
  removeSetting: (app: string, team: string, name: string) =>
    request<{ set: boolean }>(settingsPath(app, team, name), { method: "DELETE" })
};
