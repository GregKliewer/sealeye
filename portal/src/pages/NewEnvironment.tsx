// New environment: `sealeye run`, in the browser (PHASE2-PLAN Step 15). The developer
// chooses their app's folder; it is read here by the command's own rules and sent with
// secret files as names only. The interview runs in the API as it does for the command:
// its lines, its questions, the plan and its two files, then "Deploy this?". A yes
// deploys through the same POST /deployments, every setting from the organization's
// store; a no keeps the plan for the developer to download.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api, ApiError, SignedOut, type Catalog, type InterviewEvent } from "../api";
import { useSession } from "../session";
import { appNameOf, canPickFolder, emptyZip, folderFromDrop, folderFromInput, pack, pickFolder, UploadRefused, type ChosenFolder } from "../upload";
import { plainValidationErrors } from "../../../core/plan-words.js";
import { settingNamesFor } from "../../../core/setting-names.js";
import { PageTitle, Problem } from "../Layout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";

// As core/names.js safeName has it: how an app's name is compared everywhere.
const safeName = (name: string) => String(name || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

type Phase = "choose" | "interview" | "plan" | "declined" | "settings" | "deploying" | "refused" | "ended";
type Line = { kind: "step"; text: string } | { kind: "question"; text: string; lead: string[]; answer?: string };
type Need = { kind: string; line: string; evidence: { file: string; shows: string }[] };

export function NewEnvironment() {
  const { person, signedOut } = useSession();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("choose");
  const [folder, setFolder] = useState<ChosenFolder | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [asking, setAsking] = useState<{ text: string } | null>(null);
  const [reply, setReply] = useState("");
  const [plan, setPlan] = useState<InterviewEvent | null>(null);
  const [ending, setEnding] = useState<InterviewEvent | null>(null);
  const [withheld, setWithheld] = useState<string[]>([]);
  const [redeploy, setRedeploy] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [stored, setStored] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<{ needs: Need[]; deploymentId?: string } | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const interviewId = useRef<string | null>(null);
  const answered = useRef(false);
  const stop = useRef<() => void>(() => {});

  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => {});
    // Leaving mid-interview drops it, so the API keeps nothing of the app.
    return () => {
      stop.current();
      if (interviewId.current && !answered.current) api.abandonInterview(interviewId.current).catch(() => {});
    };
  }, []);

  const fail = (err: unknown) => {
    if (err instanceof SignedOut) return signedOut(err.message);
    setProblem(err instanceof Error ? err.message : String(err));
  };

  function choose(chosen: ChosenFolder | null) {
    if (!chosen) return;
    setFolder(chosen);
    setProblem(null);
  }

  async function start() {
    if (!folder) return;
    setProblem(null);
    setBusy("Reading your folder here, by the command's rules");
    try {
      const packed = await pack(folder, "interview");
      setWithheld(packed.withheld);

      // With the app already running for this team, the interview asks about what changed.
      const app = safeName(await appNameOf(folder));
      const live = (await api.deployments()).find(d =>
        d.status === "succeeded" && safeName(d.app?.name || "") === app && (person?.auth === "off" || (d.teamId || "default") === person?.team));
      const deployed = live ? (await api.deployment(live.deploymentId)).plan : undefined;
      setRedeploy(live ? app : null);

      setBusy("Handing your app to the platform");
      const started = await api.startInterview(folder.name, packed.zip, deployed);
      interviewId.current = started.interviewId;
      setPhase("interview");
      stop.current = api.interviewEvents(started.interviewId, onEvent, () => setProblem("The platform stopped answering about this interview. Start again."));
    } catch (err) {
      if (err instanceof UploadRefused) setProblem(err.message);
      else fail(err);
    } finally {
      setBusy(null);
    }
  }

  function onEvent(event: InterviewEvent) {
    if (event.type === "step" && event.line) setLines(l => [...l, { kind: "step", text: event.line! }]);
    if (event.type === "question") {
      setLines(l => [...l, { kind: "question", text: event.question || "", lead: event.lead || [] }]);
      setAsking({ text: event.question || "" });
    }
    if (event.type === "plan") {
      setPlan(event);
      setPhase("plan");
    }
    if (event.type === "finished" && !answered.current) {
      // Ended without a plan to say yes to: a plan that would not fit the contract, or
      // an interview that stopped.
      if (event.status !== "submitted") { setEnding(event); setPhase("ended"); }
    }
    if (event.type === "failed" && !answered.current) {
      setEnding(event);
      setPhase("ended");
    }
  }

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!interviewId.current || !asking) return;
    const answer = reply.trim();
    setReply("");
    setAsking(null);
    setLines(l => l.map((line, i) => (i === l.length - 1 && line.kind === "question" ? { ...line, answer } : line)));
    try {
      await api.answerInterview(interviewId.current, answer);
    } catch (err) {
      fail(err);
    }
  }

  async function decide(yes: boolean) {
    // Once only: a second click must not deploy twice.
    if (!interviewId.current || !plan?.plan || answered.current) return;
    answered.current = true;
    setPhase(yes ? "deploying" : "declined");
    await api.answerInterview(interviewId.current, yes ? "y" : "n").catch(() => {});
    if (!yes) return setPhase("declined");

    // A drafted plan is refused and saved; there is nothing to store settings for.
    const drafted = ((plan.plan.needs as unknown[]) || []).length > 0;
    // Every setting comes from the store here: there is no .env to read.
    const wanted = drafted ? [] : settingNamesFor(plan.plan);
    if (wanted.length) {
      try {
        const have = await api.settings(String(plan.plan.app?.name || ""), person?.team || "default");
        const set = have.settings.filter(x => x.set).map(x => x.name);
        setStored(wanted.filter(n => set.includes(n)));
        const absent = wanted.filter(n => !set.includes(n));
        if (absent.length) {
          setMissing(absent);
          return setPhase("settings");
        }
      } catch (err) {
        return fail(err);
      }
    }
    await deploy(wanted);
  }

  async function deploy(expectStored: string[]) {
    if (!folder || !plan?.plan) return;
    setPhase("deploying");
    setProblem(null);
    try {
      const drafted = ((plan.plan.needs as unknown[]) || []).length > 0;
      // A draft is refused before anything is packaged, so none of the folder is sent.
      setBusy(drafted ? "Saving your plan as a draft" : "Reading your folder again, as the platform packages it");
      const packed = drafted ? { zip: emptyZip() } : await pack(folder, "deploy");
      setBusy("Handing your app to the platform to build your environment");
      const answers = lines.filter(l => l.kind === "question").map(l => ({ question: l.text, answer: (l as { answer?: string }).answer || "" }));
      const made = await api.deploy({
        plan: plan.plan,
        appPath: folder.name,
        zip: packed.zip,
        expectStored,
        origin: { planSource: "interview", answers, ...(plan.traceId ? { traceId: plan.traceId } : {}) }
      });
      navigate(`/environments/${encodeURIComponent(made.stackName || made.environment || made.deploymentId)}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "UNSUPPORTED_NEEDS") {
        const details = err.details as { needs?: Need[]; deploymentId?: string } | undefined;
        setRefusal({ needs: details?.needs || [], deploymentId: details?.deploymentId });
        setPhase("refused");
      } else if (err instanceof UploadRefused) {
        setProblem(err.message);
        setPhase("plan");
      } else {
        fail(err);
        setPhase("plan");
      }
    } finally {
      setBusy(null);
    }
  }

  const appName = String(plan?.plan?.app?.name || "");
  const modules = ((plan?.plan?.modules as { id: string; enabled?: boolean }[]) || []).filter(m => m.enabled !== false);
  const needs = (plan?.plan?.needs || []) as Need[];
  const lineFor = (id: string) => catalog?.modules.find(m => m.id === id)?.shortLine || catalog?.modules.find(m => m.id === id)?.line || "";
  const org = person?.organizationName || "your organization";

  return (
    <>
      <PageTitle title="New environment" sub={<>What <code className="font-mono">sealeye run</code> does, from your browser: read your app, ask a few questions, write a plan, and build it when you say yes.</>} />

      {phase === "choose" ? (
        <Card data-testid="choose-folder">
          <CardHeader><CardTitle>Your app's folder</CardTitle></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div
              className="rounded-lg border-2 border-dashed border-rule p-6 text-center"
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = folderFromDrop(e.dataTransfer); if (f) choose(f); else setProblem("Drop one folder: the one your app is in."); }}>
              {folder ? (
                <p>Ready to read <span className="font-mono text-ink">{folder.name}</span>.</p>
              ) : (
                <p className="text-dim">Drop your app's folder here, or choose it.</p>
              )}
              <div className="mt-4 flex flex-wrap justify-center gap-3">
                {canPickFolder() ? (
                  <Button variant="ghost" onClick={() => pickFolder().then(choose).catch(fail)}>Choose a folder</Button>
                ) : null}
                <label className="inline-flex cursor-pointer items-center rounded-md border border-rule px-3 py-2 hover:bg-ground">
                  {canPickFolder() ? "Upload a folder instead" : "Choose a folder"}
                  <input type="file" className="sr-only" aria-label="Choose your app's folder" {...{ webkitdirectory: "", directory: "" }}
                    onChange={e => choose(folderFromInput(e.target.files || []))} />
                </label>
              </div>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-dim">
              <li>Read here, in your browser, by the same rules as <code className="font-mono text-ink">sealeye run</code>. Nothing in your folder changes.</li>
              <li>Left out: node_modules, .git, and what your .gitignore leaves out.</li>
              <li>For the interview, secret files, like <span className="font-mono text-ink">.env</span>, go as names only: their contents are never read.</li>
              <li>If you deploy, your folder is packaged as <code className="font-mono text-ink">sealeye run</code> packages it: everything but node_modules, .git and <span className="font-mono text-ink">.env</span>. Settings come from your organization's store.</li>
            </ul>
            <Button onClick={start} disabled={!folder || Boolean(busy)}>{busy || "Read my app"}</Button>
          </CardContent>
        </Card>
      ) : null}

      {phase !== "choose" ? (
        <Card data-testid="interview">
          <CardHeader>
            <CardTitle>{folder?.name}</CardTitle>
            {redeploy ? <Badge tone="neutral" className="ml-auto">Already running: asking about what changed</Badge> : null}
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {withheld.length ? <p className="text-dim">Sent as names only: <span className="font-mono">{withheld.join(", ")}</span></p> : null}
            <ol className="space-y-2" data-testid="interview-lines">
              {lines.map((line, i) => line.kind === "step" ? (
                <li key={i} className="text-dim">{line.text}</li>
              ) : (
                <li key={i} className="space-y-1 pt-2">
                  {line.lead.map((l, j) => <div key={j} className="text-dim">{l}</div>)}
                  <div className="font-medium text-amber">{line.text}</div>
                  {line.answer !== undefined ? <div className="text-phosphor">{line.answer || "(no answer)"}</div> : null}
                </li>
              ))}
            </ol>
            {phase === "interview" && !asking ? <p className="text-dim" role="status">The platform is working on it</p> : null}
            {asking ? (
              <form onSubmit={sendReply} className="flex flex-wrap gap-3 pt-2">
                <Input className="flex-1 min-w-48" value={reply} onChange={e => setReply(e.target.value)} aria-label="Your answer" autoFocus />
                <Button type="submit">Answer</Button>
              </form>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {plan && phase !== "interview" ? (
        <Card className="mt-6" data-testid="plan">
          <CardHeader><CardTitle>Your plan</CardTitle>{needs.length ? <Badge tone="amber" className="ml-auto">Drafted</Badge> : <Badge tone="phosphor" className="ml-auto">Ready</Badge>}</CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <div className="text-dim">Your app</div>
              <div className="font-mono">{appName}</div>
            </div>
            {modules.length ? (
              <div>
                <div className="text-dim">We will build your dev environment with</div>
                <ul className="mt-1 space-y-1">
                  {modules.map(m => <li key={m.id}><span className="font-mono">{m.id}</span> <span className="text-dim">{lineFor(m.id)}</span></li>)}
                </ul>
              </div>
            ) : null}
            {needs.length ? (
              <div>
                <div className="text-amber">What your app needs that the platform does not build yet</div>
                <ul className="mt-1 space-y-1">
                  {needs.map(n => <li key={n.kind} data-testid="plan-need">{n.line} <span className="text-dim">{n.evidence.map(e => `${e.shows} (${e.file})`).join("; ")}</span></li>)}
                </ul>
                <p className="mt-2 text-amber">This plan is drafted. The platform can build part of it today, and not the parts above. Deploying it saves the draft and says what would make it buildable.</p>
              </div>
            ) : null}
            <PlanFiles files={plan.files} error={plan.filesError} />
            {phase === "plan" ? (
              <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-4">
                <span className="font-medium">Deploy this?</span>
                <Button onClick={() => decide(true)}>Yes, deploy it</Button>
                <Button variant="ghost" onClick={() => decide(false)}>Not now</Button>
              </div>
            ) : null}
            {phase === "declined" ? (
              <p role="status" className="border-t border-rule pt-4">Nothing was deployed. Keep the two files above with your app; when you are ready, deploy the plan from Validate, or with <code className="font-mono">sealeye deploy -f sealeye.yaml</code>.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {phase === "settings" ? (
        <StoreSettings app={appName} team={person?.team || "default"} names={missing}
          onStored={name => { setStored(s => [...s, name]); setMissing(m => m.filter(n => n !== name)); }}
          onReady={() => deploy([...stored])} ready={missing.length === 0} />
      ) : null}

      {phase === "deploying" ? <p className="mt-6 text-dim" role="status">{busy || "Starting"}</p> : null}

      {phase === "refused" && refusal ? (
        <Card className="mt-6" data-testid="refusal">
          <CardHeader><CardTitle>Saved as a draft</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>Nothing was built. Your plan is drafted and saved{refusal.deploymentId ? <> as <span className="font-mono">{refusal.deploymentId}</span></> : null}. It needs:</p>
            <ul className="list-disc space-y-1 pl-5">
              {refusal.needs.map(n => <li key={n.kind}>{n.line} <span className="text-dim">{(n.evidence || []).map(e => `${e.shows} (${e.file})`).join("; ")}</span></li>)}
            </ul>
            <p className="text-dim">When {org}'s Platform Library has modules that support these, run the interview again and it will finish the plan.</p>
          </CardContent>
        </Card>
      ) : null}

      {phase === "ended" && ending ? (
        <div className="mt-6">
          {ending.type === "finished" && ending.status === "invalid" ? (
            <Problem message={`seaLeye could not write a plan that fits its own contract: ${plainValidationErrors(ending.errors || []).join(" ")}`} />
          ) : (
            <Problem message={ending.message || "The interview ended without a plan."} />
          )}
        </div>
      ) : null}

      {problem ? <div className="mt-6"><Problem message={problem} /></div> : null}
    </>
  );
}

/** The two files `sealeye run` writes into the folder, to read here and download. */
function PlanFiles({ files, error }: { files?: Record<string, string>; error?: string }) {
  if (error) return <Problem message={`The plan's files could not be written: ${error}`} />;
  if (!files) return null;
  const download = (name: string) => {
    const url = URL.createObjectURL(new Blob([files[name]], { type: name.endsWith(".md") ? "text/markdown" : "text/yaml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        {Object.keys(files).map(name => <Button key={name} variant="ghost" onClick={() => download(name)}>Download {name}</Button>)}
      </div>
      {files["DEPLOYMENT_PLAN.md"] ? (
        <details>
          <summary className="cursor-pointer text-dim hover:text-ink">The full plan, and every assumption seaLeye made</summary>
          <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-rule bg-ground p-4 font-mono text-xs" data-testid="plan-markdown">{files["DEPLOYMENT_PLAN.md"]}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** The settings the plan asks for that the store does not have yet. A value is never shown again. */
function StoreSettings({ app, team, names, onStored, onReady, ready }: { app: string; team: string; names: string[]; onStored: (n: string) => void; onReady: () => void; ready: boolean }) {
  const { signedOut } = useSession();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function store(name: string) {
    const value = values[name] || "";
    setValues(v => ({ ...v, [name]: "" }));
    if (!value) return setError(`Give ${name} a value.`);
    setBusy(true);
    setError(null);
    try {
      await api.setSetting(app, team, name, value);
      onStored(name);
    } catch (err) {
      if (err instanceof SignedOut) return signedOut(err.message);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6" data-testid="store-settings">
      <CardHeader><CardTitle>Settings your app needs</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-dim">The plan asks for these, and your organization's store does not have them yet. There is no .env to read here, so store each one; the app reads them when it starts. A value is never shown again.</p>
        {names.map(name => (
          <form key={name} className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); store(name); }}>
            <span className="w-48 font-mono">{name}</span>
            <Input className="w-72 font-mono" type="password" aria-label={`Value for ${name}`} value={values[name] || ""} autoComplete="off"
              onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))} data-1p-ignore="" data-lpignore="true" data-bwignore="true" />
            <Button type="submit" variant="ghost" disabled={busy}>Store it</Button>
          </form>
        ))}
        {ready ? <p role="status" className="text-phosphor">Every setting is stored.</p> : null}
        <Button onClick={onReady} disabled={!ready}>Deploy it</Button>
        {error ? <Problem message={error} /> : null}
      </CardContent>
    </Card>
  );
}
