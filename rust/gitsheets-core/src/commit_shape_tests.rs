//! Commit-shape tests (`specs/behaviors/transactions.md` "Additional
//! parents", "Replacing the tip", "Empty commits", "Reading a commit back").

use holo_tree::{repo as holo_repo, Context, MutableTree, ObjectId};

use crate::history;
use crate::transaction::{build_signature, Author, Transaction, TransactionOptions, TransactionResult};
use crate::Error;

fn tctx(repo: &gix::Repository) -> Context<'_> {
    Context::new(repo, Box::leak(Box::new(holo_tree::TreeCache::new())))
}

fn sig(secs: i64) -> gix::actor::Signature {
    build_signature(&Author { name: "Seed".into(), email: "seed@x.org".into() }, secs, 0).unwrap()
}

/// A raw commit (no rollup pass) of `files` on top of `parents[0]`'s tree.
fn raw(repo: &gix::Repository, parents: &[ObjectId], files: &[(&str, &str)], msg: &str) -> ObjectId {
    let ctx = tctx(repo);
    let mut tree = match parents.first() {
        Some(p) => holo_repo::create_tree_from_ref(repo, &p.to_string()).unwrap(),
        None => MutableTree::empty(),
    };
    for (path, text) in files {
        tree.write_child(&ctx, path, text).unwrap();
    }
    let hash = tree.write(&ctx).unwrap();
    // Increasing commit times, as real histories have (gix's hidden-set walk
    // leans on commit dates).
    static CLOCK: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1_600_000_000);
    let t = CLOCK.fetch_add(60, std::sync::atomic::Ordering::Relaxed);
    holo_repo::commit_tree(repo, hash, parents, msg, Some(sig(t)), Some(sig(t))).unwrap()
}

fn setup() -> (tempfile::TempDir, String, gix::Repository, ObjectId) {
    let dir = tempfile::tempdir().unwrap();
    let repo = gix::init(dir.path()).unwrap();
    let c = raw(&repo, &[], &[("seed.txt", "seed\n")], "init\n");
    holo_repo::update_ref(&repo, "refs/heads/main", c, None).unwrap();
    std::fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let git_dir = dir.path().join(".git").to_string_lossy().into_owned();
    (dir, git_dir, repo, c)
}

fn opts(message: &str) -> TransactionOptions {
    TransactionOptions {
        author: Some(Author { name: "Jane".into(), email: "jane@x.org".into() }),
        message: message.into(),
        time_seconds: 1_700_000_000,
        offset_minutes: -300,
        ..Default::default()
    }
}

/// A transaction that writes `files` raw (or nothing) and finalizes.
fn commit(git_dir: &str, o: TransactionOptions, files: &[(&str, &str)]) -> crate::Result<TransactionResult> {
    let mut tx = Transaction::begin(git_dir, o)?;
    for (path, text) in files {
        let (ctx, tree) = tx.split();
        tree.write_child(&ctx, path, text).unwrap();
        tx.mark_mutated();
    }
    tx.finalize()
}

fn begin_err(git_dir: &str, o: TransactionOptions) -> Error {
    match Transaction::begin(git_dir, o) {
        Err(e) => e,
        Ok(tx) => {
            tx.discard();
            panic!("expected begin to fail")
        }
    }
}

fn tip(repo: &gix::Repository, r: &str) -> ObjectId {
    holo_repo::resolve_ref(repo, r).unwrap().unwrap()
}

fn parents(repo: &gix::Repository, c: ObjectId) -> Vec<ObjectId> {
    repo.find_commit(c).unwrap().parent_ids().map(|p| p.detach()).collect()
}

fn tree(repo: &gix::Repository, c: ObjectId) -> ObjectId {
    repo.find_commit(c).unwrap().tree_id().unwrap().detach()
}

fn oid(s: &str) -> ObjectId {
    ObjectId::from_hex(s.as_bytes()).unwrap()
}

// ── trailers ───────────────────────────────────────────────────────────────

#[test]
fn malformed_and_reserved_trailers_are_trailer_invalid() {
    let (_d, git_dir, _repo, _c) = setup();
    for t in [("not a header", "v"), ("Action", "two\nlines")] {
        let mut o = opts("x");
        o.trailers = vec![(t.0.into(), t.1.into())];
        assert_eq!(begin_err(&git_dir, o).code(), "trailer_invalid", "{t:?}");
    }
}

