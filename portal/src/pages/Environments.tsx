// Environments: every app the platform knows about, one row per environment, newest
// change first, as `sealeye list` shows them. Consoles summarise before they list.
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useLoad, useSession } from "../session";
import { ago, groupEnvironments, PAST, publicUrl, statusOf, who } from "../model";
import { PageTitle, Problem } from "../Layout";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const WEEK_MS = 7 * 24 * 3600_000;

/** Whose environments these are, as the platform decides what this person sees. */
function whose(person: { team?: string; scope?: string; auth?: string } | null | undefined) {
  if (!person || person.auth === "off" || person.scope === "org") return "every team in your organization";
  return `your team, ${person.team}`;
}

export function Environments() {
  const { person } = useSession();
  const deployments = useLoad(api.deployments);
  const catalog = useLoad(api.catalog);
  const [search, setSearch] = useState("");
  const [showPast, setShowPast] = useState(false);

  const environments = useMemo(() => groupEnvironments(deployments.data || []), [deployments.data]);
  // An organization-wide token sees every team's, and two teams can share an app name,
  // so then each row says whose it is.
  const severalTeams = new Set(environments.map(e => e.latest.teamId || "default")).size > 1;
  const shown = environments
    .filter(env => showPast || !PAST.has(env.latest.status))
    .filter(env => {
      const q = search.trim().toLowerCase();
      return !q || env.app.toLowerCase().includes(q) || who(env.latest.requestedBy).toLowerCase().includes(q);
    });

  const now = Date.now();
  const stats = deployments.data
    ? [
        { n: environments.filter(e => e.latest.status === "succeeded").length, label: "Live environments" },
        { n: environments.filter(e => e.latest.status === "drafted").length, label: "Drafted, waiting on the platform" },
        { n: deployments.data.filter(d => d.status !== "drafted" && d.startedAt && now - Date.parse(d.startedAt) < WEEK_MS).length, label: "Deploys this week" },
        { n: catalog.data ? catalog.data.modules.length : null, label: "Modules in the library" }
      ]
    : null;

  return (
    <>
      <PageTitle title="Environments" sub={`Every environment seaLeye has built for ${whose(person)}, as the platform reports it now.`}
        action={<Link to="/new" className="inline-flex h-9 items-center rounded-md bg-phosphor px-4 text-sm font-medium text-white hover:opacity-90">New environment</Link>} />
      {deployments.error ? <Problem message={deployments.error} /> : null}

      {stats ? (
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {stats.map(s => (
            <Card key={s.label} className="px-5 py-4">
              <div className="font-mono text-[28px] leading-tight">{s.n ?? "…"}</div>
              <div className="mt-1 text-sm text-dim">{s.label}</div>
            </Card>
          ))}
        </div>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3">
          <Input type="search" placeholder="Search apps and people" aria-label="Search apps and people" value={search}
            onChange={e => setSearch(e.target.value)} className="max-w-xs" />
          <label className="flex items-center gap-2 text-sm text-dim">
            <input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} className="accent-phosphor" />
            Include drafted and torn down
          </label>
          <span className="ml-auto text-sm text-dim" aria-live="polite">{deployments.data ? `${shown.length} of ${environments.length}` : "Loading"}</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Requested by</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Last change</TableHead>
              <TableHead className="text-right">Deploys</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map(env => {
              const status = statusOf(env.latest);
              const url = publicUrl(env.latest);
              return (
                <TableRow key={env.key} data-testid="environment-row">
                  <TableCell>
                    <Link to={`/environments/${encodeURIComponent(env.key)}`} className="font-mono font-bold text-ink hover:text-phosphor">{env.app}</Link>
                    {severalTeams ? <span className="ml-2 text-xs text-dim" data-testid="team">team {env.latest.teamId || "default"}</span> : null}
                  </TableCell>
                  <TableCell>{who(env.latest.requestedBy)}</TableCell>
                  <TableCell><Badge tone={status.tone}>{status.label}</Badge></TableCell>
                  <TableCell className="max-w-[280px]">
                    {url ? <a href={url} target="_blank" rel="noreferrer" title={url} className="block truncate font-mono text-xs text-phosphor hover:underline">{url}</a> : <span className="text-dim">None yet</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-dim" title={env.latest.startedAt || ""}>{ago(env.latest.startedAt)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{env.deploys.length}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {deployments.data && shown.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-dim">
            {environments.length === 0 ? "No environments yet. A developer creates one with sealeye run." : "No environments match what you are looking for."}
          </p>
        ) : null}
      </Card>
    </>
  );
}
