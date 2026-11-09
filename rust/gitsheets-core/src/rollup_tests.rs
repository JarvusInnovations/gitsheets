//! Rollup tests (`specs/behaviors/rollups.md`): config resolution, the
//! canonical record, the commit-time pass, reads through the source,
//! materialize, merge, and sync.

use super::*;
use crate::merge::{merge_sheets, MergeOptions, MergeOutcome, Prefer};
use crate::sync::{sync_branch, ConflictPolicy, SyncOptions, SyncOutcome};
use crate::transaction::{build_signature, Author, Transaction, TransactionOptions};
use holo_tree::repo as holo_repo;

fn tctx(repo: &gix::Repository) -> Context<'_> {
    Context::new(repo, Box::leak(Box::new(holo_tree::TreeCache::new())))
}

const TX_CONFIG: &str = "[gitsheet]\nroot = 'transactions'\npath = '${{ postedAt: YYYY/MM }}/${{ id }}'\n";
const MONTHLY: &str = "[gitsheet]\nroot = 'transactions-monthly'\npath = '${{ postedAt: YYYY/MM }}'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\ncount = { count = true }\ntotal = { sum = 'amountCents' }\nlargest = { max = 'amountCents' }\nposted = { sum = 'amountCents', where = { status = 'posted' } }\nbyCategory = { sum = 'amountCents', groupBy = 'category' }\n";

fn txn(id: &str, posted: &str, cents: i64, status: &str, category: &str) -> String {
    format!("amountCents = {cents}\ncategory = \"{category}\"\nid = \"{id}\"\npostedAt = {posted}\nstatus = \"{status}\"\n")
}

fn sig() -> gix::actor::Signature {
    build_signature(&Author { name: "Seed".into(), email: "seed@x.org".into() }, 1_600_000_000, 0).unwrap()
}

/// Commit raw `files` (path → text, `None` deletes) onto `parent` — a plain
/// git write that runs no rollup pass.
fn raw_commit(repo: &gix::Repository, parent: Option<ObjectId>, files: &[(&str, Option<&str>)]) -> ObjectId {
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
    holo_repo::commit_tree(repo, hash, &parents, "raw\n", Some(sig()), Some(sig())).unwrap()
}

/// A repo whose `main` (HEAD) holds `files`, committed raw.
fn setup(files: &[(&str, &str)]) -> (tempfile::TempDir, String, gix::Repository) {
    let dir = tempfile::tempdir().unwrap();
    let repo = gix::init(dir.path()).unwrap();
    let files: Vec<(&str, Option<&str>)> = files.iter().map(|(p, t)| (*p, Some(*t))).collect();
    let c = raw_commit(&repo, None, &files);
    holo_repo::update_ref(&repo, "refs/heads/main", c, None).unwrap();
    std::fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let git_dir = dir.path().join(".git").to_string_lossy().into_owned();
    (dir, git_dir, repo)
}

fn opts() -> TransactionOptions {
    TransactionOptions {
        parent: None,
        orphan: false,
        branch: None,
        author: Some(Author { name: "Jane".into(), email: "jane@x.org".into() }),
        committer: None,
        message: "tx\n".into(),
        trailers: vec![],
        time_seconds: 1_700_000_000,
        offset_minutes: 0,
    }
}

enum Op<'a> {
    Upsert(&'a str, String),
    Delete(&'a str, &'a str),
    RawWrite(&'a str, &'a str),
}

