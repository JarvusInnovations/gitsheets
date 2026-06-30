//! Record CRUD over the holo-tree substrate — the seam wiring git trees into
//! the core.
//!
//! This is the first core layer to touch git objects. It composes the
//! bytes-authority ([`canonical`](crate::canonical)) with holo-tree's mutable
//! in-memory trees: a **read** is `tree.read_blob` → [`canonical::parse`] → a
//! core [`Value`]; a **write** is [`canonical::serialize`] → `tree.write_child`;
//! **delete** is `tree.delete_child_deep`; **list** is `tree.get_blob_map` +
//! parse. A record-level **diff** between two trees replaces the JS
//! `git diff-tree` shell-out with a holo-tree blob-map comparison, and pairs
//! each change with an RFC 6902 patch via [`crate::diff`].
//!
//! ## Scope (the substrate seam, not the orchestration)
//!
//! These are batch-first **primitives** over an explicit record path + a TOML
//! record [`Value`]. The sheet-level concerns — path-template rendering of the
//! record→path mapping, the markdown/frontmatter format, query traversal +
//! filtering, secondary indexing, and the `Sheet`/`Transaction`/`Store` state
//! machine — are owned by later plans (`record-query-index`,
//! `sheet-store-core`). A record path here is relative to a `base` subtree and
//! carries no extension; callers append `.toml`. See
//! [`specs/rust-core.md`](../../../specs/rust-core.md).
//!
//! ## Thread-confinement
//!
//! holo-tree keeps a thread-local tree/object cache, so a [`gix::Repository`]
//! handle and the trees navigated through it stay on one thread — the same
//! discipline the embedded engine ([`crate::engine`]) already requires.

use holo_tree::{MutableTree, ObjectId};

use crate::canonical;
use crate::diff::{create_patch, PatchOp};
use crate::error::{Error, Result};
use crate::value::Value;

/// Git's canonical empty-tree hash — the conventional "src" of a from-scratch
/// diff, and a valid base for a write into an empty tree.
pub const EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// The default record file extension. Records are canonical TOML blobs.
pub const TOML_EXTENSION: &str = ".toml";

// ── error mapping ────────────────────────────────────────────────────────────

/// Map a `holo_tree::Error` onto the core's typed taxonomy. A record-blob TOML
/// failure is `config_invalid` (matching the host's `#readRecordFromBlob`, and
/// the canonical layer's own mapping — see this plan's inbound-deferral note); a
/// navigation miss is `record_not_found`; other substrate failures surface as
/// `commit_failed`, the closest substrate-op bucket in `errors.md`.
pub(crate) fn map_ht(e: holo_tree::Error) -> Error {
    match e {
        holo_tree::Error::Toml { path, message } => Error::ConfigInvalid {
            message: format!("TOML parse error in {path}: {message}"),
        },
        holo_tree::Error::PathNotFound { component } => Error::RecordNotFound {
            message: format!("path component '{component}' not found in tree"),
        },
        holo_tree::Error::NotATree(s) => Error::ConfigInvalid {
            message: format!("not a tree: {s}"),
        },
        other => Error::CommitFailed {
            message: format!("holo-tree substrate error: {other}"),
        },
    }
}

// ── substrate (holo-tree) read/write counters ────────────────────────────────

/// A snapshot of holo-tree's process-wide tree/blob counters — the read-side
/// instrumentation behind the bulk benchmark and the hologit#464 perf finding
/// (per-call `to_thread_local`, the tree object-cache, per-read blob clone).
/// `cache_hits`/`misses` count the thread-local parsed-tree cache; `blobs_read`
/// counts ODB blob fetches.
#[derive(Clone, Copy, Debug, Default)]
pub struct SubstrateStats {
    pub trees_read: u64,
    pub trees_written: u64,
    pub trees_skipped_clean: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub blobs_read: u64,
}

/// Snapshot the current substrate counters.
pub fn substrate_stats() -> SubstrateStats {
    let s = holo_tree::stats();
    SubstrateStats {
        trees_read: s.trees_read,
        trees_written: s.trees_written,
        trees_skipped_clean: s.trees_skipped_clean,
        cache_hits: s.cache_hits,
        cache_misses: s.cache_misses,
        blobs_read: s.blobs_read,
    }
}

