---
status: done
depends: []
specs: []
issues: []
pr: 254
---

# README: use-case examples and four-surface getting started

## Scope

Rewrite the root README from an internal architecture note into the repo's public front door: brief use-case examples (the four production-proven patterns, generalized per the publication boundary; codeforphilly-ng named because public) and concise getting-started paths for all four consumption surfaces (library, CLI, gitsheets-axi, agent skill), plus the Python binding pointer.

## Implements

Docs only; API shapes verified against specs/api/transaction.md, specs/api/store.md, docs/cli.md.

## Approach

Structure: tagline (kept) → terminal walkthrough → use cases → getting started x4 → when not to use it → spec-driven pointer (condensed from prior README). Voice per the rollout drafts: plain, honest-limitations-visible, no promotional language.

## Validation

- [x] Every command/API line matches a shipped surface (tx.sheet(), upsert stdin, axi bootstrap, skills add)
- [x] Publication boundary held: only public repos named
- [ ] PR merged

## Risks / unknowns

None — docs only.

## Notes

The when-not-to-use section is deliberate positioning, not hedging: honest-fit framing is the rollout's credibility strategy.

## Follow-ups

- The packages/gitsheets npm README should eventually get a condensed version of the same getting-started (tracked informally; the rollout docs-TOC restructure covers it).
