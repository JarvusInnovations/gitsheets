# Behavior: Path Templates

## Rule

Every sheet declares a **path template** that determines where each record's TOML file lives in the data tree. The template serves two purposes — *where to write* a record, and *how to prune the search* when querying.

## Applies To

- [api/sheet.md](../api/sheet.md) — `upsert`, `delete`, `query`, `queryFirst`, `queryAll`, `pathForRecord`
- [`.gitsheets/<sheet>.toml`](../concepts.md#sheet) — `[gitsheet].path` config

## Syntax

The template is a slash-separated string of components. Each component is either literal text, a field reference, a date-bucket reference, or a JS expression.

| Form | Example | Meaning |
| --- | --- | --- |
| Literal | `users/by-domain/` | Static path text |
| Field reference | `${{ slug }}` | The value of `record.slug`, rendered to string |
| Date bucket | `${{ publishedAt: YYYY/MM/DD }}` | UTC date buckets of the field — expands to one path segment per format part |
| Expression | `${{ slug.toLowerCase() }}` | Arbitrary JS expression with record fields in scope |
| Recursive | `${{ path/** }}` | The value of the field, which may itself contain `/` — used for nested-path fields |
| Prefix/suffix | `user-${{ id }}.draft` | Literal prefix/suffix attached to an expression |

A template is parsed once per sheet and cached.

### Examples

```toml
# Simple unique-field key
path = "${{ slug }}"

# Composite key (two-level directory)
path = "${{ domain }}/${{ username }}"

# Date-bucketed (three-level directory: 2026/03/09/my-post.toml)
path = "${{ publishedAt: YYYY/MM/DD }}/${{ slug }}"

# Multi-variable per segment (#105 fix)
path = "${{ year }}/${{ status }}--${{ id }}"

# Nested path field (the field's value contains slashes)
path = "${{ contentPath/** }}"
```

## Date-bucket references

A date-bucket reference partitions records by a date-typed field:

```toml
path = '${{ publishedAt: YYYY/MM/DD }}/${{ slug }}'   # day partitioning
path = '${{ publishedAt: YYYY/MM }}/${{ slug }}'      # month partitioning
path = '${{ publishedAt: YYYY/WW }}/${{ slug }}'      # ISO-week partitioning
path = '${{ day: YYYY/MM/DD }}'                       # bucket as the whole path
```

### Grammar

Inside `${{ }}`, content matching

```text
^\s*<identifier(.dotted)?>\s*:\s*<format>\s*$
```

is a date-bucket reference: a field name (optionally dot-separated for a nested
field), a colon, and a format. Everything else keeps the existing
field-reference / expression behavior. Bucket recognition runs **before** the
expression fallback.

**The format is a closed set — an enum, not a format language:**

| Format | Segments produced | Example rendering |
| --- | --- | --- |
| `YYYY` | calendar year | `2026` |
| `YYYY/MM` | calendar year / month | `2026/03` |
| `YYYY/MM/DD` | calendar year / month / day | `2026/03/09` |
| `YYYY/WW` | ISO week-based year / ISO week | `2026/11` |

Anything else in the format position (e.g. `YYYY-MM`, `MM/DD`, `YYYY/MM/DD/HH`)
throws `ConfigError` (`config_invalid`) at sheet-open. Needs beyond the closed
set fall back to the JS-expression form.

A bucket reference must stand alone in its path segment — no literal
prefix/suffix and no other references in the same segment (`posts-${{ d: YYYY }}`
is `ConfigError` (`config_invalid`)). One reference expanding into multiple
real segments composes with prefixes only ambiguously, so it is rejected
outright.

### Rendering semantics

1. **UTC always.** Bucket rendering never consults a timezone — this is a
   determinism guarantee: the same record produces the same path on every
   host. An offset datetime is converted to UTC before its date parts are
   read; offset-less values (local datetime, local date, offset-less ISO
   strings) are taken at face value. (This is the bug class the expression
   form invites: `getFullYear()` renders host-timezone-dependent paths.
   `getUTCFullYear()` avoids it, but nothing enforces that spelling.)
2. **`YYYY/WW` is ISO-8601 week**, and its `YYYY` is the **ISO week-based
   year**, not the calendar year. January 1 can belong to week 52/53 of the
   prior ISO year: 2027-01-01 falls in ISO week 2026-W53, so
   `${{ d: YYYY/WW }}` renders it as `2026/53`. Likewise a late-December date
   can belong to week 1 of the next ISO year (2024-12-30 → `2025/01`).
3. **Zero-padding**: `MM`, `DD`, and `WW` are always two digits; `YYYY` is
   four.
4. **Accepted field values**: TOML datetime, local-datetime, and local-date
   values, and ISO 8601 strings (date-only, or datetime with or without
   offset). Any other value type (number, boolean, array, table, TOML
   local-time, unparseable string) fails the render with `PathTemplateError`
   (`path_render_failed`) at write time. A **missing** field follows the
   existing missing-field rule: the component is un-renderable — `render`
   fails, and a query walk treats the segments as wildcards.
5. **One token expands to multiple real path segments**: `YYYY/MM/DD` creates
   three directory levels. A bucket token may appear anywhere in the template
   — leading, between other components, or as the entire path
   (`path = '${{ day: YYYY/MM/DD }}'` makes the bucket the record identity,
   legitimate for daily-rollup records).

### Query traversal semantics

When a query's fields include the bucketed field (with a date-typed or ISO
8601 string value), the walk descends the exact rendered bucket path — one
subtree per bucket segment. When the field is absent from the query, the
bucket segments are wildcards, exactly like un-renderable components today.
A query value of any other type does not prune (the segments widen to
wildcards); the record-level equality filter still applies downstream, so
results are unchanged — only the walk is wider.

