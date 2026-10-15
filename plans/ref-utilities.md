---
status: in-progress
depends: []
specs:
  - specs/api/repository.md
issues: [331]
---

# Plan: repo.tag() and repo.listTree()

## Scope

Two thin core-backed utilities so consumer scripts stop shelling out for
`git tag -f` and `git ls-tree`: a lightweight tag set (refusing an existing
tag unless forced) and a non-recursive tree listing at a ref. Node and
Python.

## Implements

- `specs/api/repository.md` — `repo.tag`, `repo.listTree`.

## Approach

1. Core `record::set_tag(repo, name, target, force)` and
   `record::list_tree(ctx, tree, path)`.
2. napi `tagSet` / `treeList`; pyo3 `tag_set` / `tree_list`.
3. Host `Repository.tag` / `listTree`.
4. Tests in all three layers.

## Validation

- [ ] cargo test, napi, pytest, vitest.
- [ ] clippy / type-check clean.

## Risks / unknowns

- None.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
