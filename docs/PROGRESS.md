# Progress — deployme demo

Panel: Fri Oct 2, 2026. Code freeze: Sun Sept 27, 2026.
Last updated: Sun Sept 20, 2026.

## Done

**Planning artifacts** (commit `8b79a3a`)
- `CLAUDE.md` — hard rules for the build.
- `docs/SCOPE.md` — in/out list and the drop order if a day slips.
- `prompts/plan-contract.yaml`, `prompts/plan-template.md`.

**Single backend + CLI fixes** (commit `36c0efc`)
- `deployme/bin/deployme` — usage, examples, and the `--backend` default all moved
  from `terraform` to `cloudformation`.
- Removed a stray `return;` that was swallowing the unknown-command error path, so a
  bad command exited 0 silently. It now prints the error and exits 1.
- `deployme/src/server.js` — backend allowlist and error message are cloudformation-only.
- `deployme/package.json` — added a `cli` script.

**Carried over from the May POC, still working**
- CLI: `validate`, `deploy`, `status`, `watch`.
- API: `POST /plans/validate`, `POST /deployments`, `GET /deployments/{id}`.
- `deployme/src/schema.js` — planVersion 0.2 schema, five modules, frozen.

## Not started

- `deployme/src/executor/` — does not exist. No cfn composition, packaging, deploy,
  poll, or report.
- `templates/` — empty. `deployme/src/mappings.js` points at `cfn/*.yaml` files that
  are not there yet.
- `prompts/` — has the contract and plan template; missing the interview system prompt
  and the report template.
- CLI `init` and `destroy`.
- **Real status.** `POST /deployments` still fakes the lifecycle: a `setTimeout` flips
  status to `running` at 10s and `succeeded` at 20s, and `public_url` is hardcoded to
  `https://your-app-name.platform.app`. This contradicts the "status must be real,
  never fake success" rule and is the main thing the executor has to delete.

## Next

In the scope doc's drop order, so that what gets cut if a day slips is what's last:

1. `templates/http-api.yaml` — Lambda + HTTP API + log group. nodejs20.x, ca-central-1.
2. `deployme/src/executor/` — compose a stack from the enabled modules, package the
   artifact with the handler shim injected (never touching the developer's source
   folder), `CreateStack`, poll `DescribeStacks`, mirror the real stack status.
3. Replace the `setTimeout` simulation in `server.js` with the executor.
4. CLI `init` — introspect, interview via the Messages API, write `DEPLOYMENT_PLAN.md`
   + `deployme.yaml`, confirm, hand off to deploy.
5. CLI `destroy`.
6. `DEPLOYMENT_REPORT.md` generation.
7. `static_site_edge` (S3 website), then `config_basic`, then the dashboard.
8. Record an end-to-end run as insurance for the panel.

## Decisions taken today

- **One backend, removed rather than disabled.** Terraform is gone from the CLI and the
  API allowlist, not feature-flagged off. Nothing to re-enable by accident on stage.
- **The `terraform:` block in `deployme/src/mappings.js` was left in place** as dead
  config. Nothing reads it, and the executor work will rewrite that file anyway.
- **Committed with the simulation still running** (hence the commit message) rather than
  holding Day 1 until the executor landed. The tradeoff is that `main` currently reports
  success for deployments that never happened — acceptable only because no one is
  demoing off `main` yet, and it has to be fixed before anyone is.

## Open question

Executor first or `init` first? Executor first means the real AWS path — the thing that
cannot be faked and has the most unknowns — gets the most calendar. `init` first settles
the shape of the `deployme.yaml` the executor consumes, so the executor is not built
against a guess. Unresolved as of end of Day 1.
