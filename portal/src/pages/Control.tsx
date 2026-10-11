// Control: one environment. Its state as the platform reports it, the way to tear it
// down (the same DELETE /deployments/{id} `sealeye destroy` uses; the record says it
// came from the portal), and everything that has been done to it.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { api, SignedOut } from "../api";
import { useLoad, useSession } from "../session";
import { ago, groupEnvironments, IN_FLIGHT, publicUrl, statusOf, when, who } from "../model";
import { PageTitle, Problem } from "../Layout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const POLL_MS = 5000;

export function Control() {
  const key = decodeURIComponent(useParams().key || "");
  const deployments = useLoad(api.deployments, [key]);
  const env = useMemo(() => groupEnvironments(deployments.data || []).find(e => e.key === key) || null, [deployments.data, key]);
  const latest = env?.latest;

  // While anything is moving, read it again every five seconds, as `sealeye watch` does.
  useEffect(() => {
    if (!latest || !IN_FLIGHT.has(latest.status)) return;
    const t = setTimeout(deployments.reload, POLL_MS);
    return () => clearTimeout(t);
  }, [latest, deployments]);

  if (deployments.error) return <Problem message={deployments.error} />;
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
  const url = publicUrl(latest);
  const canTearDown = !["destroyed", "destroying", "drafted"].includes(latest.status);

  return (
    <>
      <div className="mb-2 text-sm"><Link to="/" className="text-dim hover:text-ink">Environments</Link></div>
      <PageTitle
        title={<span className="font-mono">{env.app}</span>}
        sub={[latest.kind === "static" ? "A static site" : latest.kind === "api" ? "An API" : null, latest.profile ? `designed for ${latest.profile}` : null].filter(Boolean).join(", ") || undefined}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>State</CardTitle><Badge tone={status.tone} className="ml-auto" data-testid="status">{status.label}</Badge></CardHeader>
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

        <Card>
          <CardHeader><CardTitle>Tear down</CardTitle></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-dim">Removes this environment and everything the platform built for it. The address stops working. The plan stays in the developer's folder, so <code className="font-mono text-ink">sealeye run</code> can build it again.</p>
            {canTearDown ? <TearDown app={env.app} deploymentId={latest.deploymentId} onDone={deployments.reload} /> : (
              <p className="text-dim">{latest.status === "drafted" ? "Nothing was built for a drafted plan, so there is nothing to tear down." : "There is nothing standing to tear down."}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>What has been done to this app</CardTitle></CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Deployment</TableHead><TableHead>Status</TableHead><TableHead>Started</TableHead><TableHead>By</TableHead><TableHead>From</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {env.deploys.map(d => {
              const s = statusOf(d);
              return (
                <TableRow key={d.deploymentId} data-testid="history-row">
                  <TableCell className="font-mono text-xs">{d.deploymentId}</TableCell>
                  <TableCell><Badge tone={s.tone}>{s.label}</Badge></TableCell>
                  <TableCell className="text-xs">{when(d.startedAt)}</TableCell>
                  <TableCell>{who(d.requestedBy)}</TableCell>
                  <TableCell className="text-dim">{d.surface === "portal" ? "Portal" : "Command line"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

/** A tear-down is asked for twice: once with the button, once by typing the app's name. */
function TearDown({ app, deploymentId, onDone }: { app: string; deploymentId: string; onDone: () => void }) {
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
