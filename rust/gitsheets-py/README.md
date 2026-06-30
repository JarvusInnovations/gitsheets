# gitsheets (Python)

The Python binding for [gitsheets](https://github.com/JarvusInnovations/gitsheets) —
a git-backed document store for low-volume, high-touch, human-scale data.

It is a thin [pyo3](https://pyo3.rs) binding over the shared Rust
`gitsheets-core` engine. Everything that determines on-disk bytes (canonical
TOML, path-template rendering, JSON-Schema validation, the embedded JS engine,
the Sheet/Transaction/Store state machine) lives in the core, so **a record
written from Python and the same record written from the Node binding produce
byte-identical trees, blobs, and commits.**

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

## Development

Build a local wheel and run the smoke + cross-binding parity suite:

```bash
uv venv && uv pip install maturin pytest pydantic
uv run maturin develop
uv run pytest tests/
```
