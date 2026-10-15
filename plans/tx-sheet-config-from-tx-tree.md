---
status: in-progress
depends: [public-file-writes-and-orphan-commits]
specs:
  - specs/api/transaction.md
issues: [329]
---

# Plan: transaction-bound sheets read config from the transaction tree

## Scope

Fix #329: the host's `Sheet.readConfig()` on a tx-bound sheet loads the
config from `parentCommitHash ?? 'HEAD'` while the core opens the same sheet
on the transaction's private tree. Make the host read the config through
the core transaction so configs staged earlier in the same transaction
(including in an orphan transaction) govern the sheet.

## Implements

- `specs/api/transaction.md` — "Read isolation" (config paragraph).

## Approach

1. napi `CoreTransaction.readFile(path)` → `{ hash, content } | null` from
   the private tree.
2. Host `readConfig()` on a tx-bound sheet: open the core sheet first (its
   open-time validation — config, contracts, template coherence — runs on
   the tx tree and throws the typed errors), then parse the config blob
   read from the tx tree. `loadConfig` splits into blob loading and a shared
   `parseConfigEntry`.
3. Tests: orphan transaction stages a config then upserts (host + Python);
   a non-orphan transaction that changes a schema sees the new one.

## Validation

- [ ] vitest: both cases; existing suites unchanged.
- [ ] napi + pytest: `readFile` sees staged content; Python orphan
      config-then-upsert.
- [ ] clippy / type-check clean.

## Risks / unknowns

- None known; the committed-ref path is unchanged.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
