# Principles

The project's philosophy, written down as principles. Each is decisive: it
picks a side of a real trade-off so an implementer can resolve an
unspecified case the way the author would. Feature specs reference the
entries that govern them from their own `## Principles` sections.

## Records carry their own path

**A record contains every field needed to render its path.** If a field
appears in a sheet's path template, it is part of the record and its schema
lists it as `required`; it is never something a writer splices in just before
the upsert. Path rendering is a pure function of the stored record: anyone
holding the record — another process, a later version, a reviewer reading the
file — can recompute where it lives, and the open-time template check
([behaviors/path-templates.md](behaviors/path-templates.md#template-fields-must-be-schema-required))
enforces it with **no escape hatch**. A config key that exempted
"writer-injected" fields was shipped in 2.8.0 and removed in the next release
for exactly this reason.

A corollary for relations: when a child's path is keyed by its parent's
handle (`${{ projectSlug }}/${{ personSlug }}`), that handle **is** how the
record references its parent. It lives in the record as a required field, not
in the service that happened to know it at write time.

Why: a path field that only the writer knows makes the stored data
incomplete — the record cannot be re-rendered, re-imported, or merged without
the writer's context — and it is exactly how two production sheets ended up
templated on fields their records never carried.

## Behave like a first-party git extension

**Every gitsheets knob layers the way git's own do: command-line argument
over environment variable over git config, and git config is the bottom
layer that both the CLI and the library read.** A binding chosen with
`git config gitsheets.branch data` applies to `git sheet query` *and* to
`openRepo()` in the application, in that clone, the way `remote.pushDefault`
or `push.recurseSubmodules` apply to every tool that touches the clone.
Explicit options always win; the library never reads config for a knob the
caller set. When a new setting is added, it gets a `gitsheets.<key>` config
name, a `GITSHEETS_<KEY>` environment variable, and a flag, in that
precedence — never a bespoke dotfile, a `package.json` field, or a
library-only option with no CLI twin.

Not every option is a setting. Three kinds, three surfaces:

| Kind | What it is | Surfaces | Examples |
| --- | --- | --- | --- |
| **Setting** | How *this clone* is wired; the same for every tool and every invocation in it | flag, `GITSHEETS_<KEY>`, `gitsheets.<key>` git config — and the library reads the env and config tiers too | `branch`, `submodule`, `stagePointer` |
| **Per-invocation pin** | What *one run* looks at; meaningless as a standing per-clone default | flag and `GITSHEETS_<KEY>` (a script exports it for one job); **no** config tier, and the library takes it only as an explicit option | `--ref`, `--at` |
| **Per-call option** | Shapes one library call's behavior or result; has no command-line meaning on its own | library option only — a CLI command may expose one as a *command* flag where it fits | `stale`, `signal`, `withBody`, `afterMove` |

A pin in git config would silently freeze every tool in the clone at one
snapshot, which is the two-tools-two-answers trap this principle exists to
prevent; a per-call option at the CLI's global level would be a knob with
nothing to turn.

**Grandfathered.** `--root`, `--prefix`, and `--ref` (with `GITSHEETS_ROOT`,
`GITSHEETS_PREFIX`, `GITSHEETS_REF`) predate this principle and have a flag
and an environment variable but no `gitsheets.<key>` config tier. `--ref` is
a per-invocation pin and needs none; `--root` / `--prefix` are kept as they
are rather than grown a config tier retroactively. New knobs follow the
table.

Why: the user experience gitsheets is going for is `git sheet` feeling like
a built-in git subcommand, and that means git's configuration model, not a
parallel one. The alternative — the library ignoring config the CLI honors —
puts two tools in the same clone on two different branches, a trap nobody
finds until the data has diverged.
