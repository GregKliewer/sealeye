# seaLeye: open questions

Decisions not yet made. Each has why it matters, the options, a leaning where there is
one, and what it blocks. When one is answered, record the answer in DESIGN.md with its
date and reason, and delete it from here.

## Blocking Phase 4

### Q17. How does the discovery swarm read the platform library?

The swarm (ROADMAP Phase 4) reads an organization's repositories, module registry and
pipeline definitions. seaLeye is a client of those services here, not their owner.

**Options:**
- **The provider's own MCP server** where one exists (GitHub's, HashiCorp's for the
  Terraform registry), routed through agentgateway so every read is named and logged.
- **Plain code in the graph** that fetches the files (a clone, the registry's API) and
  hands each worker its module. The model chooses nothing about what is read.
- **seaLeye builds MCP servers** for the services that have none.

**Leaning:** the first where it exists, the second otherwise, never the third. Wrapping
another team's service is that team's job, and fetching in code keeps the model from
choosing what it reads. Blocks Phase 4.

## Blocking Phase 5

### Q16. How does Cognito sign-in replace tokens?

Cognito was chosen for sign-in on Oct 9, 2026 (DESIGN.md, "Phase 1: who it is for").
Until it is built, each person has a token issued by the administrator, and the portal
trades it for a session (DESIGN.md, "Every caller has a token, until sign-in"). Still to
decide: how `sealeye login` signs in through the browser and what it keeps; whether
tokens survive for automation; how a person's team and an organization-wide scope
(PHASE2-PLAN D1) come from Cognito groups; and how existing token holders move over.
**Leaning:** its own plan, once seaLeye goes past a handful of people or to a bank.
Moved to Phase 5 on Oct 13, 2026. Blocks a wider pilot, not the friendly team.

### Q18. Must model inference stay in Canada?

Checked Oct 13, 2026. Bedrock serves Claude Sonnet 5.5 and Haiku 5.5 to ca-central-1
and ca-west-1 only through cross-region profiles (geographic or global), not in-region.
AWS's Canada guidance names only US and global profiles, and says logs and stored data
stay in Canada while inference may run in other regions. AWS's own advice is to read a
profile's destinations rather than trust its prefix. Greg can do that from his Mac:

```sh
aws bedrock list-inference-profiles --region ca-central-1 --type-equals SYSTEM_DEFINED \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'claude')].inferenceProfileId" --output text
aws bedrock get-inference-profile --region ca-central-1 \
  --inference-profile-identifier <an id from the first command> --query 'models[].modelArn' --output text
```

Each region in the second command's ARNs is somewhere a call may run. The interview
uses `claude-sonnet-5`; the Bedrock list for Canada names Sonnet 5.5, so the Bedrock
route would use that, after the interview's eval set passes on it. Today the
interview sends an app's code to the Anthropic API, in the US, which is acceptable for
the friendly team and the sample apps.

**Options:** accept a geographic profile, disclosed, with stored data in Canada; wait
for in-region Claude in Canada; or a model the organization runs (Phase 7).
**Leaning:** the first for a pilot, stated in the evidence, and the bank decides. Blocks a
bank pilot (Phase 5), not Phase 3: Phase 3 builds the route and its setting either way.

## Later

### Q7. Windows

The pitch said yes. Today the CLI assumes a POSIX shell, the AWS CLI on the path, and
macOS notifications. **Leaning:** support it once the interview and packaging run behind
the API, because then the CLI is a thin client with little platform-specific code left.
Phase 7.

### Q10. When does the CLI get published?

Today it is installed from seaLeye.run (`curl -fsSL https://sealeye.run/install | sh`),
which runs `npm install -g` on a package that site serves. That is enough for the
friendly team. **Options:** keep that; a public npm package; a single binary. Matters
once people outside a friendly team install it.

### Q11. Where do the marketing sites live?

seaLeye.run, seaLeye.online and seaLeye.com are in `archive/`. When the portal becomes
real it should start from the seaLeye.online mock-up's design, but in its own folder.
The two marketing sites may belong in a separate repository.