**Range-pruned queries are explicitly out of scope** for this behavior:
mapping date-*range* filters onto bounded subtree walks (skip whole years or
months outside the range) is a natural follow-up that the declarative bucket
form makes possible — an opaque JS expression could never be inverted this
way. Tracked as a follow-up; see [#252](https://github.com/JarvusInnovations/gitsheets/issues/252).

### Backward compatibility

Recognizing the bucket form breaks no working config. Inside `${{ }}`,
content like `publishedAt: YYYY/MM` previously fell through to the expression
compiler, where it parses as a JS *labeled statement* dividing
ReferenceErrors — invalid inside the renderer's `return (...)` wrapper, so it
has **never rendered successfully for anyone**. The bucket grammar claims
only that dead syntax space; every currently-working template parses exactly
as before. The same reasoning covers the `ConfigError` for unknown formats:
`${{ field: ANYTHING }}` was previously a guaranteed compile failure, so
converting it into a clearer config-time error changes no working behavior.

### Rejected alternative: a field-level `bucket` declaration

A `[gitsheet.fields.<name>] bucket = 'YYYY/MM/DD'` config block (with the
path template referencing the field plainly) was considered and rejected: the
path template should tell the whole story of the tree layout. One plain-looking
reference silently expanding to three directory levels via a side declaration
hurts readability — the reader of `path` should see the shape of the tree.

Related wart this supersedes for the bucket case: a bare `Date`-typed field
referenced as `${{ field }}` renders via JS `.toString()` (host-formatted,
timezone-dependent). That remains a wart for non-bucket references; bucket
references are the supported way to put a date field in a path.

## Rendering

`Template.render(record)` walks each component, calls `render(record)` on the component, and joins the results with `/`. Adds `.toml` as the final extension when writing.

If any component returns `null` or `undefined`, the render fails with `PathTemplateError` (`path_render_failed`). The error names which component couldn't render.

### Expression rendering

Expressions are evaluated in a sandbox (`vm.runInNewContext`) with the record's fields bound as identifiers via `with(record) { return (<expression>) }`. Undefined-identifier errors are treated as "this component is un-renderable" (returns `undefined`) rather than thrown, since they're typically expected at *query* time (see below).

This mirrors the pre-v1.0 behavior; documented here so the v1.0 TS rewrite preserves it.

### Multi-variable per segment

Components can contain multiple expressions and literal text:

```text
path = "${{ year }}/${{ status }}--${{ id }}"
```

Renders as `2026/active--12345`. The pre-v1.0 implementation had a bug where multiple expressions per segment failed to render — [#105](https://github.com/JarvusInnovations/gitsheets/issues/105). The v1.0 rewrite fixes this with a regression test.

### Invalid characters

The rendered path is validated against filesystem constraints. Windows is the strictest target — the characters `< > : " | ? *` and control codes are rejected.

`PathTemplateError` (`path_invalid_chars`) is thrown with the offending component named. Strategy options (omit / slugify / throw) are not implementation choices — throw is the v1.0 behavior. Consumers wanting slugification do it themselves in a `${{ slugify(name) }}` expression.

This addresses [#14](https://github.com/JarvusInnovations/gitsheets/issues/14).

## Query traversal

When a query specifies fields that the path template uses, gitsheets prunes the tree walk to only matching subtrees instead of reading every record.

### Algorithm

```text
For each component of the path template, in order:
  - If the component is a literal: walk into that named subtree.
  - If the component is a field reference and the query has a value for that field:
      - Compute the rendered value.
      - Walk into that named subtree (if it exists; else: no results).
  - If the component is a field reference and the query has NO value for that field:
      - Walk into ALL children of the current subtree.
      - Recurse the algorithm with the next component, against each child.
  - If the component is the last and is a field reference WITH a value:
      - Open `<rendered>.toml` directly. Apply the in-memory equality filter from queryMatches(query, record). Yield if it matches.
  - If the component is the last and is a field reference WITHOUT a value:
      - List all `*.toml` children. For each, parse and apply queryMatches. Yield if it matches.
  - If the component is recursive (`${{ field/** }}`):
      - Walk the subtree as a flat blob map (recursive); apply queryMatches.
```

A date-bucket segment behaves like a field reference in this algorithm: it has
a value (and prunes) when the query supplies the bucketed field with a
date-typed or ISO-string value, and is otherwise treated as un-renderable
(walk all children). See "Date-bucket references § Query traversal semantics".

### Practical implication

A sheet with `path = "${{ domain }}/${{ username }}"` and a query `{ domain: 'af.mil' }` reads only the `af.mil/` subtree. A query with no `domain` reads all subtrees but is still O(records). A query `{ domain: 'af.mil', username: 'GrandmaCOBOL' }` reads exactly one file.

### Function-valued filter entries

`query({ slug: (value) => value.startsWith('jane') })` cannot prune by the path template (the function is opaque). The traversal falls back to listing all subtrees. Equality predicates are preferred for fields used in path templates.

## Recursive components (`field/**`)

A `${{ field/** }}` component handles fields whose value contains `/`. Example: a CMS where `path = "${{ contentPath/** }}"` and `contentPath = "docs/guides/intro"` writes to `docs/guides/intro.toml`.

Query against a recursive component reads the full subtree as a blob map; it doesn't prune.

Only one recursive component per template (the final one). Multiple recursive components would create ambiguous paths.

## Attachments and the path template

Attachments live at `<recordPath>/<attachmentName>`. The query traversal skips them because:

- Path-template traversal only follows `.toml` files at record positions
- Sub-tree directories named `<record-without-.toml>` are treated as attachment containers, not as nested records

See [behaviors/attachments.md](attachments.md).

## Caching

Templates are parsed once per template string (process-wide cache by string). Re-parsing on every render would be wasteful and is avoided.

## Coordinates with

- [api/sheet.md](../api/sheet.md)
- [behaviors/attachments.md](attachments.md)
- [GitHub #105](https://github.com/JarvusInnovations/gitsheets/issues/105) — multi-variable component bug
- [GitHub #14](https://github.com/JarvusInnovations/gitsheets/issues/14) — invalid character handling
- [GitHub #252](https://github.com/JarvusInnovations/gitsheets/issues/252) — declarative date-bucket path keys
