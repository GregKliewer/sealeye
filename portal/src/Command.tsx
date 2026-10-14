// The command line for what a page or a button does, in the words the command takes
// (core/operations.js). The portal never types a command of its own: it asks the list,
// so a renamed command is renamed here too (test/operations.test.js).
import { useState } from "react";
import { commandLine } from "../../core/operations.js";
import { cn } from "./lib/utils";

/** A command named inside a sentence: "as `sealeye logs shop-api` shows it". */
export function Cmd({ op, target, className }: { op: string; target?: string; className?: string }) {
  return <code className={cn("font-mono text-ink", className)}>{commandLine(op, target)}</code>;
}

/**
 * The same thing from the command line, on a line of its own under a button or at the
 * foot of a card, with a button that copies it. Copying is a convenience: a browser that
 * refuses leaves the line to be selected by hand.
 */
export function CommandHint({ op, target, flags, className }: { op: string; target?: string; flags?: string[]; className?: string }) {
  const line = commandLine(op, target, flags);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <p className={cn("flex items-center gap-2 text-xs text-dim", className)} data-testid="command-hint">
      <span className="sr-only">From the command line:</span>
      <code className="min-w-0 truncate font-mono" title={line}>{line}</code>
      <button type="button" onClick={copy} aria-label={`Copy ${line}`}
        className="shrink-0 rounded px-1 text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-phosphor cursor-pointer">
        {copied ? "Copied" : (
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 fill-current"><path d="M5 2.5A1.5 1.5 0 0 1 6.5 1h6A1.5 1.5 0 0 1 14 2.5v8a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 5 10.5v-8Zm1.5 0v8h6v-8h-6ZM2 5.5A1.5 1.5 0 0 1 3.5 4H4v1.5h-.5v8h6V13H11v.5A1.5 1.5 0 0 1 9.5 15h-6A1.5 1.5 0 0 1 2 13.5v-8Z" /></svg>
        )}
      </button>
    </p>
  );
}
