//! The `Transaction` half of the orchestration state machine.
//!
//! A [`Transaction`] is the unit of atomicity: mutations stage into a private
//! in-memory tree built from a parent ref; on success the tree commits and the
//! configured branch advances; on discard nothing moves. A behavior-preserving
//! Rust port of `packages/gitsheets/src/transaction.ts` +
//! `Repository.transact`/`#resolveParent`, per
//! [`specs/api/transaction.md`](../../../specs/api/transaction.md) and
//! [`specs/behaviors/transactions.md`](../../../specs/behaviors/transactions.md).
//!
//! The lifecycle pieces this owns:
//!
//! - **parent resolution** — branch vs. commit-hash vs. default-HEAD, and the
//!   branch-to-advance.
//! - **optimistic concurrency** — re-resolve the parent ref at commit; a move is
//!   [`Error::ParentMoved`]. The CAS `update_ref` is the actual race guard.
//! - **no-op detection** — skip the commit when the resulting tree hash equals
//!   the parent commit's tree hash (and on a fresh repo, an initial commit IS
//!   produced).
//! - **commit + ref update** — holo-tree's `commit_tree` + CAS `update_ref` with
//!   explicit author/committer identity.
//!
//! ## Single-writer model
//!
//! One open transaction per git directory at a time, guarded by a process-wide
//! registry that detects an overlapping open as [`Error::TransactionInProgress`].
//! The *async queueing* of contended transactions (Node's `AsyncLocalStorage`
//! mutex, Python's `asyncio` lock) is inherently host-runtime-specific and stays
//! in the binding; the core owns the detectable correctness guard (this registry
//! plus the optimistic `parent_moved` CAS).

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use holo_tree::{repo as holo_repo, MutableTree, ObjectId};

use crate::error::{Error, Result};
use crate::record;

/// Commit identity (author / committer).
#[derive(Clone, Debug)]
pub struct Author {
    pub name: String,
    pub email: String,
}

/// Options for opening a transaction. `time_seconds` / `offset_minutes` carry
/// the host's wall-clock + local-timezone offset for the commit signature (a
/// host concern, exactly as the JS `commitTreeWithRepo` computes them).
#[derive(Clone, Debug)]
pub struct TransactionOptions {
    pub parent: Option<String>,
    pub branch: Option<String>,
    pub author: Option<Author>,
    pub committer: Option<Author>,
    pub message: String,
    pub trailers: Vec<(String, String)>,
    pub time_seconds: i64,
    pub offset_minutes: i32,
}

/// The outcome of [`Transaction::finalize`]. A no-op (no mutation, or resulting
/// tree equals the parent's) returns `commit_hash = None` — the consumer's
/// no-op signal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransactionResult {
    pub commit_hash: Option<String>,
    pub tree_hash: Option<String>,
    pub ref_name: Option<String>,
    pub parent_commit_hash: Option<String>,
}

// ── process-wide open-transaction registry ────────────────────────────────────

fn registry() -> &'static Mutex<HashSet<String>> {
    static REGISTRY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashSet::new()))
}

fn registry_key(git_dir: &str) -> String {
    std::fs::canonicalize(git_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| git_dir.to_string())
}

/// A live transaction: owns its repo handle + private root tree, the resolved
/// parent/branch, identity, and message. `!Send` (holds a `gix::Repository` and
/// holo-tree's thread-local-cached tree) — constructed and used on one thread.
pub struct Transaction {
    repo: gix::Repository,
    root: MutableTree,
    registry_key: String,
    parent_commit_hash: Option<ObjectId>,
    parent_ref: Option<String>,
    branch_ref: Option<String>,
    author: Author,
    committer: Author,
    message: String,
    trailers: Vec<(String, String)>,
    time_seconds: i64,
    offset_minutes: i32,
    any_mutation: bool,
    closed: bool,
}

