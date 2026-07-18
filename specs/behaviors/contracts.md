# Behavior: Contracts

## Rule

A sheet may declare that it **implements** one or more named, versioned schema
contracts. A contract is a JSON Schema document, vendored into the repo in
canonical TOML form, that is **composed into the sheet's write-time validation**
— so every record the sheet ever commits conforms to every contract it declares,
by construction. A consumer wiring itself to another repo's sheet can verify
conformance mechanically: fast-path by content identity (the vendored bytes hash
to the same document the consumer holds), fallback by structural validation of
the records themselves.

Contracts make cross-system sheet consumption a **checked interface instead of a
hopeful convention**: the producer's conformance is enforced where writes happen,
the consumer's expectations are verified where wiring happens, and drift becomes
a commit-time failure in the repo that caused it — never a mid-read surprise in
the repo that didn't.

## Applies To

- [`.gitsheets/<sheet>.toml`](../concepts.md#sheet) — the `implements` key
- `.gitsheets/contracts/` — the vendored contract store
- [behaviors/validation.md](validation.md) — contract composition in the write pipeline
- [api/repository.md](../api/repository.md) — `openSheet(name, { contract })` consumer verification
- [api/cli.md](../api/cli.md) — the `contracts` command group
- [api/errors.md](../api/errors.md) — `ContractError`

## Concepts

- **Contract document** — a self-contained JSON Schema (Draft-07, same dialect
  as `[gitsheet.schema]`) with a required `$id`. It describes the shape and
  semantics of records; its `title`/`description` annotations are the semantic
  payload (units, meanings — what structural checking can't see).
- **Contract name** — the document's `$id` with the URL scheme stripped:
  `$id = 'https://gitsheets.io/meals/v1'` → name `gitsheets.io/meals/v1`. Names
  are host-qualified paths; the name is the identity humans and configs use.
- **Contract identity** — the SHA-256 of the document's **canonical TOML bytes**
  (equivalently: the git blob OID of the vendored file). Two parties hold the
  same contract iff their canonical bytes are identical. Identity is of the
  document, not the semantics — no schema-equivalence reasoning exists anywhere
  in this design, by principle (see below).
- **Vendored contract** — the canonical-TOML rendering of a contract document,
  committed at its derived path under `.gitsheets/contracts/`. The vendored
  bytes are simultaneously the **lock state** and the **enforced artifact**:
  what validation compiles is what identity hashes. There is no separately
  recorded integrity hash to drift from reality.

## Contract names and the derived path

A contract name must:

- contain at least one `/` (host-qualified: `<host>/<path...>`)
- use only lowercase host characters and path segments that satisfy the same
  character rules as rendered [path-template](path-templates.md) segments
  (no Windows-invalid characters, no control characters, no `.` / `..`
  segments, no trailing slash)

The vendored path is derived mechanically — no manifest, no lookup:

```text
.gitsheets/contracts/<name>.toml
```

e.g. `gitsheets.io/meals/v1` → `.gitsheets/contracts/gitsheets.io/meals/v1.toml`.

Because names always contain a `/`, vendored documents always live in
subdirectories — top-level files in `.gitsheets/contracts/` (the `sources.toml`
sidecar) can never collide with a contract.

The document's `$id` must equal `https://` + name. At compile time the core
verifies the vendored document's internal `$id` matches the path it lives at;
mismatch is `ContractError('contract_invalid')`. The contracts directory is
therefore self-describing.

The `$id` is an identifier, not a dereference: nothing at runtime, adopt time,
or verify time ever fetches it. It may happen to resolve on the web; the system
never depends on that.

## Contract document requirements

Enforced when a document is adopted (CLI) and re-checked when it is compiled
(core). Violation is `ContractError('contract_invalid')` with a message naming
the rule:

1. **Draft-07, strictly compiled** — the same dialect and compiler as
   `[gitsheet.schema]`. Unknown keywords fail compilation. `$data` is disabled.
2. **Self-contained** — no external `$ref` (no other document, no URL).
   Internal `$ref` into own `definitions` is allowed. Closure vendoring is
   deferred (see [deferred.md](../deferred.md)).
3. **Open for extension** — the document must not use
   `additionalProperties: false` (at any level). Draft-07 has no
   `unevaluatedProperties`, so a closed contract would silently break `allOf`
   composition with sheet-local schemas and sibling contracts. Openness is a
   hard requirement, not a style preference.
4. **TOML data model only** — no null-bearing keywords (`type: 'null'`
   including inside type arrays, `const: null`, `enum` containing null,
   `default: null`). This is alignment, not compromise: contracts describe
   gitsheets records, records are TOML, and TOML has no null — a null branch
   could never match anything.
5. **Required `$id`** conforming to the name rules above.

## Canonical form

The vendored file is produced by the core's canonical TOML encoder — the same
deep-key-sorted, deterministically-rendered pipeline that writes records (see
[normalization.md](normalization.md)). Consequences, all load-bearing:

- **Byte-equality ≡ data-equality.** Two parties comparing contracts may hash
  bytes, compare git blob OIDs, or parse-and-deep-equal — all three agree.
- **Cross-binding identity for free** — the encoder is the shared Rust core, so
  Node and Python consumers compute identical identities from the same data.
- **Array order is part of identity.** The encoder sorts keys, never arrays
  (array order can be semantic in JSON Schema). Two independently-authored,
  semantically-equal documents with differently-ordered `required` arrays are
  *different contracts*. This never arises in practice because contracts
  propagate by copy, not by re-authoring — but it is the specified behavior,
  not a bug.
- **The vendored copy is byte-virgin.** No tool may inject provenance, comments,
  or metadata into it — that would fork its identity from every other party's
  copy. Provenance lives in the sidecar (below); annotations that would mutate
  a published document (deprecation, succession) are a registry concern and are
  deferred — **published contract versions are immutable, absolutely**. A
  changed contract is a new name (`…/v2`), never edited bytes under an old one.

Adoption accepts interchange JSON or TOML input and canonicalizes on vendor;
`contracts export` emits interchange JSON for the wider JSON Schema toolchain.
The identity-bearing form is always the TOML bytes.

## Declaration: `implements`

```toml
[gitsheet]
root = 'meals'
path = '${{ slug }}'
implements = ['gitsheets.io/meals/v1']
```

- `implements` is an array of contract names — **pure intent, wholly
  human/agent-authored**. Tooling never rewrites the sheet config; all
  tool-managed state lives under `.gitsheets/contracts/`.
- Each name must resolve to a vendored document at its derived path **in the
  committed tree** (the same commit-first rule as sheet configs themselves).
  A declared name with no vendored document is
  `ContractError('contract_missing')` at sheet-open.
- The same name may be declared by any number of sheets in the repo; they all
  compose the same single vendored document. One name → one document per repo:
  sheets cannot skew on the content of a shared contract, structurally.

## Composition and enforcement

When a sheet declares contracts, its effective write-time JSON Schema is:

```text
allOf: [ <vendored contract 1>, …, <vendored contract N>, <[gitsheet.schema]> ]
```

evaluated as layer 1 of the validation pipeline (before Standard Schema — see
[validation.md](validation.md)). Consequences:

- Every write to the sheet conforms to every declared contract, **by
  construction**. There is no conformance *checking* step for producers —
  enforcement happens where enforcement already happens.
- `ValidationError` issues arising from a contract branch identify the
  contract by name in the issue (alongside the existing `path` / `message` /
  `source` fields), so a failing write says *which* obligation it violated.
- Contract `default:` values apply on write exactly as `[gitsheet.schema]`
  defaults do.
- A sheet-local `[gitsheet.schema]` that sets `additionalProperties: false`
  without enumerating every contract property will reject contract-conforming
  records — a self-inflicted composition footgun. It is legal (the local schema
  is the producer's own), but `contracts verify` warns on it.
- **There is no static satisfiability check** across contracts + local schema.
  Detecting that an `allOf` is unsatisfiable is schema-subtyping territory —
  explicitly out of scope, permanently. The practical gate is adoption's
  validate-existing-records pass (below) and ordinary write-time failure.

## The sources sidecar

`.gitsheets/contracts/sources.toml` — tool-managed provenance, one entry per
contract name:

```toml
['gitsheets.io/meals/v1']
source = 'https://raw.githubusercontent.com/JarvusInnovations/claude-assist/main/contracts/meals/v1.schema.json'
adopted = 2026-07-18T00:00:00Z
```

- **Non-load-bearing.** Nothing at runtime reads it; validation and identity
  depend only on the vendored bytes. An entry may be absent (contract adopted
  from a local file, offline) with no loss of function.
- Used by `contracts sync` to re-fetch and report upstream drift, and by humans
  to answer "where did this come from".
- v1 source forms: a local file path or an HTTPS URL, fetched once at
  adopt/sync time — never at runtime. Git-native source refs
  (`owner/repo/path@ref` shorthand) and vanity-name resolution are deferred
  (see [deferred.md](../deferred.md)).

## Consumer verification

A consumer holding a contract document verifies a target sheet via a two-rung
ladder (surfaced as `openSheet(name, { contract })` — see
[api/repository.md](../api/repository.md) — and as `contracts test` in the CLI):

1. **Rung 1 — declared identity.** The sheet's config declares the contract's
   name in `implements`, **and** the vendored document at the derived path is
   byte-identical (canonical-hash-equal) to the consumer's copy. Both halves
   are required: the declaration proves the contract is composed into write
   enforcement (future records conform); byte-identity proves it is the *same*
   contract (this contract, not a namesake). Pass → verified, present and
   future, zero records read.
2. **Rung 2 — structural.** Every record of the sheet validates against the
   consumer's document. Pass → verified for the current tree only. This rung
   is what makes contract-unaware sheets consumable — pure duck typing against
   any sheet ever written.

- **A rung-1 miss is evidence-checking, not rejection**: a hash mismatch (the
  producer implements a newer or different version) falls through to rung 2,
  because the producer's data may well still satisfy the consumer's document.
- Rung-2 failure throws `ContractError('contract_unsatisfied')` carrying a
  conformance report: per-record, per-field `ValidationIssue`s — diff-quality,
  at wiring time, in the party that chose the wiring.
- A rung-2-verified sheet's guarantee is pinned to the tree hash that was
  validated. On rebind to a changed tree (see
  [freshness.md](freshness.md)), re-verification is **advisory, not
  blocking**: the consumer may register a drift callback, but reads are never
  blocked mid-flight — a producer's bad commit must not become a consumer
  outage. Refusal belongs at wiring/boot time; drift after that is a signal.

Verification modes: `verify` (rung 1, fall back to rung 2 — the default),
`declared` (rung 1 only — strict, never scans records), `structural` (rung 2
only). Exact API shape in [api/repository.md](../api/repository.md).

## Evolution

- **Additive revision** — publish a new immutable name (`…/v1.1` adding
  optional fields). A producer adopts it *alongside* the old one:
  `implements = ['gitsheets.io/meals/v1', 'gitsheets.io/meals/v1.1']`. `allOf`
  composition makes multi-conformance enforcement-by-construction — a type
  implementing two interfaces, with no entailment reasoning anywhere. Old
  consumers rung-1 match v1, new consumers rung-1 match v1.1, simultaneously,
  indefinitely. Dropping the old declaration is the producer's choice, made
  when its known consumers have moved — or never; carrying both is nearly free.
- **Adoption is gated on existing data.** `contracts adopt` validates every
  existing record of each newly-declaring sheet against the new effective
  schema and refuses to write the declaration until the data conforms. Adopting
  a contract is a commit that cannot lie.
- **Breaking revision** — a new name (`…/v2`) whose constraints conflict with
  the old. Preferred migration is the **bridge**: design v2 rename-by-addition
  so records can satisfy v1 and v2 simultaneously during the transition, then
  drop v1 and the legacy fields together later. The **hard cutover**
  alternative (switch `implements` to v2 alone) makes old consumers fail
  precisely and early: rung 1 misses, rung 2 reports exactly which fields went
  missing — at their next wiring/boot, not mid-read.
- **Succession/deprecation signaling** (`supersededBy`-style metadata) cannot
  live in the document — published versions are immutable, and annotating one
  would fork its identity. It is a registry-layer concern, deferred.

## Failure modes

| Condition | Error | When |
| --- | --- | --- |
| `implements` names a contract with no vendored document | `ContractError('contract_missing')` | sheet-open |
| Vendored/adopted document violates document requirements (compile failure, `$id`/path mismatch, non-canonical bytes, external `$ref`, null-bearing keyword, closed) | `ContractError('contract_invalid')` | sheet-open / adopt |
| Record fails a contract branch on write | `ValidationError('validation_failed')` (issue names the contract) | write |
| Consumer verification fails both rungs | `ContractError('contract_unsatisfied')` (carries conformance report) | `openSheet` with `contract` / `contracts test` |
| Vendored document no sheet declares | not an error — `contracts prune` lists/removes | CLI |

## Principles

**Local** — the decisive trade-offs this design is built on:

- **The lock is the artifact.** When the artifact is committed, a separately
  recorded hash is a cache that can lie. The vendored bytes are what validation
  compiles *and* what identity hashes — one source of truth, no divergence
  possible. Trust computations over declarations.
- **Identity is content, not location.** A contract's identity is its canonical
  bytes; names are human handles and sources are provenance. Any party may
  fetch from anywhere — hosts can change, registries can vanish — and identity
  is unaffected.
- **Conformance by construction beats conformance proofs.** Never compare
  schemas to schemas (subtyping is a tar pit up to undecidability). Compose the
  contract into write validation and the question disappears for producers;
  hash the bytes and it disappears for consumers; validate records and it
  disappears for strangers.
- **Producer-local growth must cost zero coordination.** Adding a local field
  to a sheet that implements contracts requires nothing from anyone. Any design
  change that violates this is wrong.
- **Mismatch is evidence to check, not grounds to refuse.** Every fast-path
  miss degrades to a structural check; refusal happens only on structural
  failure, and only at wiring time — never mid-read.

**Inherited** — see [validation.md](validation.md) on persisted-vs-consumer
validation layering and [normalization.md](normalization.md) on canonical bytes;
this behavior is deliberately a composition of those two existing guarantees.