/// Reset the substrate counters and the thread-local tree cache — call before a
/// timed benchmark phase for a clean read-amplification measurement.
pub fn substrate_reset() {
    holo_tree::reset();
}

// ── repo + tree handles ──────────────────────────────────────────────────────

/// Open a [`gix::Repository`] at a git directory. Failures (missing/corrupt
/// repo) surface as `config_invalid` — a setup problem, not a record one.
pub fn open_repo(git_dir: &str) -> Result<gix::Repository> {
    gix::open(git_dir).map_err(|e| Error::ConfigInvalid {
        message: format!("could not open git repo at {git_dir}: {e}"),
    })
}

/// Resolve a ref / rev-spec / tree-or-commit hash to a [`MutableTree`]. Accepts
/// the same inputs `Sheet.diffFrom` passes `git diff-tree`: a commit hash, a
/// ref name, a tag (peeled), or a bare tree hash — plus the empty-tree hash,
/// which loads an empty tree without an ODB lookup. A spec that doesn't resolve
/// is `ref_not_found`.
pub fn resolve_tree(repo: &gix::Repository, spec: &str) -> Result<MutableTree> {
    if spec == EMPTY_TREE_HASH {
        return Ok(MutableTree::empty());
    }
    let id = repo.rev_parse_single(spec).map_err(|e| Error::RefNotFound {
        message: format!("could not resolve '{spec}': {e}"),
    })?;
    let mut obj = id.object().map_err(|e| Error::RefNotFound {
        message: format!("could not load object for '{spec}': {e}"),
    })?;

    use gix::object::Kind;
    loop {
        match obj.kind {
            Kind::Tag => {
                let tag = obj.try_into_tag().map_err(|_| Error::RefNotFound {
                    message: format!("'{spec}' tag could not be parsed"),
                })?;
                let target = tag
                    .target_id()
                    .map_err(|e| Error::RefNotFound {
                        message: format!("tag '{spec}' has no target: {e}"),
                    })?
                    .detach();
                obj = repo.find_object(target).map_err(|e| Error::RefNotFound {
                    message: format!("tag target for '{spec}' not found: {e}"),
                })?;
            }
            Kind::Commit => {
                let commit = obj.try_into_commit().map_err(|_| Error::RefNotFound {
                    message: format!("'{spec}' commit could not be parsed"),
                })?;
                let tree_id = commit
                    .tree_id()
                    .map_err(|e| Error::RefNotFound {
                        message: format!("commit '{spec}' has no tree: {e}"),
                    })?
                    .detach();
                return Ok(MutableTree::new(tree_id));
            }
            Kind::Tree => return Ok(MutableTree::new(obj.id)),
            Kind::Blob => {
                return Err(Error::RefNotFound {
                    message: format!("'{spec}' resolves to a blob, not a tree"),
                })
            }
        }
    }
}

fn hex(id: ObjectId) -> String {
    id.to_string()
}

/// Read and parse a record blob by its object id — the shared primitive the
/// query walk and index build use after pruning/listing has handed them a set
/// of blob hashes (avoids re-navigating the tree per candidate). A blob that
/// isn't valid UTF-8 / canonical TOML is `config_invalid`, matching the host's
/// `#readRecordFromBlob`.
pub(crate) fn read_blob_value(repo: &gix::Repository, hash: ObjectId) -> Result<Value> {
    let bytes = repo
        .find_object(hash)
        .map_err(|e| Error::CommitFailed {
            message: format!("could not read blob {hash}: {e}"),
        })?
        .data
        .to_vec();
    let text = String::from_utf8(bytes).map_err(|e| Error::ConfigInvalid {
        message: format!("record blob {hash} is not valid UTF-8: {e}"),
    })?;
    canonical::parse(&text)
}

// ── join / path helpers ──────────────────────────────────────────────────────

