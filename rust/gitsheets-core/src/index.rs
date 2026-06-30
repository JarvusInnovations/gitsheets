//! Secondary indexing — fast lookup by a derived key.
//!
//! A behavior-preserving Rust port of the host `Sheet.defineIndex` /
//! `findByIndex` build pipeline (`packages/gitsheets/src/sheet.ts`), per
//! [`specs/behaviors/indexing.md`](../../../specs/behaviors/indexing.md). A
//! secondary index maps a derived key (computed by a `keyFn` snippet) to the
//! record(s) carrying it — the access pattern the path-template *primary* index
//! doesn't serve.
//!
//! ## Lazy, in-memory (the v1.0 decision)
//!
//! Indices are built **on demand** over the records under a sheet's base and
//! held in process memory; nothing is persisted to the data repo. This matches
//! the spec's default ("Lazy (default)") and its explicit deferral of a
//! persisted on-disk format. The build is a single pass: `keyFn(record)` per
//! record (`null`/`undefined` ⇒ excluded), populating a unique or multi map.
//!
//! The *caching* of a built index across operations, and its invalidation on
//! ref movement, is a `Sheet`-level concern (the host keys the build by the
//! data tree's commit hash; that state machine lands in `sheet-store-core`).
//! This module owns the build + lookup primitives over an already-listed record
//! set, so the binding can list once and build/serve from the result.

use crate::engine::{Engine, SnippetError, SnippetHandle};
use crate::error::{Error, Result};
use crate::value::Value;
use indexmap::IndexMap;

/// A built **unique** index: each key maps to at most one `(path, record)`. A
/// duplicate key during the build is an [`Error::IndexUniqueConflict`] naming
/// both paths — exactly the host's lazy-build conflict.
#[derive(Debug)]
pub struct UniqueIndex {
    map: IndexMap<String, (String, Value)>,
}

/// A built **non-unique** index: each key maps to every `(path, record)` that
/// produced it, in record (sorted-path) order.
#[derive(Debug)]
pub struct MultiIndex {
    map: IndexMap<String, Vec<(String, Value)>>,
}

impl UniqueIndex {
    /// Build a unique index over `records` (`(path, record)` pairs, typically
    /// from [`crate::record::list_records`]). `key_handle` is a `keyFn` snippet
    /// `(record) => string | undefined | null` compiled into `engine`.
    pub fn build(
        records: &[(String, Value)],
        key_handle: SnippetHandle,
        engine: &mut Engine,
    ) -> Result<Self> {
        let mut map: IndexMap<String, (String, Value)> = IndexMap::new();
        for (path, record) in records {
            let Some(key) = key_for(engine, key_handle, record)? else {
                continue;
            };
            if let Some((existing_path, _)) = map.get(&key) {
                return Err(Error::IndexUniqueConflict {
                    message: format!("unique index: key {key:?} appears in multiple records"),
                    conflicting_paths: vec![existing_path.clone(), path.clone()],
                });
            }
            map.insert(key, (path.clone(), record.clone()));
        }
        Ok(UniqueIndex { map })
    }

    /// Look up a key. `None` when no record carries it.
    pub fn lookup(&self, key: &str) -> Option<&Value> {
        self.map.get(key).map(|(_, record)| record)
    }
}

impl MultiIndex {
    /// Build a non-unique index over `records`. No conflicts: every record with
    /// the same key is collected.
    pub fn build(
        records: &[(String, Value)],
        key_handle: SnippetHandle,
        engine: &mut Engine,
    ) -> Result<Self> {
        let mut map: IndexMap<String, Vec<(String, Value)>> = IndexMap::new();
        for (path, record) in records {
            let Some(key) = key_for(engine, key_handle, record)? else {
                continue;
            };
            map.entry(key).or_default().push((path.clone(), record.clone()));
        }
        Ok(MultiIndex { map })
    }

    /// Look up a key. Returns every matching record (empty slice when none).
    pub fn lookup(&self, key: &str) -> &[(String, Value)] {
        self.map.get(key).map(Vec::as_slice).unwrap_or(&[])
    }
}

fn key_for(
    engine: &mut Engine,
    handle: SnippetHandle,
    record: &Value,
) -> Result<Option<String>> {
    engine.call_index_key(handle, record).map_err(|e| {
        let detail = match e {
            SnippetError::UndefinedReference(m) | SnippetError::Other(m) => m,
        };
        Error::ConfigInvalid {
            message: format!("index keyFn failed: {detail}"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(pairs: &[(&str, Value)]) -> Value {
        let mut m = IndexMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        Value::Table(m)
    }
    fn s(v: &str) -> Value {
        Value::String(v.to_string())
    }

    fn people() -> Vec<(String, Value)> {
        vec![
            ("jane".into(), rec(&[("slug", s("jane")), ("email", s("Jane@x.org")), ("team", s("eng"))])),
            ("bob".into(), rec(&[("slug", s("bob")), ("email", s("bob@y.org")), ("team", s("eng"))])),
            ("amy".into(), rec(&[("slug", s("amy")), ("email", s("amy@z.org")), ("team", s("design"))])),
        ]
    }

    #[test]
    fn unique_index_lookup_returns_the_record() {
        let mut eng = Engine::new().unwrap();
        let h = eng
            .compile("(r) => ( r.email.toLowerCase() )")
            .unwrap();
        let idx = UniqueIndex::build(&people(), h, &mut eng).unwrap();
        let jane = idx.lookup("jane@x.org").unwrap();
        let Value::Table(m) = jane else { panic!() };
        assert_eq!(m.get("slug"), Some(&s("jane")));
        assert!(idx.lookup("nobody@example.com").is_none());
    }

    #[test]
    fn non_unique_index_returns_all_matches() {
        let mut eng = Engine::new().unwrap();
        let h = eng.compile("(r) => ( r.team )").unwrap();
        let idx = MultiIndex::build(&people(), h, &mut eng).unwrap();
        assert_eq!(idx.lookup("eng").len(), 2);
        assert_eq!(idx.lookup("design").len(), 1);
        assert_eq!(idx.lookup("ops").len(), 0);
    }

    #[test]
    fn keyfn_returning_undefined_excludes_the_record() {
        let mut eng = Engine::new().unwrap();
        let h = eng
            .compile("(r) => ( 'legacyId' in r ? String(r.legacyId) : undefined )")
            .unwrap();
        let records = vec![
            ("a".into(), rec(&[("slug", s("a")), ("legacyId", Value::Integer(100))])),
            ("b".into(), rec(&[("slug", s("b"))])),
        ];
        let idx = UniqueIndex::build(&records, h, &mut eng).unwrap();
        assert!(idx.lookup("100").is_some());
        assert!(idx.lookup("anything-else").is_none());
    }

    #[test]
    fn unique_conflict_names_both_paths() {
        let mut eng = Engine::new().unwrap();
        let h = eng.compile("(r) => ( r.team )").unwrap();
        let err = UniqueIndex::build(&people(), h, &mut eng).unwrap_err();
        assert_eq!(err.code(), "index_unique_conflict");
        assert_eq!(err.conflicting_paths(), &["jane".to_string(), "bob".to_string()]);
    }
}
