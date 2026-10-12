// Validate a plan: paste or drop a sealeye.yaml and see what POST /plans/validate says,
// in the same words `sealeye validate` uses (core/plan-words.js). A plan with needs is
// drafted, never simply valid (principle 3). Checking changes nothing. A ready plan for
// an app whose code the platform already has can then be deployed with that code
// (PHASE2-PLAN Step 14, `sealeye deploy --again <app> -f sealeye.yaml`).
import { useEffect, useState } from "react";
import { Link } from "react-router";
import YAML from "yaml";
import { api, SignedOut, type DeploymentSummary, type Validation } from "../api";
import { useSession } from "../session";
import { plainValidationErrors } from "../../../core/plan-words.js";
import { PageTitle, Problem } from "../Layout";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

// A plan is a few hundred lines at most; anything far larger is not one.
const MAX_BYTES = 256 * 1024;

export function Validate() {
  const { signedOut, person } = useSession();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<Validation | null>(null);
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BYTES) return setProblem(`${file.name} is too large to be a plan.`);
    setText(await file.text());
    setFileName(file.name);
    setResult(null);
    setProblem(null);
  }

  async function check(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setProblem(null);
    let parsed: unknown;
    try {
      parsed = YAML.parse(text);
    } catch (err) {
      return setProblem(`This is not a plan the platform can read: ${(err as Error).message.split("\n")[0]}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return setProblem("This is not a plan the platform can read: a plan is a set of fields, like the sealeye.yaml seaLeye writes.");
    }
    setBusy(true);
    try {
      setResult(await api.validate(parsed));
      setPlan(parsed as Record<string, unknown>);
    } catch (err) {
      if (err instanceof SignedOut) return signedOut(err.message);
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const appName = (plan?.app as { name?: string } | undefined)?.name;

  return (
    <>
      <PageTitle title="Validate a plan" sub={<>Check a <code className="font-mono">sealeye.yaml</code> against the plan contract, as <code className="font-mono">sealeye validate</code> does. Nothing is built.</>} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Your plan</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={check} className="space-y-3 text-sm"
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); readFile(e.dataTransfer.files[0]); }}>
              <textarea
                aria-label="Plan"
                className="h-80 w-full resize-y rounded-md border border-rule bg-surface p-3 font-mono text-xs placeholder:text-dim focus-visible:outline-2 focus-visible:outline-phosphor"
                placeholder="Paste sealeye.yaml here, or drop the file on this box."
                value={text}
                onChange={e => { setText(e.target.value); setFileName(null); setResult(null); }}
                spellCheck={false}
              />
              <div className="flex flex-wrap items-center gap-3">
                <label className="cursor-pointer text-phosphor hover:underline">
                  Choose a file
                  <input type="file" accept=".yaml,.yml,text/yaml" className="sr-only" aria-label="Choose a plan file" onChange={e => readFile(e.target.files?.[0])} />
                </label>
                {fileName ? <span className="font-mono text-xs text-dim">{fileName}</span> : null}
                <Button type="submit" className="ml-auto" disabled={busy || !text.trim()}>{busy ? "Checking" : "Check it"}</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>What the platform says</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm" data-testid="validation">
            {problem ? <Problem message={problem} /> : null}
            {!problem && !result ? <p className="text-dim">Check a plan to see whether it can be built as written.</p> : null}
            {result && !result.valid ? (
              <>
                <p className="font-medium text-amber">This plan cannot be deployed as written:</p>
                <ul className="list-disc space-y-1 pl-5">
                  {plainValidationErrors(result.errors).map((line: string, i: number) => <li key={i}>{line}</li>)}
                </ul>
              </>
            ) : null}
            {result?.valid && result.status === "drafted" ? (
              <>
                <p className="font-medium text-amber">{appName ? <span className="font-mono">{appName}</span> : "This plan"}: it meets the contract, and it is drafted. It needs what the platform does not build yet:</p>
                <ul className="space-y-2">
                  {(result.needs || []).map(n => (
                    <li key={n.kind} data-testid="validation-need">
                      <div>{n.line}</div>
                      <div className="text-xs text-dim">{n.evidence.map(e => `${e.shows} (${e.file})`).join("; ")}</div>
                    </li>
                  ))}
                </ul>
                <p className="text-dim">Deploying it saves the draft. When your organization's Platform Library supports these, <code className="font-mono">sealeye run</code> again finishes the plan.</p>
              </>
            ) : null}
            {result?.valid && result.status !== "drafted" ? (
              <>
                <p className="font-medium text-phosphor">{appName ? <span className="font-mono">{appName}</span> : "This plan"}: valid and ready to deploy.</p>
                {appName ? <DeployPlan key={text} app={appName} plan={plan} team={person?.auth === "off" ? null : person?.team || "default"} /> : null}
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/**
 * Deploy a ready plan with the code the platform already has for its app: the newest
 * of the team's deployments of it whose code was packaged. With none, it says how the
 * code gets there. Nothing is deployed until the button is pressed.
 */
function DeployPlan({ app, plan, team }: { app: string; plan: unknown; team: string | null }) {
  const { signedOut } = useSession();
  const [source, setSource] = useState<DeploymentSummary | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ id: string; key: string } | null>(null);

  useEffect(() => {
    let live = true;
    api.deployments()
      .then(all => { if (live) setSource(all.find(d => d.app?.name === app && d.packaged && (team === null || (d.teamId || "default") === team)) || null); })
      .catch(err => { if (!live) return; if (err instanceof SignedOut) signedOut(err.message); else setError(err.message); setSource(null); });
    return () => { live = false; };
  }, [app, team, signedOut]);

  if (source === undefined) return <p className="text-dim">Looking for code the platform already has for {app}</p>;

  async function deploy() {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api.deployAgain(source.deploymentId, plan);
      setStarted({ id: made.deploymentId, key: made.stackName || made.environment || made.deploymentId });
    } catch (err) {
      if (err instanceof SignedOut) return signedOut(err.message);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (started) {
    return <p role="status" className="text-phosphor">Deploying as <span className="font-mono">{started.id}</span>. <Link className="underline" to={`/environments/${encodeURIComponent(started.key)}`}>Follow it in its environment</Link>.</p>;
  }
  return (
    <div className="space-y-3 border-t border-rule pt-3" data-testid="deploy-plan">
      {source ? (
        <>
          <p className="text-dim">Deploy this plan with the code <span className="font-mono text-ink">{source.packagedBy || source.deploymentId}</span> packaged. Nothing is uploaded and no .env is read: settings come from your organization's store.</p>
          <Button onClick={deploy} disabled={busy}>{busy ? "Asking the platform" : "Deploy this plan"}</Button>
        </>
      ) : (
        <p className="text-dim">The platform has no code for {app} yet. Run <code className="font-mono text-ink">sealeye run</code> in its folder to send it.</p>
      )}
      {error ? <Problem message={error} /> : null}
    </div>
  );
}
