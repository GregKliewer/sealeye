// Costs: what each of your team's apps has cost, as `sealeye costs` shows it, from the
// cost allocation tags every environment carries from its next deploy. About a day
// behind, and only what carries the tags; the page says both.
import { useState } from "react";
import { api } from "../api";
import { useLoad } from "../session";
import { when } from "../model";
import { PageTitle, Problem } from "../Layout";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

export function CostsPage() {
  const [since, setSince] = useState("30d");
  const costs = useLoad(() => api.costs(since), [since]);
  const data = costs.data;
  const money = (v: number) => `${v.toFixed(2)} ${data?.unit || ""}`.trim();
  return (
    <>
      <PageTitle title="Costs" sub={data?.everyTeam ? "What each app in your organization has cost." : "What each of your team's apps has cost."}
        action={
          <div className="flex gap-1" role="group" aria-label="Over the last">
            {[["7d", "7 days"], ["30d", "30 days"]].map(([key, label]) => (
              <Button key={key} size="sm" variant={key === since ? "primary" : "ghost"} aria-pressed={key === since} onClick={() => setSince(key)}>{label}</Button>
            ))}
          </div>
        } />
      {costs.error ? <Problem message={costs.error} /> : null}
      {!data && !costs.error ? <p className="text-dim">Reading costs</p> : null}
      {data ? (
        <Card>
          {data.apps.length ? (
            <Table>
              <TableHeader>
                <TableRow><TableHead>App</TableHead>{data.everyTeam ? <TableHead>Team</TableHead> : null}<TableHead className="text-right">Cost</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {data.apps.map(a => (
                  <TableRow key={`${a.team}/${a.app}`} data-testid="cost-row">
                    <TableCell className="font-mono text-xs">{a.app}</TableCell>
                    {data.everyTeam ? <TableCell>{a.team}</TableCell> : null}
                    <TableCell className="text-right tabular-nums">{money(a.amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-medium" colSpan={data.everyTeam ? 2 : 1}>From {data.from} to {data.to}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums" data-testid="cost-total">{money(data.total)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          ) : null}
          <CardContent className="space-y-2 text-sm">
            {!data.apps.length ? <p>No costs carry seaLeye's tags yet.</p> : null}
            <p className="text-dim">{data.note}</p>
            <p className="text-xs text-dim">Read {when(data.readAt)}.</p>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
