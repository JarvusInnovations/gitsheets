# gitsheets (Python)

The Python binding for [gitsheets](https://github.com/JarvusInnovations/gitsheets) —
a git-backed document store for low-volume, high-touch, human-scale data.
Records are canonical TOML files in a git tree; every write is a real git
commit you can diff, review, revert, and sync like any other.

**The guarantee that defines this package: a record written from Python and
the same record written from the Node.js `gitsheets` package produce
byte-identical trees, blobs, and commits.** The binding is a thin
[pyo3](https://pyo3.rs) layer over the shared Rust `gitsheets-core` engine;
everything that determines on-disk bytes (canonical TOML, path-template
rendering, JSON-Schema validation, the embedded JS engine, the
Sheet/Transaction/Store state machine) lives in the core, and a cross-binding
parity suite proves the byte equivalence in CI on every change.

## Install

```bash
pip install gitsheets
```

Prebuilt abi3 wheels (any CPython >= 3.9) ship for Linux x86_64 + aarch64
(glibc), Linux x86_64 (musl), macOS x86_64 + arm64, and Windows x86_64. Other
platforms install from the sdist, which needs a Rust toolchain.

## Quick start

A sheet is declared by a TOML config committed in the repo — here, one record
file per person, keyed by `slug`, under `people/`:

```bash
mkdir crm && cd crm && git init -b main
mkdir .gitsheets
cat > .gitsheets/people.toml <<'EOF'
[gitsheet]
path = '${{ slug }}'
root = 'people'
EOF
git add .gitsheets && git commit -m "declare the people sheet"
```

Write records inside a transaction — commit on success, discard on error:

```python
import time
import gitsheets

with gitsheets.transact(
    ".git",                       # the repo's GIT_DIR
    "people: add jane",           # commit message
    int(time.time()),
    author=("Jane Doe", "jane@example.org"),
    branch="refs/heads/main",
) as tx:
    tx.open_sheet("people", ".gitsheets/people.toml")
    tx.upsert("people", {"slug": "jane", "email": "jane@example.org"})

print(tx.result["commit_hash"])
```

The round-trip is plain git — and the bytes are canonical, identical to what
the Node binding would have written:

```console
$ git show main:people/jane.toml
email = "jane@example.org"
slug = "jane"
```

## Type fidelity

The binding marshals Python natives ↔ the core's TOML-faithful value type:

| Python                | core `Value`      | TOML                       |
| --------------------- | ----------------- | -------------------------- |
| `int`                 | `Integer` (`i64`) | integer (distinct from float) |
| `float`               | `Float` (`f64`)   | float (`1` ≠ `1.0`)        |
| `str`                 | `String`          | string                     |
| `bool`                | `Boolean`         | boolean                    |
| `datetime.datetime`   | `Datetime`        | datetime (aware UTC instant) |
| `dict`                | `Table`           | table                      |
| `list` / `tuple`      | `Array`           | array                      |

Python's `int` is arbitrary-precision, so small ids stay ergonomic and large
values never lose precision (an `int` outside the `i64` range TOML permits
raises `OverflowError`).

## Consumer validators

The runtime consumer-validator hook runs Python-side on the normalized record
before the core writes any bytes — pass any callable (a Pydantic
`Model.model_validate`, a Zod-style check, a plain assertion):

```python
import gitsheets
from pydantic import BaseModel

class Person(BaseModel):
    slug: str
    email: str

with gitsheets.transact(git_dir, "add jane", time_seconds, author=("Jane", "jane@x.org"), branch="refs/heads/main") as tx:
    tx.open_sheet("people", ".gitsheets/people.toml")
    tx.upsert("people", {"slug": "jane", "email": "jane@x.org"}, validate=Person.model_validate)
```

JSON-Schema validation declared in the sheet config runs in-core, identically
to the Node binding.

## What 0.x is (and isn't)

The 0.x releases are honestly scoped as a **transactional writer with
parity-proven reads**: `transact`/`Transaction` (`open_sheet`, `upsert`,
`delete`, `clear`, `will_change`), attachments
(`set_attachment(s)`/`get_attachment(s)`/`delete_attachment(s)`), reads
through opened sheets, and validation.

Known gaps, tracked in
[#240](https://github.com/JarvusInnovations/gitsheets/issues/240) and stated
plainly rather than papered over:

- **No freshness model** — no `refresh`/auto-refresh after commit; reads see
  the tree a transaction opened, not later commits.
- **No streaming blob reads** — attachments surface as blob hashes; there is
  no streaming read API yet.
- **No push daemon** — syncing the repo to remotes is yours to arrange.

These reach parity with the Node binding as #240 lands.

## Versioning and releases

Releases ship from the
[`py-v*` tag track](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/distribution.md):
the released version is committed in `rust/gitsheets-py/Cargo.toml`, the tag
must match it, and every release is built from a commit whose cross-binding
byte-parity suite is green. Pre-1.0 semver: breaking surface changes bump the
minor version.

## Development

Build a local wheel and run the smoke + cross-binding parity suite:

```bash
uv venv && uv pip install maturin pytest pydantic
uv run maturin develop
uv run pytest tests/
```