/// One transaction applying `ops` (sheets opened at `prefix`), finalized.
fn transact(git_dir: &str, prefix: &str, ops: &[Op<'_>]) -> Result<Option<String>> {
    let mut tx = Transaction::begin(git_dir, opts())?;
    let mut sheets: BTreeMap<String, Sheet> = BTreeMap::new();
    for op in ops {
        let name = match op {
            Op::Upsert(n, _) | Op::Delete(n, _) => *n,
            Op::RawWrite(..) => continue,
        };
        if !sheets.contains_key(name) {
            let s = tx.open_sheet(name, &format!(".gitsheets/{name}.toml"), ".", prefix)?;
            sheets.insert(name.to_string(), s);
        }
    }
    for op in ops {
        let (ctx, tree) = tx.split();
        match op {
            Op::Upsert(n, text) => {
                let sheet = sheets.get_mut(*n).unwrap();
                let c = sheet.prepare_upsert(&ctx, tree, &canonical::parse(text)?, None, false)?;
                sheet.stage_upsert(&ctx, tree, &c)?;
            }
            Op::Delete(n, path) => sheets.get_mut(*n).unwrap().delete_at_path(&ctx, tree, path)?,
            Op::RawWrite(path, text) => {
                tree.write_child(&ctx, path, text).map_err(record::map_ht)?;
            }
        }
    }
    tx.mark_mutated();
    Ok(tx.finalize()?.commit_hash)
}

fn head(repo: &gix::Repository) -> ObjectId {
    holo_repo::resolve_ref(repo, "refs/heads/main").unwrap().unwrap()
}

fn blob_at(repo: &gix::Repository, rev: ObjectId, path: &str) -> Option<String> {
    let ctx = tctx(repo);
    let mut tree = holo_repo::create_tree_from_ref(repo, &rev.to_string()).unwrap();
    tree.read_blob(&ctx, path).unwrap().map(|b| String::from_utf8(b).unwrap())
}

fn tree_id_at(repo: &gix::Repository, rev: ObjectId, path: &str) -> String {
    let ctx = tctx(repo);
    let mut tree = holo_repo::create_tree_from_ref(repo, &rev.to_string()).unwrap();
    tree.get_subtree(&ctx, path).unwrap().unwrap().write(&ctx).unwrap().to_string()
}

/// Paths under `prefix/` whose blob differs between two commits.
fn changed_under(repo: &gix::Repository, a: ObjectId, b: ObjectId, prefix: &str) -> Vec<String> {
    let ctx = tctx(repo);
    let mut ta = holo_repo::create_tree_from_ref(repo, &a.to_string()).unwrap();
    let mut tb = holo_repo::create_tree_from_ref(repo, &b.to_string()).unwrap();
    let ma: BTreeMap<String, ObjectId> = match ta.get_subtree(&ctx, prefix).unwrap() {
        Some(t) => t.get_blob_map(&ctx).unwrap().into_iter().map(|(p, i)| (p, i.hash)).collect(),
        None => BTreeMap::new(),
    };
    let mb: BTreeMap<String, ObjectId> = match tb.get_subtree(&ctx, prefix).unwrap() {
        Some(t) => t.get_blob_map(&ctx).unwrap().into_iter().map(|(p, i)| (p, i.hash)).collect(),
        None => BTreeMap::new(),
    };
    let keys: BTreeSet<&String> = ma.keys().chain(mb.keys()).collect();
    keys.into_iter().filter(|k| ma.get(*k) != mb.get(*k)).cloned().collect()
}

/// Open `name` against the tree at `rev`.
fn open_at(repo: &gix::Repository, rev: ObjectId, name: &str, prefix: &str) -> (Sheet, MutableTree) {
    let ctx = tctx(repo);
    let mut tree = holo_repo::create_tree_from_ref(repo, &rev.to_string()).unwrap();
    let sheet = Sheet::open(&ctx, &mut tree, name, &format!(".gitsheets/{name}.toml"), ".", prefix).unwrap();
    (sheet, tree)
}

fn open_err(files: &[(&str, &str)], name: &str) -> Error {
    let (_d, _g, repo) = setup(files);
    let ctx = tctx(&repo);
    let mut tree = holo_repo::create_tree_from_ref(&repo, &head(&repo).to_string()).unwrap();
    match Sheet::open(&ctx, &mut tree, name, &format!(".gitsheets/{name}.toml"), ".", "") {
        Ok(_) => panic!("expected open of {name} to fail"),
        Err(e) => e,
    }
}

fn base_fixture() -> (tempfile::TempDir, String, gix::Repository) {
    setup(&[(".gitsheets/transactions.toml", TX_CONFIG), (".gitsheets/transactions-monthly.toml", MONTHLY)])
}

fn seed_three_months(git_dir: &str) {
    transact(
        git_dir,
        "",
        &[
            Op::Upsert("transactions", txn("a", "2026-01-10T12:00:00Z", 1000, "posted", "rent")),
            Op::Upsert("transactions", txn("b", "2026-02-11T12:00:00Z", 2000, "pending", "groceries")),
            Op::Upsert("transactions", txn("c", "2026-03-05T09:00:00Z", 1200, "posted", "groceries")),
            Op::Upsert("transactions", txn("d", "2026-03-20T09:00:00Z", 240000, "posted", "rent")),
        ],
    )
    .unwrap()
    .unwrap();
}

#[test]
fn the_rollup_record_is_the_canonical_fold_with_key_and_stamp() {
    let (_d, git_dir, repo) = base_fixture();
    seed_three_months(&git_dir);
    let c = head(&repo);
    let march = blob_at(&repo, c, "transactions-monthly/2026/03.toml").unwrap();
    let stamp = tree_id_at(&repo, c, "transactions/2026/03");
    assert_eq!(
        march,
        format!(
            "count = 2\nlargest = 240000\nposted = 241200\npostedAt = 2026-03-01\nsourceTree = \"{stamp}\"\ntotal = 241200\n\n[byCategory]\ngroceries = 1200\nrent = 240000\n"
        )
    );
    // An aggregate with no contributing record is omitted; sum is 0.
    let feb = blob_at(&repo, c, "transactions-monthly/2026/02.toml").unwrap();
    assert!(feb.contains("posted = 0\n"), "{feb}");
    assert!(blob_at(&repo, c, "transactions-monthly/2026/01.toml").is_some());
}

#[test]
fn a_transaction_regenerates_exactly_the_partitions_it_touched() {
    let (_d, git_dir, repo) = base_fixture();
    seed_three_months(&git_dir);
    let before = head(&repo);
    transact(
        &git_dir,
        "",
        &[
            Op::Upsert("transactions", txn("e", "2026-02-20T12:00:00Z", 500, "posted", "fun")),
            Op::Upsert("transactions", txn("f", "2026-03-21T12:00:00Z", 700, "posted", "fun")),
        ],
    )
    .unwrap()
    .unwrap();
    let after = head(&repo);
    assert_eq!(changed_under(&repo, before, after, "transactions-monthly"), vec!["2026/02.toml", "2026/03.toml"]);
    // One commit carries both the records and the rollups.
    assert_eq!(changed_under(&repo, before, after, "transactions"), vec!["2026/02/e.toml", "2026/03/f.toml"]);
}

#[test]
fn deleting_a_months_last_record_deletes_its_rollup_in_the_same_commit() {
    let (_d, git_dir, repo) = base_fixture();
    seed_three_months(&git_dir);
    transact(&git_dir, "", &[Op::Delete("transactions", "2026/01/a")]).unwrap().unwrap();
    assert!(blob_at(&repo, head(&repo), "transactions-monthly/2026/01.toml").is_none());
    assert!(blob_at(&repo, head(&repo), "transactions-monthly/2026/02.toml").is_some());
}

#[test]
fn raw_tx_writes_count_as_changes() {
    let (_d, git_dir, repo) = base_fixture();
    seed_three_months(&git_dir);
    let text = txn("z", "2026-01-15T00:00:00Z", 1, "posted", "rent");
    transact(&git_dir, "", &[Op::RawWrite("transactions/2026/01/z.toml", &text)]).unwrap().unwrap();
    let jan = blob_at(&repo, head(&repo), "transactions-monthly/2026/01.toml").unwrap();
    assert!(jan.contains("count = 2\n"), "{jan}");
}

#[test]
fn a_stale_stamp_is_recomputed_on_read_and_persisted_by_materialize() {
    let (_d, git_dir, repo) = base_fixture();
    seed_three_months(&git_dir);
    // A plain git write (no pass): March gains a record; January loses its
    // only one; a stray directory appears under the source root.
    let extra = txn("g", "2026-03-30T00:00:00Z", 5, "posted", "fun");
    let c = raw_commit(
        &repo,
        Some(head(&repo)),
        &[
            ("transactions/2026/03/g.toml", Some(&extra)),
            ("transactions/2026/01/a.toml", None),
            ("transactions/notes/readme/x.toml", Some("x = 1\n")),
        ],
    );
    holo_repo::update_ref(&repo, "refs/heads/main", c, None).unwrap();

    let ctx = tctx(&repo);
    let (mut sheet, mut tree) = open_at(&repo, c, "transactions-monthly", "");
    let read = sheet.rollup_query(&ctx, &mut tree, &Filter::new(), Stale::Recompute).unwrap();
    let paths: Vec<&str> = read.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(paths, vec!["2026/02", "2026/03"], "orphaned January is not yielded");
    let Value::Table(m) = &read[1].1 else { panic!() };
    assert_eq!(m.get("count"), Some(&Value::Integer(3)));
    assert_eq!(
        m.get(SOURCE_TREE_FIELD),
        Some(&Value::String(tree_id_at(&repo, c, "transactions/2026/03")))
    );
    // `serve` yields what the commit claimed.
    let served = sheet.rollup_query(&ctx, &mut tree, &Filter::new(), Stale::Serve).unwrap();
    assert_eq!(served.len(), 3);
    let Value::Table(m) = &served[2].1 else { panic!() };
    assert_eq!(m.get("count"), Some(&Value::Integer(2)));
    // get reads through too.
    let got = sheet.rollup_get(&ctx, &mut tree, "2026/03", Stale::Recompute).unwrap().unwrap();
    assert_eq!(got, read[1].1);
    assert!(sheet.rollup_get(&ctx, &mut tree, "2026/01", Stale::Recompute).unwrap().is_none());

    let survey: Vec<(String, RollupStatus)> = sheet
        .rollup_survey(&ctx, &mut tree)
        .unwrap()
        .into_iter()
        .filter(|e| e.status != RollupStatus::Fresh)
        .map(|e| (e.path, e.status))
        .collect();
    assert_eq!(
        survey,
        vec![("2026/01".to_string(), RollupStatus::Orphaned), ("2026/03".to_string(), RollupStatus::Stale)]
    );

    // Materialize in a transaction: one commit, then everything is fresh.
    let mut tx = Transaction::begin(&git_dir, opts()).unwrap();
    let mut s = tx.open_sheet("transactions-monthly", ".gitsheets/transactions-monthly.toml", ".", "").unwrap();
    let out = {
        let (ctx, tree) = tx.split();
        s.materialize(&ctx, tree).unwrap()
    };
    assert_eq!(out.recomputed, vec!["2026/03"]);
    assert_eq!(out.deleted, vec!["2026/01"]);
    tx.mark_mutated();
    let r = tx.finalize().unwrap();
    assert!(r.commit_hash.is_some());
    let (mut sheet, mut tree) = open_at(&repo, head(&repo), "transactions-monthly", "");
    assert!(sheet.rollup_survey(&ctx, &mut tree).unwrap().iter().all(|e| e.status == RollupStatus::Fresh));
    // A fresh materialize is a no-op.
    let mut tx = Transaction::begin(&git_dir, opts()).unwrap();
    let mut s = tx.open_sheet("transactions-monthly", ".gitsheets/transactions-monthly.toml", ".", "").unwrap();
    let out = {
        let (ctx, tree) = tx.split();
        s.materialize(&ctx, tree).unwrap()
    };
    assert!(out.is_empty());
    tx.discard();
}

#[test]
fn a_transaction_bound_read_sees_staged_changes() {
    let (_d, git_dir, _repo) = base_fixture();
    seed_three_months(&git_dir);
    let mut tx = Transaction::begin(&git_dir, opts()).unwrap();
    let mut src = tx.open_sheet("transactions", ".gitsheets/transactions.toml", ".", "").unwrap();
    let mut roll = tx.open_sheet("transactions-monthly", ".gitsheets/transactions-monthly.toml", ".", "").unwrap();
    let (ctx, tree) = tx.split();
    let rec = canonical::parse(&txn("h", "2026-03-02T00:00:00Z", 1, "posted", "fun")).unwrap();
    let c = src.prepare_upsert(&ctx, tree, &rec, None, false).unwrap();
    src.stage_upsert(&ctx, tree, &c).unwrap();
    let got = roll.read_record(&ctx, tree, "2026/03", true, Stale::Recompute).unwrap().unwrap();
    let Value::Table(m) = got else { panic!() };
    assert_eq!(m.get("count"), Some(&Value::Integer(3)));
    tx.discard();
}

fn date(s: &str) -> Value {
    canonical::parse(&format!("d = {s}\n")).map(|v| match v {
        Value::Table(mut t) => t.shift_remove("d").unwrap(),
        _ => unreachable!(),
    })
    .unwrap()
}

#[test]
fn rollup_queries_prune_by_key_fields_like_the_source() {
    let (_d, git_dir, repo) = base_fixture();
    seed_three_months(&git_dir);
    let ctx = tctx(&repo);
    let (mut sheet, mut tree) = open_at(&repo, head(&repo), "transactions-monthly", "");
    let mut range = IndexMap::new();
    range.insert("$gte".to_string(), Value::String("2026-02-01".into()));
    range.insert("$lte".to_string(), Value::String("2026-02-28".into()));
    let mut f = Filter::new();
    f.push("postedAt", query::FilterPred::Range(query::Range::from_table(&range).unwrap()));
    let rows = sheet.rollup_query(&ctx, &mut tree, &f, Stale::Recompute).unwrap();
    assert_eq!(rows.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), vec!["2026/02"]);
    // The plan prunes the walk: only February's subtree is admitted.
    let def = sheet.rollup.as_ref().unwrap();
    let plan = def.source_template.plan_query(&query::prune_record(&f), &mut sheet.engine).unwrap();
    let mut t = holo_repo::create_tree_from_ref(&repo, &head(&repo).to_string()).unwrap();
    let base = t.get_subtree(&ctx, "transactions").unwrap().unwrap();
    let found = query::walk_partitions(&ctx, base, &plan, 2).unwrap();
    assert_eq!(found.len(), 1);
    // Equality on the key field (the period-start date) and on an aggregate.
    let mut f = Filter::new();
    f.push("postedAt", query::FilterPred::Equals(date("2026-03-01")));
    assert_eq!(sheet.rollup_query(&ctx, &mut tree, &f, Stale::Recompute).unwrap().len(), 1);
    let mut f = Filter::new();
    f.push("count", query::FilterPred::Equals(Value::Integer(1)));
    assert_eq!(sheet.rollup_query(&ctx, &mut tree, &f, Stale::Recompute).unwrap().len(), 2);
}