// ── additional parents ────────────────────────────────────────────────────────

#[test]
fn also_parents_are_written_in_order() {
    let (_d, git_dir, repo, c0) = setup();
    let l1 = raw(&repo, &[], &[("l1", "1")], "l1\n");
    let l2 = raw(&repo, &[], &[("l2", "2")], "l2\n");
    let mut o = opts("with extra parents");
    o.trailers = vec![("Cycle-Id".into(), "7".into())];
    o.also_parents = Some(vec![l1.to_string(), l2.to_string()]);
    let r = commit(&git_dir, o, &[("a.txt", "a")]).unwrap();
    let c = oid(r.commit_hash.as_deref().unwrap());
    assert_eq!(parents(&repo, c), vec![c0, l1, l2]);
    let info = history::commit_info(&repo, &c.to_string()).unwrap();
    assert_eq!(info.trailers, vec![("Cycle-Id".to_string(), "7".to_string())]);
    assert_eq!(info.parents, vec![c0.to_string(), l1.to_string(), l2.to_string()]);
    // The tree is the first parent's plus the change: nothing from l1 / l2.
    let ctx = tctx(&repo);
    let mut t = holo_repo::create_tree_from_ref(&repo, &c.to_string()).unwrap();
    assert!(t.read_blob(&ctx, "l1").unwrap().is_none());
}

#[test]
fn bad_also_parents_fail_at_open_and_move_nothing() {
    let (_d, git_dir, repo, c0) = setup();
    let ghost = "1234567890123456789012345678901234567890";
    let mut o = opts("x");
    o.also_parents = Some(vec![ghost.into()]);
    assert_eq!(begin_err(&git_dir, o).code(), "parent_not_found");

    let tree_id = tree(&repo, c0);
    let mut o = opts("x");
    o.also_parents = Some(vec![tree_id.to_string()]);
    assert_eq!(begin_err(&git_dir, o).code(), "parent_not_found");

    let l = raw(&repo, &[], &[("l", "l")], "l\n");
    let mut o = opts("x");
    o.also_parents = Some(vec![l.to_string(), l.to_string()]);
    assert_eq!(begin_err(&git_dir, o).code(), "commit_failed");

    let mut o = opts("x");
    o.also_parents = Some(vec![c0.to_string()]);
    assert_eq!(begin_err(&git_dir, o).code(), "commit_failed");

    let mut o = opts("x");
    o.orphan = true;
    o.also_parents = Some(vec![l.to_string()]);
    assert_eq!(begin_err(&git_dir, o).code(), "commit_failed");

    assert_eq!(tip(&repo, "refs/heads/main"), c0);
}

#[test]
fn also_parents_on_an_unchanged_tree_commit_nothing() {
    let (_d, git_dir, repo, c0) = setup();
    let l = raw(&repo, &[], &[("l", "l")], "l\n");
    let mut o = opts("x");
    o.also_parents = Some(vec![l.to_string()]);
    let r = commit(&git_dir, o, &[("seed.txt", "seed\n")]).unwrap();
    assert_eq!(r.commit_hash, None);
    assert_eq!(tip(&repo, "refs/heads/main"), c0);
}

// ── empty commits ──────────────────────────────────────────────────────────

#[test]
fn allow_empty_commits_the_tip_tree_with_message_trailers_and_parents() {
    let (_d, git_dir, repo, c0) = setup();
    let l = raw(&repo, &[], &[("l", "l")], "l\n");
    let mut o = opts("cycle 1: start");
    o.allow_empty = true;
    o.trailers = vec![("Cycle-Id".into(), "1".into())];
    o.also_parents = Some(vec![l.to_string()]);
    let r = commit(&git_dir, o, &[]).unwrap();
    let c = oid(r.commit_hash.as_deref().unwrap());
    assert_eq!(tree(&repo, c), tree(&repo, c0));
    assert_eq!(parents(&repo, c), vec![c0, l]);
    let info = history::commit_info(&repo, "main").unwrap();
    assert_eq!(info.subject, "cycle 1: start");
    assert_eq!(info.trailers[0], ("Cycle-Id".into(), "1".into()));
    // Without allow_empty, the same thing commits nothing.
    let r = commit(&git_dir, opts("again"), &[]).unwrap();
    assert_eq!(r.commit_hash, None);
}

