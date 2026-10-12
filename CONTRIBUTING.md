# Contributing to seaLeye

seaLeye is published by OpMo Advisory Inc. under the GNU Affero General Public
License v3.0 (`LICENSE`). The name, marks and domains are not licensed
(`NOTICE`).

## Before you write code

- Read `CLAUDE.md`: the principles there are invariants, and `npm test` enforces
  several of them.
- Pick work from `docs/ROADMAP.md`. Do not build past a question in
  `docs/OPEN-QUESTIONS.md`; raise it in an issue instead.
- A decision a later reader would otherwise have to guess goes in `DESIGN.md`,
  dated, with its reason, in the same commit as the work.

## Sign your commits

Every commit must carry a `Signed-off-by` line (`git commit -s`), which
certifies the [Developer Certificate of Origin](https://developercertificate.org):
that you wrote the change or have the right to submit it under the project's
license. A pull request with an unsigned commit is not merged.

By contributing you agree that your contribution is licensed to OpMo Advisory
Inc. under AGPL-3.0-only, and that OpMo Advisory Inc. may offer the combined
work, including your contribution, under additional terms. You keep the
copyright in what you wrote.

## What a pull request needs

- `npm test` passing, with no AWS and no model calls.
- `npm run eval:interview` run before and after any change to `prompts/`.
- One decision per commit where possible.
- No secrets, no organization names, no sizes or capacity numbers in anything a
  developer sees (`CLAUDE.md`, principles 6, 8 and 10).

## Trademarks

A fork or a hosted service built from this code must not be called seaLeye or
use the mark or domains. Call it something else and say it is derived from
seaLeye.
