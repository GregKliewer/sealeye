// Performance, as `sealeye perf` shows it: what happened to the app over a window, read
// from the platform when asked. Readings, never a capacity: what an app can take is set
// by a load test (principle 8).
import { useState } from "react";
import { api, SignedOut, type Performance, type Period } from "../api";
import { useSession } from "../session";
import { Problem } from "../Layout";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

const WINDOWS: [string, string][] = [["1h", "1 hour"], ["6h", "6 hours"], ["1d", "1 day"], ["7d", "7 days"]];
const n = (v: number) => v.toLocaleString();

export function PerformanceCard({ deploymentId }: { deploymentId: string }) {
  const { signedOut } = useSession();
  const [since, setSince] = useState("1d");
  const [perf, setPerf] = useState<Performance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);

  async function read(window = since) {
    setBusy(true);
    setError(null);
    try {
      setPerf(await api.performance(deploymentId, window));
    } catch (err) {
      if (err instanceof SignedOut) return signedOut(err.message);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const t = perf?.totals;
  return (
    <Card className="mt-6" data-testid="performance">
      <CardHeader>
        <CardTitle>Performance</CardTitle>
        <div className="ml-auto flex flex-wrap gap-1" role="group" aria-label="Over the last">
          {WINDOWS.map(([key, label]) => (
            <Button key={key} size="sm" variant={key === since ? "primary" : "ghost"} aria-pressed={key === since}
              onClick={() => { setSince(key); if (perf) read(key); }}>{label}</Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!perf || !t ? (
          <>
            <p className="text-dim">What happened to your app: requests, errors and the time its code took, as <code className="font-mono text-ink">sealeye perf</code> shows them. Readings of what happened, not what it can take: that is set by a load test.</p>
            <Button onClick={() => read()} disabled={busy}>{busy ? "Reading" : "Show readings"}</Button>
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Requests" value={n(t.requests)} />
              <Stat label="Errors" value={n(t.errors)} note={t.requests ? `${((t.errors / t.requests) * 100).toFixed(1)}% of requests` : undefined} />
              <Stat label="Time taken" value={t.averageMs === null ? "None measured" : `${t.averageMs} ms`} note={t.slowestMs === null ? undefined : `on average; 95 in 100 within ${t.slowestMs} ms`} />
            </div>
            {t.refused ? <p className="text-amber">{n(t.refused)} requests were refused while the app was paused or busy.</p> : null}
            <RequestsChart periods={perf.periods} periodMinutes={perf.periodMinutes} />
            {table ? <PeriodTable periods={perf.periods} /> : null}
            <div className="flex flex-wrap gap-3">
              <Button variant="ghost" onClick={() => setTable(v => !v)}>{table ? "Hide the table" : "Show as a table"}</Button>
              <Button variant="ghost" onClick={() => read()} disabled={busy}>{busy ? "Reading" : "Read again"}</Button>
            </div>
          </>
        )}
        {error ? <Problem message={error} /> : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-rule p-3" data-testid="stat">
      <div className="text-dim">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {note ? <div className="mt-1 text-xs text-dim">{note}</div> : null}
    </div>
  );
}

const clock = (iso: string, days: boolean) =>
  new Date(iso).toLocaleString(undefined, days ? { month: "short", day: "numeric", hour: "numeric" } : { hour: "numeric", minute: "2-digit" });

/** Requests per period: one series, so no legend; hover a column for its reading. */
function RequestsChart({ periods, periodMinutes }: { periods: Period[]; periodMinutes: number }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn in a fixed-height box that stretches across the card; the text around it is
  // HTML, so it stays the page's size at any width.
  const W = 1000, H = 120;
  const max = Math.max(1, ...periods.map(p => p.requests));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const ceiling = Math.ceil(max / step) * step;
  const slot = W / periods.length;
  const gap = Math.min(slot * 0.25, 6);
  const y = (v: number) => H * (1 - v / ceiling);
  const days = periodMinutes >= 360;
  const shown = hover === null ? null : periods[hover];
  return (
    <figure className="space-y-1">
      <figcaption className="flex flex-wrap justify-between gap-2 text-xs text-dim">
        <span>Requests every {periodMinutes < 60 ? `${periodMinutes} minutes` : periodMinutes === 60 ? "hour" : `${periodMinutes / 60} hours`}</span>
        <span data-testid="chart-readout" aria-live="polite">
          {shown ? `${clock(shown.at, days)}: ${n(shown.requests)} requests, ${n(shown.errors)} errors${shown.averageMs === null ? "" : `, ${shown.averageMs} ms on average`}` : "Hover a column for its reading"}
        </span>
      </figcaption>
      <div className="flex gap-2">
        <div className="flex h-[120px] flex-col justify-between text-right text-xs text-dim tabular-nums" aria-hidden>
          <span className="-mt-1.5">{ceiling >= 1000 ? `${ceiling / 1000}K` : ceiling}</span>
          <span className="-mb-1.5">0</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[120px] flex-1 border-y border-rule" role="img"
          aria-label={`Requests per period, highest ${n(max)}`} onMouseLeave={() => setHover(null)}>
          {periods.map((p, i) => (
            <g key={p.at} onMouseEnter={() => setHover(i)}>
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              {p.requests > 0 ? (
                <rect x={i * slot + gap / 2} y={y(p.requests)} width={slot - gap} height={H - y(p.requests)}
                  fill="var(--color-phosphor)" opacity={hover === null || hover === i ? 1 : 0.55} />
              ) : null}
            </g>
          ))}
        </svg>
      </div>
      <div className="flex justify-between pl-8 text-xs text-dim" aria-hidden>
        <span>{clock(periods[0]?.at || "", days)}</span>
        <span>now</span>
      </div>
    </figure>
  );
}

function PeriodTable({ periods }: { periods: Period[] }) {
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-rule">
      <table className="w-full text-xs tabular-nums" data-testid="period-table">
        <thead className="sticky top-0 bg-surface text-dim">
          <tr><th className="p-2 text-left font-normal">From</th><th className="p-2 text-right font-normal">Requests</th><th className="p-2 text-right font-normal">Errors</th><th className="p-2 text-right font-normal">Average</th><th className="p-2 text-right font-normal">95 in 100 within</th></tr>
        </thead>
        <tbody>
          {periods.map(p => (
            <tr key={p.at} className="border-t border-rule">
              <td className="p-2">{new Date(p.at).toLocaleString()}</td>
              <td className="p-2 text-right">{n(p.requests)}</td>
              <td className="p-2 text-right">{n(p.errors)}</td>
              <td className="p-2 text-right">{p.averageMs === null ? "None" : `${p.averageMs} ms`}</td>
              <td className="p-2 text-right">{p.slowestMs === null ? "None" : `${p.slowestMs} ms`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
