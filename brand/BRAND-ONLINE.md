# seaLeye.online brand (the console)

A delta from BRAND.md, decided September 22, 2026. Everything in BRAND.md still applies unless
this file says otherwise. Read that one first.

## The idea in one line

Two audiences, two surfaces, one brand. The developer lives in a dark terminal and types;
the platform team lives in a light console and reads. seaLeye.run looks like where the
developer is. seaLeye.online looks like where the platform team is. Put side by side, they
should be obviously the same company and obviously not the same tool.

## What changes

### 1. The ground inverts

seaLeye.run is dark because it is a terminal. seaLeye.online is light because it is a page you
read, scan and leave open in a tab. This is the single change that carries the distinction at a
glance, and in the demo it does the work without a word: alt-tab from the dark terminal to the
light console and the room registers "different tool, different audience" before you speak.

| Role | .run (BRAND.md) | .online | Note |
|---|---|---|---|
| Ground | #13181D | **#F4F6F8** | cool paper, never pure white |
| Surface (cards, table) | #1A2027 | **#FFFFFF** | |
| Ink (default text) | #D9E0E6 | **#13181D** | the terminal's ground becomes the console's ink |
| Dim | #8A96A3 | **#5C6B7A** | darker, or it fails contrast on paper |
| Rule | #2A323B | **#DCE2E8** | |
| Phosphor | #7FD8C2 | **#1A7A64** | same hue, lightness pulled down; 5.2:1 on white |
| Amber | #E8B04B | **#9A6418** | same hue, darkened; 5.0:1 on white |

The two brand colours keep their hue and their jobs. Phosphor is still the product and good
news; amber is still anything that needs a person. They are darker because they now sit on
paper, and a phosphor that reads on #13181D disappears on #FFFFFF. Never use the dark-ground
values on the light ground, or the reverse.

Status chips use the light tints of each: phosphor chip `#DDF3EC` with `#1A7A64` text, amber
chip `#FBEFD6` with `#9A6418` text, neutral chip `#E8ECF0` with `#5C6B7A` text.

### 2. Type: proportional for reading, mono for data

seaLeye.run is one hundred percent JetBrains Mono because it is a terminal. seaLeye.online uses
**IBM Plex Sans** (Google Fonts; fallback: Inter, system-ui) for everything a person reads,
and **JetBrains Mono** for everything that is data.

Mono: app names, module ids, URLs, deployment ids, timestamps, counts, the wordmark.
Sans: headings, labels, column headers, prose, chip text, navigation, buttons.

This is the second-strongest signal. A page set entirely in mono reads as a terminal, whatever
colour it is. A page that uses mono only for identifiers reads as a product.

### 3. Chrome: a console has furniture

seaLeye.run has no navigation because there is nowhere to go. seaLeye.online has:

- A top bar on the surface colour: the mark and `seaLeye.online` wordmark left, then a
  navigation row (Environments, Catalog, Activity, Team) with the current section underlined
  in phosphor, then the org name and a user chip right ("Greg K." with a phosphor initial
  disc). The rest of the nav is inert in this version; it exists because a console has it.
- A page title with a one-line subtitle in Dim, and a right-aligned primary action button
  (phosphor fill, white text): "New environment". Inert. It is there because management means
  you can do things here.
- A stat row before the table: four tiles, each a number in mono at 28 px over a sans label
  in Dim. Live environments, Planned, Deploys this week, Modules in the library. Consoles
  summarise before they list. No meters, no sparklines, no colour by tile; the numbers are
  the point.

### 4. Density and the table

Tighter than the terminal. Rows at 44 px, column headers in 11 px sans caps with letter-spacing,
zebra off, a single Rule line between rows. Status is a chip, not a coloured word. Owner is a
small initial disc plus the name. URL is mono, truncated with an ellipsis at the column width,
full on hover. A right-aligned actions column with two ghost buttons per row, "Plan" and
"Destroy", both inert; the row already expands to the decision card on click, and that stays.

The Catalog becomes a two-column list of cards, not two big panels: each module is a card with
the id in mono bold, the line in sans, and a chip top right reading "Available" (phosphor) or
"Platform Library" (amber). The Platform Library chip is the visual link to the refusal message
in the terminal, so the panel that says "waiting on 5 catalog modules" and the list of what is
waiting use the same word.

### 5. The header and the wordmark

The header construction is the one already on the page and it does not change: the mark, then
the `seaLeye.online` wordmark, then the cursor block, from `sealeye-online-wordmark.svg`. On the
light ground use `sealeye-online-wordmark-light.svg` (added Sept 22), which is the same drawing
with no background rect, ink text, the L and the cursor in phosphor-deep, and `.online` in Dim.
The mark inside it keeps its dark window and its terminal colours, so it is the one place the
terminal survives on the console: a small dark window sitting on a light desk, which is exactly
what it is.

The wordmark sits left in the top bar at 26 px cap height, then the navigation, then the org
name and the user chip right.

### 6. The footer line stays

"State shown here is read from your environments, not from anyone's laptop." Sans, Dim, above
the rule, same as now. It is the Cindy answer and it does not move.

## What does not change

- The two-colour rule. Phosphor and amber, no third colour under stress. Failures are amber.
- No em dashes, no vendor names, nothing the developer or the platform team would not say.
- The mark and the wordmark construction.
- The data. Every value on the page matches `sealeye list --deployments --all` from the
  terminal, line for line, or the mock does not survive the demo.
- Mobile: it should still read on a phone, but the console is a laptop page and is designed
  for one. The terminal site is the one that has to be perfect on a phone.

## Why not stay dark and change only the layout

It works, and it is what most infrastructure consoles do. But the demo has five minutes for the
mocked tier and the contrast has to land in the first second of the browser being on screen.
A dark console next to a dark terminal needs a sentence to explain. A light one does not.
