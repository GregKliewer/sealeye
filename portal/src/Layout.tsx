// brand/BRAND-ONLINE.md section 3: a console has furniture. The wordmark, the
// navigation with the current section underlined in phosphor (and, for a section of
// several pages, a second row of tabs under it), the organization and the
// person on the right, and the footer line that does not move.
import { matchPath, NavLink, Outlet, useLocation } from "react-router";
import { api, type Person } from "./api";
import { orgWide, useLoad, useSession } from "./session";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { label } from "../../core/operations.js";
import { hasSettingsAndCosts, organizationInWords } from "../../core/token.js";

// The sections, grouped by whose work they are (Greg, Oct 23, 2026). A section with more
// than one page shows them as a second row of tabs under the bar, so nothing is hidden
// behind a menu; its link goes to the first page this person may see.
interface Page { to: string; label: string; end?: boolean; also?: string[]; orgWide?: boolean; settingsAndCosts?: boolean }
interface Section { label: string; pages: Page[]; orgWide?: boolean }

// Every operation the portal names has a label in core/operations.js.
const L = (op: string) => label(op) ?? op;

const SECTIONS: Section[] = [
  { label: L("list"), pages: [{ to: "/", label: L("list"), end: true, also: ["/new", "/environments/*"] }] },
  { label: L("validate"), pages: [{ to: "/validate", label: L("validate") }] },
  { label: L("catalog"), pages: [{ to: "/catalog", label: L("catalog") }] },
  // A platform engineer's pages, shown only to an organization-wide token: discovery
  // (Greg, Oct 15, 2026), the platform values (PHASE4-PLAN Step 9) and what developers
  // asked for that the platform cannot build (Step 10).
  { label: "Platform", orgWide: true, pages: [
    { to: "/discovery", label: L("discover") },
    { to: "/platform", label: "Platform values" },
    { to: "/gaps", label: L("gaps") }
  ] },
  { label: L("team"), pages: [
    { to: "/team", label: L("team") },
    // Kept by team, not yet by organization: only an organization that has them sees it.
    { to: "/costs", label: L("costs"), settingsAndCosts: true }
  ] }
];

function pagesFor(section: Section, person: Person | null) {
  if (section.orgWide && !orgWide(person)) return [];
  return section.pages.filter(p => !p.settingsAndCosts || hasSettingsAndCosts(person ?? {}));
}

// A page is where you are at its own address (and below it, unless it says end), or at
// any address it also covers: Environments covers a new one and each one's controls.
function isAt(page: Page, path: string) {
  const own = matchPath({ path: page.to, end: page.end ?? false }, path) !== null;
  return own || (page.also ?? []).some(to => matchPath(to, path) !== null);
}

const tab = (isActive: boolean) => cn("border-b-2 -mb-px", isActive ? "border-phosphor text-ink font-medium" : "border-transparent text-dim hover:text-ink");

// Health sits beside the person, not among the sections: a small mark that says at a
// glance whether the platform answers and this page matches it, and opens the checks.
function HealthLink() {
  const health = useLoad(api.health);
  const ok = health.error ? false : health.data ? health.data.version === __PORTAL_VERSION__ : null;
  const words = ok === null ? "Checking the platform" : ok ? "The platform answers" : "Something needs a look";
  return (
    <NavLink to="/health" title={words} data-testid="health-link"
      className={({ isActive }) => cn("flex items-center gap-1.5", isActive ? "text-ink font-medium" : "text-dim hover:text-ink")}>
      <span aria-hidden className={cn("size-2 rounded-full", ok === null ? "bg-rule" : ok ? "bg-phosphor" : "bg-amber")} />
      {L("doctor")}
    </NavLink>
  );
}

export function Layout() {
  const { person, signedOut } = useSession();
  const { pathname } = useLocation();
  const initial = (person?.name || "?").trim().charAt(0).toUpperCase();
  const sections = SECTIONS.map(s => ({ ...s, shown: pagesFor(s, person) })).filter(s => s.shown.length > 0);
  const current = sections.find(s => s.shown.some(p => isAt(p, pathname)));

  async function signOut() {
    await api.signOut().catch(() => {});
    signedOut("You are signed out.");
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-surface border-b border-rule">
        <div className="mx-auto max-w-6xl flex flex-wrap items-center gap-x-8 gap-y-2 px-6 h-auto min-h-14 py-2">
          <img src="/sealeye-online-wordmark-light.svg" alt="seaLeye.online" className="h-8" />
          <nav className="flex max-w-full gap-4 sm:gap-6 overflow-x-auto whitespace-nowrap text-sm" aria-label="Sections">
            {sections.map(s => (
              <NavLink key={s.label} to={s.shown[0].to} end={s.shown[0].end}
                className={() => cn("py-4", tab(s === current))}>
                {s.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <HealthLink />
            <span className="text-dim hidden sm:inline" data-testid="organization">{person ? organizationInWords(person) : null}</span>
            <span className="flex items-center gap-2" title={person?.email}>
              <span aria-hidden className="grid size-7 place-items-center rounded-full bg-phosphor text-white text-xs font-semibold">{initial}</span>
              <span data-testid="person">{person?.name}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button>
          </div>
        </div>
        {current && current.shown.length > 1 ? (
          <div className="border-t border-rule">
            <nav className="mx-auto max-w-6xl flex gap-4 sm:gap-6 overflow-x-auto whitespace-nowrap px-6 text-sm" aria-label={current.label}>
              {current.shown.map(p => (
                <NavLink key={p.to} to={p.to} end={p.end} className={() => cn("py-2.5", tab(isAt(p, pathname)))}>
                  {p.label}
                </NavLink>
              ))}
            </nav>
          </div>
        ) : null}
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
