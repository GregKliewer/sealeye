// Discovery: read the organization's platform library into a draft catalog, and answer
// the questions it raises, as `sealeye discover` does (PHASE4-PLAN Step 6b). A platform
// engineer's page: only an organization-wide token sees it (Greg, Oct 15, 2026), since
// the API refuses anyone else and the portal shows nothing it cannot do. The run never
// waits on an answer; one given now is used whenever it comes. Nothing goes live here.
import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { api, ApiError, type DiscoveryQuestion, type DiscoveryRun, type DraftCatalog } from "../api";
import { orgWide, useLoad, useSession } from "../session";
import { ago, when } from "../model";
import { PageTitle, Problem } from "../Layout";
import { CommandHint } from "../Command";
import { commandLine, label } from "../../../core/operations.js";
import { choicesFor, discoveryEventLine, discoveryStateWords, isOpen, activityWords, elapsedWords, modulesDone, nextProgress, progressSummary, SOMETHING_ELSE, ANSWER_LIMIT } from "../../../core/discovery-words.js";
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

/** Milliseconds since an event's time, never less than none. */
const since = (at: string | null | undefined, now: number) => (at ? Math.max(0, now - Date.parse(at)) : 0);

const MOVES = new Set(["question", "answered", "answers_used", "draft", "finished", "stopped", "failed", "not_read", "read"]);

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
  useEffect(() => {
    if (running) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      runs.reload();
      setTick(t => t + 1);
    }, LOOK_AGAIN_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

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

  async function start() {
    setStarting(true);
    setProblem(null);
    try {
      await api.startDiscovery();
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
        sub="Read your platform library into a draft catalog. The run never waits on you: answer its questions as they come, or later. Nothing goes live from here."
        action={<div className="text-right">
          <Button onClick={start} disabled={starting || running} data-testid="start-discovery">{running ? "A run is going" : "Start a run"}</Button>
          <CommandHint op="discover" className="mt-2 justify-end" />
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
              {!running && run.modules.length ? `; ${modulesDone(run) - run.modules.filter(m => m.status === "not_read").length} of ${run.modules.length} modules read` : ""}
            </p>
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

      {draft ? <DraftTable draft={draft} version={run?.catalog?.version} questions={questions} /> : null}

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
                  {" · "}{q.usedAt ? "in the draft" : "waiting to be written into the draft"}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </>
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
          <span className="text-xs text-dim">Until it is answered, the draft rests on the guess.</span>
        </div>
        {error ? <div className="mt-2"><Problem message={error} /></div> : null}
      </CardContent>
    </Card>
  );
}

function DraftTable({ draft, version, questions }: { draft: DraftCatalog; version?: number; questions: DiscoveryQuestion[] }) {
  const openIds = new Set(questions.filter(isOpen).map(q => q.id));
  const catalogOpen = (draft.discovery?.open || []).filter(id => openIds.has(id));
  return (
    <Card className="mt-8" data-testid="draft">
      <CardHeader><CardTitle>Draft catalog {version}</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-dim">
          What the run wrote, as it stands with the answers so far. A draft goes live only after its self-test and a platform engineer's approval.
          {catalogOpen.length ? " The catalog as a whole rests on a question not yet answered." : ""}
        </p>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Module</TableHead><TableHead>Folder</TableHead><TableHead>Offered</TableHead><TableHead>What it gives an app</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {draft.modules.map(m => {
              const resting = (m.open || []).filter(id => openIds.has(id));
              return (
                <TableRow key={m.id} data-testid="draft-module">
                  <TableCell className="font-mono">{m.id}</TableCell>
                  <TableCell className="font-mono text-xs text-dim">{m.source}</TableCell>
                  <TableCell>
                    <Badge tone={m.availability === "available" ? "phosphor" : "amber"}>{m.availability === "available" ? "Offered" : m.availability === "deprecated" ? "Deprecated" : "Not read"}</Badge>
                    {resting.length ? <Badge tone="amber" className="ml-2" data-testid="rests-on-question">rests on a question</Badge> : null}
                  </TableCell>
                  <TableCell className="text-sm text-dim">{m.line}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
