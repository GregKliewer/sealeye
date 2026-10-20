// Plan and report, as `sealeye plan` writes them: the plan one deployment was approved
// with (DEPLOYMENT_PLAN.md and sealeye.yaml, the files `sealeye run` writes before the
// yes) and what it got (DEPLOYMENT_REPORT.md, written when it succeeds). Read from the
// record (GET /deployments/{id}/plan), so reading them asks nothing of AWS.
import { useEffect, useState } from "react";
import { api, type DeploymentSummary } from "../api";
import { noReportWords, planOrigin } from "../../../core/plan-report-words.js";
import { useLoad } from "../session";
import { Problem } from "../Layout";
import { CommandHint } from "../Command";
import { label } from "../../../core/operations.js";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

const REPORT_FILE = "DEPLOYMENT_REPORT.md";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: name.endsWith(".md") ? "text/markdown" : "text/yaml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const shown = "mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-rule bg-ground p-4 font-mono text-xs";

export function PlanCard({ dep, latest }: { dep: DeploymentSummary; latest: boolean }) {
  const loaded = useLoad(() => api.plan(dep.deploymentId), [dep.deploymentId, dep.status]);
  const error = loaded.data?.deploymentId === dep.deploymentId || !loaded.data ? loaded.error : null;
  const [which, setWhich] = useState<"plan" | "report">("plan");
  // Another deployment picked from the history starts on its plan, and what was read for
  // the one before is never shown under this one's id.
  useEffect(() => setWhich("plan"), [dep.deploymentId]);
  const view = loaded.data?.deploymentId === dep.deploymentId ? loaded.data : null;
  const planMd = view?.files?.["DEPLOYMENT_PLAN.md"];

  return (
    <Card className="mt-6 scroll-mt-6" id="plan" data-testid="plan-card">
      <CardHeader>
        <CardTitle>{label("plan")}</CardTitle>
        <span className="ml-auto font-mono text-xs text-dim">{dep.deploymentId}{latest ? " (the latest)" : ""}</span>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {error ? <Problem message={error} /> : null}
        {!view && !error ? <p className="text-dim" aria-live="polite">Reading the record</p> : null}
        {view ? (
          <>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Which file">
              <Button size="sm" variant={which === "plan" ? "primary" : "ghost"} aria-pressed={which === "plan"} onClick={() => setWhich("plan")}>The plan</Button>
              <Button size="sm" variant={which === "report" ? "primary" : "ghost"} aria-pressed={which === "report"} onClick={() => setWhich("report")}>The report</Button>
            </div>

            {which === "plan" ? (
              <div data-testid="plan-tab">
                {view.filesError ? <Problem message={`The plan's files could not be written: ${view.filesError}`} /> : null}
                {view.files ? (
                  <>
                    <p className="text-dim">{planOrigin(view)}</p>
                    <div className="mt-3 flex flex-wrap gap-3">
                      {Object.keys(view.files).map(name => (
                        <Button key={name} variant="ghost" onClick={() => download(name, view.files![name])}>Download {name}</Button>
                      ))}
                    </div>
                    {planMd ? <pre className={shown} data-testid="plan-file" tabIndex={0} aria-label="DEPLOYMENT_PLAN.md">{planMd}</pre> : null}
                  </>
                ) : null}
              </div>
            ) : (
              <div data-testid="report-tab">
                {view.report ? (
                  <>
                    <p className="text-dim">What this deployment built, the same DEPLOYMENT_REPORT.md the command writes when it succeeds.</p>
                    <div className="mt-3"><Button variant="ghost" onClick={() => download(REPORT_FILE, view.report!)}>Download {REPORT_FILE}</Button></div>
                    <pre className={shown} data-testid="report-file" tabIndex={0} aria-label="DEPLOYMENT_REPORT.md">{view.report}</pre>
                  </>
                ) : (
                  <p className={view.reportError || view.status === "failed" ? "text-amber" : "text-dim"} data-testid="no-report">{noReportWords({ status: view.status, failureReason: view.failureReason ?? dep.failureReason, reportError: view.reportError })}</p>
                )}
              </div>
            )}
            <CommandHint op="plan" target={dep.deploymentId} flags={which === "report" ? ["--report"] : []} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
