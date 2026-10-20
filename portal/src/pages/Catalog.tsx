// Catalog: what the platform builds, from the module catalog, and what apps have needed
// that it does not build yet, from the needs ledger (`sealeye catalog`, `sealeye needs`).
// Never a vendor, never a date: a need waits for the organization's Platform Library.
import { api } from "../api";
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
        {(catalog.data?.modules || []).map(m => (
          <Card key={m.id} data-testid="module-card">
            <CardContent>
              <div className="flex items-start gap-3">
                <div className="font-mono font-bold">{m.id}</div>
                {m.version ? <span className="font-mono text-xs text-dim" data-testid="module-version">version {m.version}</span> : null}
                <Badge tone="phosphor" className="ml-auto">Available</Badge>
              </div>
              <p className="mt-2 text-sm text-dim">{m.line}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-8">
        <CardHeader><CardTitle>What apps need that no module supports yet</CardTitle></CardHeader>
        <CardContent>
          {ledger.error ? <Problem message={ledger.error} /> : null}
          {ledger.data && ledger.data.needs.length === 0 ? (
            <p className="text-sm text-dim">No app is waiting on anything the platform does not build.</p>
          ) : null}
          <ul className="divide-y divide-rule">
            {(ledger.data?.needs || []).map(n => (
              <li key={n.kind} className="py-3" data-testid="need-row">
                <div className="flex items-start gap-3">
                  <p className="text-sm">{n.line}</p>
                  {n.listed === false ? <Badge tone="neutral" data-testid="unlisted">Not in the list yet</Badge> : null}
                  <Badge tone="amber" className="ml-auto">{n.count === 1 ? "1 app" : `${n.count} apps`}</Badge>
                </div>
                <p className="mt-1 text-xs text-dim">
                  <span className="font-mono">{n.apps.map(a => a.name).join(", ")}</span>
                  {n.lastSeen ? <>, most recently {ago(n.lastSeen)}</> : null}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-dim">When your organization's Platform Library supports one of these, running <Cmd op="run" className="text-inherit" /> again finishes the plan.</p>
          <CommandHint op="needs" className="mt-2" />
        </CardContent>
      </Card>
    </>
  );
}