#[test]
fn prefix_scopes_both_roots() {
    let (_d, git_dir, repo) = base_fixture();
    transact(
        &git_dir,
        "acme",
        &[Op::Upsert("transactions", txn("a", "2026-03-10T12:00:00Z", 10, "posted", "rent"))],
    )
    .unwrap()
    .unwrap();
    let c = head(&repo);
    let text = blob_at(&repo, c, "transactions-monthly/acme/2026/03.toml").expect("prefixed rollup");
    assert!(text.contains(&tree_id_at(&repo, c, "transactions/acme/2026/03")));
    // Nothing at the unprefixed scope.
    let ctx = tctx(&repo);
    let mut t = holo_repo::create_tree_from_ref(&repo, &c.to_string()).unwrap();
    let listed = t.get_subtree(&ctx, "transactions-monthly").unwrap().unwrap().get_blob_map(&ctx).unwrap();
    assert_eq!(listed.keys().collect::<Vec<_>>(), vec!["acme/2026/03.toml"]);
    // The unprefixed rollup sheet sees no partitions (`acme` is no year).
    let (mut sheet, mut tree) = open_at(&repo, c, "transactions-monthly", "");
    assert!(sheet.rollup_query(&ctx, &mut tree, &Filter::new(), Stale::Recompute).unwrap().is_empty());
    let (mut sheet, mut tree) = open_at(&repo, c, "transactions-monthly", "acme");
    assert_eq!(sheet.rollup_query(&ctx, &mut tree, &Filter::new(), Stale::Recompute).unwrap().len(), 1);
}

