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

# Sharded by date
path = "${{ publishedAt.getFullYear() }}/${{ publishedAt.getMonth() }}/${{ slug }}"

# Nested path field
path = "${{ contentPath/** }}"
```

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
