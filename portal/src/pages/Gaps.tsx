// Gaps: the gap report, as `sealeye gaps` shows it (PHASE4-PLAN Step 10; DESIGN.md, "The
// gap report"). What developers asked for that the live catalog cannot build, by how
// often and which teams, and what the organization's library has for each; then what
// was asked for and is built now, with the apps that can be planned again. A platform
// engineer's page: only an organization-wide token sees it, as the API answers no one
// else. The words are core/gap-words.js's, the command's own.
import { Navigate } from "react-router";
import { api } from "../api";
import { orgWide, useLoad, useSession } from "../session";
import { PageTitle, Problem } from "../Layout";
import { CommandHint } from "../Command";
import { label } from "../../../core/operations.js";
import { askedWords, gapsHeading, libraryWords, metWords, noGapsWords, rankWords } from "../../../core/gap-words.js";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export function GapsPage() {
  const { person } = useSession();
  if (person && !orgWide(person)) return <Navigate to="/" replace />;
  return <GapReport />;
}

function GapReport() {
  const report = useLoad(() => api.gaps(), []);
  const data = report.data;
  return (
    <>
      <PageTitle
        title={label("gaps")}
        sub={data ? gapsHeading(data) : "What developers asked for that your live catalog cannot build, by how often and which teams."}
        action={<CommandHint op="gaps" className="justify-end" />} />
      {report.error ? <Problem message={report.error} /> : null}
      {data && !data.gaps.length ? <p className="text-dim" data-testid="no-gaps">{noGapsWords(data)}</p> : null}
      <ol className="space-y-4" data-testid="gaps">
        {(data?.gaps || []).map(g => (
          <li key={g.kind} data-testid="gap">
            <Card>
              <CardHeader>
                <CardTitle><span className="mr-2 text-amber">{g.rank}.</span>{g.line}</CardTitle>
                {g.listed ? <Badge className="ml-auto">{g.kind}</Badge> : <Badge className="ml-auto">in the developer's words</Badge>}
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p data-testid="gap-asked">{askedWords(g)}</p>
                <p className="text-dim" data-testid="gap-library">{libraryWords(g)}</p>
                {rankWords(g) ? <p className="text-dim" data-testid="gap-rank">{rankWords(g)}</p> : null}
                <p className="text-dim">{g.apps.map(a => `${a.name} (${a.team})`).join(", ")}</p>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
      {data?.met.length ? (
        <Card className="mt-6" data-testid="gaps-met">
          <CardHeader><CardTitle>Asked for, and built now</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {data.met.map(m => <p key={m.kind}><span className="text-ink">{m.line}</span>: <span className="text-dim">{metWords(m)}</span></p>)}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