#[test]
fn generated_records_are_schema_validated() {
    let cfg = format!(
        "{MONTHLY}\n[gitsheet.schema]\ntype = 'object'\nrequired = ['postedAt']\nadditionalProperties = false\n[gitsheet.schema.properties.postedAt]\n[gitsheet.schema.properties.sourceTree]\n[gitsheet.schema.properties.count]\n"
    );
    let (_d, git_dir, repo) = setup(&[(".gitsheets/transactions.toml", TX_CONFIG), (".gitsheets/transactions-monthly.toml", &cfg)]);
    let before = head(&repo);
    let err = transact(&git_dir, "", &[Op::Upsert("transactions", txn("a", "2026-03-10T12:00:00Z", 10, "posted", "rent"))]).unwrap_err();
    assert_eq!(err.code(), "validation_failed", "{err:?}");
    assert_eq!(head(&repo), before, "nothing moves");
}

#[test]
fn an_aggregation_error_aborts_the_commit_and_names_the_partition() {
    let cfg = MONTHLY.replace("largest = { max = 'amountCents' }", "largest = { max = 'note' }");
    let (_d, git_dir, repo) = setup(&[(".gitsheets/transactions.toml", TX_CONFIG), (".gitsheets/transactions-monthly.toml", &cfg)]);
    let before = head(&repo);
    let mut a = txn("a", "2026-03-10T12:00:00Z", 10, "posted", "rent");
    a.push_str("note = \"x\"\n");
    let mut b = txn("b", "2026-03-11T12:00:00Z", 10, "posted", "rent");
    b.push_str("note = 5\n");
    let err = transact(&git_dir, "", &[Op::Upsert("transactions", a), Op::Upsert("transactions", b)]).unwrap_err();
    match &err {
        Error::AggregationFailed { sheet, aggregate, partition, .. } => {
            assert_eq!(sheet, "transactions-monthly");
            assert_eq!(aggregate, "largest");
            assert_eq!(partition.as_deref(), Some("2026/03"));
        }
        other => panic!("expected aggregation_failed, got {other:?}"),
    }
    assert_eq!(head(&repo), before);
}

