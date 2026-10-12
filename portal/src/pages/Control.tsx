// Control: one environment. Its state as the platform reports it, the way to tear it
// down (the same DELETE /deployments/{id} `sealeye destroy` uses; the record says it
// came from the portal), its settings, everything that has been done to it, and the
// change record for any of those deployments (`sealeye evidence`).
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { api, SignedOut, type DeploymentSummary, type Evidence, type Logs } from "../api";
import { evidenceSummary } from "../../../core/evidence-summary.js";
import { PerformanceCard } from "./PerformanceCard";
import { RETENTION_CHOICES, retentionOf, withRetention } from "../../../core/retention.js";
import { useLoad, useSession } from "../session";
import { addressOf, ago, changedAt, doing, elapsed, groupEnvironments, IN_FLIGHT, lockedWhile, statusOf, underWay, when, who } from "../model";
import { PageTitle, Problem } from "../Layout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const POLL_MS = 5000;

/** The time now, ticking every second while `on`, so elapsed times count up. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return on ? now : Date.now();
}

export function Control() {
  const { person } = useSession();
  const key = decodeURIComponent(useParams().key || "");
  const deployments = useLoad(api.deployments, [key]);
  const env = useMemo(() => groupEnvironments(deployments.data || []).find(e => e.key === key) || null, [deployments.data, key]);
  const latest = env?.latest;
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
  // A change under way locks everything that would change the environment, as the API
  // refuses a second change (ENVIRONMENT_BUSY), and says so on each card.
  // Usually the newest record, but a tear-down asked through an older one is under way
  // on that one: the API refuses on either, so the page locks on either.
  const busyDep = env?.deploys.find(d => underWay(d)) || null;
  const moving = Boolean(busyDep);
  const now = useNow(moving);
  const locked = busyDep ? lockedWhile(busyDep, now) : null;

  // The tab says so too, for someone who has gone to another one.
  useEffect(() => {
    if (!env) return;
    document.title = busyDep ? `${doing(busyDep).title} · ${env.app}` : `${env.app} · seaLeye.online`;
    return () => { document.title = "seaLeye.online"; };
  }, [env, busyDep]);

  // While anything is moving, read it again every five seconds, as `sealeye watch` does.
  // Keyed on the data, not the render: the elapsed clock re-renders every second, and a
  // timer restarted on each render would never fire.
  // A failed read re-arms it too, so the page recovers when the API is back.
  const inFlight = Boolean(env?.deploys.some(d => IN_FLIGHT.has(d.status) && !d.interrupted));
  const { reload } = deployments;
  useEffect(() => {
    if (!inFlight) return;
    const t = setTimeout(reload, POLL_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlight, deployments.data, deployments.error]);

  // While a change is being followed, a failed read keeps the last page and says so;
  // the next read puts it right.
  if (deployments.error && !(inFlight && deployments.data)) return <Problem message={deployments.error} />;
  if (!deployments.data) return <p className="text-dim">Loading</p>;
  if (!env || !latest) {
    return (
      <>
        <PageTitle title="Not found" sub={<>The platform has no environment called <span className="font-mono">{key}</span> that you can see.</>} />
        <Link to="/" className="text-phosphor hover:underline">Back to Environments</Link>
      </>
    );
  }

  const status = statusOf(latest);
  // The environment's address: the latest deployment's, or while a new one is under way,
  // the one it still answers at.
  const url = addressOf(env);
  const canTearDown = !["destroyed", "destroying", "drafted"].includes(latest.status);
  // The newest deployment whose code was packaged: what Deploy again runs. Only the
  // environment's own team may (an organization-wide token sees other teams' too).
  const code = latest.kind === "static" ? null : env.deploys.find(d => d.packaged) || null;
  const ownTeam = !person || person.auth === "off" || (latest.teamId || "default") === person.team;

  return (
    <>
      <div className="mb-2 text-sm"><Link to="/" className="text-dim hover:text-ink">Environments</Link></div>
      <PageTitle
        title={<span className="font-mono">{env.app}</span>}
        sub={[
          latest.kind === "static" ? "A static site" : latest.kind === "api" ? "An API" : null,
          latest.profile ? `designed for ${latest.profile}` : null,
          // An organization-wide token sees every team's: say whose this one is.
          person?.scope === "org" ? `team ${latest.teamId || "default"}` : null
        ].filter(Boolean).join(", ") || undefined}
      />

      {deployments.error ? <Problem message={`${deployments.error} Trying again.`} /> : null}
      {busyDep ? <UnderWay dep={busyDep} app={env.app} now={now} /> : null}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>State</CardTitle><Badge tone={status.tone} moving={busyDep === latest} className="ml-auto" data-testid="status">{status.label}</Badge></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
              <dt className="text-dim">Address</dt>
              <dd>{url ? <a href={url} target="_blank" rel="noreferrer" className="font-mono text-xs text-phosphor hover:underline break-all">{url}</a> : <span className="text-dim">None yet</span>}</dd>
              <dt className="text-dim">Last change</dt>
              <dd>{when(latest.startedAt)} <span className="text-dim">({ago(latest.startedAt)})</span></dd>
              <dt className="text-dim">Requested by</dt>
              <dd>{who(latest.requestedBy)} <span className="text-dim">from the {latest.surface === "portal" ? "portal" : "command line"}</span></dd>
              {latest.destroyRequestedBy ? (<>
                <dt className="text-dim">Tear down asked by</dt>
                <dd>{who(latest.destroyRequestedBy)} <span className="text-dim">from the {latest.destroyRequestedBy.surface === "portal" ? "portal" : "command line"}, {ago(latest.destroyRequestedBy.at)}</span></dd>
              </>) : null}
              {latest.failureReason ? (<>
                <dt className="text-dim">What went wrong</dt>
                <dd className="text-amber">{latest.failureReason}</dd>
              </>) : null}
              {latest.interrupted ? (<>
                <dt className="text-dim">Note</dt>
                <dd className="text-amber">The platform restarted while this was under way and has not confirmed how it ended.</dd>
              </>) : null}
            </dl>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
        {code && ownTeam ? (
          <Card data-testid="deploy-again">
            <CardHeader><CardTitle>Deploy again</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className="text-dim">Deploys the code <span className="font-mono text-ink">{code.packagedBy || code.deploymentId}</span> packaged again, with the plan it had. Nothing is uploaded and no .env is read: settings come from your organization's store.</p>
              <DeployAgain app={env.app} fromDeployment={code.deploymentId} packagedBy={code.packagedBy || code.deploymentId} locked={locked} onDone={deployments.reload} />
            </CardContent>
          </Card>
        ) : null}
        {latest.kind !== "static" && latest.stackName && !["destroyed", "destroying"].includes(latest.status) ? (
          <PauseCard deploymentId={latest.deploymentId} app={env.app} pauses={env.deploys.flatMap(d => d.pauses || [])} locked={locked} onDone={deployments.reload} />
        ) : null}
        <Card>
          <CardHeader><CardTitle>Tear down</CardTitle></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-dim">Removes this environment and everything the platform built for it. The address stops working. The plan stays in the developer's folder, so <code className="font-mono text-ink">sealeye run</code> can build it again.</p>
            {canTearDown ? <TearDown app={env.app} deploymentId={(env.deploys.find(d => d.stackName) || latest).deploymentId} locked={locked} onDone={deployments.reload} /> : (
              <p className="text-dim">{latest.status === "drafted" ? "Nothing was built for a drafted plan, so there is nothing to tear down." : "There is nothing standing to tear down."}</p>
            )}
          </CardContent>
        </Card>
        </div>
      </div>

      {latest.kind !== "static" ? <Settings app={env.app} team={latest.teamId || "default"} moving={moving} /> : null}

      {latest.kind !== "static" && code && ownTeam ? (
        <Configure fromDeployment={code.deploymentId} locked={locked} onDone={deployments.reload} />
      ) : null}

      <Card className="mt-6">
        <CardHeader><CardTitle>What has been done to this app</CardTitle></CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Deployment</TableHead><TableHead>Status</TableHead><TableHead>Started</TableHead><TableHead>By</TableHead><TableHead>From</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {env.deploys.map(d => {
              const s = statusOf(d);
              const live = underWay(d, now);
              return (
                <TableRow key={d.deploymentId} data-testid="history-row" data-under-way={live ? "" : undefined}
                  className={live ? "bg-phosphor-chip/40 shadow-[inset_3px_0_0_var(--color-phosphor)]" : undefined}>
                  <TableCell className="font-mono text-xs">
                    {d.deploymentId}
                    {d.fromDeployment ? <div className="font-sans text-dim">again, with {d.packagedBy || d.fromDeployment}'s code</div> : null}
                  </TableCell>
                  <TableCell>
                    <Badge tone={s.tone} moving={live}>{s.label}</Badge>
                    {live && d.step ? <div className="mt-1 max-w-xs text-xs text-dim" data-testid="history-step">{d.step}</div> : null}
                    {d.replaced ? <div className="mt-1 text-xs text-dim" data-testid="replaced-by">{d.replacedBy ? <>by <span className="font-mono">{d.replacedBy}</span></> : "by a newer deploy"}</div> : null}
                  </TableCell>
                  <TableCell className="text-xs">{when(d.startedAt)}</TableCell>
                  <TableCell>{who(d.requestedBy)}</TableCell>
                  <TableCell className="text-dim">{d.surface === "portal" ? "Portal" : "Command line"}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" aria-label={`Evidence for ${d.deploymentId}`} onClick={() => {
                      setEvidenceFor(d.deploymentId);
                      document.getElementById("evidence")?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}>Evidence</Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {latest.kind !== "static" && env.deploys.some(d => d.stackName) ? <PerformanceCard deploymentId={(env.deploys.find(d => d.stackName) || latest).deploymentId} /> : null}

      {latest.kind !== "static" && env.deploys.some(d => d.stackName) ? <LogsCard deploymentId={(env.deploys.find(d => d.stackName) || latest).deploymentId} /> : null}

      <EvidenceCard key={evidenceFor || latest.deploymentId} deploymentId={evidenceFor || latest.deploymentId} latest={!evidenceFor || evidenceFor === latest.deploymentId} />
    </>
  );
}

/**
 * Pause and resume, as `sealeye pause` and `sealeye resume` do: the API stops taking
 * requests and starts again. What it shows is read from AWS when the page opens and
 * after every change.
 */
