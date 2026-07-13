# Path templates

Every sheet declares a path template that determines where each record's
TOML file lives in the data tree.

For the full spec see
[`specs/behaviors/path-templates.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/path-templates.md).

## Syntax

| Form | Example | Meaning |
| --- | --- | --- |
| Literal | `users/by-domain/` | Static path text |
| Field reference | `${{ slug }}` | The value of `record.slug` |
| Date bucket | `${{ publishedAt: YYYY/MM/DD }}` | UTC date partitions of the field — one directory level per format part |
| Expression | `${{ slug.toLowerCase() }}` | Arbitrary JS expression with record fields in scope |
| Recursive | `${{ path/** }}` | Field's value may contain `/` — for nested-path fields |
| Prefix/suffix | `user-${{ id }}.draft` | Literal text attached to an expression |
| Multi-variable | `${{ year }}/${{ status }}--${{ id }}` | Multiple expressions in one segment |

## Examples

```toml
# Simple unique-field key
path = "${{ slug }}"

# Composite key (two-level directory)
path = "${{ domain }}/${{ username }}"

# Date-bucketed (2026/03/09/my-post.toml)
path = "${{ publishedAt: YYYY/MM/DD }}/${{ slug }}"

# Nested path field
path = "${{ contentPath/** }}"
```

## Date buckets

A date-bucket reference partitions records by a date field — by day, month,
year, or ISO week:

```toml
path = "${{ publishedAt: YYYY/MM/DD }}/${{ slug }}"   # 2026/03/09/my-post.toml
path = "${{ publishedAt: YYYY/MM }}/${{ slug }}"      # 2026/03/my-post.toml
path = "${{ publishedAt: YYYY/WW }}/${{ slug }}"      # 2026/11/my-post.toml (ISO week)
path = "${{ day: YYYY/MM/DD }}"                       # daily rollup: the bucket IS the key
```

The format is a **closed set** — `YYYY`, `YYYY/MM`, `YYYY/MM/DD`, `YYYY/WW`;
anything else throws `ConfigError(config_invalid)` when the sheet is opened.
Fancier partitioning falls back to the expression form.

Semantics worth knowing:

- **UTC always.** Buckets never consult the host timezone, so the same record
  produces the same path on every machine. (The expression spelling
  `getFullYear()` doesn't have this guarantee — it renders host-local dates.)
- **`YYYY/WW` is ISO-8601 week numbering**, and its year part is the ISO
  *week-based* year: 2027-01-01 belongs to ISO week 2026-W53 and renders as
  `2026/53`.
- **`MM`, `DD`, `WW` are always two digits** — partitions sort correctly.
- The field may hold a datetime/date value or an ISO 8601 string. One bucket
  token expands to multiple real directory levels, and must stand alone
  between slashes.
- Queries that supply the bucketed field (e.g.
  `posts.queryAll({ publishedAt })`) descend the exact partition instead of
  scanning every record; without it, the partition levels are walked like any
  other unconstrained segment.

## How queries use the template

When a query specifies fields the template uses, gitsheets prunes the tree
walk to only matching subtrees instead of reading every record.

```typescript
// Walks only the `af.mil/` subtree
const found = await users.queryAll({ domain: 'af.mil' });
```

A query that doesn't supply path-template fields walks every record — still
O(records), but more I/O than the pruned form. Equality predicates on
path-template fields are the fast path; function-valued filters (e.g.,
`{ slug: (v) => v.startsWith('jane') }`) are opaque to pruning.

## Invalid characters

The rendered path is rejected if it contains Windows-disallowed characters
(`< > : " | ? *` or control codes) — those throw
`PathTemplateError(path_invalid_chars)`. A non-recursive component
producing a value with `/` is also rejected for the same reason.

If you want slugification, do it in the template:

```toml
path = "${{ name.toLowerCase().replace(/[^a-z0-9]+/g, '-') }}"
```
