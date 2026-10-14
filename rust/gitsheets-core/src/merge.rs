//! Sheet-aware merge (`specs/behaviors/merge.md`): a 3-way tree merge whose
//! record files, when changed on both sides, are re-merged **as records** —
//! field by field — and written in canonical form, so a merged repository
//! never carries a mix of serializations no single version produced.
//! Conflicts follow an explicit [`Prefer`] policy or are reported with nothing
//! written; a conflict never reaches a commit.

use std::collections::{BTreeMap, BTreeSet};

use gix::merge::tree::TreatAsUnresolved;
use holo_tree::{repo as holo_repo, Context, MutableTree, ObjectId, TreeCache};

use crate::codec;
use crate::error::{Error, Result};
use crate::record;
use crate::sheet::{join_path, Sheet};
use crate::store::discover_sheets;
use crate::transaction::{build_signature, is_likely_branch, qualify_ref, resolve_author, Author};
use crate::value::Value;

/// How to resolve a conflict the field merge cannot decide.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prefer {
    /// Report every conflict; write nothing.
    Fail,
    Ours,
    Theirs,
}

impl Prefer {
    /// Parse the wire form (`fail` / `ours` / `theirs`).
    pub fn parse(s: &str) -> Option<Prefer> {
        match s {
            "fail" => Some(Prefer::Fail),
            "ours" => Some(Prefer::Ours),
            "theirs" => Some(Prefer::Theirs),
            _ => None,
        }
    }
}

/// Options for [`merge_sheets`].
#[derive(Clone, Debug)]
pub struct MergeOptions {
    /// The side merged into: a branch (its ref moves) or a commit-ish (detached).
    pub ours: String,
    /// The side merged in: any commit-ish.
    pub theirs: String,
    /// `Repository.openSheet({ root })` scoping for sheet discovery; `.` by default.
    pub open_root: String,
    pub prefer: Prefer,
    /// `false` writes the merged tree and moves nothing (`DryRun`).
    pub commit: bool,
    pub message: Option<String>,
    pub author: Option<Author>,
    pub committer: Option<Author>,
    pub time_seconds: i64,
    pub offset_minutes: i32,
}

/// One unresolved conflict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeConflict {
    pub path: String,
    /// `field` / `delete-modify` / `blob` / `tree`.
    pub kind: String,
    /// `field`: the dotted field path.
    pub field: Option<String>,
    /// The blob on our side (absent = deleted).
    pub ours: Option<String>,
    /// The blob on their side (absent = deleted).
    pub theirs: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    UpToDate,
    FastForward,
    Merged,
    Conflict,
    DryRun,
}

impl MergeOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            MergeOutcome::UpToDate => "up-to-date",
            MergeOutcome::FastForward => "fast-forward",
            MergeOutcome::Merged => "merged",
            MergeOutcome::Conflict => "conflict",
            MergeOutcome::DryRun => "dry-run",
        }
    }
}

#[derive(Clone, Debug)]
pub struct MergeResult {
    pub outcome: MergeOutcome,
    pub ours_commit: String,
    pub theirs_commit: String,
    pub base: Option<String>,
    /// The merged tree (`Merged` / `DryRun`).
    pub tree: Option<String>,
    /// The merge commit (`Merged`), or the tip adopted (`FastForward` / `UpToDate`).
    pub commit: Option<String>,
    /// Record paths re-done at the record level.
    pub merged_records: Vec<String>,
    pub conflicts: Vec<MergeConflict>,
}

// ── field-level 3-way merge ────────────────────────────────────────────────────

/// Field-level 3-way merge of three (possibly absent) values. For tables the
/// merge recurses per key; elsewhere a value changed differently on both sides
/// is a conflict, resolved by `prefer` or recorded in `conflicts` (dotted
/// paths, `""` for the whole value) with ours kept as the placeholder.
pub fn merge_values(
    base: Option<&Value>,
    ours: Option<&Value>,
    theirs: Option<&Value>,
    prefer: Prefer,
    conflicts: &mut Vec<String>,
) -> Option<Value> {
    merge_at("", base, ours, theirs, prefer, conflicts)
}