/// Join a base subtree path with a record path + extension into the deep path
/// holo-tree navigates from the tree root. Empty/`.`/stray-slash segments drop.
fn full_path(base: &str, record_path: &str, extension: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in [base, record_path] {
        for p in seg.split('/') {
            let p = p.trim_matches('/');
            if !p.is_empty() && p != "." {
                parts.push(p);
            }
        }
    }
    let joined = parts.join("/");
    format!("{joined}{extension}")
}

pub(crate) fn base_arg(base: &str) -> String {
    let cleaned: Vec<&str> = base
        .split('/')
        .map(|p| p.trim_matches('/'))
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if cleaned.is_empty() {
        ".".to_string()
    } else {
        cleaned.join("/")
    }
}

// ── CRUD over an in-memory tree (the primitives) ─────────────────────────────

/// Read a batch of records by path (relative to `base`, no extension). Returns
/// `None` for a path with no blob; a present-but-unparseable blob is
/// `config_invalid`. The whole batch shares one tree traversal.
pub fn read_records(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    base: &str,
    paths: &[String],
    extension: &str,
) -> Result<Vec<Option<Value>>> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let full = full_path(base, path, extension);
        match tree.read_blob(repo, &full).map_err(map_ht)? {
            Some(bytes) => {
                let text = String::from_utf8(bytes).map_err(|e| Error::ConfigInvalid {
                    message: format!("record at {full} is not valid UTF-8: {e}"),
                })?;
                out.push(Some(canonical::parse(&text)?));
            }
            None => out.push(None),
        }
    }
    Ok(out)
}

/// Result of a write/delete batch: the new root tree hash plus per-record output.
#[derive(Clone, Debug)]
pub struct WriteOutcome {
    /// The root tree hash after the batch (and `write()`).
    pub tree_hash: String,
    /// The blob hash written for each input record, in order.
    pub blob_hashes: Vec<String>,
}

/// Write a batch of `(record_path, value)` pairs as canonical TOML blobs under
/// `base`, then flush. Each value is serialized through the bytes-authority
/// (deep key-sort + canonical form), so two bindings writing the same record
/// produce identical blobs. Returns the new root tree hash and each blob hash.
pub fn write_records(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    base: &str,
    items: &[(String, Value)],
    extension: &str,
) -> Result<WriteOutcome> {
    let mut blob_hashes = Vec::with_capacity(items.len());
    for (record_path, value) in items {
        let text = canonical::serialize(value)?;
        let full = full_path(base, record_path, extension);
        let blob_id = tree.write_child(repo, &full, &text).map_err(map_ht)?;
        blob_hashes.push(hex(blob_id));
    }
    let tree_hash = hex(tree.write(repo).map_err(map_ht)?);
    Ok(WriteOutcome {
        tree_hash,
        blob_hashes,
    })
}

/// Outcome of a delete batch: the new root tree hash and whether each path
/// existed (was actually removed).
#[derive(Clone, Debug)]
pub struct DeleteOutcome {
    pub tree_hash: String,
    pub existed: Vec<bool>,
}

/// Delete a batch of records by path (deep delete), then flush. A path that
/// didn't exist reports `false` (not an error — matching the permissive
/// substrate primitive; the `record_not_found` guard is a sheet-level concern).
pub fn delete_records(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    base: &str,
    paths: &[String],
    extension: &str,
) -> Result<DeleteOutcome> {
    let mut existed = Vec::with_capacity(paths.len());
    for path in paths {
        let full = full_path(base, path, extension);
        existed.push(tree.delete_child_deep(repo, &full).map_err(map_ht)?);
    }
    let tree_hash = hex(tree.write(repo).map_err(map_ht)?);
    Ok(DeleteOutcome { tree_hash, existed })
}