impl Transaction {
    /// Open a transaction against the git directory `git_dir`. Resolves the
    /// parent ref + branch-to-advance, captures `parentCommitHash`, builds the
    /// private root tree, and acquires the single-writer slot for this repo.
    pub fn begin(git_dir: &str, opts: TransactionOptions) -> Result<Self> {
        validate_trailers(&opts.trailers)?;

        let repo = record::open_repo(git_dir)?;
        let key = registry_key(git_dir);
        {
            let mut set = registry().lock().expect("registry poisoned");
            if set.contains(&key) {
                return Err(Error::TransactionInProgress {
                    message: format!(
                        "a transaction is already open for {git_dir} — finalize it first"
                    ),
                });
            }
            set.insert(key.clone());
        }

        // From here on, any early return must release the slot.
        let result = (|| {
            let (parent_ref, parent_commit_hash, branch_ref) =
                resolve_parent(&repo, opts.parent.as_deref(), opts.branch.as_deref())?;

            let author = resolve_author(&repo, opts.author);
            let committer = opts.committer.unwrap_or_else(|| author.clone());

            let root = match &parent_commit_hash {
                Some(hash) => holo_repo::create_tree_from_ref(&repo, &hash.to_string())
                    .map_err(record::map_ht)?,
                None => MutableTree::empty(),
            };

            Ok(Transaction {
                repo,
                root,
                registry_key: key.clone(),
                parent_commit_hash,
                parent_ref,
                branch_ref,
                author,
                committer,
                message: opts.message,
                trailers: opts.trailers,
                time_seconds: opts.time_seconds,
                offset_minutes: opts.offset_minutes,
                any_mutation: false,
                closed: false,
            })
        })();

        if result.is_err() {
            registry().lock().expect("registry poisoned").remove(&key);
        }
        result
    }

    /// Borrow the repo handle + root tree together (disjoint) so a `Sheet` can
    /// run a mutation against this transaction's private tree.
    pub fn split(&mut self) -> (&gix::Repository, &mut MutableTree) {
        (&self.repo, &mut self.root)
    }

    pub fn repo(&self) -> &gix::Repository {
        &self.repo
    }

    pub fn parent_commit_hash(&self) -> Option<String> {
        self.parent_commit_hash.map(|h| h.to_string())
    }