// ── replace ────────────────────────────────────────────────────────────────

fn replace_opts(message: &str, expected: ObjectId) -> TransactionOptions {
    let mut o = opts(message);
    o.replace = Some(expected.to_string());
    o
}

#[test]
fn replace_takes_the_tips_parents_and_tree_and_moves_the_ref() {
    let (_d, git_dir, repo, c0) = setup();
    let l = raw(&repo, &[], &[("l", "l")], "l\n");
    let mut o = opts("t1");
    o.also_parents = Some(vec![l.to_string()]);
    let t1 = oid(commit(&git_dir, o, &[("a.txt", "a")]).unwrap().commit_hash.as_deref().unwrap());

    // Replace, adding a file: tip's tree + change, tip's parents kept.
    let r = commit(&git_dir, replace_opts("t1'", t1), &[("b.txt", "b")]).unwrap();
    let t2 = oid(r.commit_hash.as_deref().unwrap());
    assert_eq!(r.replaced_commit_hash.as_deref(), Some(t1.to_string().as_str()));
    assert_eq!(r.parent_commit_hash.as_deref(), Some(c0.to_string().as_str()));
    assert_eq!(tip(&repo, "refs/heads/main"), t2);
    assert_eq!(parents(&repo, t2), vec![c0, l]);
    assert!(history::commit_info(&repo, &t2.to_string()).unwrap().trailers.is_empty());
    let ctx = tctx(&repo);
    let mut t = holo_repo::create_tree_from_ref(&repo, &t2.to_string()).unwrap();
    assert!(t.read_blob(&ctx, "a.txt").unwrap().is_some());
    assert!(t.read_blob(&ctx, "b.txt").unwrap().is_some());

    // alsoParents given replaces the extras; [] drops them.
    let l2 = raw(&repo, &[], &[("l2", "l2")], "l2\n");
    let mut o = replace_opts("t1''", t2);
    o.also_parents = Some(vec![l2.to_string()]);
    let t3 = oid(commit(&git_dir, o, &[]).unwrap().commit_hash.as_deref().unwrap());
    assert_eq!(parents(&repo, t3), vec![c0, l2]);
    let mut o = replace_opts("t1'''", t3);
    o.also_parents = Some(vec![]);
    let t4 = oid(commit(&git_dir, o, &[]).unwrap().commit_hash.as_deref().unwrap());
    assert_eq!(parents(&repo, t4), vec![c0]);
    assert!(history::commit_info(&repo, &t4.to_string()).unwrap().trailers.is_empty());
}

#[test]
fn replace_keeps_a_tips_second_parent() {
    let (_d, git_dir, repo, c0) = setup();
    let side = raw(&repo, &[c0], &[("s", "s")], "side\n");
    let m = raw(&repo, &[c0, side], &[("m", "m")], "merge\n");
    holo_repo::update_ref(&repo, "refs/heads/main", m, Some(c0)).unwrap();
    let r = commit(&git_dir, replace_opts("merge reworded", m), &[]).unwrap();
    let n = oid(r.commit_hash.as_deref().unwrap());
    assert_eq!(parents(&repo, n), vec![c0, side]);
}

#[test]
fn replace_refused_when_the_tip_is_not_the_expected_commit() {
    let (_d, git_dir, repo, c0) = setup();
    let t1 = oid(commit(&git_dir, opts("t1"), &[("a", "a")]).unwrap().commit_hash.as_deref().unwrap());
    // At open: the handler never runs.
    let e = begin_err(&git_dir, replace_opts("x", c0));
    assert_eq!(e.code(), "tip_mismatch");
    assert_eq!(e.tip(), Some((c0.to_string().as_str(), Some(t1.to_string().as_str()))));
    // Unresolvable expectation.
    let mut o = opts("x");
    o.replace = Some("nope".into());
    assert_eq!(begin_err(&git_dir, o).code(), "tip_mismatch");

    // Moved between open and commit: tip_mismatch, the other writer's tip stays.
    let mut tx = Transaction::begin(&git_dir, replace_opts("t1'", t1)).unwrap();
    {
        let (ctx, tree) = tx.split();
        tree.write_child(&ctx, "b", "b").unwrap();
    }
    tx.mark_mutated();
    let other = raw(&repo, &[t1], &[("o", "o")], "other\n");
    holo_repo::update_ref(&repo, "refs/heads/main", other, Some(t1)).unwrap();
    let e = tx.finalize().unwrap_err();
    assert_eq!(e.code(), "tip_mismatch");
    assert_eq!(tip(&repo, "refs/heads/main"), other);
}