/// List every record under `base` as its raw on-disk **text**: enumerate the
/// subtree's blobs, keep those ending in `extension`, strip the extension, and
/// decode each as UTF-8. Paths are relative to `base` and returned in sorted
/// (git-canonical) order. The format-aware decode (canonical TOML vs the
/// markdown frontmatter codec, with/without body) is the caller's job — see
/// [`crate::codec`] and [`crate::sheet::Sheet`]. A non-UTF-8 blob is
/// `config_invalid`.
pub fn list_record_texts(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    base: &str,
    extension: &str,
) -> Result<Vec<(String, String)>> {
    let barg = base_arg(base);
    let subtree = match tree.get_subtree(repo, &barg).map_err(map_ht)? {
        Some(t) => t,
        None => return Ok(Vec::new()),
    };
    let blob_map = subtree.get_blob_map(repo).map_err(map_ht)?;
    let mut out = Vec::new();
    for (path, info) in blob_map {
        if !path.ends_with(extension) {
            continue;
        }
        let record_path = path[..path.len() - extension.len()].to_string();
        let bytes = repo
            .find_object(info.hash)
            .map_err(|e| Error::CommitFailed {
                message: format!("could not read blob {} : {e}", info.hash),
            })?
            .data
            .to_vec();
        let text = String::from_utf8(bytes).map_err(|e| Error::ConfigInvalid {
            message: format!("record at {path} is not valid UTF-8: {e}"),
        })?;
        out.push((record_path, text));
    }
    Ok(out)
}

/// List every record under `base`, parsing each as canonical TOML. Paths are
/// relative to `base` in sorted (git-canonical) order. An unparseable record
/// blob is `config_invalid`. (Markdown sheets list through [`crate::codec`] at
/// the `Sheet` layer; this primitive stays TOML-only for the thin record-CRUD
/// binding surface.)
pub fn list_records(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    base: &str,
    extension: &str,
) -> Result<Vec<(String, Value)>> {
    list_record_texts(repo, tree, base, extension)?
        .into_iter()
        .map(|(path, text)| Ok((path, canonical::parse(&text)?)))
        .collect()
}

// ── record-level diff (replacing git diff-tree) ──────────────────────────────

/// The status of one record between two trees. No `renamed`: this primitive does
/// not do similarity-based rename detection (`git diff-tree -M`); a moved record
/// surfaces as a `Deleted` + an `Added`. See the plan Notes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordStatus {
    Added,
    Modified,
    Deleted,
}

impl RecordStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RecordStatus::Added => "added",
            RecordStatus::Modified => "modified",
            RecordStatus::Deleted => "deleted",
        }
    }
}

/// One record-level change between two trees. `path` is relative to `base`,
/// without the extension; hashes are `None` on the side where the record is
/// absent.
#[derive(Clone, Debug)]
pub struct RecordChange {
    pub path: String,
    pub status: RecordStatus,
    pub src_hash: Option<String>,
    pub dst_hash: Option<String>,
}

fn record_blob_map(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    base: &str,
    extension: &str,
) -> Result<std::collections::BTreeMap<String, String>> {
    let barg = base_arg(base);
    let mut out = std::collections::BTreeMap::new();
    let subtree = match tree.get_subtree(repo, &barg).map_err(map_ht)? {
        Some(t) => t,
        None => return Ok(out),
    };
    for (path, info) in subtree.get_blob_map(repo).map_err(map_ht)? {
        if !path.ends_with(extension) {
            continue;
        }
        let record_path = path[..path.len() - extension.len()].to_string();
        out.insert(record_path, hex(info.hash));
    }
    Ok(out)
}

/// Diff records between two trees under `base`: added (only in dst), deleted
/// (only in src), modified (present in both, blob hash differs). Identical
/// blobs are skipped. Yielded in sorted path order (git-canonical), matching
/// `git diff-tree -r`'s ordering for the add/modify/delete cases.
pub fn diff_record_changes(
    repo: &gix::Repository,
    src_tree: &mut MutableTree,
    dst_tree: &mut MutableTree,
    base: &str,
    extension: &str,
) -> Result<Vec<RecordChange>> {
    let src_map = record_blob_map(repo, src_tree, base, extension)?;
    let dst_map = record_blob_map(repo, dst_tree, base, extension)?;

    let mut paths: std::collections::BTreeSet<&String> = std::collections::BTreeSet::new();
    paths.extend(src_map.keys());
    paths.extend(dst_map.keys());

    let mut out = Vec::new();
    for path in paths {
        let src = src_map.get(path);
        let dst = dst_map.get(path);
        let change = match (src, dst) {
            (Some(s), Some(d)) => {
                if s == d {
                    continue;
                }
                RecordChange {
                    path: path.clone(),
                    status: RecordStatus::Modified,
                    src_hash: Some(s.clone()),
                    dst_hash: Some(d.clone()),
                }
            }
            (None, Some(d)) => RecordChange {
                path: path.clone(),
                status: RecordStatus::Added,
                src_hash: None,
                dst_hash: Some(d.clone()),
            },
            (Some(s), None) => RecordChange {
                path: path.clone(),
                status: RecordStatus::Deleted,
                src_hash: Some(s.clone()),
                dst_hash: None,
            },
            (None, None) => unreachable!(),
        };
        out.push(change);
    }
    Ok(out)
}

