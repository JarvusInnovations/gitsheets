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

- The **canonical serializer** is the Rust core's `gitsheets-core::canonical::serialize` — the [`toml` crate](https://docs.rs/toml)'s default formatting applied to a deep-key-sorted value. It defines the canonical bytes: a value is lowered to `toml::Value` (whose `Table` is a `BTreeMap`, so the deep key sort happens structurally) and emitted with the crate's default rendering (triple-quoted multiline strings, literal-quoted strings where possible). Parsing is the same crate's parser. See [architecture.md](../architecture.md) and [rust-core.md](../rust-core.md#canonical-form-rebaseline).
- Dates, datetimes, and date-times round-trip by native TOML datetime type — all four kinds (offset date-time, local date-time, local date, local time) parse to the core `Datetime` and serialize back to the matching TOML type byte-faithfully.
- Multi-line string formatting follows the `toml` crate's defaults — strings with newlines emit as triple-quoted (`"""…"""`); the library imposes no length threshold of its own.
- Null values are *omitted* from the output. TOML can't represent `null`; absent fields read back as `undefined` and are treated as null by validation.
- Empty arrays and empty objects are preserved (they have semantic meaning distinct from absent).

> **v1.0 substrate note.** The v1.0 Node substrate still serializes through `@iarna/toml`, so its on-disk bytes differ from the canonical form above by exactly the three value-preserving reformat classes documented under [Canonical-form re-baseline](#canonical-form-re-baseline-the-rust-serializer). The cutover to the core serializer — and the one-time live re-normalization — is sequenced with the Node binding work (`node-binding-thin`), not performed implicitly. Until then this is a bounded, documented spec↔substrate drift.

### File bytes

After all of the above:

1. Apply array sort rules (if declared)
2. Sort object keys (deep)
3. Serialize via the canonical serializer (`gitsheets-core::canonical::serialize`)
4. The resulting bytes are what's written to the blob

The same record always produces the same bytes, regardless of the order fields were set on the input object.

## Canonical-form re-baseline (the Rust serializer)

Adopting the Rust core's `gitsheets-core::canonical::serialize` **re-baselines the canonical bytes once**: a value that was already canonical under the previous `@iarna/toml` serializer may now serialize to different — but *value-identical* — bytes. This is a deliberate, one-time change, decided while gitsheets effectively has a single consumer (the blast radius of re-normalizing existing repos only grows with adoption). See [rust-core.md](../rust-core.md#canonical-form-rebaseline) and [#196](https://github.com/JarvusInnovations/gitsheets/issues/196).

The decision is backed by a full-corpus parity run in [PR #205](https://github.com/JarvusInnovations/gitsheets/pull/205): the Rust serializer was run over the entire 29,556-record CodeForPhilly corpus with **0 data-loss, 0 non-idempotent serializations, and 0 parse errors**. Every byte divergence from the old `@iarna/toml` bytes falls into one of three reformat classes below.

### The three sanctioned reformat classes

[#196](https://github.com/JarvusInnovations/gitsheets/issues/196) originally predicted a *single* change (integer underscores). The corpus parity run proved that prediction incomplete: there are **three** value-preserving reformat classes relative to the old `@iarna/toml` bytes. All three are proven data-lossless (re-parsing the fresh bytes yields the same value) and idempotent (a second serialization is a no-op), and all move *toward* the readable form #196 endorses — never the single-line re-escaping it rejects.

1. **Integer digit-group underscores dropped.** `legacyId = 31_618` → `legacyId = 31618`. gitsheets serializes fresh from a value, so digit-group separators are never re-emitted. This is the dominant class and the one #196 predicted.

2. **String requote.** A string containing *both* `"` and `'` (so it cannot be a TOML literal string) moves from `@iarna`'s escaped single-line basic string (`"…\"…"`) to the `toml` crate's readable triple-quoted form (`"""…"""`). For example, a bio with embedded HTML — `<a href=\"…\">` inside a single-line basic string — becomes `<a href="…">` inside a `"""…"""` block, with the apostrophes and quotes no longer escaped.

3. **Multiline trailing-quote layout.** A multiline string whose content ends in a `"` character: `@iarna` emits the `"` followed by a `\`-line-continuation and then the closing `"""` (two physical lines); the `toml` crate places adjacent quotes before the delimiter (`…UAE""""`, one line). Same string value, fewer lines.

Because all three preserve the value, the canonical invariant — *logically-equal records produce byte-identical TOML* — still holds; only the specific byte image changed, once.

### Re-normalizing an existing repo (consumer recipe)

Adopting the new canonical form across an existing repo is a single re-serialize-everything commit. The routine reads every record, parses it, re-serializes it through the canonical serializer, and writes the result back. It is **idempotent** — a second run produces zero diff, which is the adoption check.

The repo ships a minimal one-shot for this over a checked-out tree:

```bash
# Re-normalize every *.toml record under a directory, in place.
cargo run -p gitsheets-core --example normalize_tree -- path/to/records

git add path/to/records
git commit -m "chore: re-baseline records to the Rust canonical form"

# Verify idempotence — a second pass must report 0 files re-normalized:
cargo run -p gitsheets-core --example normalize_tree -- path/to/records
```

The example refuses to write any file whose fresh bytes don't re-parse to the same value (a data-loss guard), so a parse or serialize bug can never silently rewrite a record's meaning.

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

- **Float precision** — the canonical serializer preserves IEEE-754 doubles (`1.0` stays `1.0`, distinct from the integer `1`). For decimal arithmetic, consumers should use string representation or a decimal library; the canonical form is still byte-stable for any given input.
- **Custom classes** — only TOML-representable types round-trip. Anything else (functions, symbols, class instances beyond Date) should be omitted from records or stringified by the consumer's Standard Schema layer.

## Coordinates with

- [api/sheet.md](../api/sheet.md)
- [behaviors/validation.md](validation.md)
- [behaviors/content-types.md](content-types.md) — markdown body normalization layers on top of this pipeline
