//! Query traversal + native filtering — the read-query half of the record
//! engine.
//!
//! A behavior-preserving Rust port of the host query path (`Sheet.query` +
//! `Template.queryTree` + `queryMatches` in `packages/gitsheets/src`). A query
//! is two stages.
//!
//! **Stage 1 — path-template pruning** ([`Template::plan_query`] + [`walk_query`]).
//! The template's *primary* index narrows the tree walk: when the (partial)
//! filter supplies the inputs to render a component, the walk descends into only
//! that subtree; when a component is un-renderable against the partial filter,
//! the walk expands across all subtrees at that level. This is where path
//! templates earn their keep at scale — a query that pins the leading partition
//! components reads one subtree, not all.
//!
//! **Stage 2 — native filtering** ([`matches`]). Each pruned candidate is read +
//! parsed, then the full filter is applied over the core [`Value`]: declarative
//! equality / nested-table predicates evaluated natively in Rust, plus the
//! embedded-engine escape hatch for arbitrary `(value, record)` predicate
//! snippets ([`crate::engine`]). This mirrors the host `queryMatches`, whose
//! filter values are a literal (equality) or a predicate function — here the
//! function runs in the *core's* engine so the semantics are identical across
//! every binding.
//!
//! Batch-first: a whole query crosses the FFI once and returns the matched
//! records as one `Vec`.
//!
//! ## Enumerated divergences from the host (all on unrealistic filter shapes)
//!
//! *Datetime equality* — the host's `queryMatches` compares a `Date` literal by
//! reference (`rval !== qval`), so a `Date`-valued *equality* filter never
//! matches (a footgun); the core compares datetimes structurally, so it *can*
//! match. Realistic filters use a predicate for datetimes, where there is no
//! divergence.
//!
//! *Integer vs float equality* — the host (JS) sees `30` and `30.0` as the same
//! `number`; the core keeps them distinct (`Value::Integer` vs `Value::Float`),
//! so an integer filter does not equal a float-stored field. This is the same
//! bytes-authority int/float distinction the value type carries everywhere.
//!
//! *Datetime as a path/prune field* — a datetime field renders to `None` in the
//! core path layer (see `path_template`), so a component keyed on a datetime is
//! treated as un-renderable and the walk expands rather than prunes — fewer
//! records pruned, identical final results.

use holo_tree::{Child, MutableTree, ObjectId};

use crate::engine::{Engine, SnippetError, SnippetHandle};
use crate::error::{Error, Result};
use crate::path_template::{QueryComponentPlan, Template};
use crate::record::{base_arg, map_ht, read_blob_value};
use crate::value::Value;

/// One field's filter predicate. The declarative cases ([`Equals`] /
/// [`Nested`]) evaluate natively; [`Predicate`] is the escape hatch — a snippet
/// compiled into the engine and run as `(value, record) => …`.
///
/// [`Equals`]: FilterPred::Equals
/// [`Nested`]: FilterPred::Nested
/// [`Predicate`]: FilterPred::Predicate
#[derive(Clone, Debug)]
pub enum FilterPred {
    /// Strict equality against a literal value (host `rval !== qval`).
    Equals(Value),
    /// A nested-table filter: the field must be a table and recursively match
    /// (host `queryMatches` recursing into a plain-object query value).
    Nested(Filter),
    /// An arbitrary predicate snippet compiled into the engine.
    Predicate(SnippetHandle),
}

/// A query filter: an ordered set of `(field, predicate)` clauses, all of which
/// must hold for a record to match (host `queryMatches`'s AND-of-clauses).
#[derive(Clone, Debug, Default)]
pub struct Filter(pub Vec<(String, FilterPred)>);