/// A record change plus its RFC 6902 patch (and the parsed src/dst records). The
/// patch is `create_patch(src, dst)` with `None` for the absent side, so an
/// added record's patch is `replace "" <record>` and a deleted record's is
/// `replace "" null` — matching `Sheet.diffFrom` + `rfc6902`.
#[derive(Clone, Debug)]
pub struct RecordDiff {
    pub change: RecordChange,
    pub src: Option<Value>,
    pub dst: Option<Value>,
    pub patch: Vec<PatchOp>,
}

/// Diff records between two trees and pair each change with its parsed src/dst
/// records and RFC 6902 patch — the full `Sheet.diffFrom(opts: {records,
/// patches})` payload, computed in the core.
pub fn diff_records(
    repo: &gix::Repository,
    src_tree: &mut MutableTree,
    dst_tree: &mut MutableTree,
    base: &str,
    extension: &str,
) -> Result<Vec<RecordDiff>> {
    let changes = diff_record_changes(repo, src_tree, dst_tree, base, extension)?;
    let mut out = Vec::with_capacity(changes.len());
    for change in changes {
        let src = match &change.src_hash {
            Some(_) => read_one(repo, src_tree, base, &change.path, extension)?,
            None => None,
        };
        let dst = match &change.dst_hash {
            Some(_) => read_one(repo, dst_tree, base, &change.path, extension)?,
            None => None,
        };
        let patch = create_patch(src.as_ref(), dst.as_ref());
        out.push(RecordDiff {
            change,
            src,
            dst,
            patch,
        });
    }
    Ok(out)
}

fn read_one(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    base: &str,
    path: &str,
    extension: &str,
) -> Result<Option<Value>> {
    let full = full_path(base, path, extension);
    match tree.read_blob(repo, &full).map_err(map_ht)? {
        Some(bytes) => {
            let text = String::from_utf8(bytes).map_err(|e| Error::ConfigInvalid {
                message: format!("record at {full} is not valid UTF-8: {e}"),
            })?;
            Ok(Some(canonical::parse(&text)?))
        }
        None => Ok(None),
    }
}

// ── ref-string wrappers (the thin-binding surface) ───────────────────────────
//
// These open the repo + resolve a ref/hash to a tree and run a batch primitive,
// so a binding crosses the FFI once with strings + a `Vec<Value>` and never
// handles a `gix::Repository` or `MutableTree` itself. Each opens its own repo
// handle (cheap relative to the batch it drives), keeping the thread-confinement
// contract trivially satisfied: the handle and its trees never outlive the call.

/// Open the repo, resolve `tree_ref`, and read a batch of records. See
/// [`read_records`].
pub fn read_records_at_ref(
    git_dir: &str,
    tree_ref: &str,
    base: &str,
    paths: &[String],
    extension: &str,
) -> Result<Vec<Option<Value>>> {
    let repo = open_repo(git_dir)?;
    let mut tree = resolve_tree(&repo, tree_ref)?;
    read_records(&repo, &mut tree, base, paths, extension)
}

/// Open the repo, resolve `base_ref` to a starting tree, write a batch, and
/// flush — returning the new root tree hash + blob hashes. See [`write_records`].
pub fn write_records_at_ref(
    git_dir: &str,
    base_ref: &str,
    base: &str,
    items: &[(String, Value)],
    extension: &str,
) -> Result<WriteOutcome> {
    let repo = open_repo(git_dir)?;
    let mut tree = resolve_tree(&repo, base_ref)?;
    write_records(&repo, &mut tree, base, items, extension)
}

