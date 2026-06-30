---
status: done
depends: [sheet-store-core]
specs:
  - specs/rust-core.md
issues: [127]
pr: https://github.com/JarvusInnovations/gitsheets/pull/211
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

- [x] A record written via **Python** and a record written via **Node** for the
      same input produce **byte-identical** commits (the cross-binding consistency
      proof — the architecture's whole point). `tests/test_cross_binding.py` —
      identical tree, blob, AND commit hashes for both bindings over the same core
      (4 passing tests; concrete `typed`-fixture run in PR #211).
- [x] A definition-embedded JS snippet yields identical results under Python and
      Node (`test_embedded_engine_comparator_identical_across_bindings`).
- [x] Type fidelity: a `datetime` round-trips Python → core → on-disk → Node as the
      same instant; int/float stay distinct (smoke + cross-binding `typed` fixture).
- [x] Wheels build + install on this platform; a smoke test round-trips
      upsert→commit (abi3 `cp39-abi3-manylinux` wheel built with maturin, installed
      into a uv venv, `pytest tests/` = 21/21). The full per-platform release
      matrix + trusted publishing is a documented follow-up.

## Risks / unknowns

- **GIL + the core's thread model** — the embedded-engine thread-confinement and
  holo-tree's thread-local cache must cooperate with Python's GIL/threading.
- **Packaging surface** — Python wheels per platform/ABI is its own release track
  (reuse the trusted-publishing patterns, different ecosystem).
- **API idiom translation** — keep it Pythonic without diverging the *behavior*
  from Node (behavior is the core's; only ergonomics differ).

## Notes

Built `rust/gitsheets-py` — a net-new pyo3 (0.29, abi3-py39) workspace member
over the *unmodified* `gitsheets-core`. No change to the core or the Node binding;
only the shared `rust/Cargo.toml` `members` line + `Cargo.lock`.

**Surface.** Mirrors the full napi entry-point set, batch-first: marshalling
round-trip, canonical TOML parse/serialize, path-template render, JSON-Schema
validate, the embedded **boa** engine (`run_comparator` + `CompiledDefinition`),
record CRUD/list/diff over holo-tree, query + candidates + field-names,
unique/multi indices, RFC 6902/7396 patch, substrate stats, and the
Sheet/Transaction/Store state machine (`CoreTransaction`) with the two-phase
consumer-validator protocol. A pure-Python `gitsheets/__init__.py` adds the
idiomatic surface (`transact` context manager, `Transaction` facade); the
consumer validator is any callable (Pydantic `model_validate`, etc.) run on the
normalized record between `prepare_upsert` and `stage_upsert`.

**Type fidelity.** `int` ↔ Integer (Python arbitrary-precision in, `i64` core; an
out-of-`i64` int raises `OverflowError` — no 2^53 dance), `float` ↔ Float (kept
distinct), `str`/`bool`, `datetime.datetime` ↔ Datetime, `dict` ↔ Table,
`list`/`tuple` ↔ Array. Datetimes funnel through the *same* epoch-millis bridge as
the napi `Date` mapping (aware-UTC instant; naive treated as UTC; sub-ms dropped),
which is what makes a Python `datetime` and a JS `Date` at the same instant
serialize to identical bytes. Datetime detection is `isinstance` against the
runtime `datetime` class (abi3-safe — no datetime C-API).

**Cross-binding byte-identical proof (the headline).** `test_cross_binding.py`
writes the same logical record from Python and from Node (the napi binding,
driven through `_node_writer.mjs`) and asserts identical tree + blob hashes
(`record_write`, content-addressed) AND identical commit hashes (full
upsert→commit from a shared seed). PASSED for real on linux — e.g. the `typed`
fixture (`count = 7` int, `ratio = 1.5` float, `when = …Z` datetime) yields tree
`bf0a0b1e…` / blob `83a5df2b…` from both bindings. Commit parity also passes. No
bytes-authority leak found.

**GIL / thread model.** pyo3 holds the GIL per call. The two `!Send` stateful
classes (boa engine; `gix::Repository` + holo-tree thread-local cache) are
declared `#[pyclass(unsendable)]`, so pyo3 pins each instance to its creating
thread — the runtime enforcement of the core's thread-confinement requirement.
The two-phase protocol holds no core borrow across the Python validator callback
(`prepare_upsert` and `stage_upsert` are separate FFI calls); the single-writer
registry lock is only held briefly in begin/finalize/discard.

**Packaging.** maturin mixed layout (`python-source = "python"`,
`module-name = "gitsheets._gitsheets"`), abi3-py39 → one wheel per platform for
CPython ≥ 3.9. Locally: `gitsheets-0.0.0-cp39-abi3-manylinux_2_39_x86_64.whl`
built + installed into a uv venv; `pytest tests/` = 21/21. A `python` CI job
(`.github/workflows/rust-core.yml`) builds the wheel + the napi peer and runs the
suite. The per-platform release matrix + trusted publishing is deferred (below).

**Validations run:** `cargo clippy --workspace --all-targets -- -D warnings`
clean; `cargo test -p gitsheets-core` 110+ pass (core untouched); napi `npm test`
61/61 (independent); `pytest tests/` 21/21.

## Follow-ups

- **Per-platform wheel release matrix + trusted publishing** (taxonomy: packaging
  / release-track). Mirror the holo-tree prebuild playbook: a
  `PyO3/maturin-action` build matrix across the six targets (incl. musl + macOS +
  windows) + sdist, and PyPI trusted publishing on tag. This plan scaffolded the
  maturin config + a single-platform CI build; the release matrix is its own track.
- **Async surface** (taxonomy: ergonomics). Sync-only today (matches Node's sync
  core surface); add `asyncio` wrappers only if a real consumer needs them.
- **`Store`/`Repository` high-level Python API** (taxonomy: ergonomics). The
  binding exposes the `CoreTransaction` primitive + a thin `transact` helper; a
  fuller idiomatic `Store.open(...)` / sheet-handle API can layer on later without
  touching the core.
