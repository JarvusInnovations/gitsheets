# Contracts

A **contract** is a named, versioned, immutable JSON Schema document that a sheet
can declare it **implements**. Declaring one composes it into the sheet's
write-time validation — every record the sheet ever commits conforms, enforced
where writes already happen. A consumer wiring itself to that sheet from another
system can then *verify* conformance mechanically instead of hoping.

Use contracts when one system consumes a sheet owned by another — a shared
toolkit reading a domain sheet out of an application repo, two services meeting
over a data repo, a published dataset with a stable shape. Without a contract,
the consumer's expectations live implicitly in its code and drift surfaces as a
confusing runtime failure in the system that *didn't* change. With one, drift is
a commit-time failure in the producer and a precise wiring-time refusal in the
consumer.

## Declaring: the producer side

A contract document is plain JSON Schema (Draft-07, the same dialect as
`[gitsheet.schema]`) with a required `$id`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://gitsheets.io/meals/v1",
  "title": "Meal",
  "type": "object",
  "required": ["slug", "name", "nutrition"],
  "properties": {
    "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "name": { "type": "string", "minLength": 1 },
    "nutrition": {
      "type": "object",
      "description": "Ballpark per serving.",
      "required": ["calories"],
      "properties": {
        "calories": { "type": "number", "description": "kcal" },
        "protein_g": { "type": "number" }
      }
    }
  }
}
```

The `$id` minus its scheme is the **contract name** (`gitsheets.io/meals/v1`).
It's an identifier, not a URL anything ever fetches — it only has to be
host-qualified and stable.

Adopt it into the repo:

```console
$ gitsheets contracts adopt ./meals-v1.schema.json
adopted gitsheets.io/meals/v1 → .gitsheets/contracts/gitsheets.io/meals/v1.toml
add to the declaring sheet's config (tooling never edits sheet configs):
  implements = ['gitsheets.io/meals/v1']
```

`adopt` accepts a local file, an `https://` URL (fetched once, at adopt time —
nothing ever fetches at runtime), or `-` for stdin, in JSON or TOML. It
re-encodes the document through the canonical TOML encoder and **vendors** it at
a path derived from its name. The vendored file is both the lock state and the
enforced artifact: what validation compiles is exactly what identity hashes, so
there is no recorded checksum that can drift from reality — the bytes *are* the
pin.

Then declare it — a one-line edit that stays yours (tooling never rewrites sheet
configs):

```toml
# .gitsheets/meal-bank.toml
[gitsheet]
root = 'meals'
path = '${{ slug }}'
implements = ['gitsheets.io/meals/v1']

[gitsheet.schema]                 # local extensions, composed with the contract
type = 'object'
required = ['tier']

[gitsheet.schema.properties.tier]
type = 'string'
enum = ['anchor', 'rotation', 'occasional']
```

From here the sheet's effective schema is `allOf(contract, local schema)`: every
write must satisfy both, and a violation says which contract it broke:

```text
gitsheets: ValidationError: record failed JSON Schema validation
  code:   validation_failed
  issue:  nutrition: "calories" is a required property (json-schema) [gitsheets.io/meals/v1]
```

The sheet keeps evolving freely beyond the contract — extra fields, stricter
local rules — with zero coordination. Contracts are required to stay **open**
(no `additionalProperties: false`) precisely so extension always works.

Adopting into a sheet that already has records is gated on those records:
`gitsheets contracts adopt <source> --sheet meal-bank` validates every existing
record against the new effective schema and refuses (leaving the tree untouched)
until the data conforms — adopting a contract is a claim that cannot lie.

Add the offline gate to CI:

```console
$ gitsheets contracts verify
contracts verify: ok
```

It checks every declaring sheet: names resolve to vendored documents, documents
are byte-canonical with matching `$id`s, records validate, and it warns if a
local schema sets `additionalProperties: false` (which can reject
contract-conforming records under composition).

## Verifying: the consumer side

A consumer holds its own copy of the contract document and verifies at wiring
time, through a two-rung ladder:

```typescript
import { openRepo, ContractError } from 'gitsheets';
import mealsV1 from './contracts/meals-v1.schema.json';

const repo = await openRepo({ gitDir: '/srv/hari/.git' });
const meals = await repo.openSheet('meal-bank', {
  contract: { schema: mealsV1 },   // mode: 'verify' is the default
});

meals.contractVerification;
// { name: 'gitsheets.io/meals/v1', rung: 'declared', tree: '9c41…', conforming: true, issues: [] }
```

- **Rung 1 — declared identity.** The sheet declares the contract's name *and*
  the vendored document is byte-identical (canonical-hash-equal) to the
  consumer's copy. Pass ⇒ verified for the present **and the future** — the
  producer's write-time enforcement guarantees every record that will ever
  land — with zero records read.
- **Rung 2 — structural.** On a rung-1 miss (no declaration, or a different
  version), every record is validated against the consumer's document directly.
  Pass ⇒ verified for the current tree. This is duck typing: it works against
  any sheet ever written, contract-aware or not.

Failure of the attempted rung(s) throws `ContractError('contract_unsatisfied')`
carrying a per-record, per-field conformance report — a diff-quality refusal at
wiring time, never a surprise mid-read.

Three modes: `'verify'` (rung 1 then rung 2 — default), `'declared'` (rung 1
only, never scans records), `'structural'` (rung 2 only). An optional `onDrift`
callback gets an advisory signal if a structurally-verified sheet's producer
later commits non-conforming data — reads are never blocked by drift; refusal
belongs at wiring time only.

The identity primitive is also exported directly:

```typescript
import { canonicalContractHash } from 'gitsheets';

canonicalContractHash(mealsV1);                    // parsed data
canonicalContractHash(text, { format: 'json' });   // or text — same hash either way
```

Two parties holding the same logical document get the same hash regardless of
serialization, because everything funnels through the canonical TOML encoder —
byte-equality and data-equality are the same question. (It's also the git blob
OID question: the vendored file's hash *is* its identity.)

From the command line, the structural check works against any sheet:

```console
$ gitsheets contracts test meal-bank --against ./contracts/meals-v1.schema.json
ok overnight-oat-jar
```

## Evolving a contract

Published versions are immutable — `…/v1` never changes; a changed document is a
new name. Evolution patterns:

- **Additive** (`…/v1.1` adds optional fields): the producer declares **both** —
  `implements = ['gitsheets.io/meals/v1', 'gitsheets.io/meals/v1.1']`. Old
  consumers keep matching v1 on rung 1, upgraded consumers match v1.1, both
  fast-path, indefinitely. Carrying both costs nearly nothing.
- **Breaking** (`…/v2` renames or restructures): prefer a bridge — design v2 so
  records can satisfy v1 and v2 simultaneously during the transition (rename by
  addition), then drop v1 and the legacy fields together later. A hard cutover
  also fails *well*: old consumers get a precise conformance report at their
  next boot, not a mid-request surprise.
- A consumer needing more than a contract gives is a new contract version, not a
  side channel — the ask arrives at the producer as a PR whose CI can't go
  green until the data satisfies it.

## Housekeeping

```console
$ gitsheets contracts sync            # re-fetch recorded sources, report drift — never rewrites
match gitsheets.io/meals/v1
$ gitsheets contracts export gitsheets.io/meals/v1   # interchange JSON to stdout
$ gitsheets contracts prune --dry-run # list vendored documents no sheet declares
```

Provenance (where a contract was adopted from) lives in
`.gitsheets/contracts/sources.toml` — tool-managed, non-load-bearing; validation
and identity depend only on the vendored bytes.

## Reference

- CLI: [`gitsheets contracts`](cli.md#git-sheet-contracts-subcommand)
- API: [`openSheet(name, { contract })`](api.md), `canonicalContractHash`,
  `ContractError`
- Authoritative behavior:
  [`specs/behaviors/contracts.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/contracts.md)
