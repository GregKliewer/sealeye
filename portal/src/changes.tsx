// Following changes as they happen (DESIGN.md, "The portal follows changes as they
// happen"): one stream per tab from GET /deployments/events, which says only that a
// deployment this person can see was saved. Each time it does, the count goes up, and a
// page that lists deployments reads them again, so a tear-down run from the command
// line, or anything a teammate does, shows without a refresh.
import { createContext, useContext, useEffect, useState } from "react";
import { useSession } from "./session";

const Changes = createContext(0);

// Changes come in bursts (each step of a deploy is one), so read at most once in this
// long, after the first of them. Never waiting for a quiet spell: a busy platform may
// never have one.
const SETTLE_MS = 300;
// A stream the platform refused, or that is closed for good, is tried again after this.
const RETRY_MS = 30_000;

export function ChangesProvider({ children }: { children: React.ReactNode }) {
  const { person } = useSession();
  const [count, setCount] = useState(0);
  // A laptop API with sign-in off has one person and no email.
  const who = person ? person.email || (person.auth === "off" ? "sign-in off" : null) : null;

  useEffect(() => {
    if (!who || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let openedBefore = false;
    let stopped = false;
    const changed = () => {
      if (settle !== undefined) return;
      settle = setTimeout(() => { settle = undefined; setCount(c => c + 1); }, SETTLE_MS);
    };
    const open = () => {
      if (stopped) return;
      source = new EventSource("/api/deployments/events");
      source.addEventListener("changed", changed);
      // The platform ends each stream after a few minutes and the browser opens the next
      // by itself. Anything saved in between was not heard, so every opening after the
      // first reads again.
      source.onopen = () => {
        if (openedBefore) changed();
        openedBefore = true;
      };
      // Closed for good: refused (an ended sign-in among the reasons) or unreachable.
      // Reading again shows the truth now, and sends an ended sign-in to Sign in; then
      // try the stream again later.
      source.onerror = () => {
        if (source?.readyState !== EventSource.CLOSED) return;
        changed();
        retry = setTimeout(open, RETRY_MS);
      };
    };
    open();
    return () => {
      stopped = true;
      source?.close();
      clearTimeout(settle);
      clearTimeout(retry);
    };
  }, [who]);

  return <Changes.Provider value={count}>{children}</Changes.Provider>;
}

/** Goes up each time a deployment this person can see changes; a load keyed on it reads again. */
export const useChanges = () => useContext(Changes);
