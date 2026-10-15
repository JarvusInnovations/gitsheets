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
