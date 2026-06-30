---
status: planned
depends: [sheet-store-core]
specs:
  - specs/rust-core.md
issues: [127]
---

# Plan: Python binding (pyo3)

## Scope

The first **second** binding — `gitsheets` for Python over the same
`gitsheets-core`, proving the thin-binding model and the cross-binding
byte-consistency the whole architecture is for. **In:** a pyo3 binding,
Python-idiomatic API, native `dict`/`datetime` marshalling, the consumer-validator
hook (Pydantic-or-similar), packaging/wheels. **Out:** feature parity beyond the
core's surface; any core change (if Python needs something the core lacks, that's a
core plan).

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — the multi-binding goal made real;
  validates that "the bytes-authority lives in the core" actually yields identical
  bytes across languages.

## Approach

- **pyo3 binding** over `gitsheets-core`; map the core `Value` ↔ Python natives
  with fidelity (TOML datetime ↔ `datetime.datetime`, int/float, table ↔ `dict`).
- **Idiomatic surface** in Python conventions (sync first; async if warranted).
- **Consumer validator** hook runs Python-side (e.g. Pydantic) on the native object
  before the core takes over — same write order as Node.
- **Embedded-engine reuse:** definition-embedded JS snippets run in the **core's**
  engine, so Python gets identical sort/partition/validation results as Node with
  no Python JS runtime. (This is the payoff of "embed in the core, not the host.")
- **Packaging:** maturin/abi3 wheels per platform (mirror the holo-tree prebuild +
  trusted-publishing playbook).

## Validation

- [ ] A record written via **Python** and a record written via **Node** for the
      same input produce **byte-identical** commits (the cross-binding consistency
      proof — the architecture's whole point).
- [ ] A definition-embedded JS snippet yields identical results under Python and
      Node.
- [ ] Type fidelity: a `datetime` round-trips Python → core → on-disk → Node as the
      same instant.
- [ ] Wheels build + install on the target platforms; a smoke test round-trips
      upsert→commit.

## Risks / unknowns

- **GIL + the core's thread model** — the embedded-engine thread-confinement and
  holo-tree's thread-local cache must cooperate with Python's GIL/threading.
- **Packaging surface** — Python wheels per platform/ABI is its own release track
  (reuse the trusted-publishing patterns, different ecosystem).
- **API idiom translation** — keep it Pythonic without diverging the *behavior*
  from Node (behavior is the core's; only ergonomics differ).

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
