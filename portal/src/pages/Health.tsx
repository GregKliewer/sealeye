// Health: what `sealeye doctor` checks for someone using the hosted platform, for this
// browser (GET /health, GET /whoami). Each check answers one question a person can act
// on, and one that fails says what to do. Nothing here changes anything.
import { api } from "../api";
import { useLoad, useSession } from "../session";
import { seesInWords } from "../../../core/token.js";
import { PageTitle } from "../Layout";
import { Badge } from "../components/ui/badge";
import { Card, CardContent } from "../components/ui/card";

interface Check { name: string; ok: boolean | null; detail: string; fix?: string }

export function Health() {
  const health = useLoad(api.health);
  const me = useLoad(api.whoami);
  const { person } = useSession();

  const checks: Check[] = [];

  if (health.error) {
    checks.push({ name: "Platform", ok: false, detail: `did not answer (${health.error})`, fix: "Check this computer is online. If it still does not answer, tell your platform team." });
  } else if (health.data) {
    checks.push({ name: "Platform", ok: true, detail: `answering, version ${health.data.version}` });
  } else {
    checks.push({ name: "Platform", ok: null, detail: "asking" });
  }

  const who = me.data || person;
  if (me.error) {
    checks.push({ name: "Signed in", ok: false, detail: me.error, fix: "Sign out, then sign in again with the token your platform team gave you." });
  } else if (who?.auth === "off") {
    checks.push({ name: "Signed in", ok: true, detail: "this platform does not ask who is calling" });
  } else if (who) {
    checks.push({ name: "Signed in", ok: true, detail: `${who.name} (${who.email}), ${seesInWords(who)}` });
  }

  // A page left open across a release is older than the platform behind it, and may ask
  // for something the platform no longer answers the same way.
  if (health.data) {
    const same = health.data.version === __PORTAL_VERSION__;
    checks.push(same
      ? { name: "This page", ok: true, detail: `version ${__PORTAL_VERSION__}, the same as the platform` }
      : { name: "This page", ok: false, detail: `version ${__PORTAL_VERSION__}; the platform runs ${health.data.version}`, fix: "Reload the page to get the version that matches." });
  }

  return (
    <>
      <PageTitle title="Health" sub={<>What <code className="font-mono">sealeye doctor</code> checks, for this browser.</>} />
      <Card>
        <CardContent>
          <ul className="divide-y divide-rule">
            {checks.map(c => (
              <li key={c.name} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3 text-sm" data-testid="health-check">
                <span className="w-24 sm:w-28 shrink-0 font-medium">{c.name}</span>
                <span className="flex-1 min-w-0">
                  <span className="break-words">{c.detail}</span>
                  {c.fix ? <span className="mt-1 block text-amber">{c.fix}</span> : null}
                </span>
                {c.ok === null ? null : <Badge tone={c.ok ? "phosphor" : "amber"}>{c.ok ? "OK" : "Needs attention"}</Badge>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
