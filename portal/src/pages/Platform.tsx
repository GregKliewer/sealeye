// Platform: the organization's platform values, as `sealeye platform` reads and sets them
// (PHASE4-PLAN Step 9; DESIGN.md, "An organization's platform values"). What only the
// platform team can give a module of the organization's own library: subnets, security
// groups, a permissions boundary. By stage, though developers' environments are built as
// dev, so only dev's are used today. A platform engineer's page: only an
// organization-wide token sees it, as Discovery is, since the API refuses anyone else.
// A value is a word or a list of words, never a secret; the API refuses one that looks
// like a secret, and says so in its own words, which the page shows as they are.
import { useRef, useState } from "react";
import { Navigate } from "react-router";
import { api, ApiError, SignedOut, type Platform, type PlatformValue, type PlatformWanted, type PlatformWord } from "../api";
import { orgWide, useLoad, useSession } from "../session";
import { ago, when } from "../model";
import { PageTitle, Problem } from "../Layout";
import { CommandHint } from "../Command";
import { label } from "../../../core/operations.js";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

export function PlatformPage() {
  const { person } = useSession();
  if (person && !orgWide(person)) return <Navigate to="/" replace />;
  return <PlatformValues />;
}

/** A value's words, one line each, as the form takes them: one word, or a list. */
const wordsOf = (value: PlatformWord) => (Array.isArray(value) ? value : [value]);

/** What was typed, as the API takes it: one line is a word, several are a list. */
function valueFrom(text: string, list: boolean): PlatformWord {
  const words = text.split(/\r?\n/).map(w => w.trim()).filter(Boolean);
  return list || words.length > 1 ? words : words[0] ?? "";
}

/** The stage flag the command takes, left out for the stage it uses when none is given. */
const stageFlags = (stage: string, developerStage: string) => (stage === developerStage ? [] : ["--stage", stage]);