#[test]
fn rollup_sheets_are_read_only() {
    let (_d, git_dir, _repo) = base_fixture();
    seed_three_months(&git_dir);
    let mut tx = Transaction::begin(&git_dir, opts()).unwrap();
    let mut s = tx.open_sheet("transactions-monthly", ".gitsheets/transactions-monthly.toml", ".", "").unwrap();
    let (ctx, tree) = tx.split();
    let rec = canonical::parse("postedAt = 2026-03-01\ncount = 1\n").unwrap();
    for err in [
        s.prepare_upsert(&ctx, tree, &rec, None, false).map(|_| ()).unwrap_err(),
        s.delete_at_path(&ctx, tree, "2026/03").unwrap_err(),
        s.clear(&ctx, tree).unwrap_err(),
        s.set_attachments(&ctx, tree, "2026/03", &[]).unwrap_err(),
        s.delete_attachment(&ctx, tree, "2026/03", "x").unwrap_err(),
        s.delete_attachments(&ctx, tree, "2026/03").map(|_| ()).unwrap_err(),
    ] {
        assert_eq!(err.code(), "sheet_derived");
        assert_eq!(err.class().as_str(), "TransactionError");
        assert!(err.message().contains("transactions-monthly") && err.message().contains("transactions"));
    }
    tx.discard();
}

#[test]
fn whole_sheet_iso_week_and_plain_field_partitions() {
    let whole = "[gitsheet]\nroot = 'totals'\npath = 'all'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\nn = { count = true }\n";
    let weekly_src = "[gitsheet]\nroot = 'events'\npath = '${{ at: YYYY/WW }}/${{ id }}'\n";
    let weekly = "[gitsheet]\nroot = 'events-weekly'\npath = '${{ at: YYYY/WW }}'\n\n[gitsheet.rollup]\nfrom = 'events'\n\n[gitsheet.rollup.aggregates]\nn = { count = true }\n";
    let domain_src = "[gitsheet]\nroot = 'pages'\npath = '${{ domain }}/${{ slug }}'\n";
    let by_domain = "[gitsheet]\nroot = 'pages-by-domain'\npath = '${{ domain }}'\n\n[gitsheet.rollup]\nfrom = 'pages'\n\n[gitsheet.rollup.aggregates]\nn = { count = true }\nslugs = { distinct = 'slug' }\n";
    let (_d, git_dir, repo) = setup(&[
        (".gitsheets/transactions.toml", TX_CONFIG),
        (".gitsheets/totals.toml", whole),
        (".gitsheets/events.toml", weekly_src),
        (".gitsheets/events-weekly.toml", weekly),
        (".gitsheets/pages.toml", domain_src),
        (".gitsheets/pages-by-domain.toml", by_domain),
    ]);
    transact(
        &git_dir,
        "",
        &[
            Op::Upsert("transactions", txn("a", "2026-03-10T12:00:00Z", 10, "posted", "rent")),
            Op::Upsert("transactions", txn("b", "2025-12-10T12:00:00Z", 10, "posted", "rent")),
            // 2027-01-01 is ISO 2026-W53; its Monday is 2026-12-28.
            Op::Upsert("events", "id = 'e1'\nat = 2027-01-01T10:00:00Z\n".to_string()),
            Op::Upsert("pages", "domain = 'example.com'\nslug = 'b'\n".to_string()),
            Op::Upsert("pages", "domain = 'example.com'\nslug = 'a'\n".to_string()),
        ],
    )
    .unwrap()
    .unwrap();
    let c = head(&repo);
    assert_eq!(
        blob_at(&repo, c, "totals/all.toml").unwrap(),
        format!("n = 2\nsourceTree = \"{}\"\n", tree_id_at(&repo, c, "transactions"))
    );
    let week = blob_at(&repo, c, "events-weekly/2026/53.toml").unwrap();
    assert!(week.starts_with("at = 2026-12-28\nn = 1\n"), "{week}");
    let dom = blob_at(&repo, c, "pages-by-domain/example.com.toml").unwrap();
    assert!(dom.starts_with("domain = \"example.com\"\nn = 2\n"), "{dom}");
    assert!(dom.contains("slugs = [\"a\", \"b\"]"), "{dom}");
}

