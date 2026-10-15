//! Opt-in branch sync — the object-database half of `repo.sync()`
//! (`specs/behaviors/push-sync.md` "Sync (opt-in, explicit)").
//!
//! The host fetches (git's own transport + auth) and holds the write lock;
//! this module classifies the local tip against the remote-tracking tip and
//! moves the ref: fast-forward by compare-and-swap, replay each local commit
//! onto the remote tip as a 3-way tree merge (author / date / message kept,
//! committer set), or — on a conflict — preserve the local history on a side
//! branch and adopt the remote. Pure plumbing: no working tree, no index,
//! nothing to abort. Nothing here ever force-moves a ref the caller did not
//! name, and a conflict stops the replay before any ref moves.

use gix::merge::tree::TreatAsUnresolved;
use holo_tree::{repo as holo_repo, ObjectId};

use crate::error::{Error, Result};
use crate::transaction::{build_signature, qualify_ref, resolve_author, Author};

/// What to do when a local commit cannot be replayed cleanly onto the remote tip.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConflictPolicy {
    /// Leave everything where it is; report `Conflict` and the offending commit.
    Fail,
    /// Preserve the local tip on `<prefix><UTC timestamp>`, reset the branch to
    /// the remote tip; report `ConflictEscaped` with the branch name.
    PreserveBranch { prefix: String },
}

/// Options for [`sync_branch`].
#[derive(Clone, Debug)]
pub struct SyncOptions {
    /// The local branch (bare name or qualified ref).
    pub branch: String,
    /// The remote-tracking ref (or any commit-ish) to sync against, e.g.
    /// `refs/remotes/origin/main`.
    pub remote_ref: String,
    pub on_conflict: ConflictPolicy,
    /// Committer for replayed commits; `None` = the repository's identity.
    pub committer: Option<Author>,
    /// Wall clock for the replayed commits' committer signature and the
    /// conflict-branch timestamp.
    pub time_seconds: i64,
    pub offset_minutes: i32,
}

/// The classification a sync ended in (`specs/behaviors/push-sync.md`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncOutcome {
    InSync,
    FastForwarded,
    Ahead,
    Rebased,
    Conflict,
    ConflictEscaped,
}

impl SyncOutcome {
    /// The outcome's wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            SyncOutcome::InSync => "in-sync",
            SyncOutcome::FastForwarded => "fast-forwarded",
            SyncOutcome::Ahead => "ahead",
            SyncOutcome::Rebased => "rebased",
            SyncOutcome::Conflict => "conflict",
            SyncOutcome::ConflictEscaped => "conflict-escaped",
        }
    }
}

/// The result of [`sync_branch`].
#[derive(Clone, Debug)]
pub struct SyncResult {
    pub outcome: SyncOutcome,
    /// The branch tip before.
    pub old_commit: String,
    /// The branch tip after (`== old_commit` when nothing moved).
    pub new_commit: String,
    /// Local commits the remote lacked (`base..local`).
    pub ahead: u32,
    /// Remote commits the local lacked (`base..remote`).
    pub behind: u32,
    /// `Conflict` / `ConflictEscaped`: the local commit that would not replay.
    pub conflict_commit: Option<String>,
    /// `ConflictEscaped`: the qualified ref the local history was preserved on.
    pub conflict_branch: Option<String>,
}

fn resolve_commit(repo: &gix::Repository, spec: &str) -> Result<ObjectId> {
    let id = repo.rev_parse_single(spec).map_err(|e| Error::RefNotFound {
        message: format!("could not resolve '{spec}': {e}"),
    })?;
    let obj = id.object().map_err(|e| Error::RefNotFound {
        message: format!("could not load '{spec}': {e}"),
    })?;
    let commit = obj.peel_to_commit().map_err(|e| Error::RefNotFound {
        message: format!("'{spec}' does not resolve to a commit: {e}"),
    })?;
    Ok(commit.id)
}

/// Whether commit `a` is reachable from commit `b` (or equal).
pub fn is_ancestor(repo: &gix::Repository, a: &str, b: &str) -> Result<bool> {
    let a = resolve_commit(repo, a)?;
    let b = resolve_commit(repo, b)?;
    if a == b {
        return Ok(true);
    }
    match repo.merge_base(a, b) {
        Ok(base) => Ok(base.detach() == a),
        Err(_) => Ok(false),
    }
}