#[test]
fn replace_on_an_unborn_branch_is_tip_mismatch_with_no_actual() {
    let (_d, git_dir, repo, c0) = setup();
    let _ = repo;
    let mut o = replace_opts("x", c0);
    o.parent = Some("unborn".into());
    // A branch that does not exist is ref_not_found at parent resolution; an
    // unborn HEAD branch is the case replace sees.
    assert_eq!(begin_err(&git_dir, o).code(), "ref_not_found");
    let dir = tempfile::tempdir().unwrap();
    gix::init(dir.path()).unwrap();
    let gd = dir.path().join(".git").to_string_lossy().into_owned();
    let e = begin_err(&gd, replace_opts("x", c0));
    assert_eq!(e.code(), "tip_mismatch");
    assert_eq!(e.tip().unwrap().1, None);
}

#[test]
fn replace_refused_when_a_remote_tracking_ref_contains_the_tip() {
    let (_d, git_dir, repo, _c0) = setup();
    let t1 = oid(commit(&git_dir, opts("t1"), &[("a", "a")]).unwrap().commit_hash.as_deref().unwrap());
    holo_repo::update_ref(&repo, "refs/remotes/origin/main", t1, None).unwrap();
    assert_eq!(begin_err(&git_dir, replace_opts("x", t1)).code(), "tip_published");
    assert_eq!(tip(&repo, "refs/heads/main"), t1);

    // A descendant on the remote counts too.
    let (_d2, git_dir, repo, _c0) = setup();
    let t1 = oid(commit(&git_dir, opts("t1"), &[("a", "a")]).unwrap().commit_hash.as_deref().unwrap());
    let desc = raw(&repo, &[t1], &[("d", "d")], "desc\n");
    holo_repo::update_ref(&repo, "refs/remotes/other/elsewhere", desc, None).unwrap();
    assert_eq!(begin_err(&git_dir, replace_opts("x", t1)).code(), "tip_published");

    // Published after open: refused at commit.
    let (_d3, git_dir, repo, _c0) = setup();
    let t1 = oid(commit(&git_dir, opts("t1"), &[("a", "a")]).unwrap().commit_hash.as_deref().unwrap());
    let tx = Transaction::begin(&git_dir, replace_opts("t1'", t1)).unwrap();
    holo_repo::update_ref(&repo, "refs/remotes/origin/main", t1, None).unwrap();
    assert_eq!(tx.finalize().unwrap_err().code(), "tip_published");
    assert_eq!(tip(&repo, "refs/heads/main"), t1);

    // The unpublished tip above a published commit can be replaced.
    let t2 = oid(commit(&git_dir, opts("t2"), &[("b", "b")]).unwrap().commit_hash.as_deref().unwrap());
    let r = commit(&git_dir, replace_opts("t2'", t2), &[]).unwrap();
    assert!(r.commit_hash.is_some());
}

#[test]
fn replace_with_incompatible_options_is_commit_failed() {
    let (_d, git_dir, _repo, c0) = setup();
    let mut o = replace_opts("x", c0);
    o.parent = Some(c0.to_string());
    assert_eq!(begin_err(&git_dir, o).code(), "commit_failed");
    let mut o = replace_opts("x", c0);
    o.orphan = true;
    assert_eq!(begin_err(&git_dir, o).code(), "commit_failed");
    let mut o = replace_opts("x", c0);
    o.branch = Some("other".into());
    assert_eq!(begin_err(&git_dir, o).code(), "commit_failed");
}

