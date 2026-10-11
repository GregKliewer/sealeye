// Who is signed in, for every page. Anything the API answers with "signed out" (the
// session expired, the person signed out elsewhere, their token was revoked) sends the
// browser to the sign-in page, saying why.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api, SignedOut, type Person } from "./api";

interface SessionState {
  person: Person | null;
  checked: boolean;
  /** Why the sign-in page is showing, when it is because a session ended. */
  notice: string | null;
  signedIn: (p: Person) => void;
  signedOut: (reason?: string) => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [person, setPerson] = useState<Person | null>(null);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();

  // The reason is kept here rather than passed along with the redirect, so it survives
  // however many redirects it takes to reach the sign-in page.
  const signedOut = useCallback((reason?: string) => {
    setNotice(reason || null);
    setPerson(null);
    navigate("/sign-in", { replace: true });
  }, [navigate]);

  const signedIn = useCallback((p: Person) => {
    setNotice(null);
    setPerson(p);
  }, []);

  useEffect(() => {
    api.whoami()
      .then(setPerson)
      .catch(() => setPerson(null))
      .finally(() => setChecked(true));
  }, []);

  return <SessionContext.Provider value={{ person, checked, notice, signedIn, signedOut }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

/** Load something from the API for a page; a signed-out answer goes to sign-in. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const { signedOut } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    load()
      .then(d => { if (live) { setData(d); setError(null); } })
      .catch(err => {
        if (!live) return;
        if (err instanceof SignedOut) signedOut("Your sign-in has ended. Sign in again with your token.");
        else setError(err.message);
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, reload: () => setTick(t => t + 1) };
}
