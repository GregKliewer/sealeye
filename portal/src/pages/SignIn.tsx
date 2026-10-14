// The portal's sign-in (DESIGN.md, "The portal signs in with a session cookie"): the
// token goes to the API once and comes back as a session cookie the page cannot read.
// Nothing here keeps the token.
import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { useSession } from "../session";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Problem } from "../Layout";

const TOKEN = /^sl_[A-Za-z0-9_-]{43}$/;

/**
 * Where to go once signed in: the portal page that sent the browser here, and only ever
 * a page of this portal (a path, never another site's address), else Environments.
 */
function returnTo(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//") || from.startsWith("/\\") || from.startsWith("/sign-in")) return "/";
  return from;
}

export function SignIn() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signedIn, notice: reason } = useSession();
  const navigate = useNavigate();
  const back = returnTo(useLocation().state);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = token.trim();
    if (!TOKEN.test(value)) {
      setError("That is not a seaLeye token: a token starts with sl_ and is 46 characters long.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.signIn(value);
      setToken("");
      signedIn(await api.whoami());
      navigate(back, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <div className="w-full max-w-md">
        <img src="/sealeye-online-wordmark-light.svg" alt="seaLeye.online" className="h-8 mb-8" />
        <Card>
          <CardContent className="py-6">
            <h1 className="text-xl font-semibold">Sign in</h1>
            <p className="mt-2 text-sm text-dim">Paste the token your platform team gave you, the same one <code className="font-mono text-ink">sealeye login</code> takes.</p>
            <form onSubmit={submit} className="mt-5 space-y-4">
              <label className="block text-sm font-medium" htmlFor="token">Token</label>
              <Input id="token" type="password" autoComplete="off" spellCheck={false} value={token}
                onChange={e => setToken(e.target.value)} placeholder="sl_..." className="font-mono" />
              {reason && !error ? <p className="text-sm text-dim">{reason}</p> : null}
              {error ? <Problem message={error} /> : null}
              <Button type="submit" disabled={busy || !token} className="w-full">{busy ? "Checking" : "Sign in"}</Button>
            </form>
            <p className="mt-5 text-xs text-dim">Your sign-in lasts twelve hours. This browser keeps a session for it, never the token itself.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