#[test]
fn replace_no_op_rules() {
    let (_d, git_dir, repo, c0) = setup();
    let t1 = oid(commit(&git_dir, opts("t1"), &[("a", "a")]).unwrap().commit_hash.as_deref().unwrap());
    // Only the message changes: the tip changed records, so it commits.
    let r = commit(&git_dir, replace_opts("t1 reworded", t1), &[]).unwrap();
    let t2 = oid(r.commit_hash.as_deref().unwrap());
    assert_eq!(tree(&repo, t2), tree(&repo, t1));

    // An empty tip replaced without allow_empty: nothing, the tip stays.
    let mut o = opts("empty");
    o.allow_empty = true;
    let e1 = oid(commit(&git_dir, o, &[]).unwrap().commit_hash.as_deref().unwrap());
    let r = commit(&git_dir, replace_opts("e1'", e1), &[]).unwrap();
    assert_eq!(r.commit_hash, None);
    assert_eq!(tip(&repo, "refs/heads/main"), e1);
    // With allow_empty it commits.
    let mut o = replace_opts("e1'", e1);
    o.allow_empty = true;
    let r = commit(&git_dir, o, &[]).unwrap();
    assert!(r.commit_hash.is_some());
    let _ = c0;
}

#[test]
fn replacing_a_root_commit_produces_a_root_commit() {
    let (_d, git_dir, repo, c0) = setup();
    let r = commit(&git_dir, replace_opts("root'", c0), &[]).unwrap();
    let n = oid(r.commit_hash.as_deref().unwrap());
    assert!(parents(&repo, n).is_empty());
    assert_eq!(r.parent_commit_hash, None);
}

/// The consumer's main loop: an empty commit with an extra parent, replaced
/// many times with new trailers and no alsoParents.
#[test]
fn an_empty_commit_with_an_extra_parent_replaced_many_times_keeps_it() {
    let (_d, git_dir, repo, c0) = setup();
    let snapshot = raw(&repo, &[], &[("world", "w")], "world\n");
    let mut o = opts("cycle 1");
    o.allow_empty = true;
    o.also_parents = Some(vec![snapshot.to_string()]);
    o.trailers = vec![("State".into(), "0".into())];
    let mut cur = oid(commit(&git_dir, o, &[]).unwrap().commit_hash.as_deref().unwrap());
    for i in 1..=5 {
        let mut o = replace_opts("cycle 1", cur);
        o.allow_empty = true;
        o.trailers = vec![("State".into(), i.to_string())];
        let r = commit(&git_dir, o, &[]).unwrap();
        let next = oid(r.commit_hash.as_deref().unwrap());
        assert_eq!(parents(&repo, next), vec![c0, snapshot], "round {i}");
        cur = next;
    }
    let info = history::commit_info(&repo, "main").unwrap();
    assert_eq!(info.trailers, vec![("State".to_string(), "5".to_string())]);
    assert_eq!(info.parents, vec![c0.to_string(), snapshot.to_string()]);
}

// ── read-back ────────────────────────────────────────────────────────────

#[test]
fn commit_info_round_trips() {
    let (_d, git_dir, repo, c0) = setup();
    let l = raw(&repo, &[], &[("l", "l")], "l\n");
    let mut o = opts("Subject line\n\nBody para one.\n\nBody para two.");
    o.trailers = vec![("Action".into(), "x.y".into()), ("Reason".into(), "a: b = c".into())];
    o.also_parents = Some(vec![l.to_string()]);
    o.allow_empty = true;
    let c = commit(&git_dir, o, &[]).unwrap().commit_hash.unwrap();
    let info = history::commit_info(&repo, "main").unwrap();
    assert_eq!(info.hash, c);
    assert_eq!(info.tree, tree(&repo, c0).to_string());
    assert_eq!(info.subject, "Subject line");
    assert_eq!(info.body, "Body para one.\n\nBody para two.");
    assert_eq!(info.trailers.len(), 2);
    assert_eq!(info.parents, vec![c0.to_string(), l.to_string()]);
    assert_eq!(info.trailers[1], ("Reason".into(), "a: b = c".into()));
    assert_eq!(info.author.name, "Jane");
    assert_eq!(info.author.date, "2023-11-14T17:13:20-05:00");
    assert_eq!(history::commit_info(&repo, "nope").unwrap_err().code(), "ref_not_found");
}
