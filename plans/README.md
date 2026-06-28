# plans/

If `specs/` is the architecture document (timeless: what *should be true*), `plans/` is
the project plan (motion: how we get there). Each plan is one scope-bounded chunk of work
that declares the specs it implements, its dependencies, an approach, and concrete
validation criteria. Together the plan files form a **micro-DAG of work** bridging specs
to merged code. Once merged, a plan freezes to `status: done` — its merged-PR link plus
its checked validation criteria become the project's working memory of what got built.

- **One plan per file.** Kebab-case slug filenames (e.g. `storage-foundation.md`); the
  slug *is* the plan ID that other plans reference in `depends:`. No numeric prefixes.
- **No DAG drawing or status table here** — per-plan frontmatter is the single source of
  truth for both status and graph shape, and a hand-maintained view would rot. Query it
  on demand with the bundled CLI instead.

Query the DAG:

```sh
.claude/skills/specops/scripts/specops          # dashboard: ready / in-progress / blocked
.claude/skills/specops/scripts/specops next     # what to work on next
.claude/skills/specops/scripts/specops dag      # dependency graph
```

The full protocol — frontmatter schema, body template (Scope / Implements / Approach /
Validation / Follow-ups), status lifecycle, and the closeout-commit ritual — is in the
specops skill's [plans-protocol reference](../.claude/skills/specops/references/plans-protocol.md).
Read it before authoring or closing out a plan.
