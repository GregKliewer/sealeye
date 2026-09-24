# seaLeye.run brand (Terminal direction)

Chosen September 20, 2026. Everything the developer sees comes from this file.

## Name
- Written: **seaLeye.run**. The capital L is the only typographic trick; keep it everywhere the name is written in prose.
- Command: `sealeye`. Lowercase, one word, always in code font.
- Spoken: "C-L-I dot run".
- Tagline: `cd your-app && sealeye run`

## Type
- One face everywhere: **JetBrains Mono** (Google Fonts; fallback: IBM Plex Mono, Menlo, monospace).
- Wordmark: JetBrains Mono Bold, tracking -3%, `.run` in regular weight and Dim colour.
- Terminal for the demo: JetBrains Mono 18 pt, line height 1.35.

## Colour
| Role | Hex | Where |
|---|---|---|
| Ground | #13181D | terminal background, deck slides, README hero |
| Foreground | #D9E0E6 | default text |
| Phosphor (accent) | #7FD8C2 | wordmark, ✓ success lines, values the developer chose |
| Amber (prompt) | #E8B04B | the `$` prompt, every `?` question, ✗ failures |
| Dim | #8A96A3 | secondary text, timestamps, "what the platform is doing" lines |

Two colours only in the terminal: phosphor for the product and for good news, amber for anything that asks the developer something. Failures are amber, not red; the brand does not add a third colour under stress.

## The mark
A rounded terminal window with a phosphor `>` and an amber cursor block. Files: `sealeye-mark.svg`, `sealeye-mark.png`. Sits to the left of the wordmark at cap height; alone as the deck icon and README hero.

## Rules
- The banner prints once at the top of every command: the figlet block in phosphor, then the tagline line in Dim with optional meta (version, region).
- Every step the platform takes is one Dim line starting two spaces in. Every question is amber `?`. Every answer echo is phosphor.
- The report header is the `>_ seaLeye.run` line, then the meta line in plain text, then a rule.
- Never the word "deployme" in anything the developer sees.