fn merge_at(
    path: &str,
    base: Option<&Value>,
    ours: Option<&Value>,
    theirs: Option<&Value>,
    prefer: Prefer,
    conflicts: &mut Vec<String>,
) -> Option<Value> {
    if ours == theirs {
        return ours.cloned();
    }
    if ours == base {
        return theirs.cloned();
    }
    if theirs == base {
        return ours.cloned();
    }
    if let (Some(Value::Table(o)), Some(Value::Table(t))) = (ours, theirs) {
        let b = match base {
            Some(Value::Table(b)) => Some(b),
            _ => None,
        };
        let mut keys: Vec<&String> = Vec::new();
        for k in o.keys().chain(t.keys()).chain(b.into_iter().flat_map(|b| b.keys())) {
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
        let mut out = indexmap::IndexMap::new();
        for k in keys {
            let child = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
            let merged = merge_at(
                &child,
                b.and_then(|b| b.get(k)),
                o.get(k),
                t.get(k),
                prefer,
                conflicts,
            );
            if let Some(v) = merged {
                out.insert(k.clone(), v);
            }
        }
        return Some(Value::Table(out));
    }
    match prefer {
        Prefer::Ours => ours.cloned(),
        Prefer::Theirs => theirs.cloned(),
        Prefer::Fail => {
            conflicts.push(path.to_string());
            ours.cloned()
        }
    }
}

/// The result of merging one record's three texts.
#[derive(Clone, Debug)]
pub struct RecordMergeOutcome {
    /// The canonical merged text when there are no outstanding conflicts.
    pub text: Option<String>,
    /// Dotted field paths that conflicted (empty when `text` is `Some`).
    pub conflicts: Vec<String>,
}

/// Field-merge one record's `base` / `ours` / `theirs` texts through `sheet`
/// (parse with its format, merge, normalize, serialize canonically). The
/// merge-driver primitive. `base` absent = both sides added the record.
pub fn merge_record_texts(
    sheet: &mut Sheet,
    base: Option<&str>,
    ours: &str,
    theirs: &str,
    prefer: Prefer,
) -> Result<RecordMergeOutcome> {
    let format = sheet.config().format.clone();
    let parse = |text: &str| -> Result<Value> { codec::parse(text, &format) };
    let b = match base {
        Some(t) => Some(parse(t)?),
        None => None,
    };
    let o = parse(ours)?;
    let t = parse(theirs)?;
    let mut conflicts = Vec::new();
    let merged = merge_values(b.as_ref(), Some(&o), Some(&t), prefer, &mut conflicts);
    if !conflicts.is_empty() {
        return Ok(RecordMergeOutcome { text: None, conflicts });
    }
    let merged = merged.unwrap_or_else(|| Value::Table(Default::default()));
    let normalized = sheet.normalize_record(&merged)?;
    let text = codec::serialize(&normalized, &format)?;
    Ok(RecordMergeOutcome { text: Some(text), conflicts })
}

// ── the tree merge ─────────────────────────────────────────────────────────────

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

fn failed<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> Error + '_ {
    move |e| Error::CommitFailed {
        message: format!("{what}: {e}"),
    }
}

/// Whether commit `a` is reachable from commit `b`.
fn is_ancestor(repo: &gix::Repository, a: ObjectId, b: ObjectId) -> bool {
    a == b || matches!(repo.merge_base(a, b), Ok(base) if base.detach() == a)
}

fn tree_of(repo: &gix::Repository, commit: ObjectId) -> Result<ObjectId> {
    Ok(repo
        .find_commit(commit)
        .map_err(failed("find commit"))?
        .tree_id()
        .map_err(failed("commit tree"))?
        .detach())
}

/// `path → (before, after)` for every blob that differs between two trees.
type BlobChanges = BTreeMap<String, (Option<ObjectId>, Option<ObjectId>)>;