function PlatformValues() {
  const { signedOut } = useSession();
  // Null until the API has said which stage it answers for when none is asked: dev.
  const [stage, setStage] = useState<string | null>(null);
  const platform = useLoad(() => api.platform(stage ?? ""), [stage]);
  const data = platform.data;
  const shown = data?.stage ?? stage ?? "";
  const developerStage = data?.developerStage ?? "dev";

  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [list, setList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const valueBox = useRef<HTMLTextAreaElement>(null);

  async function act(run: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await run());
      platform.reload();
    } catch (err) {
      if (err instanceof SignedOut) return signedOut("Your sign-in has ended. Sign in again with your token.");
      // A value that looks like a secret is not left on the page either.
      if (err instanceof ApiError && err.code === "LOOKS_LIKE_A_SECRET") setText("");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    const value = valueFrom(text, list);
    act(async () => {
      const kept = await api.setPlatformValue(n, value, shown);
      setName("");
      setText("");
      setList(false);
      return `${kept.name} is set for ${kept.stage}${kept.organization ? ` in ${kept.organization}` : ""}.`;
    });
  }

  function remove(v: PlatformValue) {
    act(async () => {
      const r = await api.removePlatformValue(v.name, shown);
      const where = r.organization ? ` in ${r.organization}` : "";
      return r.removed ? `${r.name} is no longer set for ${r.stage}${where}.` : `${r.name} was not set for ${r.stage}${where}.`;
    });
  }

  /** Fill the form's name, so the value is all that is left to give. */
  function prefill(n: string) {
    setName(n);
    setError(null);
    setDone(null);
    valueBox.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    valueBox.current?.focus();
  }

  const typed = valueFrom(text, list);
  const typedWords = wordsOf(typed).filter(Boolean);

  return (
    <>
      <PageTitle
        title={label("platform")}
        sub="What only your platform team can give a module of your organization's own library, such as subnets, security groups and a permissions boundary. A value is a word or a list of words, never a secret."
        action={<CommandHint op="platform" flags={stageFlags(shown, developerStage)} className="justify-end" />} />
      {platform.error ? <Problem message={platform.error} /> : null}

      <div className="mb-6 flex flex-wrap items-end gap-4">
        <label className="grid gap-1 text-sm">
          <span className="text-dim">Stage</span>
          <select aria-label="Stage" className="h-9 rounded-md border border-rule bg-surface px-3" value={shown}
            onChange={e => { setStage(e.target.value); setDone(null); setError(null); }} disabled={!data}>
            {(data?.stages || [shown]).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <p className="pb-2 text-sm text-dim" data-testid="developer-stage">
          Developers' environments are built as {developerStage}, so only {developerStage}'s values are used today. The other stages are kept for when promotion comes.
        </p>
      </div>

      <Card data-testid="platform-values">
        <CardHeader><CardTitle>Values for {shown}</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          {data && data.values.length === 0 ? <p className="text-dim" data-testid="no-values">No values are set for {data.stage}.</p> : null}
          {data && data.values.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Name</TableHead><TableHead>Value</TableHead><TableHead>Set by</TableHead><TableHead>When</TableHead><TableHead /></TableRow>
              </TableHeader>
              <TableBody>
                {data.values.map(v => (
                  <TableRow key={v.name} data-testid="platform-value">
                    <TableCell className="font-mono text-xs">{v.name}</TableCell>
                    <TableCell>
                      <ul className="font-mono text-xs" data-testid="platform-words">
                        {wordsOf(v.value).map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                      {Array.isArray(v.value) ? <span className="text-xs text-dim">{v.value.length === 1 ? "a list of one" : "a list"}</span> : null}
                    </TableCell>
                    <TableCell>{v.setBy || "Not recorded"}</TableCell>
                    <TableCell className="text-xs" title={when(v.setAt)}>{ago(v.setAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" disabled={busy} aria-label={`Remove ${v.name}`} onClick={() => remove(v)}>Remove</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}

          <form onSubmit={save} className="space-y-3 border-t border-rule pt-4" data-testid="platform-form">
            <div className="flex flex-wrap items-start gap-3">
              <label className="grid gap-1">
                <span className="text-dim">Name</span>
                <Input className="w-72 font-mono" value={name} onChange={e => setName(e.target.value)} aria-label="Value name" autoComplete="off"
                  placeholder="subnet_ids" spellCheck={false} />
              </label>
              <label className="grid gap-1">
                <span className="text-dim">Value, one word per line</span>
                <textarea ref={valueBox} rows={3} value={text} onChange={e => setText(e.target.value)} aria-label="Value" spellCheck={false} autoComplete="off"
                  className="w-80 resize-y rounded-md border border-rule bg-surface px-3 py-2 font-mono text-sm placeholder:text-dim focus-visible:outline-2 focus-visible:outline-phosphor"
                  placeholder={"subnet-0a1b2c3d\nsubnet-4e5f6a7b"} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-dim">
              <input type="checkbox" checked={list} onChange={e => setList(e.target.checked)} />
              Keep one word as a list (an input that takes a list)
            </label>
            <p className="text-xs text-dim">
              A name is the input it fills, such as subnet_ids, for every module that takes it. A module's id, a dot and the input, such as postgres.security_group_ids, fills that module's only, and wins over the plain name. One line is a word; several lines are a list.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy}>{busy ? "Asking the platform" : `Set it for ${shown}`}</Button>
            </div>
            <CommandHint op="platform" flags={["set", name.trim() || "<name>", ...(typedWords.length ? typedWords : ["<word>"]), ...(list ? ["--list"] : []), ...stageFlags(shown, developerStage)]} />
          </form>
          {done ? <p role="status" className="text-phosphor" data-testid="platform-done">{done}</p> : null}
          {error ? <Problem message={error} /> : null}
        </CardContent>
      </Card>

      {data ? <Wanted data={data} onSet={prefill} /> : null}
    </>
  );
}

/** For each module of the live catalog that is offered: what it still needs from the platform. */
function Wanted({ data, onSet }: { data: Platform; onSet: (name: string) => void }) {
  const which = data.catalog.source === "starter" ? "the starter catalog" : `catalog ${data.catalog.version}`;
  return (
    <Card className="mt-6" data-testid="wanted">
      <CardHeader>
        <CardTitle>What each module still needs</CardTitle>
        <span className="ml-auto text-xs text-dim">from {which}, the one live now, with {data.stage}'s values</span>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {data.wanted.length === 0 ? (
          <p className="text-dim" data-testid="nothing-wanted">The live catalog offers no module from your organization's own library, so no module is waiting on a platform value.</p>
        ) : data.wanted.map(w => <WantedModule key={w.module} wanted={w} onSet={onSet} />)}
      </CardContent>
    </Card>
  );
}

function WantedModule({ wanted, onSet }: { wanted: PlatformWanted; onSet: (name: string) => void }) {
  return (
    <section className="rounded-md border border-rule" data-testid="wanted-module" aria-label={wanted.module}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="font-mono font-bold">{wanted.module}</span>
        {wanted.source ? <span className="font-mono text-xs text-dim">{wanted.source}</span> : null}
        <Badge tone={wanted.builds ? "phosphor" : "amber"} className="ml-auto" data-testid="wanted-builds">{wanted.builds ? "The platform builds it" : "Not built yet"}</Badge>
      </div>
      {!wanted.builds && wanted.why ? <p className="px-4 pb-3 text-amber" data-testid="wanted-why">Not built because {wanted.why}.</p> : null}
      {wanted.inputs.length === 0 ? (
        <p className="border-t border-rule px-4 py-3 text-dim">It takes nothing only the platform can give.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow><TableHead>Input</TableHead><TableHead>What it is</TableHead><TableHead>Filled by</TableHead><TableHead /></TableRow>
          </TableHeader>
          <TableBody>
            {wanted.inputs.map(i => (
              <TableRow key={i.input} data-testid="wanted-input">
                <TableCell className="font-mono text-xs">
                  {i.input}
                  <div className="font-sans text-dim">{i.required ? "required" : "optional"}</div>
                </TableCell>
                <TableCell className="text-dim">{i.line || "Not described"}</TableCell>
                <TableCell>
                  {i.filledBy
                    ? <span className="font-mono text-xs" data-testid="filled-by">{i.filledBy}</span>
                    : <Badge tone={i.required ? "amber" : "neutral"} data-testid="no-value">no value</Badge>}
                </TableCell>
                <TableCell className="space-x-2 whitespace-nowrap text-right">
                  {i.filledBy ? null : (<>
                    <Button variant="ghost" size="sm" onClick={() => onSet(i.input)} aria-label={`Set ${i.input}`}>Set it</Button>
                    <Button variant="link" size="sm" onClick={() => onSet(`${wanted.module}.${i.input}`)} aria-label={`Set ${i.input} for ${wanted.module} only`}>for {wanted.module} only</Button>
                  </>)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