/// The commits reachable from `tip` but not from `hidden`, newest first.
fn commits_between(repo: &gix::Repository, tip: ObjectId, hidden: ObjectId) -> Result<Vec<ObjectId>> {
    let walk = repo
        .rev_walk([tip])
        .with_hidden([hidden])
        .all()
        .map_err(|e| Error::CommitFailed {
            message: format!("rev-walk failed: {e}"),
        })?;
    let mut out = Vec::new();
    for info in walk {
        let info = info.map_err(|e| Error::CommitFailed {
            message: format!("rev-walk failed: {e}"),
        })?;
        out.push(info.id);
    }
    Ok(out)
}

fn commit_failed<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> Error + '_ {
    move |e| Error::CommitFailed {
        message: format!("{what}: {e}"),
    }
}

/// Replay `commits` (oldest first) onto `onto`; `Ok(Err(commit))` names the
/// first commit whose 3-way merge left unresolved conflicts.
fn replay(
    repo: &gix::Repository,
    commits: &[ObjectId],
    onto: ObjectId,
    committer: &gix::actor::Signature,
) -> Result<std::result::Result<ObjectId, ObjectId>> {
    let mut tip = onto;
    for &commit_id in commits {
        let commit = repo.find_commit(commit_id).map_err(commit_failed("find commit"))?;
        let parent = commit.parent_ids().next().map(|p| p.detach());
        let parent_tree = match parent {
            Some(p) => repo
                .find_commit(p)
                .map_err(commit_failed("find parent"))?
                .tree_id()
                .map_err(commit_failed("parent tree"))?
                .detach(),
            None => gix::ObjectId::empty_tree(repo.object_hash()),
        };
        let commit_tree = commit.tree_id().map_err(commit_failed("commit tree"))?.detach();
        let tip_tree = repo
            .find_commit(tip)
            .map_err(commit_failed("find tip"))?
            .tree_id()
            .map_err(commit_failed("tip tree"))?
            .detach();

        let labels = gix::merge::blob::builtin_driver::text::Labels {
            ancestor: Some("base".into()),
            current: Some("remote".into()),
            other: Some("local".into()),
        };
        let options = repo.tree_merge_options().map_err(commit_failed("merge options"))?;
        let mut outcome = repo
            .merge_trees(parent_tree, tip_tree, commit_tree, labels, options)
            .map_err(commit_failed("merge trees"))?;
        if outcome.has_unresolved_conflicts(TreatAsUnresolved::default()) {
            return Ok(Err(commit_id));
        }
        let merged_tree = outcome.tree.write().map_err(commit_failed("write merged tree"))?.detach();

        let author = commit
            .author()
            .map_err(commit_failed("commit author"))?
            .to_owned()
            .map_err(commit_failed("commit author time"))?;
        let message = commit
            .message_raw()
            .map_err(commit_failed("commit message"))?
            .to_string();
        tip = holo_repo::commit_tree(repo, merged_tree, &[tip], &message, Some(author), Some(committer.clone()))
            .map_err(commit_failed("commit-tree"))?;
    }
    Ok(Ok(tip))
}

/// `YYYY-MM-DDTHH-MM-SSZ` for a UTC epoch — git-ref-safe (no colons), the same
/// shape operators already alert on for `conflicts/*` branches.
fn utc_stamp(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}-{m:02}-{s:02}Z")
}