fn blob_changes(repo: &gix::Repository, from: ObjectId, to: ObjectId) -> Result<BlobChanges> {
    use gix::object::tree::diff::Change;
    use std::ops::ControlFlow;
    let from_tree = repo.find_tree(from).map_err(failed("find tree"))?;
    let to_tree = repo.find_tree(to).map_err(failed("find tree"))?;
    let mut out: BlobChanges = BTreeMap::new();
    let mut platform = from_tree.changes().map_err(failed("diff"))?;
    platform.options(|o| {
        o.track_path();
        o.track_rewrites(None);
    });
    platform
        .for_each_to_obtain_tree(&to_tree, |change: Change<'_, '_, '_>| -> std::result::Result<ControlFlow<()>, std::convert::Infallible> {
            match change {
                Change::Addition { location, entry_mode, id, .. } => {
                    if entry_mode.is_blob() {
                        out.insert(location.to_string(), (None, Some(id.detach())));
                    }
                }
                Change::Deletion { location, entry_mode, id, .. } => {
                    if entry_mode.is_blob() {
                        out.insert(location.to_string(), (Some(id.detach()), None));
                    }
                }
                Change::Modification { location, previous_entry_mode, previous_id, entry_mode, id, .. } => {
                    if previous_entry_mode.is_blob() || entry_mode.is_blob() {
                        out.insert(
                            location.to_string(),
                            (
                                previous_entry_mode.is_blob().then(|| previous_id.detach()),
                                entry_mode.is_blob().then(|| id.detach()),
                            ),
                        );
                    }
                }
                Change::Rewrite { .. } => {}
            }
            Ok(ControlFlow::Continue(()))
        })
        .map_err(failed("diff walk"))?;
    Ok(out)
}

struct SheetScope {
    base_dir: String,
    extension: String,
    sheet: Sheet,
}

/// Every sheet declared under `open_root` in `tree`, with the directory its
/// records live under.
fn open_sheets(repo: &gix::Repository, tree_id: ObjectId, open_root: &str) -> Result<Vec<SheetScope>> {
    let cache = TreeCache::new();
    let ctx = Context::new(repo, &cache);
    let mut tree = MutableTree::new(tree_id);
    let names = discover_sheets(&ctx, &mut tree, open_root)?;
    let mut out = Vec::new();
    for name in names {
        let config_path = join_path(&[open_root, ".gitsheets", &format!("{name}.toml")]);
        let sheet = Sheet::open(&ctx, &mut tree, &name, &config_path, open_root, "")?;
        out.push(SheetScope {
            base_dir: sheet.base().to_string(),
            extension: sheet.config().format.extension().to_string(),
            sheet,
        });
    }
    Ok(out)
}

fn sheet_for<'a>(sheets: &'a mut [SheetScope], path: &str) -> Option<&'a mut SheetScope> {
    sheets.iter_mut().find(|s| {
        let under = if s.base_dir.is_empty() || s.base_dir == "." {
            true
        } else {
            path.starts_with(&format!("{}/", s.base_dir))
        };
        under && path.ends_with(&s.extension)
    })
}

fn blob_text(repo: &gix::Repository, id: ObjectId) -> Result<String> {
    record::read_blob_text(repo, id)
}

