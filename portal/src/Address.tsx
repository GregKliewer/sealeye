// An environment's address, as Environments and Control both show it: a link while it
// answers there, greyed out and not a link while it is being torn down, and none once
// it is gone. A torn-down record keeps the address it had, for the evidence and the
// history, but a link to it would only lead to an error.
import { goingAway, type Environment } from "./model";
import { cn } from "./lib/utils";

export function Address({ env, url, row = false }: { env: Environment; url: string | null; row?: boolean }) {
  const fit = row ? "block truncate" : "break-all";
  if (url && goingAway(env)) {
    // Said apart from the address, on a line of its own, so a row that cuts a long
    // address short still says it, and the address never runs into the words (the
    // first database's tear-down, Oct 21, 2026).
    return (
      <span className="block text-xs text-dim" title={row ? url : undefined}>
        <span className={cn(fit, "block font-mono")}>{url}</span>
        <span className="block">Going away: it is being torn down</span>
      </span>
    );
  }
  if (url) {
    return <a href={url} target="_blank" rel="noreferrer" title={row ? url : undefined} className={cn(fit, "font-mono text-xs text-phosphor hover:underline")}>{url}</a>;
  }
  return <span className="text-dim">{env.latest.status === "destroyed" ? "None, it was torn down" : "None yet"}</span>;
}