#[test]
fn every_rollup_config_problem_is_config_invalid_at_open() {
    let src = (".gitsheets/transactions.toml", TX_CONFIG);
    let case = |body: &str| -> Error {
        let cfg = format!("[gitsheet]\n{body}");
        open_err(&[src, (".gitsheets/r.toml", cfg.as_str())], "r")
    };
    let aggs = "\n[gitsheet.rollup.aggregates]\nn = { count = true }\n";
    let roll = |root: &str, path: &str| format!("root = '{root}'\npath = '{path}'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n{aggs}");
    let cases: Vec<(String, &str)> = vec![
        (roll("r", "${{ postedAt: YYYY/MM }}/${{ id }}"), "proper prefix"),
        (roll("r", "${{ id }}"), "not a prefix"),
        (roll("r", "${{ postedAt.getUTCFullYear() }}"), "only literal"),
        (roll("transactions", "${{ postedAt: YYYY }}"), "overlaps"),
        (roll(".", "${{ postedAt: YYYY }}"), "overlaps"),
        (roll("transactions/sub", "${{ postedAt: YYYY }}"), "overlaps"),
        (format!("root = 'r'\npath = 'all'\n\n[gitsheet.rollup]\nfrom = 'nope'\n{aggs}"), "no source sheet"),
        (format!("root = 'r'\npath = 'all'\n\n[gitsheet.rollup]\nfrom = 'r'\n{aggs}"), "rollups over rollups"),
        (format!("root = 'r'\npath = 'all'\n\n[gitsheet.format]\ntype = 'markdown'\nbody = 'b'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n{aggs}"), "TOML records"),
        ("root = 'r'\npath = '${{ postedAt: YYYY }}'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\npostedAt = { count = true }\n".to_string(), "collides"),
        ("root = 'r'\npath = 'all'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\nsourceTree = { count = true }\n".to_string(), "collides"),
        ("root = 'r'\npath = 'all'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\nn = { sum = 3 }\n".to_string(), "aggregate"),
        (format!("root = 'r'\npath = 'all'\n\n[gitsheet.rollup]\nfrom = 'transactions'\nwhere = 1\n{aggs}"), "unknown key"),
        ("root = 'r'\npath = 'all'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n".to_string(), "aggregates"),
    ];
    for (body, needle) in cases {
        let err = case(&body);
        assert_eq!(err.code(), "config_invalid", "{body}: {err:?}");
        assert!(err.message().contains(needle), "{body}: expected {needle:?} in {}", err.message());
    }
    // YYYY/WW only whole; a body-field reference on a content-typed source.
    let wk = "[gitsheet]\nroot = 'e'\npath = '${{ at: YYYY/WW }}/${{ id }}'\n";
    let err = open_err(
        &[(".gitsheets/e.toml", wk), (".gitsheets/r.toml", &format!("[gitsheet]\nroot = 'r'\npath = '${{{{ at: YYYY }}}}'\n\n[gitsheet.rollup]\nfrom = 'e'\n{aggs}"))],
        "r",
    );
    assert!(err.message().contains("YYYY/WW") || err.message().contains("not a prefix"), "{}", err.message());
    let md = "[gitsheet]\nroot = 'posts'\npath = '${{ slug }}/x'\n\n[gitsheet.format]\ntype = 'markdown'\nbody = 'content'\n";
    let err = open_err(
        &[(".gitsheets/posts.toml", md), (".gitsheets/r.toml", "[gitsheet]\nroot = 'r'\npath = 'all'\n\n[gitsheet.rollup]\nfrom = 'posts'\n\n[gitsheet.rollup.aggregates]\nw = { distinct = 'content' }\n")],
        "r",
    );
    assert_eq!(err.code(), "config_invalid");
    assert!(err.message().contains("body"), "{}", err.message());
    // A YYYY cut of a YYYY/MM/DD source is fine.
    let daily = "[gitsheet]\nroot = 'd'\npath = '${{ at: YYYY/MM/DD }}/${{ id }}'\n";
    let (_d, _g, repo) = setup(&[(".gitsheets/d.toml", daily), (".gitsheets/y.toml", &format!("[gitsheet]\nroot = 'y'\npath = '${{{{ at: YYYY }}}}'\n\n[gitsheet.rollup]\nfrom = 'd'\n{aggs}"))]);
    let (s, _) = open_at(&repo, head(&repo), "y", "");
    assert!(s.is_rollup());
}

