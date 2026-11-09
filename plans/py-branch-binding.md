---
status: in-progress
depends: []
specs:
  - specs/behaviors/default-branch.md
  - specs/api/python-binding.md
issues: [355]
---

# Plan: Python binding honors the default-branch and submodule binding

## Scope

Give the Python binding the same default-branch / submodule binding Node's
`openRepo` resolves, so a Python writer in a bound clone commits where
`git sheet` does: a `resolve_binding()` function with the same tiers and
opt-out semantics, a `Binding` value (a `str` holding the bound git dir),
and the defaults that follow it — `transact(parent=None)`, `tree_ref=None`
on every tree read, `tag_set(target=None)`, plus the submodule detached-HEAD
pointer advance and `stage_pointer`.

Out of scope: `at` (explicit `tree_ref` covers it), pointer staging after
`sync_branch` / `merge_sheets` (explicit-branch calls), live-sheet rebind,
a Python version bump (separate `py-v*` step).

## Implements

- `specs/behaviors/default-branch.md` — "Python binding".
- `specs/api/python-binding.md` — "Default-branch binding", `tag_set`'s default.

## Approach

1. **Resolution in Python, by `git` subprocess** — Node resolves in the host
   (`repository.ts` / `submodule.ts` with `git` subprocesses), not the core,
   so `python/gitsheets/_binding.py` ports it line for line under the same
   environment hygiene as `git-exec.ts`. Using git itself for config keeps
   includes and local-over-global layering identical to Node and the CLI.
2. **`Binding(str)`** — the bound git dir as the string value, the
   resolution as attributes, so it flows into every native call unchanged.
3. **Defaults** — wrap the `tree_ref` reads to resolve `None` to the bound
   tree (`rev-parse <ref>^{tree}`, empty tree when unborn); rework
   `transact` to compute Node's `#defaultStart` (tip / unborn-orphan /
   as-given), discard an unmutated unborn bootstrap, advance a detached
   submodule `HEAD` by CAS, and stage the gitlink. Expose
   `CoreTransaction.is_mutated()` from the pyo3 layer for the discard.
4. **Tests** — Python unit tests for each tier, opt-out, refusal, the
   transact defaults (tip, unborn bootstrap, empty bootstrap, detached
   submodule advance, `stage_pointer`), and a cross-binding test diffing
   `openRepo` (built `packages/gitsheets/dist`) against `resolve_binding`
   over the same clones and env.
5. **Docs** — `rust/gitsheets-py/README.md`, `docs/recipes/headless-data.md`.

## Validation

- [ ] `resolve_binding` resolves option → env → git config → `HEAD` for
  branch and submodule, with `False` opting out without reading env/config
- [ ] Tag, commit, and remote-only branch refused with `ConfigError`
  (`config_invalid`); unborn branch allowed
- [ ] `transact(parent=None)` commits to the bound branch's tip; an unborn
  bound branch gets a root commit; an empty handler commits nothing
- [ ] `tree_ref=None` reads the bound branch's tree; explicit refs unchanged
- [ ] Submodule mode: detached `HEAD` advanced by CAS; `stage_pointer`
  stages the gitlink
- [ ] Cross-binding test: Node `openRepo` and Python `resolve_binding` bind
  identically across the same clones/env/config
- [ ] Gate: Python suite green; cargo build / test / clippy green
