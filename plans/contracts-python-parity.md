---
status: planned
depends: []
specs:
  - specs/api/python-binding.md
  - specs/behaviors/contracts.md
issues: []
---

# Plan: contracts parity for the Python binding

## Scope

Bring the Python binding's contract surface to parity with Node, in the
binding's own batch-first shape: `verify_sheet_contract` (the module-level
consumer-verification function), a documented `canonical_contract_hash` (already
shipped in #265 but absent from the spec until now), and `ContractError` with
all three stable codes surfaced through the pyo3 exception taxonomy. Write-time
enforcement needs nothing — it rides the shared core.

Out of scope: any OO `open_sheet(contract=...)` surface (the binding is
deliberately batch-first per `specs/api/python-binding.md`); drift callbacks
(no live-rebind model exists on this surface); the axi work
([`contracts-axi`](contracts-axi.md)).

## Implements

- `specs/api/python-binding.md` — the new **Contracts** subsection of
  "Supported surface (0.x)" (this plan's spec change, landed with it)
- `specs/behaviors/contracts.md` — Consumer verification, as exposed through
  the batch FFI

## Approach

1. pyo3: `verify_sheet_contract(...)` wrapping the existing core
   `gitsheets_core::verify_sheet_contract` (built in #267) — mirror the napi
   wrapper's shape (`rust/gitsheets-napi/src/lib.rs::verify_sheet_contract`):
   open the sheet read-only at `(git_dir, tree_ref)`, resolve the document
   input (dict / JSON text / TOML text with explicit `format`, exactly like
   the existing `canonical_contract_hash` py wrapper), run the ladder, return
   the report as a dict (`name`, `rung`, `conforming`, `issues`, `tree`);
   `contract_unsatisfied` raises `ContractError` with `issues` attached.
2. Confirm `ContractError` marshalling covers all three codes (the class
   landed in #265; `contract_unsatisfied` must carry per-record issues the
   same way `ValidationError` carries its issues).
3. Pure-Python wrapper in `python/gitsheets/__init__.py` following the
   existing module-function conventions (docstrings, keyword defaults).
4. Tests (`rust/gitsheets-py/tests/`): mirror the napi contract-verification
   suite — rung-1 pass against a declaring fixture; rung-1 miss → rung-2 pass;
   rung-2 failure report (record paths + contract + field issues);
   `declared` fail-fast; `structural` duck-typing a contract-unaware sheet.
   Extend the cross-binding parity suite: Node and Python must return the same
   report (name/rung/conforming, same issue set) for the same fixture, and
   identical `canonical_contract_hash` values (already covered — keep green).

## Validation

- [ ] `verify_sheet_contract` passes rung 1 against a declaring fixture sheet
      and reports `rung: 'declared'` without reading records
- [ ] Rung-1 miss falls through to a rung-2 structural pass; `declared` mode
      raises immediately; `structural` mode verifies a contract-unaware sheet
- [ ] A non-conforming sheet raises `ContractError` (`contract_unsatisfied`)
      whose issues name record path, field, and contract
- [ ] Cross-binding parity: Node and Python produce equivalent conformance
      reports for the same fixtures
- [ ] Full existing suites pass unchanged (`cargo test`, pytest, napi, JS)

## Risks / unknowns

- **Sheet-open plumbing in the py crate** — the napi wrapper leans on shared
  `record::open_repo`/`resolve_tree`/`CoreSheet::open` helpers; confirm the py
  crate has (or can reuse) equivalents without duplicating logic. If a helper
  needs to move core-side for sharing, keep it a pure refactor.
- **Issue marshalling shape** — Python issues today come through as dicts on
  `ValidationError`; keep `ContractError.issues` the same shape (including the
  new `record`/`contract` keys) rather than inventing a class.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