#[test]
fn reduce_rollups_run_in_a_deterministic_realm() {
    let roll = |body: &str| {
        format!("[gitsheet]\nroot = 'r'\npath = 'all'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\nv = {{ reduce = '{body}', initial = 0 }}\n")
    };
    for (body, ok) in [
        ("return Math.random()", false),
        ("return Date.now()", false),
        ("return new Date().getTime()", false),
        ("return Date()", false),
        ("return new Date(86400000).getHours() + new Date(0).getTimezoneOffset()", true),
        ("return Date.UTC(2026, 0, 1) + Date.parse(\"2026-01-01T00:00:00Z\")", true),
        ("return (new Date(0) instanceof Date) ? 1 : 0", true),
    ] {
        let cfg = roll(body);
        let (_d, git_dir, repo) = setup(&[(".gitsheets/transactions.toml", TX_CONFIG), (".gitsheets/r.toml", &cfg)]);
        let res = transact(&git_dir, "", &[Op::Upsert("transactions", txn("a", "2026-03-10T12:00:00Z", 10, "posted", "rent"))]);
        if ok {
            res.unwrap_or_else(|e| panic!("{body}: {e:?}"));
            let text = blob_at(&repo, head(&repo), "r/all.toml").unwrap();
            if body.contains("getHours") {
                assert!(text.contains("v = 0\n"), "UTC local time: {text}");
            }
            if body.contains("instanceof") {
                assert!(text.contains("v = 1\n"), "{text}");
            }
        } else {
            let err = res.unwrap_err();
            assert_eq!(err.code(), "aggregation_failed", "{body}: {err:?}");
            assert!(err.message().contains("not available"), "{body}: {}", err.message());
        }
    }
}

#[test]
fn a_config_added_over_existing_data_backfills_in_its_commit() {
    let (_d, git_dir, repo) = setup(&[(".gitsheets/transactions.toml", TX_CONFIG)]);
    seed_three_months(&git_dir);
    assert!(blob_at(&repo, head(&repo), "transactions-monthly/2026/01.toml").is_none());
    transact(&git_dir, "", &[Op::RawWrite(".gitsheets/transactions-monthly.toml", MONTHLY)]).unwrap().unwrap();
    for m in ["01", "02", "03"] {
        assert!(blob_at(&repo, head(&repo), &format!("transactions-monthly/2026/{m}.toml")).is_some());
    }
}

#[test]
fn a_sheet_aware_merge_regenerates_rollups_over_both_sides() {
    let (_d, git_dir, repo) = base_fixture();
    seed_three_months(&git_dir);
    let base = head(&repo);
    holo_repo::update_ref(&repo, "refs/heads/import", base, None).unwrap();
    transact(&git_dir, "", &[Op::Upsert("transactions", txn("x", "2026-03-11T00:00:00Z", 1, "posted", "fun"))]).unwrap();
    // The other branch, through a transaction on it.
    let mut o = opts();
    o.parent = Some("import".into());
    let mut tx = Transaction::begin(&git_dir, o).unwrap();
    let mut s = tx.open_sheet("transactions", ".gitsheets/transactions.toml", ".", "").unwrap();
    {
        let (ctx, tree) = tx.split();
        let rec = canonical::parse(&txn("y", "2026-03-12T00:00:00Z", 2, "posted", "fun")).unwrap();
        let c = s.prepare_upsert(&ctx, tree, &rec, None, false).unwrap();
        s.stage_upsert(&ctx, tree, &c).unwrap();
    }
    tx.mark_mutated();
    tx.finalize().unwrap();

    for commit in [false, true] {
        let r = merge_sheets(
            &repo,
            &MergeOptions {
                ours: "main".into(),
                theirs: "import".into(),
                open_root: ".".into(),
                prefer: Prefer::Fail,
                commit,
                message: None,
                author: Some(Author { name: "M".into(), email: "m@x.org".into() }),
                committer: None,
                time_seconds: 1_700_000_000,
                offset_minutes: 0,
            },
        )
        .unwrap();
        assert!(r.conflicts.is_empty(), "{:?}", r.conflicts);
        assert_eq!(r.outcome, if commit { MergeOutcome::Merged } else { MergeOutcome::DryRun });
        let tree = ObjectId::from_hex(r.tree.unwrap().as_bytes()).unwrap();
        let ctx = tctx(&repo);
        let mut t = MutableTree::new(tree);
        let march = String::from_utf8(t.read_blob(&ctx, "transactions-monthly/2026/03.toml").unwrap().unwrap()).unwrap();
        assert!(march.contains("count = 4\n"), "{march}");
        let stamp = t.get_subtree(&ctx, "transactions/2026/03").unwrap().unwrap().write(&ctx).unwrap();
        assert!(march.contains(&stamp.to_string()));
    }
}