impl Filter {
    pub fn new() -> Self {
        Filter(Vec::new())
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn push(&mut self, field: impl Into<String>, pred: FilterPred) {
        self.0.push((field.into(), pred));
    }
}

/// Does `record` satisfy every clause of `filter`? A behavior-preserving port
/// of the host `queryMatches`. A predicate snippet that throws surfaces as an
/// error (the host lets such throws propagate, too).
pub fn matches(filter: &Filter, record: &Value, engine: &mut Engine) -> Result<bool> {
    let table = match record {
        Value::Table(map) => map,
        // A non-table "record" can satisfy only an empty filter (host: every
        // `record[key]` is `undefined`, so any clause fails).
        _ => return Ok(filter.is_empty()),
    };
    for (key, pred) in &filter.0 {
        let rval = table.get(key);
        match pred {
            FilterPred::Equals(expected) => {
                if rval != Some(expected) {
                    return Ok(false);
                }
            }
            FilterPred::Nested(sub) => match rval {
                Some(Value::Table(_)) => {
                    if !matches(sub, rval.unwrap(), engine)? {
                        return Ok(false);
                    }
                }
                // Field absent or not a table → the nested filter can't match.
                _ => return Ok(false),
            },
            FilterPred::Predicate(handle) => {
                let ok = engine
                    .call_filter(*handle, rval, record)
                    .map_err(|e| predicate_error(key, e))?;
                if !ok {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

fn predicate_error(field: &str, e: SnippetError) -> Error {
    let detail = match e {
        SnippetError::UndefinedReference(m) | SnippetError::Other(m) => m,
    };
    Error::ConfigInvalid {
        message: format!("query predicate on field {field:?} failed: {detail}"),
    }
}

/// The scalar equality fields of a filter, as a `Value::Table` — the partial
/// "record" the template renders against for pruning. Only top-level scalar
/// equality clauses contribute (predicates, nested filters, arrays, and
/// datetimes render to nothing / un-renderable, so they widen the walk exactly
/// as the host's `queryTree` does when it renders the full query object and a
/// function/object/array value stringifies to `undefined`).
pub fn prune_record(filter: &Filter) -> Value {
    let mut map = indexmap::IndexMap::new();
    for (key, pred) in &filter.0 {
        if let FilterPred::Equals(v) = pred {
            if matches!(
                v,
                Value::String(_) | Value::Integer(_) | Value::Float(_) | Value::Boolean(_)
            ) {
                map.insert(key.clone(), v.clone());
            }
        }
    }
    Value::Table(map)
}

/// Walk a tree under `base`, prune by the template against `filter`, read each
/// surviving candidate, apply the full `filter`, and return the matched
/// `(path, record)` pairs in sorted (git-canonical) path order. `template`,
/// `filter`, and `engine` are prepared by the caller (the template compiled and
/// any predicate snippets compiled into the same `engine`) so a query crosses
/// the FFI once.
pub fn query_records(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    base: &str,
    template: &Template,
    filter: &Filter,
    engine: &mut Engine,
    extension: &str,
) -> Result<Vec<(String, Value)>> {
    let plan = template.plan_query(&prune_record(filter), engine)?;

    // Candidate (path, blob-hash) pairs the pruning walk surfaces.
    let mut candidates: Vec<(String, ObjectId)> = Vec::new();
    let barg = base_arg(base);
    if let Some(subtree) = tree.get_subtree(repo, &barg).map_err(map_ht)? {
        walk_query(repo, subtree, &plan, 0, "", extension, &mut candidates)?;
    }

    // Sorted candidate order keeps results deterministic and git-canonical
    // (the host's `queryTree` sorts at each leaf; cross-subtree order is not
    // contractual — the host tests sort before comparing).
    candidates.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out = Vec::new();
    for (path, hash) in candidates {
        let record = read_blob_value(repo, hash)?;
        if matches(filter, &record, engine)? {
            out.push((path, record));
        }
    }
    Ok(out)
}

/// The pruning candidate set alone (no content filter applied) — the direct
/// parity target for the host `Template.queryTree`. Returns candidate record
/// paths (relative to `base`, no extension) in sorted order.
pub fn query_candidate_paths(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    base: &str,
    template: &Template,
    query: &Value,
    engine: &mut Engine,
    extension: &str,
) -> Result<Vec<String>> {
    let plan = template.plan_query(query, engine)?;
    let mut candidates: Vec<(String, ObjectId)> = Vec::new();
    let barg = base_arg(base);
    if let Some(subtree) = tree.get_subtree(repo, &barg).map_err(map_ht)? {
        walk_query(repo, subtree, &plan, 0, "", extension, &mut candidates)?;
    }
    let mut paths: Vec<String> = candidates.into_iter().map(|(p, _)| p).collect();
    paths.sort();
    Ok(paths)
}

fn join_path(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Recursive port of the host `Template.queryTree`. At each component:
/// - **leaf, renderable** → fetch exactly `<rendered><ext>` if it's a blob;
/// - **leaf, un-renderable** → list this tree's record blobs (recursive
///   component: the whole blob-map; else: direct children), skipping a record's
///   own attachment files;
/// - **intermediate, renderable** → descend into that one subtree;
/// - **intermediate, un-renderable** → expand into every subtree.
fn walk_query(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    plan: &[QueryComponentPlan],
    depth: usize,
    prefix: &str,
    extension: &str,
    out: &mut Vec<(String, ObjectId)>,
) -> Result<()> {
    let num = plan.len();
    if depth >= num {
        return Ok(());
    }
    let comp = &plan[depth];
    let is_last = depth + 1 == num;

    if is_last {
        if let Some(rendered) = &comp.rendered {
            let leaf = format!("{rendered}{extension}");
            if let Some(Child::Blob { hash, .. }) = tree.get_child(repo, &leaf).map_err(map_ht)? {
                out.push((join_path(prefix, rendered), *hash));
            }
            return Ok(());
        }
        if comp.recursive {
            // Recursive leaf: every blob beneath this tree (the host's
            // `getBlobMap`), skipping any path under an already-yielded record
            // (its attachment files).
            let blob_map = tree.get_blob_map(repo).map_err(map_ht)?;
            let mut attachment_prefix: Option<String> = None;
            for (path, info) in blob_map {
                if !path.ends_with(extension) {
                    continue;
                }
                if let Some(ap) = &attachment_prefix {
                    if path.starts_with(ap) {
                        continue;
                    }
                }
                let name = path[..path.len() - extension.len()].to_string();
                attachment_prefix = Some(format!("{name}/"));
                out.push((join_path(prefix, &name), info.hash));
            }
        } else {
            // Non-recursive leaf: this tree's direct record blobs (BTreeMap →
            // sorted). Subdirectories (attachment dirs) are not blobs → skipped.
            tree.ensure_children(repo).map_err(map_ht)?;
            for (name, child) in tree.children.as_ref().unwrap().iter() {
                if let Child::Blob { hash, .. } = child {
                    if !name.ends_with(extension) {
                        continue;
                    }
                    let bare = &name[..name.len() - extension.len()];
                    out.push((join_path(prefix, bare), *hash));
                }
            }
        }
        return Ok(());
    }

    // Intermediate component.
    if let Some(rendered) = &comp.rendered {
        if let Some(next) = tree.get_subtree(repo, rendered).map_err(map_ht)? {
            let child_prefix = join_path(prefix, rendered);
            return walk_query(repo, next, plan, depth + 1, &child_prefix, extension, out);
        }
        return Ok(());
    }

    // Un-renderable intermediate → expand across all subtrees.
    tree.ensure_children(repo).map_err(map_ht)?;
    let names: Vec<String> = tree
        .children
        .as_ref()
        .unwrap()
        .iter()
        .filter(|(_, c)| matches!(c, Child::Tree(_)))
        .map(|(n, _)| n.clone())
        .collect();
    for name in names {
        if let Some(Child::Tree(sub)) = tree.children.as_mut().unwrap().get_mut(&name) {
            let child_prefix = join_path(prefix, &name);
            walk_query(repo, sub, plan, depth + 1, &child_prefix, extension, out)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{resolve_tree, write_records, TOML_EXTENSION};
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

    fn temp_repo() -> (tempfile::TempDir, gix::Repository) {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = gix::init(dir.path()).expect("git init");
        (dir, repo)
    }

    /// Seed a flat people sheet (`path = ${{ slug }}`, base `people`) and return
    /// its tree hash.
    fn seed_people(repo: &gix::Repository) -> String {
        let mut tree = MutableTree::empty();
        let items = vec![
            ("jane".to_string(), rec(&[("slug", s("jane")), ("email", s("jane@x.org")), ("team", s("eng"))])),
            ("bob".to_string(), rec(&[("slug", s("bob")), ("email", s("bob@y.org")), ("team", s("eng"))])),
            ("amy".to_string(), rec(&[("slug", s("amy")), ("email", s("amy@z.org")), ("team", s("design"))])),
        ];
        write_records(repo, &mut tree, "people", &items, TOML_EXTENSION)
            .unwrap()
            .tree_hash
    }

    #[test]
    fn empty_filter_returns_all_records_sorted() {
        let (_d, repo) = temp_repo();
        let hash = seed_people(&repo);
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ slug }}", &mut eng).unwrap();
        let out =
            query_records(&repo, &mut tree, "people", &template, &Filter::new(), &mut eng, TOML_EXTENSION)
                .unwrap();
        let paths: Vec<&str> = out.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["amy", "bob", "jane"]);
    }

    #[test]
    fn equality_filter_prunes_to_one_leaf() {
        let (_d, repo) = temp_repo();
        let hash = seed_people(&repo);
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ slug }}", &mut eng).unwrap();
        let mut filter = Filter::new();
        filter.push("slug", FilterPred::Equals(s("jane")));
        let out =
            query_records(&repo, &mut tree, "people", &template, &filter, &mut eng, TOML_EXTENSION)
                .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "jane");
    }

    #[test]
    fn non_path_equality_filter_scans_then_matches() {
        let (_d, repo) = temp_repo();
        let hash = seed_people(&repo);
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ slug }}", &mut eng).unwrap();
        let mut filter = Filter::new();
        filter.push("team", FilterPred::Equals(s("eng")));
        let out =
            query_records(&repo, &mut tree, "people", &template, &filter, &mut eng, TOML_EXTENSION)
                .unwrap();
        let paths: Vec<&str> = out.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["bob", "jane"]);
    }

