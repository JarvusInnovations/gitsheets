# Behavior: Path Templates

## Rule

Every sheet declares a **path template** that determines where each record's TOML file lives in the data tree. The template serves two purposes — *where to write* a record, and *how to prune the search* when querying.

## Applies To

- [api/sheet.md](../api/sheet.md) — `upsert`, `delete`, `query`, `queryFirst`, `queryAll`, `pathForRecord`
- [`.gitsheets/<sheet>.toml`](../concepts.md#sheet) — `[gitsheet].path` config

## Syntax

The template is a slash-separated string of components. Each component is either literal text, a field reference, or a JS expression.

| Form | Example | Meaning |
| --- | --- | --- |
| Literal | `users/by-domain/` | Static path text |
| Field reference | `${{ slug }}` | The value of `record.slug`, rendered to string |
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

# Sharded by date
path = "${{ publishedAt.getFullYear() }}/${{ publishedAt.getMonth() }}/${{ slug }}"

# Multi-variable per segment (#105 fix)
path = "${{ year }}/${{ status }}--${{ id }}"

# Nested path field (the field's value contains slashes)
path = "${{ contentPath/** }}"
```

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
