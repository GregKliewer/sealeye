# Design decisions

`brand/BRAND.md` is the rule for everything the developer sees. This file is where a
deliberate departure from it is written down, with the reason, so that a difference
nobody can explain later is a bug rather than a decision.

## The dashboard header says seaLeye.online

Decided Mon Sept 22, 2026.

`apps/sealeye-online` is the page that shows environments across the organization, and
it is served from sealeye.online. Its header now reads **seaLeye.online** rather than
seaLeye.run, because a header names the thing you are looking at, and the thing you are
looking at is the dashboard rather than the command line tool.

Everything else still says seaLeye.run: the CLI banner, the report header,
`apps/sealeye-run`, and the product itself in prose. The name of the product did not
change. One page is named after its own address.

**The asset.** `brand/sealeye-online-wordmark.svg`, copied into the app folder beside
the page that uses it. It is the wordmark from `BRAND.md` with `.online` in place of
`.run`: same mark, same JetBrains Mono Bold, same phosphor `L`, and `.online` in regular
weight and Dim exactly as `.run` was. Two geometry changes follow from three more
characters: the canvas widens from 640 to 760, and the phosphor cursor block moves from
x=530 to x=648, which keeps the right margin it had before.

**It carries no provenance manifest.** The files in `brand/` ship a c2pa manifest that
describes those files. A derived file that kept it would be asserting provenance for an
image that no longer exists, so the variant was written clean.

**If the dashboard is ever shown beside the CLI**, the two wordmarks differ only in the
last word, which is the point: same product, two surfaces, and the address is how you
tell which one you are in.
