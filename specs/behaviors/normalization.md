# Behavior: Canonical Normalization

## Rule

Records are written to disk in a **canonical form** so that logically-equal records produce byte-identical TOML. This makes git diffs meaningful (changes show real changes, not key reorderings) and makes byte-level merging viable for propose-review flows.

Normalization is separate from validation:

- **Validation** (see [validation.md](validation.md)) decides *whether* a record is acceptable.
- **Normalization** decides *how* that record's bytes are written.

Both run on every write.

## Applies To

- [api/sheet.md](../api/sheet.md) — `upsert`, `patch`, `normalizeRecord`
- [`.gitsheets/<sheet>.toml`](../concepts.md#sheet) — `[gitsheet.fields.<name>]` config

## Rules

### Object keys

All object keys are alphabetically sorted, **deep**. A record like:

```javascript
{ slug: 'jane', email: 'jane@x.org', fullName: 'Jane' }
```

writes as TOML with keys in alphabetical order:

```toml
email = 'jane@x.org'
fullName = 'Jane'
slug = 'jane'
```

This applies recursively to nested objects (TOML tables).

### Array element order

By default, **arrays preserve insertion order**. This is the right default — many arrays are intrinsically ordered (a list of steps, a timeline).

For arrays whose order is *not* significant, a sheet declares a sort rule:

```toml
[gitsheet.fields.tags.sort]
# ...spec below
```

When a sort rule is declared, the array is sorted before write.

### Sort rule formats

Three equivalent forms:

**Array of field names** (most concise):

```toml
[gitsheet.fields.tags]
sort = ['namespace', 'slug']
```

Sorts an array of objects by `namespace` then `slug`, ascending.

**Table of field → direction:**

```toml
[gitsheet.fields.tags.sort]
namespace = 'ASC'
slug = 'ASC'
```

Same as above, but lets you declare descending order per field:

```toml
[gitsheet.fields.audit.sort]
timestamp = 'DESC'
```

**Inline JS expression** (most flexible):

```toml
[gitsheet.fields.relationships]
sort = '''
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.label.localeCompare(b.label);
'''
```

The string is the *body* of a sort comparator — `(a, b) => { <body> }`. Used when the comparison is non-trivial.

**Bare boolean** (sort scalars):

```toml
[gitsheet.fields.aliases]
sort = true
```

Sorts an array of strings using locale-aware comparison (`localeCompare` with `sensitivity: 'base'`, `numeric: true`, `ignorePunctuation: true`).

### TOML serialization details

- The library uses `@iarna/toml` for serialization. Dates, datetimes, and date-times round-trip correctly (a Date in the record becomes the matching TOML date type).
- Multi-line string formatting follows `@iarna/toml`'s defaults — strings with newlines emit as triple-quoted; the library doesn't impose its own length threshold.
- Null values are *omitted* from the output. TOML can't represent `null`; absent fields read back as `undefined` and are treated as null by validation.
- Empty arrays and empty objects are preserved (they have semantic meaning distinct from absent).

### File bytes

After all of the above:

1. Apply array sort rules (if declared)
2. Sort object keys (deep)
3. Serialize via `@iarna/toml`
4. The resulting bytes are what's written to the blob

The same record always produces the same bytes, regardless of the order fields were set on the input object.

## Validation order vs. normalization order

Per [validation.md](validation.md):

1. JSON Schema validation
2. Standard Schema validation (may transform the record)
3. **Normalization** (key sort, array sort)
4. TOML serialize
5. Write to tree

Normalization runs after the Standard Schema transform — so if a Zod schema transforms `tag: 'TYPESCRIPT'` to `tag: 'typescript'`, the normalized output reflects the transform.

## Hash determinism

Because the on-disk bytes are deterministic, the git blob hash is deterministic per logical-record state. Two writes of the same record from different code paths produce the same blob hash — meaning git sees no change to commit.

This is load-bearing for:

- Reproducible imports (`upsert` of identical input is idempotent in the commit graph)
- Reliable propose-review flows (a "proposal" branch that re-writes the same records doesn't show as different)
- Hash-based caching (e.g., the parsed-record cache in #138)

## Limits

- **Float precision** — `@iarna/toml` preserves IEEE-754 doubles. For decimal arithmetic, consumers should use string representation or a decimal library; the canonical form is still byte-stable for any given input.
- **Custom classes** — only TOML-representable types round-trip. Anything else (functions, symbols, class instances beyond Date) should be omitted from records or stringified by the consumer's Standard Schema layer.

## Coordinates with

- [api/sheet.md](../api/sheet.md)
- [behaviors/validation.md](validation.md)
- [behaviors/content-types.md](content-types.md) — markdown body normalization layers on top of this pipeline