/// Open the repo, resolve `base_ref`, delete a batch, and flush. See
/// [`delete_records`].
pub fn delete_records_at_ref(
    git_dir: &str,
    base_ref: &str,
    base: &str,
    paths: &[String],
    extension: &str,
) -> Result<DeleteOutcome> {
    let repo = open_repo(git_dir)?;
    let mut tree = resolve_tree(&repo, base_ref)?;
    delete_records(&repo, &mut tree, base, paths, extension)
}

/// Open the repo, resolve `tree_ref`, and list every record under `base`. See
/// [`list_records`].
pub fn list_records_at_ref(
    git_dir: &str,
    tree_ref: &str,
    base: &str,
    extension: &str,
) -> Result<Vec<(String, Value)>> {
    let repo = open_repo(git_dir)?;
    let mut tree = resolve_tree(&repo, tree_ref)?;
    list_records(&repo, &mut tree, base, extension)
}

/// Open the repo, resolve both refs, and diff records (with parsed src/dst +
/// RFC 6902 patches). See [`diff_records`].
pub fn diff_records_at_refs(
    git_dir: &str,
    src_ref: &str,
    dst_ref: &str,
    base: &str,
    extension: &str,
) -> Result<Vec<RecordDiff>> {
    let repo = open_repo(git_dir)?;
    let mut src = resolve_tree(&repo, src_ref)?;
    let mut dst = resolve_tree(&repo, dst_ref)?;
    diff_records(&repo, &mut src, &mut dst, base, extension)
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

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

    /// A throwaway git repo (init bare-ish working dir) for integration tests.
    fn temp_repo() -> (tempfile::TempDir, gix::Repository) {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = gix::init(dir.path()).expect("git init");
        (dir, repo)
    }

    /// Git blob hash of canonical bytes, computed independently of holo-tree:
    /// sha1("blob <len>\0<bytes>"). Proves holo-tree wrote the *expected* object.
    fn git_blob_hash(bytes: &[u8]) -> String {
        let header = format!("blob {}\0", bytes.len());
        let mut hasher = gix::hash::hasher(gix::hash::Kind::Sha1);
        hasher.update(header.as_bytes());
        hasher.update(bytes);
        hasher.try_finalize().unwrap().to_string()
    }

    #[test]
    fn write_then_read_round_trips_byte_identically() {
        let (_dir, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let record = rec(&[("email", s("jane@x.org")), ("slug", s("jane"))]);
        let out = write_records(&repo, &mut tree, "people", &[("jane".into(), record.clone())], TOML_EXTENSION)
            .expect("write");

        // The blob hash holo-tree produced is the git blob hash of the canonical
        // bytes — the substrate is wired and writing the expected object.
        let canonical_bytes = canonical::serialize(&record).unwrap();
        assert_eq!(out.blob_hashes[0], git_blob_hash(canonical_bytes.as_bytes()));

        // Read back from the same tree: identical value.
        let read = read_records(&repo, &mut tree, "people", &["jane".into()], TOML_EXTENSION).unwrap();
        assert_eq!(read[0].as_ref().unwrap(), &record);

        // And from the persisted tree hash, via a fresh tree handle.
        let mut reloaded = resolve_tree(&repo, &out.tree_hash).unwrap();
        let read2 = read_records(&repo, &mut reloaded, "people", &["jane".into()], TOML_EXTENSION).unwrap();
        assert_eq!(read2[0].as_ref().unwrap(), &record);
    }

    #[test]
    fn read_missing_record_is_none() {
        let (_dir, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let read = read_records(&repo, &mut tree, "people", &["nobody".into()], TOML_EXTENSION).unwrap();
        assert!(read[0].is_none());
    }

    #[test]
    fn list_records_returns_all_under_base_sorted() {
        let (_dir, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        write_records(
            &repo,
            &mut tree,
            "people",
            &[
                ("zoe".into(), rec(&[("slug", s("zoe"))])),
                ("amy".into(), rec(&[("slug", s("amy"))])),
            ],
            TOML_EXTENSION,
        )
        .unwrap();
        let listed = list_records(&repo, &mut tree, "people", TOML_EXTENSION).unwrap();
        let paths: Vec<&str> = listed.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["amy", "zoe"]);
        assert_eq!(listed[0].1, rec(&[("slug", s("amy"))]));
    }

    #[test]
    fn delete_removes_record_and_reports_existed() {
        let (_dir, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        write_records(&repo, &mut tree, "people", &[("jane".into(), rec(&[("slug", s("jane"))]))], TOML_EXTENSION)
            .unwrap();
        let del = delete_records(&repo, &mut tree, "people", &["jane".into(), "ghost".into()], TOML_EXTENSION)
            .unwrap();
        assert_eq!(del.existed, vec![true, false]);
        let read = read_records(&repo, &mut tree, "people", &["jane".into()], TOML_EXTENSION).unwrap();
        assert!(read[0].is_none());
    }

    #[test]
    fn diff_classifies_added_modified_deleted_with_patches() {
        let (_dir, repo) = temp_repo();

        // src tree: jane + bob
        let mut src = MutableTree::empty();
        write_records(
            &repo,
            &mut src,
            "people",
            &[
                ("jane".into(), rec(&[("email", s("old")), ("slug", s("jane"))])),
                ("bob".into(), rec(&[("slug", s("bob"))])),
            ],
            TOML_EXTENSION,
        )
        .unwrap();
        let src_hash = src.write(&repo).unwrap().to_string();

        // dst tree: jane (modified) + amy (added); bob deleted
        let mut dst = resolve_tree(&repo, &src_hash).unwrap();
        write_records(
            &repo,
            &mut dst,
            "people",
            &[("jane".into(), rec(&[("email", s("new")), ("slug", s("jane"))]))],
            TOML_EXTENSION,
        )
        .unwrap();
        write_records(&repo, &mut dst, "people", &[("amy".into(), rec(&[("slug", s("amy"))]))], TOML_EXTENSION)
            .unwrap();
        delete_records(&repo, &mut dst, "people", &["bob".into()], TOML_EXTENSION).unwrap();
        let dst_hash = dst.write(&repo).unwrap().to_string();

        let mut src2 = resolve_tree(&repo, &src_hash).unwrap();
        let mut dst2 = resolve_tree(&repo, &dst_hash).unwrap();
        let diffs = diff_records(&repo, &mut src2, &mut dst2, "people", TOML_EXTENSION).unwrap();

        let by_path: std::collections::HashMap<&str, &RecordDiff> =
            diffs.iter().map(|d| (d.change.path.as_str(), d)).collect();

        assert_eq!(by_path["amy"].change.status, RecordStatus::Added);
        assert_eq!(by_path["bob"].change.status, RecordStatus::Deleted);
        assert_eq!(by_path["jane"].change.status, RecordStatus::Modified);

        // jane's patch is a single field replace.
        let jane = by_path["jane"];
        assert_eq!(jane.patch.len(), 1);
        assert_eq!(jane.patch[0].path, "/email");

        // amy added -> replace "" <record>; bob deleted -> replace "" null.
        assert_eq!(by_path["amy"].patch.len(), 1);
        assert_eq!(by_path["amy"].patch[0].path, "");
        assert_eq!(by_path["bob"].patch.len(), 1);
        assert!(matches!(by_path["bob"].patch[0].value, crate::diff::PatchValue::Null));
    }

    #[test]
    fn diff_against_empty_tree_is_all_added() {
        let (_dir, repo) = temp_repo();
        let mut dst = MutableTree::empty();
        write_records(&repo, &mut dst, "people", &[("jane".into(), rec(&[("slug", s("jane"))]))], TOML_EXTENSION)
            .unwrap();
        let dst_hash = dst.write(&repo).unwrap().to_string();

        let mut empty = resolve_tree(&repo, EMPTY_TREE_HASH).unwrap();
        let mut dst2 = resolve_tree(&repo, &dst_hash).unwrap();
        let diffs = diff_records(&repo, &mut empty, &mut dst2, "people", TOML_EXTENSION).unwrap();
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].change.status, RecordStatus::Added);
    }
}
