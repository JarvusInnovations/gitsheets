# Specs

This directory is the source of truth for what `gitsheets` *should be*. The implementation under `packages/gitsheets/src/` is brought into conformance with these specs — not the other way around.

If you're about to write code, you're in the wrong place. Start here, read the relevant spec, then go write code that matches it.

## Workflow

```text
1. Spec change  →  propose what should be true
2. Accept       →  reviewer agrees on desired state
3. Implement    →  bring code into conformance
4. Verify       →  compare running software to spec
```

Concretely:

- **Starting a feature** — write or update the spec first. Open the PR with the spec changes. Once reviewers agree, implement.
- **Fixing a bug** — if the spec covers the behavior, the spec is right and the code is wrong; fix the code. If the spec is silent, decide whether the spec should be amended.
- **Reviewing code** — compare the diff against the spec. The spec is the acceptance criteria.
- **Spec is ambiguous** — propose a spec amendment in the same PR; don't guess and code.

PRs that change runtime behavior should include a spec change. If they don't, that's a smell.

## Directory layout

```text
specs/
├── README.md             # This file — workflow + layout
├── architecture.md       # Tech stack, packaging, foundational decisions
├── concepts.md           # Vocabulary: Repository, Sheet, Record, Transaction, Store, Index
├── deferred.md           # Features intentionally not in scope for v1.0
├── api/                  # Per-symbol API contracts
│   ├── conventions.md
│   ├── repository.md
│   ├── sheet.md
│   ├── transaction.md
│   ├── store.md
│   ├── errors.md
│   └── cli.md
└── behaviors/            # Cross-cutting rules referenced from multiple APIs
    ├── path-templates.md
    ├── validation.md
    ├── normalization.md
    ├── transactions.md
    ├── indexing.md
    ├── push-sync.md
    ├── attachments.md
    ├── content-types.md
    └── patch-semantics.md
```

### Why no `data-model.md`?

Most spec-driven projects describe a domain (Person, Project, Order…). Gitsheets is a **library**, not a domain app. The closest equivalent — the vocabulary of types we expose to consumers — lives in [`concepts.md`](concepts.md). API surface lives under [`api/`](api/).

### Why no `screens/`?

Gitsheets has no UI. The pre-v1.0 Vue frontend is being removed (see [GitHub #128](https://github.com/JarvusInnovations/gitsheets/issues/128)). The only user-facing surfaces are the JS/TS API and the CLI — both speced in [`api/`](api/).

## What specs cover

- **API contracts** — function signatures, semantics, errors thrown
- **On-disk formats** — `.gitsheets/<name>.toml` config, record TOML files, attachment paths
- **Cross-cutting rules** — path templates, validation, normalization, transactions, indexing
- **CLI commands** — flags, defaults, behavior

## What specs do NOT cover

- **Implementation details** — internal class hierarchies, helper-function naming, file organization within `packages/gitsheets/src/`
- **Performance microbenches** — covered in PR descriptions and the [holo-tree migration](https://github.com/JarvusInnovations/gitsheets/issues/127), not here
- **Test cases** — tests derive from specs but aren't the spec
- **Repository housekeeping** — branch naming, release procedure, CI workflow specifics

## The right level of detail

Specs declare *what* must be true, not *how* to implement it.

**Good** — declarative, testable:
> "`Sheet.patch(query, partial)` reads the matched record via `queryFirst`, applies RFC 7396 JSON Merge Patch semantics to combine the patch with the existing record, validates the result against the sheet's JSON Schema and any consumer-supplied Standard Schema validator, then upserts the new record within the current transaction."

**Too vague** — implementer still has to guess:
> "Patch updates a record by merging in changes."

**Too detailed** — duplicates the code:
> "Open the record blob, parse with `iarna/toml`, deepclone the object, walk the patch tree with a recursive merge function, then…"

## Spec drift auditing

Run `/audit-spec-drift` (the Claude Code command at `.claude/commands/audit-spec-drift.md`) to launch a comprehensive audit comparing this directory against the implementation. It produces three tables: specified-but-not-implemented, implemented-but-not-specified, and conflicts. Use it before starting major work and as part of the release checklist.

## Versioning relative to specs

These specs describe the **current shipped surface** of gitsheets. v1.0 sets the API contract; v1.1 adds the full CLI flag/command surface plus library additions (`diffFrom`, attachment iterator + deletes, query AbortSignal, push-daemon hardening, `--prefix`). v1.2 adds content-typed records (markdown/mdx with TOML frontmatter), lazy body loading, and the `check` CLI command. Items intentionally deferred to later releases (e.g., [`--working`](https://github.com/JarvusInnovations/gitsheets/issues/165), watch mode, field-level encryption) live in [`deferred.md`](deferred.md). The [holo-tree migration](https://github.com/JarvusInnovations/gitsheets/issues/127) is now carried by [`architecture.md`](architecture.md#holo-tree-migration-deferred) and tracked as plans in [`plans/`](../plans/).

When work begins on a deferred item, the entry is promoted out of `deferred.md` into the active specs in the same PR that closes the issue; the spec authoring rules above apply.

## Authoring guidance

- Use the templates below. Sections may be empty during early drafts; mark them `_TBD_` rather than deleting them so readers know what's missing.
- Link liberally between specs. Specs form a graph.
- Prefer enumerations and tables over prose for anything with discrete cases.

### API template

```markdown
# API: <Symbol>

## Summary
One paragraph on what this is.

## Signature
TypeScript signature(s).

## Semantics
Per-method behavior. Rules for return values, side effects, errors.

## Errors
Which exception classes get thrown, under what conditions.

## Examples
Compact code snippets showing typical use.

## Coordinates with
Links to related specs.
```

### Behavior template

```markdown
# Behavior: <Name>

## Rule
The invariant or rule, stated declaratively.

## Applies To
Which APIs / concepts this behavior governs.

## Details
Edge cases, calculations, timing, error handling.
```