function PauseCard({ deploymentId, app, pauses, locked, onDone }: { deploymentId: string; app: string; pauses: NonNullable<DeploymentSummary["pauses"]>; locked: string | null; onDone: () => void }) {
  const { signedOut } = useSession();
  const [paused, setPausedState] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.paused(deploymentId)
      .then(r => { if (live) setPausedState(r.paused); })
      .catch(err => { if (!live) return; if (err instanceof SignedOut) signedOut(err.message); else setError(err.message); });
    return () => { live = false; };
  }, [deploymentId, signedOut]);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      setPausedState((await api.setPaused(deploymentId, next)).paused);
      onDone();
    } catch (err) {
      if (err instanceof SignedOut) return signedOut(err.message);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const last = [...pauses].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  return (
    <Card data-testid="pause">
      <CardHeader>
        <CardTitle>Pause</CardTitle>
        {paused === null ? null : <Badge tone={paused ? "amber" : "phosphor"} className="ml-auto" data-testid="pause-state">{paused ? "Paused" : "Taking requests"}</Badge>}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-dim">{paused
          ? `${app} takes no requests until it is resumed. Nothing else changes, and nothing is removed.`
          : `Stops ${app} taking requests, without removing anything. Resume puts it back as it was.`}</p>
        {last ? <p className="text-dim">{last.action === "paused" ? "Paused" : "Resumed"} by {who(last.by)} from the {last.surface === "portal" ? "portal" : "command line"}, {ago(last.at)}.</p> : null}
        {paused === null ? null : paused
          ? <Button onClick={() => change(false)} disabled={busy || Boolean(locked)}>{busy ? "Asking the platform" : "Resume"}</Button>
          : <Button variant="ghost" onClick={() => change(true)} disabled={busy || Boolean(locked)}>{busy ? "Asking the platform" : "Pause"}</Button>}
        {locked ? <Locked text={locked} /> : null}
        {error ? <Problem message={error} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * Configure, as `sealeye config` does: how long the app's logs are kept. Changing it is a
 * deploy of the same code again with the plan changed, so it says so, and the history
 * shows it. Settings are the card above.
 */
function Configure({ fromDeployment, locked, onDone }: { fromDeployment: string; locked: string | null; onDone: () => void }) {
  const { signedOut } = useSession();
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.deployment(fromDeployment)
      .then(r => { if (live && r.plan) { setPlan(r.plan); setDays(retentionOf(r.plan)); } })
      .catch(err => { if (!live) return; if (err instanceof SignedOut) signedOut(err.message); else setError(err.message); });
    return () => { live = false; };
  }, [fromDeployment, signedOut]);

  const now = plan ? retentionOf(plan) : null;
  async function apply() {
    if (!plan || days === null || days === now) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api.deployAgain(fromDeployment, withRetention(plan, days));
      setDone(`Deploying again as ${made.deploymentId}, with logs kept for ${days} days. The app's sealeye.yaml still says ${now}: change it there too, or the next sealeye run puts it back.`);
      onDone();
    } catch (err) {
      if (err instanceof SignedOut) return signedOut(err.message);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6" data-testid="configure">
      <CardHeader><CardTitle>Configure</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        {now === null ? <p className="text-dim">Reading the plan this environment was built from</p> : (
          <>
            <p className="text-dim">Logs are kept for <span className="text-ink">{now} days</span>. Changing it deploys the same code again with the plan changed; nothing is uploaded.</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1">
                <span className="text-dim">Keep logs for</span>
                <select aria-label="Keep logs for" className="h-9 rounded-md border border-rule bg-surface px-3 disabled:opacity-50" value={days ?? now} disabled={Boolean(locked)}
                  onChange={e => setDays(Number(e.target.value))}>
                  {RETENTION_CHOICES.map((d: number) => <option key={d} value={d}>{d === 1 ? "1 day" : `${d} days`}</option>)}
                </select>
              </label>
              <Button onClick={apply} disabled={busy || Boolean(locked) || days === now}>{busy ? "Asking the platform" : "Deploy with this"}</Button>
            </div>
            {locked ? <Locked text={locked} /> : null}
          </>
        )}
        {done ? <p role="status" className="text-phosphor">{done}</p> : null}
        {error ? <Problem message={error} /> : null}
      </CardContent>
    </Card>
  );
}