#[test]
fn a_sync_replay_carries_rollups_over_both_sets_of_records() {
    let (_d, git_dir, repo) = base_fixture();
    seed_three_months(&git_dir);
    let base = head(&repo);
    // The "remote": another March record on top of base.
    holo_repo::update_ref(&repo, "refs/heads/main", base, None).unwrap();
    transact(&git_dir, "", &[Op::Upsert("transactions", txn("r", "2026-03-13T00:00:00Z", 3, "posted", "fun"))]).unwrap();
    let remote = head(&repo);
    holo_repo::update_ref(&repo, "refs/remotes/origin/main", remote, None).unwrap();
    // Local: back to base, then its own March record.
    holo_repo::update_ref(&repo, "refs/heads/main", base, Some(remote)).unwrap();
    transact(&git_dir, "", &[Op::Upsert("transactions", txn("l", "2026-03-14T00:00:00Z", 4, "posted", "fun"))]).unwrap();
    let r = sync_branch(
        &repo,
        &SyncOptions {
            branch: "main".into(),
            remote_ref: "refs/remotes/origin/main".into(),
            on_conflict: ConflictPolicy::Fail,
            committer: None,
            time_seconds: 1_700_000_100,
            offset_minutes: 0,
        },
    )
    .unwrap();
    assert_eq!(r.outcome, SyncOutcome::Rebased, "{r:?}");
    let tip = head(&repo);
    let march = blob_at(&repo, tip, "transactions-monthly/2026/03.toml").unwrap();
    assert!(march.contains("count = 4\n"), "{march}");
    assert!(march.contains(&tree_id_at(&repo, tip, "transactions/2026/03")));
}

#[test]
fn a_merge_driver_merge_is_healed_by_materialize() {
    // A plain git merge leaves a rollup file a stale stamp: reads self-heal,
    // the survey reports it, and materialize repairs it.
    let (_d, git_dir, repo) = base_fixture();
    seed_three_months(&git_dir);
    let c = head(&repo);
    let stale = blob_at(&repo, c, "transactions-monthly/2026/02.toml").unwrap().replace("count = 1", "count = 9");
    let c2 = raw_commit(&repo, Some(c), &[("transactions-monthly/2026/02.toml", Some(&stale))]);
    holo_repo::update_ref(&repo, "refs/heads/main", c2, None).unwrap();
    let ctx = tctx(&repo);
    let (mut sheet, mut tree) = open_at(&repo, c2, "transactions-monthly", "");
    let survey: Vec<_> = sheet.rollup_survey(&ctx, &mut tree).unwrap().into_iter().filter(|e| e.status != RollupStatus::Fresh).collect();
    assert_eq!(survey.len(), 1);
    assert_eq!(survey[0].status, RollupStatus::Stale);
    let out = sheet.materialize(&ctx, &mut tree).unwrap();
    assert_eq!(out.recomputed, vec!["2026/02"]);
}

/// The 10k-record partitioned fixture (plan Validation): a single-record
/// upsert's commit time with a monthly rollup vs. without one. Run with
/// `cargo test --release -p gitsheets-core rollup_commit_timing -- --ignored --nocapture`.
#[test]
#[ignore]
fn rollup_commit_timing() {
    use std::time::Instant;
    let mut files: Vec<(String, String)> = Vec::new();
    for i in 0..10_000 {
        // 120 monthly partitions (2016-01 .. 2025-12) of ~83 records each.
        let month = 1 + i % 12;
        let year = 2016 + (i / 12) % 10;
        let text = txn(&format!("t{i:05}"), &format!("{year}-{month:02}-15T00:00:00Z"), (i as i64) * 7 % 100_000, if i % 3 == 0 { "pending" } else { "posted" }, ["rent", "fun", "groceries"][i % 3]);
        files.push((format!("transactions/{year}/{month:02}/t{i:05}.toml"), text));
    }
    let repo_for = |with_rollup: bool| {
        let mut seed: Vec<(&str, &str)> = files.iter().map(|(p, t)| (p.as_str(), t.as_str())).collect();
        seed.push((".gitsheets/transactions.toml", TX_CONFIG));
        if with_rollup {
            seed.push((".gitsheets/transactions-monthly.toml", MONTHLY));
        }
        setup(&seed)
    };
    let (_bd, base_dir, _br) = repo_for(false);
    let (_rd, roll_dir, _rr) = repo_for(true);
    let commit = |git_dir: &str, k: i64| {
        let t = Instant::now();
        transact(git_dir, "", &[Op::Upsert("transactions", txn(&format!("n{k}"), "2020-06-10T00:00:00Z", k, "posted", "fun"))]).unwrap();
        t.elapsed().as_secs_f64() * 1000.0
    };
    // Interleaved, so machine load hits both sides alike.
    let (mut base, mut roll) = (Vec::new(), Vec::new());
    for k in 0..31 {
        base.push(commit(&base_dir, k));
        roll.push(commit(&roll_dir, k));
    }
    let (base_cold, roll_cold) = (base.remove(0), roll.remove(0));
    let median = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    let (base_med, roll_med) = (median(&mut base), median(&mut roll));
    println!(
        "10k fixture (120 monthly partitions), single-upsert commit: baseline median {base_med:.2} ms, with monthly rollup median {roll_med:.2} ms (ratio {:.2}); first commit in the process (cold parse cache): baseline {base_cold:.2} ms, rollup {roll_cold:.2} ms",
        roll_med / base_med
    );
    assert!(roll_med <= base_med * 2.0, "rollup commit {roll_med:.2} ms > 2x baseline {base_med:.2} ms");
}
