// Catalog: what the platform builds, from the module catalog, and what apps have needed
// that it does not build yet, from the needs ledger (`sealeye catalog`, `sealeye needs`).
// Never a vendor, never a date: a need waits for the organization's Platform Library.
import { useState } from "react";
import { Link } from "react-router";
import { api, type Catalog, type NeedsLedger } from "../api";
import { useLoad } from "../session";
import { ago } from "../model";
import { PageTitle, Problem } from "../Layout";
import { Cmd, CommandHint } from "../Command";
import { label } from "../../../core/operations.js";
import { catalogSentence } from "../../../core/plan-words.js";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export function CatalogPage() {
  const catalog = useLoad(api.catalog);
  const ledger = useLoad(api.needs);

  return (
    <>
      <PageTitle title={label("catalog")} sub="What the platform builds today, and what apps have needed that it does not build yet." />
      {catalog.error ? <Problem message={catalog.error} /> : null}
      {catalog.data ? <p className="mb-4 text-sm text-dim" data-testid="catalog-version">{catalogSentence(catalog.data.catalog)}</p> : null}

      <div className="grid gap-4 md:grid-cols-2">
        {(catalog.data?.modules || []).map(m => <ModuleCard key={m.id} m={m} />)}
      </div>

      <Card className="mt-8">
        <CardHeader><CardTitle>What apps need that no module supports yet</CardTitle></CardHeader>
        <CardContent>
          {ledger.error ? <Problem message={ledger.error} /> : null}
          {ledger.data && ledger.data.needs.length === 0 ? (
            <p className="text-sm text-dim">No app is waiting on anything the platform does not build.</p>
          ) : null}
          <ul className="divide-y divide-rule">
            {(ledger.data?.needs || []).map(n => <NeedRow key={n.kind} n={n} />)}
          </ul>
          <p className="mt-4 text-xs text-dim">When your organization's Platform Library supports one of these, running <Cmd op="run" className="text-inherit" /> again finishes the plan.</p>
          <CommandHint op="needs" className="mt-2" />
        </CardContent>
      </Card>
    </>
  );
}

/** One module: what it gives an app, and on a click, which apps use it now and at which release. */
function ModuleCard({ m }: { m: Catalog["modules"][number] }) {
  const [open, setOpen] = useState(false);
  const users = m.usedBy;
  return (
    <Card data-testid="module-card">
      <CardContent>
        <button type="button" className="block w-full text-left disabled:cursor-default" aria-expanded={open} onClick={() => setOpen(o => !o)} disabled={!users?.length} data-testid="module-toggle">
          <div className="flex items-start gap-3">
            <div className="font-mono font-bold">{m.id}</div>
            {m.version ? <span className="font-mono text-xs text-dim" data-testid="module-version">version {m.version}</span> : null}
            <Badge tone="phosphor" className="ml-auto">Available</Badge>
          </div>
          <p className="mt-2 text-sm text-dim">{m.line}</p>
          {users ? (
            <p className={users.length ? "mt-2 text-xs text-phosphor" : "mt-2 text-xs text-dim"} data-testid="module-use-count">
              {users.length === 0 ? "Used by no app yet" : users.length === 1 ? "Used by 1 app" : `Used by ${users.length} apps`}{users.length ? (open ? ", hide them" : ", show which") : ""}
            </p>
          ) : null}
        </button>
        {open && users?.length ? (
          <ul className="mt-3 space-y-1 border-t border-rule pt-3 text-sm" data-testid="module-users">
            {users.map(u => (
              <li key={`${u.team}/${u.app}`} className="flex flex-wrap items-baseline gap-x-2" data-testid="module-user">
                {u.path ? <Link to={u.path} className="font-mono text-phosphor hover:underline">{u.app}</Link> : <span className="font-mono">{u.app}</span>}
                <span className="text-dim">{u.version ? `at ${u.version}` : null}</span>
                <span className="text-xs text-dim">team {u.team}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One need: its line, and on a click, the apps waiting on it, each linked where you may open it. */
function NeedRow({ n }: { n: NeedsLedger["needs"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-3" data-testid="need-row">
      <button type="button" className="block w-full text-left" aria-expanded={open} onClick={() => setOpen(o => !o)} data-testid="need-toggle">
        <div className="flex items-start gap-3">
          <p className="text-sm">{n.line}</p>
          {n.listed === false ? <Badge tone="neutral" data-testid="unlisted">Not in the list yet</Badge> : null}
          <Badge tone="amber" className="ml-auto">{n.count === 1 ? "1 app" : `${n.count} apps`}</Badge>
        </div>
        <p className="mt-1 text-xs text-dim">
          <span className="font-mono">{n.apps.map(a => a.name).join(", ")}</span>
          {n.lastSeen ? <>, most recently {ago(n.lastSeen)}</> : null}
          <span className="text-phosphor">{open ? ", hide" : ", show each"}</span>
        </p>
      </button>
      {open ? (
        <ul className="mt-2 ml-1 space-y-1 border-l-2 border-rule pl-3 text-sm" data-testid="need-apps">
          {n.apps.map(a => (
            <li key={`${a.team}/${a.name}`} className="flex flex-wrap items-baseline gap-x-2" data-testid="need-app">
              {a.path ? <Link to={a.path} className="font-mono text-phosphor hover:underline">{a.name}</Link> : <span className="font-mono">{a.name}</span>}
              <span className="text-xs text-dim">team {a.team || "default"}{a.when ? `, ${ago(a.when)}` : ""}{a.path ? "" : ", another team's, so its page is theirs"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

