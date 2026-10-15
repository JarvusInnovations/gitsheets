# Behavior: Sheet-aware Merge

## Rule

Merging two branches of a gitsheets repository merges **records**, not lines. For every record file changed on both sides since the merge base, gitsheets performs a field-level 3-way merge of the parsed records and writes the result in **canonical form** — the bytes the current version would write — so a merged repository never carries a mix of serializations that no single gitsheets version produced. Delete/modify conflicts and irreconcilable field conflicts are resolved by an explicit policy or reported, never guessed. Non-record files (attachments, configs, contracts, anything outside a sheet's root or with another extension) merge the way git merges them.

Surfaces: the library's `repo.merge(opts)`, the CLI's `git sheet merge <theirs>`, and a git **merge driver** (`git sheet merge-driver`) that gives a plain `git merge` the same record-level behaviour for files changed on both sides.

## Applies To

- [api/repository.md](../api/repository.md) — `repo.merge(opts)`
- [api/cli.md](../api/cli.md) — `git sheet merge`, `git sheet merge-driver`
- [behaviors/normalization.md](normalization.md) — the canonical form every merged record is written in
- [behaviors/push-sync.md](push-sync.md) — `repo.sync()` replays commits with a *tree* merge; this behavior is the record-level merge of two branches

## Details

### Classification

With `O` = ours (the branch being merged into), `T` = theirs, `B` = their merge base:

| Relation | Outcome | Effect |
| --- | --- | --- |
| `T == O`, or `T` reachable from `O` | `up-to-date` | nothing |
| `O` reachable from `T` | `fast-forward` | `O`'s branch moves to `T` (no merge commit) |
| otherwise | `merged` / `conflict` / `dry-run` | below |
| no common history | throws `RefError` (`not_an_ancestor`) | nothing |

### The merge

1. **Tree merge.** `B`, `O`, `T` trees go through a standard 3-way tree merge (gix): files changed on one side only are taken; files changed identically on both are taken; files changed differently on both are text-merged by git's rules, which may conflict.
2. **Record pass.** Every path under a sheet's root with the sheet's extension (a *record path*) that changed on **both** sides is re-done at the record level, replacing whatever the tree merge produced for it:
   - Both modified → parse `B`, `O`, `T` with the sheet's format and **field-merge** them: for each field, if both sides agree take it; if one side left it as in `B` take the other side's value; if both changed it to different values, recurse when both are tables, otherwise it is a **field conflict**. The merged record is normalized (sort rules, canonical key order, markdown body normalization) and serialized canonically.
   - Both added (no `B`) → the same, against an empty base.
   - Deleted on one side, modified on the other → a **delete/modify conflict**.
3. **Policy.** `prefer` decides conflicts:
   - `'fail'` (default) — every conflict is reported; **nothing is written and no ref moves**. The result lists each conflict with its path, kind (`field`, `delete-modify`, `blob`, `tree`), and the field path for field conflicts.
   - `'ours'` / `'theirs'` — a field conflict takes that side's value; a delete/modify conflict takes that side's state (the deletion or the modified record); a non-record content conflict takes that side's blob. Rename/directory conflicts the tree merge could not resolve are always reported.
4. **Commit.** With no outstanding conflicts, the merged tree is committed with parents `[O, T]` (message default `Merge <theirs> into <ours>`), and `O`'s branch moves to it by compare-and-swap. `commit: false` writes the tree, moves nothing, and returns it (`dry-run`).

Records are never left with conflict markers: a conflict either resolves by policy or stops the merge before any commit.

### Which paths are records

A path is a record path when it lies under a discovered sheet's root (`<openRoot>/<config.root>/…`) and ends with that sheet's format extension (`.toml`, `.md`, `.mdx`). An attachment that happens to carry the extension is parsed as a record; if it does not parse, the tree merge's result stands and the path is reported as a `blob` conflict only if git could not merge it either.

### Merge driver

A `.gitattributes` line routes record files through gitsheets during any `git merge` / `rebase` / `cherry-pick`:

```text
people/**/*.toml merge=gitsheets
posts/**/*.md    merge=gitsheets
```

```text
git config merge.gitsheets.name   "gitsheets record merge"
git config merge.gitsheets.driver "git sheet merge-driver %O %A %B %P"
```

`git sheet merge --install-driver` does both: it sets the two `merge.gitsheets.*` keys in the repository's git config (per clone — git config is not versioned) and adds one `<root>/**/*<ext> merge=gitsheets` line per sheet discovered at `HEAD` to the working tree's `.gitattributes`, skipping lines already present, so it is idempotent. It never commits: the attributes file is working-tree content the user reviews and commits like any other. In a bare repository it sets the config and prints the lines to add instead. Each run reports what it set and what it added.

`git sheet merge-driver <base> <ours> <theirs> <path>` resolves the sheet by `<path>` from `HEAD`'s configs, field-merges the three files, writes the canonical result to `<ours>` and exits 0; on a conflict it falls back to git's own text merge (`git merge-file`) so the familiar markers appear, and exits 1. Git invokes the driver for every file changed on both sides, which is exactly the set the record pass covers — so a plain `git merge` with the driver installed produces the same record bytes as `repo.merge`.

### Why

A plain `git merge` of record files merges TOML text line by line, so each side's serialization survives: after merging an importer branch written by one gitsheets version into a branch written by another, records carried `legacyId` from one side and `githubUserId = 458_494` from the other — a mix no version would write and the next normalization pass would rewrite wholesale. And bulk-resolving thousands of `deleted by us / modified by them` conflicts by hand is a policy (`prefer: 'theirs'`), not a job. [#307](https://github.com/JarvusInnovations/gitsheets/issues/307).

## Principles

**Local:**

- **Records merge as records.** When a line-wise merge and a field-wise merge disagree, the field-wise merge wins; the on-disk bytes are an encoding, not the data. This is the same stance that makes canonical normalization the bytes-authority.
- **No guessed resolutions.** A conflict is resolved by an explicit `prefer` or reported; a merge never commits a record whose value was chosen by line order.

## Coordinates with

- [behaviors/normalization.md](normalization.md)
- [behaviors/push-sync.md](push-sync.md)
- [api/repository.md](../api/repository.md), [api/cli.md](../api/cli.md)