/// Merge `opts.theirs` into `opts.ours` per `specs/behaviors/merge.md`. The
/// caller holds the write lock.
pub fn merge_sheets(repo: &gix::Repository, opts: &MergeOptions) -> Result<MergeResult> {
    let ours = resolve_commit(repo, &opts.ours)?;
    let theirs = resolve_commit(repo, &opts.theirs)?;
    let ours_ref = if is_likely_branch(&opts.ours) { Some(qualify_ref(&opts.ours)) } else { None };
    let mut result = MergeResult {
        outcome: MergeOutcome::UpToDate,
        ours_commit: ours.to_string(),
        theirs_commit: theirs.to_string(),
        base: None,
        tree: None,
        commit: None,
        merged_records: Vec::new(),
        conflicts: Vec::new(),
    };

    if ours == theirs || is_ancestor(repo, theirs, ours) {
        result.commit = Some(ours.to_string());
        return Ok(result);
    }
    if is_ancestor(repo, ours, theirs) {
        if opts.commit {
            if let Some(r) = &ours_ref {
                holo_repo::update_ref(repo, r, theirs, Some(ours)).map_err(failed("fast-forward"))?;
            }
        }
        result.outcome = if opts.commit { MergeOutcome::FastForward } else { MergeOutcome::DryRun };
        result.commit = Some(theirs.to_string());
        result.tree = Some(tree_of(repo, theirs)?.to_string());
        return Ok(result);
    }

    let base = repo.merge_base(ours, theirs).map_err(|e| Error::NotAnAncestor {
        message: format!("{} and {} share no history (no merge base): {e}", opts.ours, opts.theirs),
    })?;
    let base = base.detach();
    result.base = Some(base.to_string());
    let (base_tree, ours_tree, theirs_tree) = (tree_of(repo, base)?, tree_of(repo, ours)?, tree_of(repo, theirs)?);

    // 1. Tree merge.
    let labels = gix::merge::blob::builtin_driver::text::Labels {
        ancestor: Some("base".into()),
        current: Some("ours".into()),
        other: Some("theirs".into()),
    };
    let options = repo.tree_merge_options().map_err(failed("merge options"))?;
    let mut outcome = repo
        .merge_trees(base_tree, ours_tree, theirs_tree, labels, options)
        .map_err(failed("merge trees"))?;

    // 2. Record pass over paths changed on both sides.
    let ours_changes = blob_changes(repo, base_tree, ours_tree)?;
    let theirs_changes = blob_changes(repo, base_tree, theirs_tree)?;
    let mut sheets = open_sheets(repo, ours_tree, &opts.open_root)?;
    let mut handled: BTreeSet<String> = BTreeSet::new();
    for (path, (b, o)) in &ours_changes {
        let Some((_, t)) = theirs_changes.get(path) else { continue };
        if o == t {
            continue; // identical change on both sides — the tree merge took it
        }
        let Some(scope) = sheet_for(&mut sheets, path) else { continue };
        handled.insert(path.clone());
        match (b, o, t) {
            (Some(_), None, Some(t_id)) | (Some(_), Some(t_id), None) if (o.is_none()) != (t.is_none()) => {
                // delete/modify
                let (ours_side, theirs_side) = (*o, *t);
                match opts.prefer {
                    Prefer::Fail => result.conflicts.push(MergeConflict {
                        path: path.clone(),
                        kind: "delete-modify".into(),
                        field: None,
                        ours: ours_side.map(|i| i.to_string()),
                        theirs: theirs_side.map(|i| i.to_string()),
                    }),
                    Prefer::Ours | Prefer::Theirs => {
                        let chosen = if opts.prefer == Prefer::Ours { ours_side } else { theirs_side };
                        match chosen {
                            Some(id) => {
                                outcome.tree.upsert(path.as_str(), gix::object::tree::EntryKind::Blob, id).map_err(failed("upsert"))?;
                            }
                            None => {
                                outcome.tree.remove(path.as_str()).map_err(failed("remove"))?;
                            }
                        }
                        let _ = t_id;
                        result.merged_records.push(path.clone());
                    }
                }
            }
            (_, Some(o_id), Some(t_id)) => {
                let base_text = match b {
                    Some(id) => Some(blob_text(repo, *id)?),
                    None => None,
                };
                let ours_text = blob_text(repo, *o_id)?;
                let theirs_text = blob_text(repo, *t_id)?;
                let merged = merge_record_texts(&mut scope.sheet, base_text.as_deref(), &ours_text, &theirs_text, opts.prefer)?;
                match merged.text {
                    Some(text) => {
                        let id = record::parse_oid(&record::write_blob(repo, text.as_bytes())?)?;
                        outcome.tree.upsert(path.as_str(), gix::object::tree::EntryKind::Blob, id).map_err(failed("upsert"))?;
                        result.merged_records.push(path.clone());
                    }
                    None => {
                        for field in merged.conflicts {
                            result.conflicts.push(MergeConflict {
                                path: path.clone(),
                                kind: "field".into(),
                                field: Some(field),
                                ours: Some(o_id.to_string()),
                                theirs: Some(t_id.to_string()),
                            });
                        }
                    }
                }
            }
            _ => {} // both deleted — the tree merge handled it
        }
    }

    // 3. Whatever the tree merge could not resolve elsewhere.
    for conflict in &outcome.conflicts {
        if !conflict.is_unresolved(TreatAsUnresolved::default()) {
            continue;
        }
        let (ours_change, _theirs_change) = conflict.changes_in_resolution();
        let path = ours_change.location().to_string();
        if handled.contains(&path) {
            continue;
        }
        let entries = conflict.entries();
        let (ours_entry, theirs_entry) = (entries[1], entries[2]);
        let blob_sides = ours_entry.map(|e| e.mode.is_blob()).unwrap_or(true) && theirs_entry.map(|e| e.mode.is_blob()).unwrap_or(true);
        match (opts.prefer, blob_sides) {
            (Prefer::Fail, _) | (_, false) => result.conflicts.push(MergeConflict {
                path: path.clone(),
                kind: if blob_sides { "blob".into() } else { "tree".into() },
                field: None,
                ours: ours_entry.map(|e| e.id.to_string()),
                theirs: theirs_entry.map(|e| e.id.to_string()),
            }),
            (Prefer::Ours, true) | (Prefer::Theirs, true) => {
                let chosen = if opts.prefer == Prefer::Ours { ours_entry } else { theirs_entry };
                match chosen {
                    Some(e) => {
                        outcome.tree.upsert(path.as_str(), gix::object::tree::EntryKind::Blob, e.id).map_err(failed("upsert"))?;
                    }
                    None => {
                        outcome.tree.remove(path.as_str()).map_err(failed("remove"))?;
                    }
                }
            }
        }
    }

    if !result.conflicts.is_empty() {
        result.outcome = MergeOutcome::Conflict;
        return Ok(result);
    }

    // 4. Commit.
    let tree_id = outcome.tree.write().map_err(failed("write merged tree"))?.detach();
    result.tree = Some(tree_id.to_string());
    if !opts.commit {
        result.outcome = MergeOutcome::DryRun;
        return Ok(result);
    }
    let author = resolve_author(repo, opts.author.clone());
    let committer = opts.committer.clone().unwrap_or_else(|| author.clone());
    let author_sig = build_signature(&author, opts.time_seconds, opts.offset_minutes)?;
    let committer_sig = build_signature(&committer, opts.time_seconds, opts.offset_minutes)?;
    let message = opts
        .message
        .clone()
        .unwrap_or_else(|| format!("Merge {} into {}\n", opts.theirs, opts.ours));
    let commit = holo_repo::commit_tree(repo, tree_id, &[ours, theirs], &message, Some(author_sig), Some(committer_sig))
        .map_err(failed("commit-tree"))?;
    if let Some(r) = &ours_ref {
        holo_repo::update_ref(repo, r, commit, Some(ours)).map_err(failed("update-ref"))?;
    }
    result.outcome = MergeOutcome::Merged;
    result.commit = Some(commit.to_string());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical;
    use indexmap::IndexMap;

    fn tctx(repo: &gix::Repository) -> Context<'_> {
        Context::new(repo, Box::leak(Box::new(TreeCache::new())))
    }

    fn sig(name: &str) -> gix::actor::Signature {
        build_signature(&Author { name: name.into(), email: format!("{}@x.org", name.to_lowercase()) }, 1_600_000_000, 0).unwrap()
    }

    /// Commit `files` (path → text; `None` = delete) on top of `parent`.
    fn commit(repo: &gix::Repository, parent: Option<ObjectId>, files: &[(&str, Option<&str>)], msg: &str) -> ObjectId {
        let ctx = tctx(repo);
        let mut tree = match parent {
            Some(p) => holo_repo::create_tree_from_ref(repo, &p.to_string()).unwrap(),
            None => MutableTree::empty(),
        };
        for (path, text) in files {
            match text {
                Some(t) => {
                    tree.write_child(&ctx, path, t).unwrap();
                }
                None => {
                    tree.delete_child_deep(&ctx, path).unwrap();
                }
            }
        }
        let hash = tree.write(&ctx).unwrap();
        let parents: Vec<ObjectId> = parent.into_iter().collect();
        holo_repo::commit_tree(repo, hash, &parents, msg, Some(sig("Seed")), Some(sig("Seed"))).unwrap()
    }

    const CONFIG: &str = "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n";
    const JANE: &str = "email = \"jane@x.org\"\nname = \"Jane\"\nslug = \"jane\"\n";

    /// main at base (config + jane); `ours`/`theirs` branches off it.
    fn setup(ours_files: &[(&str, Option<&str>)], theirs_files: &[(&str, Option<&str>)]) -> (tempfile::TempDir, gix::Repository, ObjectId, ObjectId, ObjectId) {
        let dir = tempfile::tempdir().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        let base = commit(&repo, None, &[(".gitsheets/people.toml", Some(CONFIG)), ("people/jane.toml", Some(JANE)), ("README.md", Some("hi\n"))], "base\n");
        let o = commit(&repo, Some(base), ours_files, "ours\n");
        let t = commit(&repo, Some(base), theirs_files, "theirs\n");
        holo_repo::update_ref(&repo, "refs/heads/main", o, None).unwrap();
        holo_repo::update_ref(&repo, "refs/heads/import", t, None).unwrap();
        (dir, repo, base, o, t)
    }

    fn opts(prefer: Prefer) -> MergeOptions {
        MergeOptions {
            ours: "main".into(),
            theirs: "import".into(),
            open_root: ".".into(),
            prefer,
            commit: true,
            message: None,
            author: Some(Author { name: "Merger".into(), email: "m@x.org".into() }),
            committer: None,
            time_seconds: 1_700_000_000,
            offset_minutes: 0,
        }
    }

    fn blob(repo: &gix::Repository, commit: ObjectId, path: &str) -> Option<String> {
        let ctx = tctx(repo);
        let mut tree = holo_repo::create_tree_from_ref(repo, &commit.to_string()).unwrap();
        tree.read_blob(&ctx, path).unwrap().map(|b| String::from_utf8(b).unwrap())
    }

    fn tip(repo: &gix::Repository, r: &str) -> ObjectId {
        holo_repo::resolve_ref(repo, r).unwrap().unwrap()
    }

    #[test]
    fn merge_values_takes_each_side_s_change_and_recurses() {
        let v = |s: &str| canonical::parse(s).unwrap();
        let base = v("a = 1\nb = 1\n[n]\nx = 1\ny = 1\n");
        let ours = v("a = 2\nb = 1\n[n]\nx = 1\ny = 1\n");
        let theirs = v("a = 1\nb = 1\nc = 3\n[n]\nx = 1\ny = 9\n");
        let mut conflicts = Vec::new();
        let merged = merge_values(Some(&base), Some(&ours), Some(&theirs), Prefer::Fail, &mut conflicts).unwrap();
        assert!(conflicts.is_empty());
        assert_eq!(canonical::serialize(&merged).unwrap(), "a = 2\nb = 1\nc = 3\n\n[n]\nx = 1\ny = 9\n");

        // Both changed `a` differently → field conflict / policy.
        let theirs2 = v("a = 3\nb = 1\n[n]\nx = 1\ny = 1\n");
        let mut conflicts = Vec::new();
        merge_values(Some(&base), Some(&ours), Some(&theirs2), Prefer::Fail, &mut conflicts);
        assert_eq!(conflicts, vec!["a".to_string()]);
        let mut none = Vec::new();
        let m = merge_values(Some(&base), Some(&ours), Some(&theirs2), Prefer::Theirs, &mut none).unwrap();
        assert_eq!(canonical::serialize(&m).unwrap(), "a = 3\nb = 1\n\n[n]\nx = 1\ny = 1\n");
        assert!(none.is_empty());
    }

    #[test]
    fn disjoint_field_changes_merge_canonically_even_from_non_canonical_sides() {
        // theirs wrote the record in an old serialization (underscored int,
        // different key order); the merge output is canonical.
        let (_d, repo, base, o, t) = setup(
            &[("people/jane.toml", Some("email = \"jane@new.org\"\nname = \"Jane\"\nslug = \"jane\"\n"))],
            &[("people/jane.toml", Some("slug = \"jane\"\nname = \"Jane\"\nemail = \"jane@x.org\"\ngithubUserId = 458_494\n"))],
        );
        let r = merge_sheets(&repo, &opts(Prefer::Fail)).unwrap();
        assert_eq!(r.outcome, MergeOutcome::Merged, "{:?}", r.conflicts);
        assert_eq!(r.merged_records, vec!["people/jane.toml".to_string()]);
        assert_eq!(r.base.as_deref(), Some(base.to_string().as_str()));
        let commit = ObjectId::from_hex(r.commit.as_ref().unwrap().as_bytes()).unwrap();
        assert_eq!(tip(&repo, "refs/heads/main"), commit);
        let c = repo.find_commit(commit).unwrap();
        let parents: Vec<ObjectId> = c.parent_ids().map(|p| p.detach()).collect();
        assert_eq!(parents, vec![o, t]);
        assert_eq!(c.message_raw().unwrap().to_string(), "Merge import into main\n");
        assert_eq!(
            blob(&repo, commit, "people/jane.toml").as_deref(),
            Some("email = \"jane@new.org\"\ngithubUserId = 458494\nname = \"Jane\"\nslug = \"jane\"\n")
        );
        // The import branch is untouched.
        assert_eq!(tip(&repo, "refs/heads/import"), t);
    }

    #[test]
    fn field_conflict_fails_by_default_and_follows_prefer() {
        let (_d, repo, _b, o, _t) = setup(
            &[("people/jane.toml", Some("email = \"ours@x.org\"\nname = \"Jane\"\nslug = \"jane\"\n"))],
            &[("people/jane.toml", Some("email = \"theirs@x.org\"\nname = \"Jane\"\nslug = \"jane\"\n"))],
        );
        let r = merge_sheets(&repo, &opts(Prefer::Fail)).unwrap();
        assert_eq!(r.outcome, MergeOutcome::Conflict);
        assert_eq!(r.commit, None);
        assert_eq!(r.conflicts.len(), 1);
        assert_eq!((r.conflicts[0].kind.as_str(), r.conflicts[0].field.as_deref()), ("field", Some("email")));
        assert_eq!(tip(&repo, "refs/heads/main"), o);

        let r = merge_sheets(&repo, &opts(Prefer::Theirs)).unwrap();
        assert_eq!(r.outcome, MergeOutcome::Merged);
        let commit = ObjectId::from_hex(r.commit.as_ref().unwrap().as_bytes()).unwrap();
        assert_eq!(blob(&repo, commit, "people/jane.toml").as_deref(), Some("email = \"theirs@x.org\"\nname = \"Jane\"\nslug = \"jane\"\n"));
    }

    #[test]
    fn delete_modify_follows_prefer() {
        let modified = "email = \"jane@x.org\"\nname = \"Jane D\"\nslug = \"jane\"\n";
        let (_d, repo, _b, o, _t) = setup(&[("people/jane.toml", None)], &[("people/jane.toml", Some(modified))]);
        let r = merge_sheets(&repo, &opts(Prefer::Fail)).unwrap();
        assert_eq!(r.outcome, MergeOutcome::Conflict);
        assert_eq!(r.conflicts[0].kind, "delete-modify");
        assert!(r.conflicts[0].ours.is_none() && r.conflicts[0].theirs.is_some());
        assert_eq!(tip(&repo, "refs/heads/main"), o);

        let r = merge_sheets(&repo, &opts(Prefer::Theirs)).unwrap();
        assert_eq!(r.outcome, MergeOutcome::Merged);
        let commit = ObjectId::from_hex(r.commit.as_ref().unwrap().as_bytes()).unwrap();
        assert_eq!(blob(&repo, commit, "people/jane.toml").as_deref(), Some(modified));

        // Fresh branches for the ours side.
        holo_repo::update_ref(&repo, "refs/heads/main", o, None).unwrap();
        let r = merge_sheets(&repo, &opts(Prefer::Ours)).unwrap();
        assert_eq!(r.outcome, MergeOutcome::Merged);
        let commit = ObjectId::from_hex(r.commit.as_ref().unwrap().as_bytes()).unwrap();
        assert_eq!(blob(&repo, commit, "people/jane.toml"), None);
    }

    #[test]
    fn non_record_content_conflict_is_reported_as_blob_and_follows_prefer() {
        let (_d, repo, _b, _o, _t) = setup(&[("README.md", Some("ours\n"))], &[("README.md", Some("theirs\n"))]);
        let r = merge_sheets(&repo, &opts(Prefer::Fail)).unwrap();
        assert_eq!(r.outcome, MergeOutcome::Conflict);
        assert_eq!((r.conflicts[0].path.as_str(), r.conflicts[0].kind.as_str()), ("README.md", "blob"));
        let r = merge_sheets(&repo, &opts(Prefer::Ours)).unwrap();
        assert_eq!(r.outcome, MergeOutcome::Merged);
        let commit = ObjectId::from_hex(r.commit.as_ref().unwrap().as_bytes()).unwrap();
        assert_eq!(blob(&repo, commit, "README.md").as_deref(), Some("ours\n"));
    }

    #[test]
    fn dry_run_writes_the_tree_and_moves_nothing() {
        let (_d, repo, _b, o, _t) = setup(&[("people/bob.toml", Some("slug = \"bob\"\n"))], &[("people/amy.toml", Some("slug = \"amy\"\n"))]);
        let mut op = opts(Prefer::Fail);
        op.commit = false;
        let r = merge_sheets(&repo, &op).unwrap();
        assert_eq!(r.outcome, MergeOutcome::DryRun);
        assert!(r.tree.is_some() && r.commit.is_none());
        assert_eq!(tip(&repo, "refs/heads/main"), o);
    }

    #[test]
    fn up_to_date_and_fast_forward() {
        let (_d, repo, _b, o, t) = setup(&[], &[("people/amy.toml", Some("slug = \"amy\"\n"))]);
        // ours has no own commits beyond base? `setup` makes an empty ours commit; make main == base's child with nothing new:
        // theirs reachable from ours → up-to-date
        let mut op = opts(Prefer::Fail);
        op.ours = "import".into();
        op.theirs = "main".into();
        // main (o) is not an ancestor of import (t) — both are base children, so that is a real merge; test ff on a linear branch instead.
        holo_repo::update_ref(&repo, "refs/heads/linear", t, None).unwrap();
        let t2 = commit(&repo, Some(t), &[("people/cat.toml", Some("slug = \"cat\"\n"))], "more\n");
        holo_repo::update_ref(&repo, "refs/heads/import", t2, Some(t)).unwrap();
        let mut ff = opts(Prefer::Fail);
        ff.ours = "linear".into();
        let r = merge_sheets(&repo, &ff).unwrap();
        assert_eq!(r.outcome, MergeOutcome::FastForward);
        assert_eq!(tip(&repo, "refs/heads/linear"), t2);
        let r = merge_sheets(&repo, &ff).unwrap();
        assert_eq!(r.outcome, MergeOutcome::UpToDate);
        assert_eq!(tip(&repo, "refs/heads/linear"), t2);
        let _ = o;
    }

    #[test]
    fn unrelated_histories_are_not_an_ancestor() {
        let (_d, repo, _b, _o, _t) = setup(&[], &[]);
        let orphan = commit(&repo, None, &[("q.toml", Some("q = 1\n"))], "orphan\n");
        holo_repo::update_ref(&repo, "refs/heads/orphan", orphan, None).unwrap();
        let mut op = opts(Prefer::Fail);
        op.theirs = "orphan".into();
        assert_eq!(merge_sheets(&repo, &op).err().unwrap().code(), "not_an_ancestor");
    }

    #[test]
    fn merge_record_texts_is_the_driver_primitive() {
        let (_d, repo, base, _o, _t) = setup(&[], &[]);
        let ctx = tctx(&repo);
        let mut tree = holo_repo::create_tree_from_ref(&repo, &base.to_string()).unwrap();
        let mut sheet = Sheet::open(&ctx, &mut tree, "people", ".gitsheets/people.toml", ".", "").unwrap();
        let r = merge_record_texts(
            &mut sheet,
            Some(JANE),
            "email = \"jane@new.org\"\nname = \"Jane\"\nslug = \"jane\"\n",
            "slug = \"jane\"\nname = \"Jane\"\nemail = \"jane@x.org\"\ntags = [\"b\", \"a\"]\n",
            Prefer::Fail,
        )
        .unwrap();
        assert_eq!(r.text.as_deref(), Some("email = \"jane@new.org\"\nname = \"Jane\"\nslug = \"jane\"\ntags = [\"b\", \"a\"]\n"));
        let r = merge_record_texts(&mut sheet, Some(JANE), "email = \"a@x.org\"\nname = \"Jane\"\nslug = \"jane\"\n", "email = \"b@x.org\"\nname = \"Jane\"\nslug = \"jane\"\n", Prefer::Fail).unwrap();
        assert_eq!(r.text, None);
        assert_eq!(r.conflicts, vec!["email".to_string()]);
        let _ = IndexMap::<String, Value>::new();
    }
}