    #[test]
    fn predicate_escape_hatch_filters_natively_in_the_engine() {
        let (_d, repo) = temp_repo();
        let hash = seed_people(&repo);
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ slug }}", &mut eng).unwrap();
        // (value, record) => value.endsWith('y.org') — only bob.
        let handle = eng
            .compile("(value, record) => ( value.endsWith('y.org') )")
            .unwrap();
        let mut filter = Filter::new();
        filter.push("email", FilterPred::Predicate(handle));
        let out =
            query_records(&repo, &mut tree, "people", &template, &filter, &mut eng, TOML_EXTENSION)
                .unwrap();
        let paths: Vec<&str> = out.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["bob"]);
    }

    #[test]
    fn candidate_paths_prune_by_partial_composite_key() {
        // Composite template: domain/username. Supplying only `domain` prunes to
        // that one subtree (host `queryTree` "prunes to a single subtree" test).
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let items = vec![
            ("af.mil/grandma".to_string(), rec(&[("domain", s("af.mil")), ("username", s("grandma"))])),
            ("af.mil/cobol".to_string(), rec(&[("domain", s("af.mil")), ("username", s("cobol"))])),
            ("navy.mil/sailor".to_string(), rec(&[("domain", s("navy.mil")), ("username", s("sailor"))])),
        ];
        let hash = write_records(&repo, &mut tree, "people", &items, TOML_EXTENSION)
            .unwrap()
            .tree_hash;
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ domain }}/${{ username }}", &mut eng).unwrap();

        let q = rec(&[("domain", s("af.mil"))]);
        let paths =
            query_candidate_paths(&repo, &mut tree, "people", &template, &q, &mut eng, TOML_EXTENSION)
                .unwrap();
        assert_eq!(paths, vec!["af.mil/cobol", "af.mil/grandma"]);

        // No fields supplied → expand across all subtrees.
        let all = query_candidate_paths(
            &repo,
            &mut tree,
            "people",
            &template,
            &Value::Table(IndexMap::new()),
            &mut eng,
            TOML_EXTENSION,
        )
        .unwrap();
        assert_eq!(all, vec!["af.mil/cobol", "af.mil/grandma", "navy.mil/sailor"]);
    }
}