    /// Mark that a mutating method ran in this transaction. The authoritative
    /// no-op check is still tree-hash equality at finalize; this flag is the
    /// cheap short-circuit (matches `tx.markMutated`).
    pub fn mark_mutated(&mut self) {
        self.any_mutation = true;
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Finalize: commit-on-success-only with no-op detection + the optimistic
    /// `parent_moved` re-check + CAS ref movement. Consumes the transaction.
    pub fn finalize(mut self) -> Result<TransactionResult> {
        self.closed = true;
        let parent_str = self.parent_commit_hash.map(|h| h.to_string());

        let no_change = TransactionResult {
            commit_hash: None,
            tree_hash: None,
            ref_name: None,
            parent_commit_hash: parent_str.clone(),
        };

        if !self.any_mutation {
            self.release();
            return Ok(no_change);
        }

        // Optimistic concurrency: re-check the parent ref hasn't moved.
        if let Some(parent_ref) = &self.parent_ref {
            let current = holo_repo::resolve_ref(&self.repo, parent_ref).map_err(record::map_ht)?;
            if current != self.parent_commit_hash {
                self.release();
                return Err(Error::ParentMoved {
                    message: format!(
                        "parent ref {parent_ref} moved during transaction (expected {}, found {})",
                        opt_hash(&self.parent_commit_hash),
                        opt_hash(&current),
                    ),
                });
            }
        }

        let tree_hash = match self.root.write(&self.repo) {
            Ok(h) => h,
            Err(e) => {
                self.release();
                return Err(record::map_ht(e));
            }
        };

        // No-op detection: resulting tree equals the parent commit's tree.
        if let Some(parent) = self.parent_commit_hash {
            let mut parent_tree =
                match holo_repo::create_tree_from_ref(&self.repo, &parent.to_string()) {
                    Ok(t) => t,
                    Err(e) => {
                        self.release();
                        return Err(record::map_ht(e));
                    }
                };
            let parent_tree_hash = match parent_tree.write(&self.repo) {
                Ok(h) => h,
                Err(e) => {
                    self.release();
                    return Err(record::map_ht(e));
                }
            };
            if parent_tree_hash == tree_hash {
                self.release();
                return Ok(no_change);
            }
        }

        let full_message = format_commit_message(&self.message, &self.trailers);
        let author_sig = match build_signature(&self.author, self.time_seconds, self.offset_minutes) {
            Ok(s) => s,
            Err(e) => {
                self.release();
                return Err(e);
            }
        };
        let committer_sig =
            match build_signature(&self.committer, self.time_seconds, self.offset_minutes) {
                Ok(s) => s,
                Err(e) => {
                    self.release();
                    return Err(e);
                }
            };

        let parents: Vec<ObjectId> = self.parent_commit_hash.into_iter().collect();
        let commit_id = match holo_repo::commit_tree(
            &self.repo,
            tree_hash,
            &parents,
            &full_message,
            Some(author_sig),
            Some(committer_sig),
        ) {
            Ok(id) => id,
            Err(e) => {
                self.release();
                return Err(Error::CommitFailed {
                    message: format!("holo-tree commit_tree failed: {e}"),
                });
            }
        };

        if let Some(branch) = &self.branch_ref {
            if let Err(e) =
                holo_repo::update_ref(&self.repo, branch, commit_id, self.parent_commit_hash)
            {
                self.release();
                return Err(Error::CommitFailed {
                    message: format!("holo-tree update_ref {branch} failed: {e}"),
                });
            }
        }

        let ref_name = self.branch_ref.clone();
        self.release();
        Ok(TransactionResult {
            commit_hash: Some(commit_id.to_string()),
            tree_hash: Some(tree_hash.to_string()),
            ref_name,
            parent_commit_hash: parent_str,
        })
    }

    /// Discard the transaction without committing (handler threw). Releases the
    /// single-writer slot.
    pub fn discard(mut self) {
        self.closed = true;
        self.release();
    }

    fn release(&self) {
        registry()
            .lock()
            .expect("registry poisoned")
            .remove(&self.registry_key);
    }
}

impl Drop for Transaction {
    fn drop(&mut self) {
        // Safety net: a leaked/panicked transaction frees its slot.
        if !self.registry_key.is_empty() {
            if let Ok(mut set) = registry().lock() {
                set.remove(&self.registry_key);
            }
        }
    }
}

fn opt_hash(h: &Option<ObjectId>) -> String {
    h.map(|h| h.to_string()).unwrap_or_else(|| "null".into())
}

// ── parent resolution (port of Repository.#resolveParent) ─────────────────────

fn resolve_parent(
    repo: &gix::Repository,
    parent: Option<&str>,
    branch: Option<&str>,
) -> Result<(Option<String>, Option<ObjectId>, Option<String>)> {
    match parent {
        None => {
            if let Some(head_ref) = head_branch_ref(repo) {
                let commit = holo_repo::resolve_ref(repo, &head_ref).map_err(record::map_ht)?;
                let branch_ref = branch.map(qualify_ref).unwrap_or_else(|| head_ref.clone());
                Ok((Some(head_ref), commit, Some(branch_ref)))
            } else {
                // Detached HEAD or fresh repo.
                let head_hash = holo_repo::resolve_ref(repo, "HEAD").map_err(record::map_ht)?;
                Ok((None, head_hash, branch.map(qualify_ref)))
            }
        }
        Some(p) => {
            if is_likely_branch(p) {
                let ref_name = qualify_ref(p);
                let commit = holo_repo::resolve_ref(repo, &ref_name).map_err(record::map_ht)?;
                let Some(commit) = commit else {
                    return Err(Error::RefNotFound {
                        message: format!("ref not found: {p}"),
                    });
                };
                let branch_ref = branch.map(qualify_ref).unwrap_or_else(|| ref_name.clone());
                Ok((Some(ref_name), Some(commit), Some(branch_ref)))
            } else {
                let resolved = holo_repo::resolve_ref(repo, p).map_err(record::map_ht)?;
                let Some(resolved) = resolved else {
                    return Err(Error::RefNotFound {
                        message: format!("cannot resolve commit: {p}"),
                    });
                };
                Ok((None, Some(resolved), branch.map(qualify_ref)))
            }
        }
    }
}

/// The symbolic-ref name HEAD points at (e.g. `refs/heads/main`), even when the
/// branch is unborn. `None` when HEAD is detached.
fn head_branch_ref(repo: &gix::Repository) -> Option<String> {
    let head = repo.head().ok()?;
    head.referent_name().map(|n| n.as_bstr().to_string())
}

fn is_likely_branch(p: &str) -> bool {
    let ref_like = !p.is_empty()
        && p.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'));
    let hash_like = (4..=40).contains(&p.len()) && p.chars().all(|c| c.is_ascii_hexdigit());
    ref_like && !hash_like
}

fn qualify_ref(name: &str) -> String {
    if name.starts_with("refs/") {
        name.to_string()
    } else {
        format!("refs/heads/{name}")
    }
}

fn resolve_author(repo: &gix::Repository, explicit: Option<Author>) -> Author {
    if let Some(a) = explicit {
        return a;
    }
    if let Some(Ok(sig)) = repo.author() {
        let name = sig.name.to_string();
        let email = sig.email.to_string();
        if !name.is_empty() && !email.is_empty() {
            return Author { name, email };
        }
    }
    Author {
        name: "Anonymous".into(),
        email: "anonymous@gitsheets.local".into(),
    }
}

// ── commit message + trailers (port of transaction.ts) ────────────────────────

const TRAILER_KEY_ERR: &str =
    "does not match HTTP-header style (e.g., \"Subject-Id\", \"Action\")";

fn validate_trailers(trailers: &[(String, String)]) -> Result<()> {
    for (key, value) in trailers {
        if !is_http_header_key(key) {
            return Err(Error::CommitFailed {
                message: format!("trailer key {key:?} {TRAILER_KEY_ERR}"),
            });
        }
        if value.contains('\r') || value.contains('\n') {
            return Err(Error::CommitFailed {
                message: format!(
                    "trailer {key:?} has invalid value (must be string with no newlines): {value:?}"
                ),
            });
        }
    }
    Ok(())
}

/// HTTP-header style: hyphen-separated segments, each `[A-Z][a-z0-9]*`. Matches
/// the `HTTP_HEADER_KEY_RE` in `transaction.ts`.
fn is_http_header_key(key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    key.split('-').all(|seg| {
        let mut chars = seg.chars();
        match chars.next() {
            Some(c) if c.is_ascii_uppercase() => {}
            _ => return false,
        }
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
}

/// Format the commit message: subject/body (trimmed trailing whitespace) plus
/// trailers appended after a blank line. Matches `formatCommitMessage`.
pub fn format_commit_message(message: &str, trailers: &[(String, String)]) -> String {
    let body = message.trim_end();
    if trailers.is_empty() {
        return format!("{body}\n");
    }
    let lines: Vec<String> = trailers
        .iter()
        .map(|(k, v)| format!("{k}: {v}"))
        .collect();
    format!("{body}\n\n{}\n", lines.join("\n"))
}

fn build_signature(
    author: &Author,
    seconds: i64,
    offset_minutes: i32,
) -> Result<gix::actor::Signature> {
    let (sign, abs) = if offset_minutes < 0 {
        ('-', -offset_minutes)
    } else {
        ('+', offset_minutes)
    };
    let hh = abs / 60;
    let mm = abs % 60;
    let time = format!("{seconds} {sign}{hh:02}{mm:02}");
    gix::actor::SignatureRef {
        name: author.name.as_str().into(),
        email: author.email.as_str().into(),
        time: time.as_str(),
    }
    .to_owned()
    .map_err(|e| Error::CommitFailed {
        message: format!("invalid commit signature: {e}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{self, write_records, TOML_EXTENSION};
    use crate::sheet::Sheet;
    use crate::value::Value;
    use indexmap::IndexMap;

    fn config_value(path: &str, root: &str) -> Value {
        let mut gs = IndexMap::new();
        gs.insert("path".to_string(), Value::String(path.to_string()));
        gs.insert("root".to_string(), Value::String(root.to_string()));
        let mut top = IndexMap::new();
        top.insert("gitsheet".to_string(), Value::Table(gs));
        Value::Table(top)
    }

    fn record_value(pairs: &[(&str, &str)]) -> Value {
        let mut m = IndexMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), Value::String((*v).to_string()));
        }
        Value::Table(m)
    }

    /// A throwaway repo with a committed `.gitsheets/people.toml` (`path =
    /// ${ slug }`, root = `people`) on `refs/heads/main`, HEAD symbolic to it.
    /// Returns the tempdir, the git-dir path, and the initial commit hash.
    fn setup(config: Value) -> (tempfile::TempDir, String, ObjectId) {
        let dir = tempfile::tempdir().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        let git_dir = dir.path().join(".git").to_string_lossy().into_owned();

        let mut tree = MutableTree::empty();
        write_records(
            &repo,
            &mut tree,
            ".gitsheets",
            &[("people".into(), config)],
            TOML_EXTENSION,
        )
        .unwrap();
        let tree_hash = tree.write(&repo).unwrap();
        let sig = build_signature(
            &Author {
                name: "Seed".into(),
                email: "seed@x.org".into(),
            },
            1_600_000_000,
            0,
        )
        .unwrap();
        let commit =
            holo_repo::commit_tree(&repo, tree_hash, &[], "init\n", Some(sig.clone()), Some(sig))
                .unwrap();
        holo_repo::update_ref(&repo, "refs/heads/main", commit, None).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        (dir, git_dir, commit)
    }

    fn default_opts(message: &str) -> TransactionOptions {
        TransactionOptions {
            parent: None,
            branch: None,
            author: Some(Author {
                name: "Jane Doe".into(),
                email: "jane@x.org".into(),
            }),
            committer: None,
            message: message.to_string(),
            trailers: vec![],
            time_seconds: 1_700_000_000,
            offset_minutes: -300,
        }
    }

    /// `Transaction::begin` expecting an error (the Ok type isn't `Debug`).
    fn begin_err(git_dir: &str, opts: TransactionOptions) -> Error {
        match Transaction::begin(git_dir, opts) {
            Err(e) => e,
            Ok(tx) => {
                tx.discard();
                panic!("expected Transaction::begin to fail")
            }
        }
    }

    /// Drive a single staged upsert through a transaction → finalize.
    fn upsert_one(git_dir: &str, opts: TransactionOptions, rec: Value) -> TransactionResult {
        let mut tx = Transaction::begin(git_dir, opts).unwrap();
        {
            let (repo, tree) = tx.split();
            let mut sheet =
                Sheet::open(repo, tree, "people", ".gitsheets/people.toml", ".", "").unwrap();
            let candidate = sheet.prepare_upsert(repo, tree, &rec, None, false).unwrap();
            sheet.stage_upsert(repo, tree, &candidate).unwrap();
        }
        tx.mark_mutated();
        tx.finalize().unwrap()
    }

    #[test]
    fn record_and_attachment_land_in_one_commit_atomically() {
        let (dir, git_dir, parent) = setup(config_value("${{ slug }}", "people"));

        // One transaction: upsert the record AND stage an attachment for it.
        let mut tx = Transaction::begin(&git_dir, default_opts("add jane + avatar")).unwrap();
        let attach_hash;
        {
            let (repo, tree) = tx.split();
            let mut sheet =
                Sheet::open(repo, tree, "people", ".gitsheets/people.toml", ".", "").unwrap();
            let rec = record_value(&[("slug", "jane")]);
            let candidate = sheet.prepare_upsert(repo, tree, &rec, None, false).unwrap();
            sheet.stage_upsert(repo, tree, &candidate).unwrap();
            // Blob-write primitive → set_attachments (place-by-hash into the SAME
            // live tree the record staged into).
            attach_hash = record::write_blob(repo, b"AVATAR").unwrap();
            sheet
                .set_attachments(repo, tree, "jane", &[("avatar.jpg".into(), attach_hash.clone())])
                .unwrap();
        }
        tx.mark_mutated();
        let result = tx.finalize().unwrap();

        let commit_hash = result.commit_hash.expect("one commit produced");

        // The new commit is a single child of the parent (one commit, not two).
        let repo = record::open_repo(&git_dir).unwrap();
        let obj = repo.rev_parse_single(commit_hash.as_str()).unwrap().object().unwrap();
        let commit = obj.try_into_commit().unwrap();
        let parents: Vec<_> = commit.parent_ids().collect();
        assert_eq!(parents.len(), 1);
        assert_eq!(parents[0].to_string(), parent.to_string());

        // That ONE commit's tree contains BOTH the record and the attachment.
        let mut committed = record::resolve_tree(&repo, &commit_hash).unwrap();
        let record_blob = committed.read_blob(&repo, "people/jane.toml").unwrap();
        assert!(record_blob.is_some(), "record file is in the commit");
        let attach_child = committed.get_child(&repo, "people/jane/avatar.jpg").unwrap();
        match attach_child {
            Some(holo_tree::Child::Blob { hash, .. }) => {
                assert_eq!(hash.to_string(), attach_hash, "attachment blob is the written one");
            }
            _ => panic!("attachment blob missing from the committed tree"),
        }
        drop(dir);
    }

    #[test]
    fn full_upsert_commits_with_identity_trailers_and_record() {
        let (dir, git_dir, parent) = setup(config_value("${{ slug }}", "people"));
        let mut opts = default_opts("people: add jane");
        opts.trailers = vec![("Action".into(), "person.create".into())];
        let result = upsert_one(
            &git_dir,
            opts,
            record_value(&[("slug", "jane"), ("email", "jane@x.org")]),
        );

        let commit_hash = result.commit_hash.expect("a commit was produced");
        assert_eq!(result.ref_name.as_deref(), Some("refs/heads/main"));
        assert_eq!(result.parent_commit_hash.as_deref(), Some(parent.to_string().as_str()));

        // The branch advanced to the new commit.
        let repo = record::open_repo(&git_dir).unwrap();
        let head = holo_repo::resolve_ref(&repo, "refs/heads/main").unwrap().unwrap();
        assert_eq!(head.to_string(), commit_hash);

        // Author/committer identity + message + trailer survived.
        let obj = repo.rev_parse_single("HEAD").unwrap().object().unwrap();
        let commit = obj.try_into_commit().unwrap();
        let author = commit.author().unwrap();
        assert_eq!(author.name.to_string(), "Jane Doe");
        assert_eq!(author.email.to_string(), "jane@x.org");
        let committer = commit.committer().unwrap();
        assert_eq!(committer.name.to_string(), "Jane Doe"); // committer falls back to author
        let message = commit.message_raw().unwrap().to_string();
        assert!(message.contains("people: add jane"));
        assert!(message.contains("Action: person.create"));

        // The record landed at people/jane.toml with canonical bytes.
        let read = record::read_records_at_ref(
            &git_dir,
            &commit_hash,
            "people",
            &["jane".into()],
            TOML_EXTENSION,
        )
        .unwrap();
        assert_eq!(
            read[0].as_ref().unwrap(),
            &record_value(&[("email", "jane@x.org"), ("slug", "jane")])
        );
        drop(dir);
    }

    #[test]
    fn reupsert_of_byte_identical_record_is_a_noop() {
        let (_dir, git_dir, _parent) = setup(config_value("${{ slug }}", "people"));
        let rec = record_value(&[("slug", "jane"), ("email", "jane@x.org")]);
        let first = upsert_one(&git_dir, default_opts("add jane"), rec.clone());
        assert!(first.commit_hash.is_some());

        // Re-upsert the exact same record: the resulting tree equals the parent's
        // → no commit (tree-hash equality no-op).
        let second = upsert_one(&git_dir, default_opts("re-add jane"), rec);
        assert_eq!(second.commit_hash, None);
        assert_eq!(second.tree_hash, None);
        assert_eq!(second.ref_name, None);
    }

    #[test]
    fn no_mutation_short_circuits_to_noop() {
        let (_dir, git_dir, _parent) = setup(config_value("${{ slug }}", "people"));
        let tx = Transaction::begin(&git_dir, default_opts("nothing")).unwrap();
        // Never mark mutated → no commit.
        let result = tx.finalize().unwrap();
        assert_eq!(result.commit_hash, None);
    }

    #[test]
    fn parent_moved_when_branch_advances_mid_transaction() {
        let (_dir, git_dir, parent) = setup(config_value("${{ slug }}", "people"));
        let mut tx = Transaction::begin(&git_dir, default_opts("add jane")).unwrap();
        {
            let (repo, tree) = tx.split();
            let mut sheet =
                Sheet::open(repo, tree, "people", ".gitsheets/people.toml", ".", "").unwrap();
            let rec = record_value(&[("slug", "jane")]);
            let candidate = sheet.prepare_upsert(repo, tree, &rec, None, false).unwrap();
            sheet.stage_upsert(repo, tree, &candidate).unwrap();
        }
        tx.mark_mutated();

        // Externally advance refs/heads/main (a separate process committed).
        let repo2 = record::open_repo(&git_dir).unwrap();
        let mut t = holo_repo::create_tree_from_ref(&repo2, &parent.to_string()).unwrap();
        write_records(
            &repo2,
            &mut t,
            "people",
            &[("intruder".into(), record_value(&[("slug", "intruder")]))],
            TOML_EXTENSION,
        )
        .unwrap();
        let th = t.write(&repo2).unwrap();
        let sig = build_signature(
            &Author {
                name: "Other".into(),
                email: "o@x.org".into(),
            },
            1_700_000_001,
            0,
        )
        .unwrap();
        let c1 = holo_repo::commit_tree(&repo2, th, &[parent], "external\n", Some(sig.clone()), Some(sig))
            .unwrap();
        holo_repo::update_ref(&repo2, "refs/heads/main", c1, Some(parent)).unwrap();

        let err = tx.finalize().unwrap_err();
        assert_eq!(err.code(), "parent_moved");
    }

    #[test]
    fn concurrent_open_on_same_repo_is_transaction_in_progress() {
        let (_dir, git_dir, _parent) = setup(config_value("${{ slug }}", "people"));
        let tx1 = Transaction::begin(&git_dir, default_opts("first")).unwrap();
        let err = begin_err(&git_dir, default_opts("second"));
        assert_eq!(err.code(), "transaction_in_progress");
        // Releasing the first frees the slot.
        tx1.discard();
        let tx2 = Transaction::begin(&git_dir, default_opts("third")).unwrap();
        tx2.discard();
    }

    #[test]
    fn validation_rejection_prevents_any_write() {
        // Schema requires email to match a pattern.
        let mut gs = IndexMap::new();
        gs.insert("path".to_string(), Value::String("${ slug }".to_string()));
        gs.insert("root".to_string(), Value::String("people".to_string()));
        let mut schema = IndexMap::new();
        schema.insert("type".to_string(), Value::String("object".to_string()));
        let mut props = IndexMap::new();
        let mut email_schema = IndexMap::new();
        email_schema.insert("type".to_string(), Value::String("string".to_string()));
        email_schema.insert("format".to_string(), Value::String("email".to_string()));
        props.insert("email".to_string(), Value::Table(email_schema));
        schema.insert("properties".to_string(), Value::Table(props));
        schema.insert(
            "required".to_string(),
            Value::Array(vec![Value::String("email".to_string())]),
        );
        gs.insert("schema".to_string(), Value::Table(schema));
        let mut top = IndexMap::new();
        top.insert("gitsheet".to_string(), Value::Table(gs));

        let (_dir, git_dir, _parent) = setup(Value::Table(top));
        let mut tx = Transaction::begin(&git_dir, default_opts("bad")).unwrap();
        let err = {
            let (repo, tree) = tx.split();
            let mut sheet =
                Sheet::open(repo, tree, "people", ".gitsheets/people.toml", ".", "").unwrap();
            let bad = record_value(&[("slug", "jane"), ("email", "not-an-email")]);
            sheet.prepare_upsert(repo, tree, &bad, None, false).unwrap_err()
        };
        assert_eq!(err.code(), "validation_failed");
        // No stage happened → no mutation → finalize is a no-op.
        let result = tx.finalize().unwrap();
        assert_eq!(result.commit_hash, None);
    }

    #[test]
    fn commit_onto_a_branch_name_advances_that_branch() {
        let (_dir, git_dir, parent) = setup(config_value("${{ slug }}", "people"));
        // Create a feature branch at the same parent.
        let repo = record::open_repo(&git_dir).unwrap();
        holo_repo::update_ref(&repo, "refs/heads/feature", parent, None).unwrap();

        let mut opts = default_opts("on feature");
        opts.parent = Some("feature".into());
        let result = upsert_one(&git_dir, opts, record_value(&[("slug", "fx")]));
        assert_eq!(result.ref_name.as_deref(), Some("refs/heads/feature"));
        // main is untouched.
        let repo = record::open_repo(&git_dir).unwrap();
        let main = holo_repo::resolve_ref(&repo, "refs/heads/main").unwrap().unwrap();
        assert_eq!(main, parent);
    }

    #[test]
    fn commit_onto_a_hash_advances_no_branch() {
        let (_dir, git_dir, parent) = setup(config_value("${{ slug }}", "people"));
        let mut opts = default_opts("detached");
        opts.parent = Some(parent.to_string());
        let result = upsert_one(&git_dir, opts, record_value(&[("slug", "d")]));
        assert!(result.commit_hash.is_some());
        assert_eq!(result.ref_name, None);
    }

    #[test]
    fn unknown_parent_branch_is_ref_not_found() {
        let (_dir, git_dir, _parent) = setup(config_value("${{ slug }}", "people"));
        let mut opts = default_opts("x");
        opts.parent = Some("nope".into());
        let err = begin_err(&git_dir, opts);
        assert_eq!(err.code(), "ref_not_found");
    }

    #[test]
    fn invalid_trailer_key_is_rejected() {
        let (_dir, git_dir, _parent) = setup(config_value("${{ slug }}", "people"));
        let mut opts = default_opts("x");
        opts.trailers = vec![("not a header".into(), "v".into())];
        let err = begin_err(&git_dir, opts);
        assert_eq!(err.code(), "commit_failed");
    }

    #[test]
    fn commit_message_formatting_matches_js() {
        assert_eq!(format_commit_message("subject", &[]), "subject\n");
        assert_eq!(
            format_commit_message("subject\n\nbody", &[("A".into(), "1".into())]),
            "subject\n\nbody\n\nA: 1\n"
        );
        assert_eq!(
            format_commit_message(
                "s",
                &[("Action".into(), "x".into()), ("Reason".into(), "y".into())]
            ),
            "s\n\nAction: x\nReason: y\n"
        );
    }

    #[test]
    fn http_header_key_validation() {
        assert!(is_http_header_key("Action"));
        assert!(is_http_header_key("Subject-Id"));
        assert!(is_http_header_key("User-Ip"));
        assert!(is_http_header_key("Response-Code"));
        assert!(!is_http_header_key("action"));
        assert!(!is_http_header_key("subject_id"));
        assert!(!is_http_header_key(""));
        assert!(!is_http_header_key("Has Space"));
    }
}
