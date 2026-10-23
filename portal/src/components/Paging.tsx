// Paging and status chips for the portal's longer lists (Greg, Oct 23, 2026): a list
// shows a window of rows with Previous and Next, and a rows picker (10, 25 or 50) that
// each card remembers in this browser. Status chips, with counts, choose which rows a
// list shows; every chip is on to begin with, and paging counts only what is shown.
// All of this is display: every row still comes from the API, as the command prints them.
import { useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export const ROW_CHOICES = [10, 25, 50] as const;
const DEFAULT_ROWS = ROW_CHOICES[0];

/** The rows this card was last set to show, in this browser; the default where storage is unavailable. */
function rememberedRows(card: string): number {
  try {
    const n = Number(window.localStorage.getItem(`sealeye.rows.${card}`));
    return (ROW_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_ROWS;
  } catch {
    return DEFAULT_ROWS;
  }
}

function rememberRows(card: string, n: number) {
  try { window.localStorage.setItem(`sealeye.rows.${card}`, String(n)); } catch { /* shown, not kept */ }
}

/**
 * A window of `items`, with what the pager needs. `card` names the card, for the rows it
 * remembers; `reset` is anything (a filter) that should send the list back to its first page.
 */
export function usePaged<T>(items: T[], card: string, reset: unknown = null) {
  const [size, setSizeState] = useState(() => rememberedRows(card));
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size));
  useEffect(() => { setPage(0); }, [reset, size]);
  // A list that shrank (a row removed, a filter) never leaves the page past its end.
  useEffect(() => { if (page > pages - 1) setPage(pages - 1); }, [page, pages]);
  const at = Math.min(page, pages - 1);
  const shown = useMemo(() => items.slice(at * size, at * size + size), [items, at, size]);
  const setSize = (n: number) => { rememberRows(card, n); setSizeState(n); };
  return { shown, page: at, pages, size, setSize, setPage, total: items.length, card };
}

/** Previous, Next, where you are, and how many rows a page shows. Nothing for a list that fits the smallest page. */
export function Pager({ paged, className }: { paged: ReturnType<typeof usePaged<unknown>>; className?: string }) {
  const { page, pages, size, setSize, setPage, total, card } = paged;
  if (total <= DEFAULT_ROWS) return null;
  const first = page * size + 1;
  const last = Math.min(total, first + size - 1);
  return (
    <div className={cn("flex flex-wrap items-center gap-3 text-sm text-dim", className)} data-testid="pager" data-card={card}>
      <span data-testid="pager-position">{first} to {last} of {total}</span>
      <Button size="sm" variant="ghost" onClick={() => setPage(page - 1)} disabled={page === 0}>Previous</Button>
      <Button size="sm" variant="ghost" onClick={() => setPage(page + 1)} disabled={page >= pages - 1}>Next</Button>
      <label className="ml-auto flex items-center gap-2">
        Rows
        <select className="rounded-md border border-rule bg-surface px-2 py-1 text-ink" value={size} onChange={e => setSize(Number(e.target.value))} data-testid="pager-rows">
          {ROW_CHOICES.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
  );
}

export interface Chip { key: string; label: string }

/**
 * Toggle chips for the statuses a list holds, each with its count. Every chip starts on;
 * the set returned holds the keys that are on. Nothing is drawn for a list of one status.
 */
export function useChips<T>(items: T[], statusOf: (item: T) => Chip) {
  const [off, setOff] = useState<Set<string>>(new Set());
  const chips = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const item of items) {
      const { key, label } = statusOf(item);
      counts.set(key, { label, count: (counts.get(key)?.count || 0) + 1 });
    }
    return [...counts].map(([key, v]) => ({ key, ...v }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const shown = useMemo(() => items.filter(item => !off.has(statusOf(item).key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, off]);
  const toggle = (key: string) => setOff(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return { chips, off, shown, toggle, filterKey: [...off].sort().join(",") };
}

export function Chips({ chips: c, className }: { chips: ReturnType<typeof useChips<unknown>>; className?: string }) {
  if (c.chips.length < 2) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)} role="group" aria-label="Show by status" data-testid="status-chips">
      {c.chips.map(chip => {
        const on = !c.off.has(chip.key);
        return (
          <button key={chip.key} type="button" aria-pressed={on} onClick={() => c.toggle(chip.key)} data-testid="status-chip"
            className={cn("rounded-full border px-3 py-1 text-xs font-medium",
              on ? "border-phosphor bg-phosphor-chip text-phosphor" : "border-rule bg-surface text-dim line-through decoration-dim/60")}>
            {chip.label} {chip.count}
          </button>
        );
      })}
    </div>
  );
}

/** What a list says when its chips leave nothing to show. */
export const NOTHING_CHOSEN = "Nothing with the statuses chosen. Turn a status back on above.";
