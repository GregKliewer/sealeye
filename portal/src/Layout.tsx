// brand/BRAND-ONLINE.md section 3: a console has furniture. The wordmark, the
// navigation with the current section underlined in phosphor, the organization and the
// person on the right, and the footer line that does not move.
import { NavLink, Outlet } from "react-router";
import { api } from "./api";
import { useSession } from "./session";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

const NAV = [
  { to: "/", label: "Environments", end: true },
  { to: "/validate", label: "Validate", end: false },
  { to: "/catalog", label: "Catalog", end: false },
  { to: "/health", label: "Health", end: false }
];

export function Layout() {
  const { person, signedOut } = useSession();
  const initial = (person?.name || "?").trim().charAt(0).toUpperCase();

  async function signOut() {
    await api.signOut().catch(() => {});
    signedOut("You are signed out.");
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-surface border-b border-rule">
        <div className="mx-auto max-w-6xl flex flex-wrap items-center gap-x-8 gap-y-2 px-6 h-auto min-h-14 py-2">
          <img src="/sealeye-online-wordmark-light.svg" alt="seaLeye.online" className="h-8" />
          <nav className="flex gap-6 text-sm" aria-label="Sections">
            {NAV.map(n => (
              <NavLink key={n.to} to={n.to} end={n.end}
                className={({ isActive }) => cn("py-4 border-b-2 -mb-px", isActive ? "border-phosphor text-ink font-medium" : "border-transparent text-dim hover:text-ink")}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-dim hidden sm:inline">{person?.organizationName}</span>
            <span className="flex items-center gap-2" title={person?.email}>
              <span aria-hidden className="grid size-7 place-items-center rounded-full bg-phosphor text-white text-xs font-semibold">{initial}</span>
              <span data-testid="person">{person?.name}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <Outlet />
      </main>
      <footer className="mx-auto w-full max-w-6xl px-6 pb-8 text-sm text-dim">
        <div className="border-t border-rule pt-4 space-y-1">
          <div>Developers deploy to dev. The plan they approve is what the later stages are built from.</div>
          <div>State shown here is read from your environments, not from anyone's laptop.</div>
        </div>
      </footer>
    </div>
  );
}

export function PageTitle({ title, sub, action }: { title: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {sub ? <p className="mt-1 text-dim">{sub}</p> : null}
      </div>
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  );
}

export function Problem({ message }: { message: string }) {
  return <div role="alert" className="rounded-lg border border-amber/40 bg-amber-chip px-4 py-3 text-sm text-amber">{message}</div>;
}