const WINDOWS: [string, string][] = [["15m", "15 minutes"], ["1h", "hour"], ["6h", "6 hours"], ["1d", "day"]];

/**
 * What the app wrote, as `sealeye logs` shows it: the most recent lines over a window,
 * newest first, with anything that looks like a secret taken out by the platform. Read
 * when asked, since it asks AWS.
 */
function LogsCard({ deploymentId }: { deploymentId: string }) {
  const { signedOut } = useSession();
  const [since, setSince] = useState("1h");
  const [logs, setLogs] = useState<Logs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read(window = since) {
    setBusy(true);
    setError(null);
    try {
      setLogs(await api.logs(deploymentId, window));
    } catch (err) {
      if (err instanceof SignedOut) return signedOut(err.message);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const words = WINDOWS.find(([k]) => k === since)?.[1] || since;
  return (
    <Card className="mt-6" data-testid="logs">
      <CardHeader>
        <CardTitle>Logs</CardTitle>
        <div className="ml-auto flex flex-wrap gap-1" role="group" aria-label="How far back">
          {WINDOWS.map(([key, label]) => (
            <Button key={key} size="sm" variant={key === since ? "primary" : "ghost"} aria-pressed={key === since}
              onClick={() => { setSince(key); if (logs) read(key); }}>{label === "hour" ? "1 hour" : label === "day" ? "1 day" : label}</Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!logs ? (
          <>
            <p className="text-dim">What your app wrote, newest first, as <code className="font-mono text-ink">sealeye logs</code> shows it. Anything that looks like a secret, and the value of any setting in the store, is taken out before it reaches this page; a value printed on its own, with no name beside it, cannot be told from other text.</p>
            <Button onClick={() => read()} disabled={busy}>{busy ? "Reading your app's logs" : "Show logs"}</Button>
          </>
        ) : (
          <>
            {logs.note ? <p className="text-dim">{logs.note}</p> : null}
            {!logs.note && !logs.lines.length ? <p className="text-dim">Nothing in the last {words}.</p> : null}
            {logs.lines.length ? (
              <ol className="max-h-[32rem] overflow-auto rounded-md border border-rule bg-ground p-3 font-mono text-xs" data-testid="log-lines">
                {logs.lines.map((l, i) => (
                  <li key={i} className="flex gap-3 py-0.5"><span className="shrink-0 text-dim">{new Date(l.at).toLocaleTimeString()}</span><span className="whitespace-pre-wrap break-all">{l.message}</span></li>
                ))}
              </ol>
            ) : null}
            {logs.more ? <p className="text-dim">Only the most recent lines are shown. A shorter window shows fewer.</p> : null}
            <Button variant="ghost" onClick={() => read()} disabled={busy}>{busy ? "Reading" : "Read again"}</Button>
          </>
        )}
        {error ? <Problem message={error} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * The change record for one deployment: what `sealeye evidence` prints, and the same
 * DEPLOYMENT_EVIDENCE.md it writes, to download. Read only when asked, because reading
 * it asks AWS what it says now and sends one GET to the app's own address. It changes
 * nothing and creates nothing.
 */
function EvidenceCard({ deploymentId, latest }: { deploymentId: string; latest: boolean }) {
  const { signedOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<Evidence | null>(null);

  async function read() {
    setBusy(true);
    setError(null);
    try {
      setRecord(await api.evidence(deploymentId));
    } catch (err) {
      if (err instanceof SignedOut) return signedOut(err.message);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!record) return;
    const url = URL.createObjectURL(new Blob([record.markdown], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "DEPLOYMENT_EVIDENCE.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  const summary = record ? evidenceSummary(record.evidence, { name: "seaLeye", command: "sealeye" }) : null;

  return (
    <Card className="mt-6 scroll-mt-6" id="evidence" data-testid="evidence">
      <CardHeader>
        <CardTitle>Evidence</CardTitle>
        <span className="ml-auto font-mono text-xs text-dim">{deploymentId}{latest ? " (the latest)" : ""}</span>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!summary ? (
          <>
            <p className="text-dim">The change record for this deployment, as <code className="font-mono text-ink">sealeye evidence</code> writes it: who asked, the plan they approved, what was built, and what AWS says about it now. Reading it changes nothing.</p>
            <Button onClick={read} disabled={busy}>{busy ? "Reading the record and asking AWS what it says now" : "Read the evidence"}</Button>
          </>
        ) : (
          <>
            <p className="font-medium">{summary.title}</p>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
              {summary.rows.map((r: { label: string; text: string; alarm: boolean }) => (
                <div key={r.label} className="contents" data-testid="evidence-row">
                  <dt className="text-dim">{r.label}</dt>
                  <dd className={r.alarm ? "text-amber" : undefined}>{r.text}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap gap-3">
              <Button onClick={download}>Download DEPLOYMENT_EVIDENCE.md</Button>
              <Button variant="ghost" onClick={read} disabled={busy}>{busy ? "Reading" : "Read it again"}</Button>
            </div>
            <details>
              <summary className="cursor-pointer text-dim hover:text-ink">The whole record</summary>
              <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-rule bg-ground p-4 font-mono text-xs" data-testid="evidence-markdown">{record!.markdown}</pre>
            </details>
          </>
        )}
        {error ? <Problem message={error} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * The app's settings, as `sealeye settings` shows them (PHASE2-PLAN Step 8): which the
 * plan asks for, whether each is stored, and who changed it. A value can be put in, and
 * is never shown again: the field is cleared the moment it is sent.
 */
function Settings({ app, team, moving }: { app: string; team: string; moving: boolean }) {
  const settings = useLoad(() => api.settings(app, team), [app, team]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { signedOut } = useSession();

  async function act(run: () => Promise<unknown>, said: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await run();
      setDone(said);
      settings.reload();
    } catch (err) {
      if (err instanceof SignedOut) return signedOut(err.message);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    const v = value;
    setValue("");
    if (!n || !v) return setError("Give the setting a name and a value.");
    act(() => api.setSetting(app, team, n, v), `${n} is stored. The environment reads it the next time it is deployed.`);
  }

  const missing = (settings.data?.settings || []).filter(x => x.wanted && !x.set).map(x => x.name);

  return (
    <Card className="mt-6" data-testid="settings">
      <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-dim">Kept in your organization's store, encrypted. A value is never shown again, here or anywhere.</p>
        {moving ? <p className="text-dim" data-testid="settings-while-moving">Storing a value changes nothing that is running, so this stays open. The change under way may already have read its settings: a value stored now is certain to reach the environment at its next deploy.</p> : null}
        {settings.error ? <Problem message={settings.error} /> : null}
        {settings.data && settings.data.settings.length === 0 ? <p className="text-dim">No settings are stored, and the latest plan asks for none.</p> : null}
        {settings.data && settings.data.settings.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Changed</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {settings.data.settings.map(x => (
                <TableRow key={x.name} data-testid="setting-row">
                  <TableCell className="font-mono text-xs">{x.name}{x.wanted ? null : <span className="ml-2 text-dim">not in the latest plan</span>}</TableCell>
                  <TableCell><Badge tone={x.set ? "phosphor" : "amber"}>{x.set ? "Set" : "Not set"}</Badge></TableCell>
                  <TableCell className="text-xs text-dim">{x.changedAt ? `${ago(x.changedAt)}${x.changedBy?.name ? ` by ${x.changedBy.name}` : ""}` : "Never"}</TableCell>
                  <TableCell className="text-right">
                    {x.set ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => api.removeSetting(app, team, x.name), `${x.name} is no longer stored.`)}>Remove</Button> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        <form onSubmit={save} className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1">
            <span className="text-dim">Name</span>
            <Input className="font-mono w-56" list="wanted-settings" value={name} onChange={e => setName(e.target.value)} aria-label="Setting name" autoComplete="off" />
            <datalist id="wanted-settings">{missing.map(n => <option key={n} value={n} />)}</datalist>
          </label>
          <label className="grid gap-1">
            <span className="text-dim">Value</span>
            <Input className="font-mono w-72" type="password" value={value} onChange={e => setValue(e.target.value)} aria-label="Setting value" autoComplete="off" data-1p-ignore="" data-lpignore="true" data-bwignore="true" />
          </label>
          <Button type="submit" disabled={busy}>{busy ? "Storing" : "Store it"}</Button>
        </form>
        {done ? <p role="status" className="text-phosphor">{done}</p> : null}
        {error ? <Problem message={error} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * Deploy again: one confirmation, because it changes a live environment, then the same
 * POST /deployments `sealeye deploy --again` sends. A refusal is the platform's sentence.
 */
function DeployAgain({ app, fromDeployment, packagedBy, locked, onDone }: { app: string; fromDeployment: string; packagedBy: string; locked: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signedOut } = useSession();

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.deployAgain(fromDeployment);
      setOpen(false);
      onDone();
    } catch (err) {
      if (err instanceof SignedOut) signedOut("Your sign-in has ended. Sign in again with your token.");
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (locked) return <><Button disabled>Deploy again</Button><Locked text={locked} /></>;
  return (
    <>
      <Dialog open={open} onOpenChange={o => { setOpen(o); setError(null); }}>
        <DialogTrigger asChild><Button>Deploy again</Button></DialogTrigger>
        <DialogContent>
          <DialogTitle>Deploy {app} again?</DialogTitle>
          <DialogDescription>The code <span className="font-mono text-ink">{packagedBy}</span> packaged goes to this environment again, with its plan. Settings come from your organization's store.</DialogDescription>
          {error ? <div className="mt-3"><Problem message={error} /></div> : null}
          <div className="mt-5 flex justify-end gap-3">
            <DialogClose asChild><Button variant="ghost">Not now</Button></DialogClose>
            <Button disabled={busy} onClick={confirm}>{busy ? "Asking the platform" : "Deploy it"}</Button>
          </div>
        </DialogContent>
      </Dialog>
      {error && !open ? <Problem message={error} /> : null}
    </>
  );
}

/** A tear-down is asked for twice: once with the button, once by typing the app's name. */
function TearDown({ app, deploymentId, locked, onDone }: { app: string; deploymentId: string; locked: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signedOut } = useSession();

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.destroy(deploymentId);
      setOpen(false);
      onDone();
    } catch (err) {
      if (err instanceof SignedOut) signedOut("Your sign-in has ended. Sign in again with your token.");
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (locked) return <><Button variant="danger" disabled>Tear down</Button><Locked text={locked} /></>;
  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); setTyped(""); setError(null); }}>
      <DialogTrigger asChild><Button variant="danger">Tear down</Button></DialogTrigger>
      <DialogContent>
        <DialogTitle>Tear down {app}?</DialogTitle>
        <DialogDescription>Everything the platform built for it is removed, and its address stops working. Type <span className="font-mono text-ink">{app}</span> to confirm.</DialogDescription>
        <Input className="mt-4 font-mono" aria-label="Type the app's name to confirm" value={typed} onChange={e => setTyped(e.target.value)} autoFocus />
        {error ? <div className="mt-3"><Problem message={error} /></div> : null}
        <div className="mt-5 flex justify-end gap-3">
          <DialogClose asChild><Button variant="ghost">Keep it</Button></DialogClose>
          <Button variant="danger" disabled={typed !== app || busy} onClick={confirm}>{busy ? "Asking the platform" : "Tear it down"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Why a card that would change the environment cannot just now. */
function Locked({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-dim" data-testid="locked">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="mt-0.5 size-3.5 shrink-0 fill-current"><path d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 1 0-3 0v2Z" /></svg>
      <span>{text}</span>
    </p>
  );
}

/**
 * The banner across the top while a change is under way: what it is, the step the
 * platform is on now (the same line `sealeye watch` prints), how long it has taken,
 * and who started it. The page reads it again every five seconds.
 */
function UnderWay({ dep, app, now }: { dep: DeploymentSummary; app: string; now: number }) {
  const what = doing(dep);
  const by = dep.status === "destroying" ? dep.destroyRequestedBy : dep.requestedBy;
  const from = (dep.status === "destroying" ? dep.destroyRequestedBy?.surface : dep.surface) === "portal" ? "the portal" : "the command line";
  return (
    <section aria-label="Under way" aria-live="polite" data-testid="under-way" className="mb-6 overflow-hidden rounded-lg border border-phosphor/30 bg-surface">
      <div className="relative h-1 overflow-hidden bg-phosphor-chip" aria-hidden="true">
        <div className="sealeye-sweep absolute inset-y-0 left-0 w-1/4 rounded-full bg-phosphor" />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-4">
        <span className="font-semibold">{what.title} <span className="font-mono">{app}</span></span>
        <span className="font-mono text-sm text-dim" data-testid="under-way-elapsed">{elapsed(changedAt(dep), now)}</span>
        <p className="w-full text-sm" data-testid="under-way-step">{dep.step || "Waiting for the platform's first step"}</p>
        <p className="w-full text-xs text-dim">
          <span className="font-mono">{dep.deploymentId}</span>{dep.fromDeployment ? ", deployed again" : ""}, started by {who(by)} from {from}.
          {" "}This page follows it as it goes; you can leave and come back, or follow it with <code className="font-mono text-ink">sealeye watch {dep.deploymentId}</code>.
        </p>
      </div>
    </section>
  );
}
