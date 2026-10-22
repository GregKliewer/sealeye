// Discovery: read the organization's platform library into a draft catalog, and answer
// the questions it raises, as `sealeye discover` does (PHASE4-PLAN Step 6b). A platform
// engineer's page: only an organization-wide token sees it (Greg, Oct 15, 2026), since
// the API refuses anyone else and the portal shows nothing it cannot do. The run never
// waits on an answer; one given now is used whenever it comes. Its Catalogs card runs
// the self-test, approves a draft and makes a catalog live, as `sealeye catalog` does
// (PHASE4-PLAN Step 7), and walks each field that blocks a draft's approval, as `sealeye
// catalog fix` does (DESIGN.md, "What blocks approval is fixed in one walk").
import { Fragment, useEffect, useState } from "react";
import { Navigate } from "react-router";
import { api, ApiError, type CatalogSummary, type DiscoveryQuestion, type DiscoveryRun, type DraftCatalog, type DraftModule, type SelfTest, type WordFix } from "../api";
import { orgWide, useLoad, useSession } from "../session";
import { ago, when } from "../model";
import { PageTitle, Problem } from "../Layout";
import { CommandHint } from "../Command";
import { commandLine, label } from "../../../core/operations.js";
import { editableFieldsOf, EDIT_LIMIT } from "../../../core/catalog-edits.js";
import { forbiddenWords } from "../../../core/developer-words.js";
import { comparedWords, READ_ALL, choicesFor, discoveryEventLine, discoveryStateWords, isOpen, activityWords, answerStateWords, elapsedWords, modulesDone, nextProgress, progressSummary, SOMETHING_ELSE, ANSWER_LIMIT, approvedWords, catalogStatusWords, catalogSummaryWords, madeLiveWords, nextCatalogStep, RESTS_ON_QUESTION, selfTestSummary, avoidWords, stillSaysWords, FIX_OFFER, fixableByEditing, fixedWords, fixPlaceWords, notFixedByEditing, wordFixesOf, builtWords, withVersion } from "../../../core/discovery-words.js";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

export function DiscoveryPage() {
  const { person } = useSession();
  if (person && !orgWide(person)) return <Navigate to="/" replace />;
  return <Discovery />;
}

const LOOK_AGAIN_MS = 5000;
const LOOK_AGAIN_WRITING_MS = 1500;

/** Milliseconds since an event's time, never less than none. */
const since = (at: string | null | undefined, now: number) => (at ? Math.max(0, now - Date.parse(at)) : 0);

const MOVES = new Set(["question", "answered", "answers_used", "merged", "draft", "finished", "stopped", "failed", "not_read", "read"]);

