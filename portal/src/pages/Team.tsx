// Team: the people on your team, as `sealeye team` shows them, from the tokens your
// platform team has issued. Names and when each last used seaLeye; never a token.
// Issuing and revoking stay with the administrator.
import { api } from "../api";
import { useLoad } from "../session";
import { ago, when } from "../model";
import { PageTitle, Problem } from "../Layout";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { label } from "../../../core/operations.js";

export function TeamPage() {
  const team = useLoad(api.team);
  const data = team.data;
  return (
    <>
      <PageTitle title={label("team")} sub={data?.everyTeam ? "Everyone in your organization with a seaLeye token." : data?.team ? `Everyone on team ${data.team} with a seaLeye token. Your platform team issues them.` : undefined} />
      {team.error ? <Problem message={team.error} /> : null}
      {data?.note ? <p className="text-dim">{data.note}</p> : null}
      {data && !data.note ? (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead><TableHead>Email</TableHead>{data.everyTeam ? <TableHead>Team</TableHead> : null}<TableHead>Since</TableHead><TableHead>Last used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.people.map(p => (
                <TableRow key={`${p.team}:${p.email}`} data-testid="person-row">
                  <TableCell>{p.name || "Not recorded"}{p.scope === "org" ? <Badge tone="neutral" className="ml-2">every team</Badge> : null}</TableCell>
                  <TableCell className="text-dim">{p.email}</TableCell>
                  {data.everyTeam ? <TableCell>{p.team}</TableCell> : null}
                  <TableCell className="text-xs">{when(p.issuedAt)}</TableCell>
                  <TableCell className="text-xs text-dim">{p.lastUsedAt ? ago(p.lastUsedAt) : "Never"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}