/// Classify the local branch against the remote-tracking tip and move it per
/// `specs/behaviors/push-sync.md` "Sync (opt-in, explicit)". The caller holds
/// the write lock and has already fetched.
pub fn sync_branch(repo: &gix::Repository, opts: &SyncOptions) -> Result<SyncResult> {
    let branch_ref = qualify_ref(&opts.branch);
    let local = holo_repo::resolve_ref(repo, &branch_ref)
        .map_err(crate::record::map_ht)?
        .ok_or_else(|| Error::RefNotFound {
            message: format!("branch not found: {branch_ref}"),
        })?;
    let remote = resolve_commit(repo, &opts.remote_ref)?;

    let done = |outcome: SyncOutcome, new: ObjectId, ahead: u32, behind: u32| SyncResult {
        outcome,
        old_commit: local.to_string(),
        new_commit: new.to_string(),
        ahead,
        behind,
        conflict_commit: None,
        conflict_branch: None,
    };

    if local == remote {
        return Ok(done(SyncOutcome::InSync, local, 0, 0));
    }
    let base = repo.merge_base(local, remote).map_err(|e| Error::NotAnAncestor {
        message: format!(
            "{branch_ref} and {} share no history (no merge base): {e}",
            opts.remote_ref
        ),
    })?;
    let base = base.detach();
    let local_commits = commits_between(repo, local, base)?; // newest first
    let ahead = local_commits.len() as u32;
    let behind = commits_between(repo, remote, base)?.len() as u32;

    if base == local {
        holo_repo::update_ref(repo, &branch_ref, remote, Some(local)).map_err(|e| Error::CommitFailed {
            message: format!("fast-forward of {branch_ref} failed: {e}"),
        })?;
        return Ok(done(SyncOutcome::FastForwarded, remote, 0, behind));
    }
    if base == remote {
        return Ok(done(SyncOutcome::Ahead, local, ahead, 0));
    }

    // Diverged: replay the local commits, oldest first, onto the remote tip.
    let committer_author = resolve_author(repo, opts.committer.clone());
    let committer = build_signature(&committer_author, opts.time_seconds, opts.offset_minutes)?;
    let mut oldest_first = local_commits.clone();
    oldest_first.reverse();
    match replay(repo, &oldest_first, remote, &committer)? {
        Ok(new_tip) => {
            holo_repo::update_ref(repo, &branch_ref, new_tip, Some(local)).map_err(|e| Error::CommitFailed {
                message: format!("moving {branch_ref} to the replayed tip failed: {e}"),
            })?;
            Ok(done(SyncOutcome::Rebased, new_tip, ahead, behind))
        }
        Err(conflict_commit) => match &opts.on_conflict {
            ConflictPolicy::Fail => {
                let mut r = done(SyncOutcome::Conflict, local, ahead, behind);
                r.conflict_commit = Some(conflict_commit.to_string());
                Ok(r)
            }
            ConflictPolicy::PreserveBranch { prefix } => {
                let conflict_branch = qualify_ref(&format!("{prefix}{}", utc_stamp(opts.time_seconds)));
                holo_repo::update_ref(repo, &conflict_branch, local, None).map_err(|e| Error::CommitFailed {
                    message: format!("preserving {branch_ref} on {conflict_branch} failed: {e}"),
                })?;
                holo_repo::update_ref(repo, &branch_ref, remote, Some(local)).map_err(|e| Error::CommitFailed {
                    message: format!("resetting {branch_ref} to the remote tip failed: {e}"),
                })?;
                let mut r = done(SyncOutcome::ConflictEscaped, remote, ahead, behind);
                r.conflict_commit = Some(conflict_commit.to_string());
                r.conflict_branch = Some(conflict_branch);
                Ok(r)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holo_tree::{Context, MutableTree, TreeCache};

    fn tctx(repo: &gix::Repository) -> Context<'_> {
        Context::new(repo, Box::leak(Box::new(TreeCache::new())))
    }

    fn sig(name: &str, secs: i64) -> gix::actor::Signature {
        build_signature(
            &Author {
                name: name.into(),
                email: format!("{}@x.org", name.to_lowercase()),
            },
            secs,
            0,
        )
        .unwrap()
    }

    /// Commit `files` (path → text) on top of `parent`'s tree (or empty).
    fn commit(repo: &gix::Repository, parent: Option<ObjectId>, files: &[(&str, &str)], msg: &str, who: &str) -> ObjectId {
        let ctx = tctx(repo);
        let mut tree = match parent {
            Some(p) => holo_repo::create_tree_from_ref(repo, &p.to_string()).unwrap(),
            None => MutableTree::empty(),
        };
        for (path, text) in files {
            tree.write_child(&ctx, path, text).unwrap();
        }
        let tree_hash = tree.write(&ctx).unwrap();
        let parents: Vec<ObjectId> = parent.into_iter().collect();
        holo_repo::commit_tree(repo, tree_hash, &parents, msg, Some(sig(who, 1_600_000_000)), Some(sig(who, 1_600_000_000)))
            .unwrap()
    }

    fn setup() -> (tempfile::TempDir, gix::Repository, ObjectId) {
        let dir = tempfile::tempdir().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        let base = commit(&repo, None, &[("a.toml", "x = 1\n")], "base\n", "Seed");
        holo_repo::update_ref(&repo, "refs/heads/main", base, None).unwrap();
        holo_repo::update_ref(&repo, "refs/remotes/origin/main", base, None).unwrap();
        (dir, repo, base)
    }

    fn opts(policy: ConflictPolicy) -> SyncOptions {
        SyncOptions {
            branch: "main".into(),
            remote_ref: "refs/remotes/origin/main".into(),
            on_conflict: policy,
            committer: Some(Author {
                name: "Sync Bot".into(),
                email: "sync@x.org".into(),
            }),
            time_seconds: 1_700_000_000,
            offset_minutes: 0,
        }
    }

    fn tip(repo: &gix::Repository, r: &str) -> ObjectId {
        holo_repo::resolve_ref(repo, r).unwrap().unwrap()
    }

    fn blob(repo: &gix::Repository, commit: ObjectId, path: &str) -> Option<String> {
        let ctx = tctx(repo);
        let mut tree = holo_repo::create_tree_from_ref(repo, &commit.to_string()).unwrap();
        tree.read_blob(&ctx, path).unwrap().map(|b| String::from_utf8(b).unwrap())
    }

    #[test]
    fn in_sync_when_tips_match() {
        let (_d, repo, base) = setup();
        let r = sync_branch(&repo, &opts(ConflictPolicy::Fail)).unwrap();
        assert_eq!(r.outcome, SyncOutcome::InSync);
        assert_eq!(r.new_commit, base.to_string());
    }

    #[test]
    fn behind_fast_forwards_by_cas() {
        let (_d, repo, base) = setup();
        let r1 = commit(&repo, Some(base), &[("b.toml", "y = 1\n")], "remote 1\n", "Other");
        let r2 = commit(&repo, Some(r1), &[("c.toml", "z = 1\n")], "remote 2\n", "Other");
        holo_repo::update_ref(&repo, "refs/remotes/origin/main", r2, None).unwrap();
        let r = sync_branch(&repo, &opts(ConflictPolicy::Fail)).unwrap();
        assert_eq!(r.outcome, SyncOutcome::FastForwarded);
        assert_eq!((r.ahead, r.behind), (0, 2));
        assert_eq!(tip(&repo, "refs/heads/main"), r2);
    }

    #[test]
    fn ahead_moves_nothing() {
        let (_d, repo, base) = setup();
        let l1 = commit(&repo, Some(base), &[("b.toml", "y = 1\n")], "local 1\n", "Me");
        holo_repo::update_ref(&repo, "refs/heads/main", l1, Some(base)).unwrap();
        let r = sync_branch(&repo, &opts(ConflictPolicy::Fail)).unwrap();
        assert_eq!(r.outcome, SyncOutcome::Ahead);
        assert_eq!((r.ahead, r.behind), (1, 0));
        assert_eq!(tip(&repo, "refs/heads/main"), l1);
    }

    #[test]
    fn diverged_clean_replays_local_commits_onto_remote() {
        let (_d, repo, base) = setup();
        let l1 = commit(&repo, Some(base), &[("b.toml", "y = 1\n")], "local 1\n", "Me");
        let l2 = commit(&repo, Some(l1), &[("b.toml", "y = 2\n")], "local 2\n", "Me");
        holo_repo::update_ref(&repo, "refs/heads/main", l2, Some(base)).unwrap();
        let r1 = commit(&repo, Some(base), &[("c.toml", "z = 1\n")], "remote 1\n", "Other");
        holo_repo::update_ref(&repo, "refs/remotes/origin/main", r1, None).unwrap();

        let r = sync_branch(&repo, &opts(ConflictPolicy::Fail)).unwrap();
        assert_eq!(r.outcome, SyncOutcome::Rebased);
        assert_eq!((r.ahead, r.behind), (2, 1));
        let new_tip = tip(&repo, "refs/heads/main");
        assert_eq!(new_tip.to_string(), r.new_commit);
        // Both sides' content, local commits on top of the remote tip, in order.
        assert_eq!(blob(&repo, new_tip, "b.toml").as_deref(), Some("y = 2\n"));
        assert_eq!(blob(&repo, new_tip, "c.toml").as_deref(), Some("z = 1\n"));
        let top = repo.find_commit(new_tip).unwrap();
        assert_eq!(top.message_raw().unwrap().to_string(), "local 2\n");
        assert_eq!(top.author().unwrap().name, "Me");
        assert_eq!(top.committer().unwrap().name, "Sync Bot");
        let second = top.parent_ids().next().unwrap().detach();
        let second_c = repo.find_commit(second).unwrap();
        assert_eq!(second_c.message_raw().unwrap().to_string(), "local 1\n");
        assert_eq!(second_c.parent_ids().next().unwrap().detach(), r1);
    }

    #[test]
    fn conflict_with_fail_policy_moves_nothing() {
        let (_d, repo, base) = setup();
        let l1 = commit(&repo, Some(base), &[("a.toml", "x = 2\n")], "local\n", "Me");
        holo_repo::update_ref(&repo, "refs/heads/main", l1, Some(base)).unwrap();
        let r1 = commit(&repo, Some(base), &[("a.toml", "x = 3\n")], "remote\n", "Other");
        holo_repo::update_ref(&repo, "refs/remotes/origin/main", r1, None).unwrap();
        let r = sync_branch(&repo, &opts(ConflictPolicy::Fail)).unwrap();
        assert_eq!(r.outcome, SyncOutcome::Conflict);
        assert_eq!(r.conflict_commit.as_deref(), Some(l1.to_string().as_str()));
        assert_eq!(tip(&repo, "refs/heads/main"), l1);
    }

    #[test]
    fn conflict_with_preserve_policy_escapes_to_a_side_branch() {
        let (_d, repo, base) = setup();
        let l1 = commit(&repo, Some(base), &[("a.toml", "x = 2\n")], "local\n", "Me");
        holo_repo::update_ref(&repo, "refs/heads/main", l1, Some(base)).unwrap();
        let r1 = commit(&repo, Some(base), &[("a.toml", "x = 3\n")], "remote\n", "Other");
        holo_repo::update_ref(&repo, "refs/remotes/origin/main", r1, None).unwrap();
        let r = sync_branch(&repo, &opts(ConflictPolicy::PreserveBranch { prefix: "conflicts/".into() })).unwrap();
        assert_eq!(r.outcome, SyncOutcome::ConflictEscaped);
        assert_eq!(r.conflict_branch.as_deref(), Some("refs/heads/conflicts/2023-11-14T22-13-20Z"));
        assert_eq!(tip(&repo, "refs/heads/main"), r1);
        assert_eq!(tip(&repo, "refs/heads/conflicts/2023-11-14T22-13-20Z"), l1);
    }

    #[test]
    fn unrelated_histories_are_not_an_ancestor() {
        let (_d, repo, _base) = setup();
        let orphan = commit(&repo, None, &[("q.toml", "q = 1\n")], "orphan\n", "Other");
        holo_repo::update_ref(&repo, "refs/remotes/origin/main", orphan, None).unwrap();
        let err = sync_branch(&repo, &opts(ConflictPolicy::Fail)).err().unwrap();
        assert_eq!(err.code(), "not_an_ancestor");
    }

    #[test]
    fn is_ancestor_follows_reachability() {
        let (_d, repo, base) = setup();
        let l1 = commit(&repo, Some(base), &[("b.toml", "y = 1\n")], "local\n", "Me");
        assert!(is_ancestor(&repo, &base.to_string(), &l1.to_string()).unwrap());
        assert!(!is_ancestor(&repo, &l1.to_string(), &base.to_string()).unwrap());
        assert!(is_ancestor(&repo, &l1.to_string(), &l1.to_string()).unwrap());
        assert_eq!(is_ancestor(&repo, "nope", &l1.to_string()).err().unwrap().code(), "ref_not_found");
    }

    #[test]
    fn utc_stamp_formats_like_the_shell_version() {
        assert_eq!(utc_stamp(0), "1970-01-01T00-00-00Z");
        assert_eq!(utc_stamp(1_700_000_000), "2023-11-14T22-13-20Z");
    }
}