function Discovery() {
  const runs = useLoad(api.discoveries);
  const latestId = runs.data?.[0]?.discoveryId || null;
  const [run, setRun] = useState<DiscoveryRun | null>(null);
  const [draft, setDraft] = useState<DraftCatalog | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  // How far the run has got, from its events: a module's own status says "reading" until
  // every reader is done, so it cannot say this while the run goes.
  const [progress, setProgress] = useState(() => nextProgress(null, null));
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [tick, setTick] = useState(0);

  // The run and its draft, read again whenever something the page shows has moved.
  useEffect(() => {
    if (!latestId) { setRun(null); setDraft(null); return; }
    let live = true;
    api.discovery(latestId).then(r => {
      if (!live) return;
      setRun(r);
      if (r.catalog) api.discoveryDraft(latestId).then(d => live && setDraft(d.document)).catch(() => {});
    }).catch(err => live && setProblem(err.message));
    return () => { live = false; };
  }, [latestId, tick]);

  // A run that is going is followed as it goes.
  const running = run?.status === "running";

  // Otherwise the page looks again every few seconds while it is in view, so a run
  // started, or a question answered, from the command line shows without a refresh.
  // While an answer is being written into the draft it looks more often, so the answer
  // shows as in the draft soon after it is.
  const rewriting = Boolean(run?.rewriting);
  useEffect(() => {
    if (running) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      runs.reload();
      setTick(t => t + 1);
    }, rewriting ? LOOK_AGAIN_WRITING_MS : LOOK_AGAIN_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, rewriting]);

  // A clock for the run card while the run goes, so how long a step has taken moves.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!latestId || !running) return;
    setLines([]);
    setProgress(nextProgress(null, null));
    return api.discoveryEvents(latestId, e => {
      // The platform stamps each event; one that is not is timed from when it came.
      const stamped = e.at ? e : { ...e, at: new Date().toISOString() };
      setProgress((p: ReturnType<typeof nextProgress>) => nextProgress(p, stamped));
      const line = e.type === "reading" ? null : discoveryEventLine(e);
      if (line) setLines(prev => [...prev, line]);
      if (MOVES.has(e.type)) setTick(t => t + 1);
    }, () => { setTick(t => t + 1); runs.reload(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestId, running]);

  // Every module read again, whatever changed: `sealeye discover --all`.
  const [readAll, setReadAll] = useState(false);

  async function start() {
    setStarting(true);
    setProblem(null);
    try {
      await api.startDiscovery(readAll);
      runs.reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const questions = run?.questions || [];
  const open = questions.filter(isOpen);
  const answered = questions.filter(q => !isOpen(q));

  return (
    <>
      <PageTitle
        title={label("discover")}
        sub="Read your platform library into a draft catalog, and answer its questions as they come, or later: the run never waits on you. A catalog goes live only after its self-test, once approved and made live below."
        action={<div className="text-right">
          <Button onClick={start} disabled={starting || running} data-testid="start-discovery">{running ? "A run is going" : "Start a run"}</Button>
          <label className="mt-2 flex items-center justify-end gap-2 text-sm text-dim">
            <input type="checkbox" checked={readAll} onChange={e => setReadAll(e.target.checked)} disabled={starting || running} data-testid="read-all" />
            {READ_ALL}
          </label>
          <CommandHint op="discover" flags={readAll ? ["--all"] : []} className="mt-2 justify-end" />
        </div>} />
      {runs.error ? <Problem message={runs.error} /> : null}
      {problem ? <Problem message={problem} /> : null}
      {runs.data && !runs.data.length ? <p className="text-dim" data-testid="no-runs">No discovery run yet.</p> : null}

      {run ? (
        <Card className="mb-6" data-testid="run">
          <CardContent>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono">{run.discoveryId}</span>
              <Badge tone={run.status === "finished" ? "phosphor" : run.status === "running" ? "neutral" : "amber"} moving={running}>{discoveryStateWords(run)}</Badge>
              <span className="ml-auto text-xs text-dim">started {ago(run.createdAt)}{run.startedBy ? ` by ${run.startedBy}` : ""}</span>
            </div>
            <p className="mt-2 text-sm text-dim">
              {run.repos.map(r => `${r.repo}${r.commit ? ` at ${r.commit.slice(0, 7)}` : ""}`).join(", ")}
              {!running && run.modules.length && !run.unchangedSince ? `; ${modulesDone(run) - run.modules.filter(m => m.status === "not_read").length} of ${run.modules.length} modules read or kept` : ""}
            </p>
            {comparedWords(run) ? <p className="mt-1 text-sm text-dim" data-testid="run-compared">{comparedWords(run)}</p> : null}
            {running ? (
              <div className="mt-3" data-testid="run-progress">
                <div className="flex items-center gap-2 text-sm">
                  <span aria-hidden="true" className="sealeye-spin inline-block size-3.5 rounded-full border-2 border-phosphor border-t-transparent" />
                  <span>{activityWords(progress)}</span>
                  <span className="text-xs text-dim">{elapsedWords(since(progress.since, now))}</span>
                </div>
                <p className="mt-1 text-xs text-dim">{progressSummary(progress, open.length)} · {elapsedWords(since(run.createdAt, now))} so far</p>
              </div>
            ) : null}
            {run.message && run.status !== "finished" ? <p className="mt-2 text-sm text-amber">{run.message}</p> : null}
            {lines.length ? (
              <ul className="mt-3 space-y-0.5 font-mono text-xs text-dim" data-testid="run-lines">
                {lines.slice(-6).map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {open.length ? (
        <div className="mb-3">
          <h2 className="text-lg font-semibold">Waiting on an answer: {open.length}</h2>
          <p className="text-sm text-dim" data-testid="answer-anytime">The run carries on while these wait. Answer here or with <span className="font-mono">{commandLine("discover", null, ["answers"])}</span>, now or after it finishes.</p>
        </div>
      ) : null}
      <div className="space-y-4">
        {open.map(q => <QuestionCard key={q.id} runId={run!.discoveryId} q={q} onAnswered={() => setTick(t => t + 1)} />)}
      </div>

      {draft ? <DraftTable draft={draft} version={run?.catalog?.version} questions={questions} tick={tick} onChanged={() => setTick(t => t + 1)} /> : null}

      <CatalogsCard tick={tick} runDraft={draft ? run?.catalog?.version : undefined} />

      {answered.length ? (
        <Card className="mt-8">
          <CardHeader><CardTitle>Answered</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {answered.map(q => (
              <div key={q.id} className="text-sm" data-testid="answered-question">
                <div>{q.question}</div>
                <div className="mt-1 text-dim">
                  <span className="text-ink">{q.answer}</span>
                  {q.answeredBy ? ` · ${q.answeredBy}` : ""}{q.answeredAt ? ` · ${when(q.answeredAt)}` : ""}
                  {" · "}<AnswerState q={q} run={run!} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

/** Where an answer stands: in the draft, being written in (turning), or not yet and why. */
function AnswerState({ q, run }: { q: DiscoveryQuestion; run: DiscoveryRun }) {
  const state = answerStateWords(q, run);
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="answer-state">
      {state.moving ? <span aria-hidden="true" className="sealeye-spin inline-block size-3 rounded-full border-2 border-phosphor border-t-transparent" /> : null}
      <span className={state.moving ? "text-ink" : undefined}>{state.words}</span>
    </span>
  );
}

function QuestionCard({ runId, q, onAnswered }: { runId: string; q: DiscoveryQuestion; onAnswered: () => void }) {
  const choices = choicesFor(q);
  const [choice, setChoice] = useState<string>(choices[0] || SOMETHING_ELSE);
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reply = choice === SOMETHING_ELSE ? own.trim() : choice;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api.answerDiscovery(runId, q.id, reply);
      onAnswered();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Card data-testid="open-question">
      <CardContent>
        <p className="font-medium">{q.question}</p>
        {q.touches.length ? <p className="mt-1 text-xs text-dim">Touches {q.touches.join(", ")}</p> : null}
        {q.merged?.length ? <p className="mt-1 text-xs text-dim" data-testid="also-asked">Also asked as: {q.merged.map(m => `"${m.question}"`).join("; ")}</p> : null}
        <ul className="mt-2 space-y-0.5 text-xs text-dim">
          {q.evidence.map((e, i) => <li key={i}><span className="font-mono">{e.file}{e.line ? `:${e.line}` : ""}</span>: {e.shows}</li>)}
        </ul>
        <fieldset className="mt-3 space-y-1.5">
          <legend className="sr-only">Your answer</legend>
          {[...choices, SOMETHING_ELSE].map(c => (
            <label key={c} className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="radio" name={q.id} value={c} checked={choice === c} onChange={() => setChoice(c)} className="mt-1 accent-[var(--color-phosphor)]" />
              <span>{c}{c === q.guess ? <Badge tone="neutral" className="ml-2">the run's guess</Badge> : null}</span>
            </label>
          ))}
        </fieldset>
        {choice === SOMETHING_ELSE ? (
          <Input className="mt-2" value={own} onChange={e => setOwn(e.target.value)} placeholder="Your answer, in a sentence" aria-label="Your own answer" maxLength={ANSWER_LIMIT} />
        ) : null}
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" onClick={send} disabled={busy || !reply}>Answer</Button>
          <span className="text-xs text-dim">{RESTS_ON_QUESTION}</span>
        </div>
        {error ? <div className="mt-2"><Problem message={error} /></div> : null}
      </CardContent>
    </Card>
  );
}

function DraftTable({ draft, version, questions, tick, onChanged }: { draft: DraftCatalog; version?: number; questions: DiscoveryQuestion[] | null; tick: number; onChanged: () => void }) {
  // Without its run's questions (a draft read by its version), a question an entry rests
  // on is taken as open: the draft is rewritten when one is answered.
  const isOpenId = (id: string) => (questions ? questions.some(q => q.id === id && isOpen(q)) : true);
  const openIds = { has: isOpenId };
  const catalogOpen = (draft.discovery?.open || []).filter(id => openIds.has(id));
  // Only a draft's words can be changed: once approved, a catalog is as it was tested.
  const [status, setStatus] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.catalogs().then(l => live && setStatus(l.catalogs.find(c => c.version === version)?.status || null)).catch(() => {});
    return () => { live = false; };
  }, [version, tick]);
  const editable = status === "draft" && typeof version === "number";
  return (
    <Card className="mt-8" data-testid="draft">
      <CardHeader><CardTitle>Draft catalog {version}</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-dim">
          What the run wrote, as it stands with the answers so far. A draft goes live only after its self-test, once a platform engineer approves it and makes it live.
          {catalogOpen.length ? " The catalog as a whole rests on a question not yet answered." : ""}
        </p>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Module</TableHead><TableHead>Folder</TableHead><TableHead>Offered</TableHead><TableHead>What it gives an app</TableHead>{editable ? <TableHead><span className="sr-only">{label("catalog-edit")}</span></TableHead> : null}</TableRow>
          </TableHeader>
          <TableBody>
            {draft.modules.map(m => {
              const resting = (m.open || []).filter(id => openIds.has(id));
              return (
                <Fragment key={m.id}>
                <TableRow data-testid="draft-module">
                  <TableCell className="font-mono">{m.id}</TableCell>
                  <TableCell className="font-mono text-xs text-dim">{m.source}</TableCell>
                  <TableCell>
                    <Badge tone={m.availability === "available" ? "phosphor" : "amber"}>{m.availability === "available" ? "Offered" : m.availability === "deprecated" ? "Deprecated" : "Not read"}</Badge>
                    {resting.length ? <Badge tone="amber" className="ml-2" data-testid="rests-on-question" title={RESTS_ON_QUESTION}>never built until answered</Badge> : null}
                  </TableCell>
                  <TableCell className="text-sm text-dim">{m.line}{m.edited ? <Badge tone="neutral" className="ml-2">edited</Badge> : null}</TableCell>
                  {editable ? (
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(editing === m.id ? null : m.id)} data-testid="edit-words" className="whitespace-nowrap">{editing === m.id ? "Close" : label("catalog-edit")}</Button>
                    </TableCell>
                  ) : null}
                </TableRow>
                {editable && editing === m.id ? (
                  <TableRow data-testid="edit-panel">
                    <TableCell colSpan={5}><EditWords key={m.id} version={version!} module={m} onChanged={onChanged} /></TableCell>
                  </TableRow>
                ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** A draft that is not the latest run's, read by its version, with its words to edit. */
function OtherDraft({ version, tick, onChanged }: { version: number; tick: number; onChanged: () => void }) {
  const [document, setDocument] = useState<DraftCatalog | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.catalogVersion(version).then(r => live && setDocument(r.document)).catch(err => live && setProblem(err instanceof ApiError ? err.message : String(err)));
    return () => { live = false; };
  }, [version, tick]);
  if (problem) return <div className="mt-4"><Problem message={problem} /></div>;
  if (!document) return null;
  return <div data-testid="other-draft"><DraftTable draft={document} version={version} questions={null} tick={tick} onChanged={onChanged} /></div>;
}

/**
 * The organization's catalogs: which is live, each one's status, its self-test, and the
 * next step for each: approve a draft, make an approved or retired one live.
 */
function CatalogsCard({ tick, runDraft }: { tick: number; runDraft?: number }) {
  const [list, setList] = useState<{ live: { version: number | "starter"; source: string }; catalogs: CatalogSummary[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [mine, setMine] = useState(0);
  const [shown, setShown] = useState<{ version: number; result: SelfTest; message?: string; done?: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  // Making a catalog live changes what every developer plans against: asked once more.
  const [confirming, setConfirming] = useState<number | null>(null);
  // The walk through what blocks a draft's approval, and the self-test it starts from.
  const [fixing, setFixing] = useState<{ version: number; first?: SelfTest } | null>(null);
  // Any draft's words, as `sealeye catalog edit <v>` reaches any draft; the latest run's
  // draft is already on the page above (Greg, Oct 16, 2026).
  const [wording, setWording] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    api.catalogs().then(l => live && setList(l)).catch(err => live && setProblem(err instanceof ApiError ? err.message : String(err)));
    return () => { live = false; };
  }, [tick, mine]);

  async function act(version: number, step: "test" | "approve" | "live") {
    setConfirming(null);
    setFixing(null);
    setShown(null);
    setBusy(version);
    setProblem(null);
    try {
      if (step === "test") setShown({ version, result: await api.catalogSelfTest(version) });
      else {
        const done = step === "approve" ? await api.approveCatalog(version) : await api.makeCatalogLive(version);
        setShown({ version, result: done.selfTest, done: step === "approve" ? approvedWords(version) : madeLiveWords(version) });
      }
    } catch (err) {
      const result = err instanceof ApiError ? (err.details as { selfTest?: SelfTest } | undefined)?.selfTest : undefined;
      if (result) setShown({ version, result, message: (err as Error).message });
      else setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
      setMine(n => n + 1);
    }
  }

  if (!list) return problem ? <div className="mt-8"><Problem message={problem} /></div> : null;
  return (
    <Card className="mt-8" data-testid="catalogs">
      <CardHeader><CardTitle>{label("catalogs")}</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-dim" data-testid="live-catalog">
          {list.live.source === "starter"
            ? "Your organization plans against the starter catalog: seaLeye's own modules. None of its own is live."
            : `Your organization plans against catalog ${list.live.version}.`}
        </p>
        {problem ? <div className="mb-3"><Problem message={problem} /></div> : null}
        {list.catalogs.length ? (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Catalog</TableHead><TableHead>Status</TableHead><TableHead>About it</TableHead><TableHead className="text-right">Next</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {list.catalogs.map(x => {
                const next = nextCatalogStep(x.status);
                return (
                  <TableRow key={x.version} data-testid="catalog-row">
                    <TableCell className="font-mono">{x.version}</TableCell>
                    <TableCell><Badge tone={x.status === "live" ? "phosphor" : x.status === "draft" ? "amber" : "neutral"}>{catalogStatusWords(x.status)}</Badge></TableCell>
                    <TableCell className="text-sm text-dim">{catalogSummaryWords(x)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => act(x.version, "test")} disabled={busy !== null}>{label("catalog-test")}</Button>
                      {x.status === "draft" && x.version !== runDraft ? (
                        <Button size="sm" variant="ghost" className="ml-2" onClick={() => setWording(wording === x.version ? null : x.version)} disabled={busy !== null} data-testid="catalog-edit-words">{wording === x.version ? "Close" : label("catalog-edit")}</Button>
                      ) : null}
                      {x.status === "draft" ? (
                        <Button size="sm" variant="ghost" className="ml-2" onClick={() => { setShown(null); setConfirming(null); setFixing({ version: x.version }); }} disabled={busy !== null} data-testid="catalog-fix">{label("catalog-fix")}</Button>
                      ) : null}
                      {next ? (
                        <Button size="sm" className="ml-2" onClick={() => (next === "live" ? setConfirming(x.version) : act(x.version, next))} disabled={busy !== null} data-testid={`catalog-${next}`}>
                          {next === "approve" ? label("catalog-approve") : label("catalog-live")}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : <p className="text-sm text-dim">No catalog of its own yet: a discovery run writes a draft.</p>}
        {confirming !== null ? (
          <div className="mt-4 rounded-md border border-rule bg-ground p-4 text-sm" role="alertdialog" aria-label={`Make catalog ${confirming} live`} data-testid="confirm-live">
            <p>Make catalog {confirming} live? Every developer in your organization plans against it from now on, and the live one is retired. Its self-test runs again first.</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => act(confirming, "live")} data-testid="confirm-live-yes">{label("catalog-live")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
            </div>
          </div>
        ) : null}
        {shown ? <SelfTestResult {...shown} /> : null}
        {shown && shown.message && fixableByEditing(shown.result) && !fixing ? (
          <div className="mt-3 flex items-center gap-3" data-testid="fix-offer">
            <span className="text-sm">{FIX_OFFER}</span>
            <Button size="sm" onClick={() => { const { version, result } = shown; setShown(null); setFixing({ version, first: result }); }} data-testid="fix-offer-yes">{label("catalog-fix")}</Button>
          </div>
        ) : null}
        {wording !== null && list.catalogs.some(x => x.version === wording && x.status === "draft") ? (
          <OtherDraft key={wording} version={wording} tick={tick + mine} onChanged={() => setMine(n => n + 1)} />
        ) : null}
        {fixing ? (
          <FixWalk key={fixing.version} version={fixing.version} first={fixing.first} onChanged={() => setMine(n => n + 1)} onClose={() => setFixing(null)} />
        ) : null}
        <CommandHint op="catalogs" className="mt-3" />
      </CardContent>
    </Card>
  );
}

function SelfTestResult({ version, result, message, done }: { version: number; result: SelfTest; message?: string; done?: string }) {
  return (
    <div className="mt-4 rounded-md border border-rule p-4" data-testid="self-test">
      <p className={result.passed ? "text-phosphor" : "text-amber"} data-testid="self-test-summary">{message || selfTestSummary(result)}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {result.checks.map(check => (
          <li key={check.id} data-testid="self-test-check">
            <span className={check.passed ? "text-phosphor" : "text-amber"} aria-hidden="true">{check.passed ? "\u2713" : "\u2717"}</span>{" "}
            <span className="sr-only">{check.passed ? "Passed:" : "Failed:"}</span>{check.title}
            {check.problems.length ? (
              <ul className="ml-5 mt-1 space-y-0.5 text-xs text-amber">{check.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
            ) : null}
          </li>
        ))}
      </ul>
      {builtWords(result) ? <p className="mt-3 text-sm" data-testid="self-test-built">{builtWords(result)}</p> : null}
      {result.refused.length ? (
        <div className="mt-3 text-sm">
          <p>Never built from catalog {version}:</p>
          <ul className="mt-1 space-y-0.5 text-xs text-dim">{result.refused.map(r => <li key={r.id}><span className="font-mono">{withVersion(r.id, result.versions?.[r.id])}</span>: {r.why}</li>)}</ul>
        </div>
      ) : null}
      {result.notes.map((n, i) => <p key={i} className="mt-3 text-sm text-dim">{n}</p>)}
      {notFixedByEditing(result).length ? (
        <ul className="mt-3 space-y-0.5 text-sm text-amber" data-testid="not-fixed-by-editing">{notFixedByEditing(result).map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
      ) : null}
      {done ? <p className="mt-3 text-sm text-phosphor" data-testid="catalog-done">{done}</p> : null}
    </div>
  );
}

/**
 * A draft entry's words, each in a box to change, as `sealeye catalog edit` changes them.
 * Words only; the self-test runs again on each save and says what is left.
 */
function EditWords({ version, module, onChanged }: { version: number; module: DraftModule; onChanged: () => void }) {
  const fields = editableFieldsOf(module) as { field: string; label: string; text: string }[];
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(f => [f.field, f.text])));
  // The boxes refill when the entry beneath them changes (a save read back, a late
  // answer's rewrite), so stale words are never saved back as a person's. The panel
  // stays mounted, so the self-test a save just ran stays shown (it was lost when the
  // panel was remounted on every change, and GitHub's runner caught it).
  const fieldsNow = JSON.stringify(fields.map(f => [f.field, f.text]));
  useEffect(() => {
    setTexts(Object.fromEntries((JSON.parse(fieldsNow) as [string, string][])));
  }, [fieldsNow]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<SelfTest | null>(null);
  // Which of this entry's fields the self-test says to change, marked beside each.
  const [failing, setFailing] = useState<Map<string, WordFix>>(new Map());
  useEffect(() => {
    let live = true;
    const mark = (r: SelfTest) => live && setFailing(new Map((wordFixesOf(r) as WordFix[]).filter(f => f.module === module.id).map(f => [f.field, f])));
    if (result) mark(result);
    else api.catalogSelfTest(version).then(mark).catch(() => {});
    return () => { live = false; };
  }, [version, module.id, result]);

  async function save(field: string) {
    setBusy(field);
    setProblem(null);
    try {
      const done = await api.editCatalog(version, module.id, field, texts[field] || "");
      setResult(done.selfTest);
      onChanged();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 py-2" data-testid="edit-words-panel">
      <p className="text-xs text-dim">Words only: what {module.id} is, when to use it, and what its inputs are for. Its id, inputs and whether it is offered stay as the library says.</p>
      {fields.map(f => (
        <div key={f.field}>
          <label className="text-xs text-dim" htmlFor={`edit-${module.id}-${f.field}`}>{f.label}{module.edited?.[f.field] ? ` · edited by ${module.edited[f.field].by}` : ""}</label>
          {failing.get(f.field) ? <span className="ml-2 text-xs text-amber" data-testid="field-fails">{"\u2717"} {avoidWords(failing.get(f.field))}</span> : null}
          <div className="mt-1 flex items-start gap-2">
            <textarea id={`edit-${module.id}-${f.field}`} rows={2} maxLength={EDIT_LIMIT} value={texts[f.field] ?? ""}
              onChange={e => setTexts(t => ({ ...t, [f.field]: e.target.value }))}
              className="min-w-0 flex-1 rounded-md border border-rule bg-surface px-3 py-2 text-sm" />
            <Button size="sm" onClick={() => save(f.field)} disabled={busy !== null || (texts[f.field] ?? "") === f.text}>Save</Button>
          </div>
        </div>
      ))}
      {problem ? <Problem message={problem} /> : null}
      {result ? <SelfTestResult version={version} result={result} /> : null}
      <CommandHint op="catalog-edit" flags={[String(version), module.id]} />
    </div>
  );
}

/**
 * Each field the self-test says to change, one at a time, as `sealeye catalog fix` walks
 * them: its words now, the words to leave out, and a box holding them to change. Leave
 * moves on without a change. At the end the self-test runs again, and a draft that
 * passes can be approved here.
 */
function FixWalk({ version, first, onChanged, onClose }: { version: number; first?: SelfTest; onChanged: () => void; onClose: () => void }) {
  const [fixes, setFixes] = useState<WordFix[] | null>(first ? (wordFixesOf(first) as WordFix[]) : null);
  const [start, setStart] = useState<SelfTest | null>(first || null);
  const [at, setAt] = useState(0);
  const [text, setText] = useState("");
  const [warned, setWarned] = useState<string | null>(null);
  const [counts, setCounts] = useState({ changed: 0, kept: 0 });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [end, setEnd] = useState<SelfTest | null>(null);
  const [approved, setApproved] = useState<SelfTest | null>(null);

  useEffect(() => {
    if (fixes) return;
    let live = true;
    api.catalogSelfTest(version).then(r => { if (live) { setStart(r); setFixes(wordFixesOf(r) as WordFix[]); } })
      .catch(err => live && setProblem(err instanceof ApiError ? err.message : String(err)));
    return () => { live = false; };
  }, [version, fixes]);

  const fix = fixes && at < fixes.length ? fixes[at] : null;
  useEffect(() => { setText(fix?.text || ""); setWarned(null); setProblem(null); }, [fix]);

  // The walk is over: the self-test as the catalog stands now.
  useEffect(() => {
    if (!fixes || fix) return;
    let live = true;
    api.catalogSelfTest(version).then(r => live && setEnd(r)).catch(err => live && setProblem(err instanceof ApiError ? err.message : String(err)));
    return () => { live = false; };
  }, [version, fixes, fix]);

  const next = (kind: "changed" | "kept") => { setCounts(c => ({ ...c, [kind]: c[kind] + 1 })); setAt(i => i + 1); };

  async function save() {
    if (!fix) return;
    const words = text.replace(/\s+/g, " ").trim();
    if (words === fix.text.replace(/\s+/g, " ").trim()) return next("kept");
    const still = forbiddenWords(words) as { term: string; kind: string; found: string }[];
    if (still.length && warned !== words) {
      setWarned(words);
      return setProblem(stillSaysWords(still, "save again"));
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.editCatalog(version, fix.module, fix.field, words);
      onChanged();
      next("changed");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setProblem(null);
    try {
      setApproved((await api.approveCatalog(version)).selfTest);
      onChanged();
    } catch (err) {
      const result = err instanceof ApiError ? (err.details as { selfTest?: SelfTest } | undefined)?.selfTest : undefined;
      if (result) setEnd(result);
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-md border border-rule p-4" data-testid="fix-walk" role="region" aria-label={`${label("catalog-fix")}, catalog ${version}`}>
      <div className="flex items-center gap-3">
        <p className="font-medium">{label("catalog-fix")}: catalog {version}</p>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>Close</Button>
      </div>
      {start && !start.passed && notFixedByEditing(start).length ? (
        <ul className="mt-2 space-y-0.5 text-sm text-amber">{notFixedByEditing(start).map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
      ) : null}
      {fix && fixes ? (
        <div className="mt-3" data-testid="fix-step">
          <p className="text-sm">
            <span className="text-xs text-dim">{fixPlaceWords(at + 1, fixes.length)}</span>{" "}
            <span className="font-mono">{fix.module}</span> · {fix.label}
          </p>
          <p className="mt-1 text-sm text-dim">{fix.text}</p>
          <p className="mt-1 text-xs text-amber" data-testid="fix-avoid">{avoidWords(fix)}</p>
          <label className="sr-only" htmlFor="fix-words">New words for {fix.module}, {fix.label}</label>
          <textarea id="fix-words" rows={3} maxLength={EDIT_LIMIT} value={text} onChange={e => setText(e.target.value)}
            className="mt-2 w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm" data-testid="fix-text" />
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={save} disabled={busy || (!text.trim() && fix.field === "line")} data-testid="fix-save">Save and go on</Button>
            <Button size="sm" variant="ghost" onClick={() => next("kept")} disabled={busy} data-testid="fix-leave">Leave it</Button>
          </div>
        </div>
      ) : null}
      {!fix && fixes && !end && !problem ? <p className="mt-3 text-sm text-dim">Running the self-test again…</p> : null}
      {!fix && fixes ? <p className="mt-3 text-sm" data-testid="fix-counts">{fixedWords(counts)}</p> : null}
      {problem ? <div className="mt-3"><Problem message={problem} /></div> : null}
      {end && !approved ? <SelfTestResult version={version} result={end} /> : null}
      {end && end.passed && !approved ? (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-sm">Approve catalog {version} now?</span>
          <Button size="sm" onClick={approve} disabled={busy} data-testid="fix-approve">{label("catalog-approve")}</Button>
        </div>
      ) : null}
      {approved ? <SelfTestResult version={version} result={approved} done={approvedWords(version)} /> : null}
      <CommandHint op="catalog-fix" flags={[String(version)]} className="mt-3" />
    </div>
  );
}
