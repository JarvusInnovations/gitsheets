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
//! *Datetime as a path/prune field* — a datetime field renders to `None` for a
//! plain `${{ field }}` reference (see `path_template`), so such a component
//! keyed on a datetime is treated as un-renderable and the walk expands rather
//! than prunes — fewer records pruned, identical final results. Datetime
//! equality values DO enter the prune record (see [`prune_record`]) so that
//! date-*bucket* components (`${{ field: YYYY/MM/DD }}`) — and expression
//! components using UTC accessors — prune to the exact rendered path.

use holo_tree::{Context, Child, MutableTree, ObjectId};

use crate::engine::{Engine, SnippetError, SnippetHandle};
use crate::error::{Error, Result};
use std::cmp::Ordering;

use crate::path_template::{
    datetime_instant, is_range_table, iso_instant, Bounds, QueryComponentPlan, Template,
    RANGE_OPERATORS,
};
use crate::codec;
use crate::config::FormatConfig;
use crate::record::{base_arg, map_ht, read_blob_text, read_blob_value};
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
    /// An ordered-comparison range (`$gt` / `$gte` / `$lt` / `$lte`), evaluated
    /// natively by kind — spec: `Sheet.query` "Range filter entries".
    Range(Range),
}

/// One side of a [`Range`]: the bound value and whether the bound itself
/// satisfies the predicate (`$gte` / `$lte`) or not (`$gt` / `$lt`).
#[derive(Clone, Debug, PartialEq)]
pub struct Bound {
    pub value: Value,
    pub inclusive: bool,
}

/// A range predicate: every bound present must hold. Built from the `$`-keyed
/// object form by [`Range::from_table`], which is what every binding feeds.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Range {
    pub lower: Option<Bound>,
    pub upper: Option<Bound>,
}

impl Range {
    /// Parse the wire form `{ "$gte": a, "$lt": b, … }`. Every key must be a
    /// range operator and at least one must be present; a `$`-prefixed key
    /// outside the vocabulary (or a mix with ordinary keys) is
    /// `ConfigInvalid` — the bindings surface it as `TypeError` at query
    /// start. Giving both `$gt` and `$gte` (or `$lt` and `$lte`) is likewise
    /// rejected: one bound per side.
    pub fn from_table(map: &indexmap::IndexMap<String, Value>) -> Result<Range> {
        if !is_range_table(map) {
            let bad: Vec<&str> = map
                .keys()
                .map(String::as_str)
                .filter(|k| !RANGE_OPERATORS.contains(k))
                .collect();
            return Err(Error::ConfigInvalid {
                message: format!(
                    "query filter: a range object may only carry {} — found {:?}",
                    RANGE_OPERATORS.join(" / "),
                    bad
                ),
            });
        }
        let mut range = Range::default();
        for (op, value) in map {
            let (slot, side, inclusive) = match op.as_str() {
                "$gt" => (&mut range.lower, "lower", false),
                "$gte" => (&mut range.lower, "lower", true),
                "$lt" => (&mut range.upper, "upper", false),
                _ => (&mut range.upper, "upper", true),
            };
            if slot.is_some() {
                return Err(Error::ConfigInvalid {
                    message: format!(
                        "query filter: range object carries two {side} bounds — give one of \
                         $gt/$gte and one of $lt/$lte"
                    ),
                });
            }
            *slot = Some(Bound {
                value: value.clone(),
                inclusive,
            });
        }
        Ok(range)
    }

    /// Does `field` (the record's value, `None` when absent) satisfy the range?
    /// An absent field or an incomparable kind pairing never matches.
    pub fn matches(&self, field: Option<&Value>) -> bool {
        let Some(field) = field else {
            return false;
        };
        if let Some(lower) = &self.lower {
            match compare_values(field, &lower.value) {
                Some(Ordering::Greater) => {}
                Some(Ordering::Equal) if lower.inclusive => {}
                _ => return false,
            }
        }
        if let Some(upper) = &self.upper {
            match compare_values(field, &upper.value) {
                Some(Ordering::Less) => {}
                Some(Ordering::Equal) if upper.inclusive => {}
                _ => return false,
            }
        }
        true
    }

    /// The `$`-keyed wire form of this range — what [`prune_record`] hands the
    /// planner so a range on a date-bucket field becomes [`Bounds`].
    pub fn to_table(&self) -> Value {
        let mut map = indexmap::IndexMap::new();
        if let Some(b) = &self.lower {
            map.insert(if b.inclusive { "$gte" } else { "$gt" }.to_string(), b.value.clone());
        }
        if let Some(b) = &self.upper {
            map.insert(if b.inclusive { "$lte" } else { "$lt" }.to_string(), b.value.clone());
        }
        Value::Table(map)
    }
}

/// Order a record's field value against a range bound, by kind (spec:
/// `Sheet.query` "Range filter entries"): integers and floats numerically
/// (int↔float compares as `f64`), strings lexicographically, datetimes
/// chronologically as UTC instants, and a datetime field against an
/// accepted-ISO-8601 string bound chronologically. Any other pairing is
/// incomparable (`None`) and so never matches.
pub fn compare_values(field: &Value, bound: &Value) -> Option<Ordering> {
    match (field, bound) {
        (Value::Integer(a), Value::Integer(b)) => Some(a.cmp(b)),
        (Value::Float(a), Value::Float(b)) => a.partial_cmp(b),
        (Value::Integer(a), Value::Float(b)) => (*a as f64).partial_cmp(b),
        (Value::Float(a), Value::Integer(b)) => a.partial_cmp(&(*b as f64)),
        (Value::String(a), Value::String(b)) => Some(a.cmp(b)),
        (Value::Datetime(a), Value::Datetime(b)) => {
            Some(datetime_instant(a)?.cmp(&datetime_instant(b)?))
        }
        (Value::Datetime(a), Value::String(b)) => Some(datetime_instant(a)?.cmp(&iso_instant(b)?)),
        _ => None,
    }
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
            FilterPred::Range(range) => {
                if !range.matches(rval) {
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
/// equality clauses contribute (predicates, nested filters, and arrays render
/// to nothing / un-renderable, so they widen the walk exactly as the host's
/// `queryTree` does when it renders the full query object and a
/// function/object/array value stringifies to `undefined`).
///
/// Datetimes are included so a datetime-valued equality filter prunes a
/// date-*bucket* component to its exact rendered path (spec:
/// "Date-bucket references § Query traversal semantics"). A plain
/// `${{ field }}` reference still treats a datetime as un-renderable
/// (`field_to_string` → `None`), preserving the walk-widening behavior there.
pub fn prune_record(filter: &Filter) -> Value {
    let mut map = indexmap::IndexMap::new();
    for (key, pred) in &filter.0 {
        match pred {
            FilterPred::Equals(v) => {
                if matches!(
                    v,
                    Value::String(_)
                        | Value::Integer(_)
                        | Value::Float(_)
                        | Value::Boolean(_)
                        | Value::Datetime(_)
                ) {
                    map.insert(key.clone(), v.clone());
                }
            }
            // A range enters the prune record in its `$`-keyed wire form: a
            // date-bucket component plans it to bounds; any other component
            // sees a table-valued field and widens (spec: "Range filter
            // entries" under "Query traversal").
            FilterPred::Range(range) => {
                map.insert(key.clone(), range.to_table());
            }
            FilterPred::Nested(_) | FilterPred::Predicate(_) => {}
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
    ctx: &Context<'_>,
    tree: &mut MutableTree,
    base: &str,
    template: &Template,
    filter: &Filter,
    engine: &mut Engine,
    extension: &str,
) -> Result<Vec<(String, Value)>> {
    query_records_with(ctx, tree, base, template, filter, engine, extension, |hash| {
        read_blob_value(ctx.repo, hash)
    })
}

/// The format-aware query (spec: `rust-core.md` "Query traversal +
/// filtering"): the same pruning walk as [`query_records`], with each
/// candidate blob decoded through the format codec — canonical TOML, or
/// markdown frontmatter with (`with_body`) or without the body field (the
/// lazy-body switch; a no-op for TOML). Works over any tree — a committed ref
/// or a transaction's private tree — so no binding ever fetches record bytes
/// itself. `extension` is the record-file extension the walk keys on (the
/// format's own, e.g. `.md`).
#[allow(clippy::too_many_arguments)]
pub fn query_records_format(
    ctx: &Context<'_>,
    tree: &mut MutableTree,
    base: &str,
    template: &Template,
    filter: &Filter,
    engine: &mut Engine,
    extension: &str,
    format: &FormatConfig,
    with_body: bool,
) -> Result<Vec<(String, Value)>> {
    query_records_with(ctx, tree, base, template, filter, engine, extension, |hash| {
        let text = read_blob_text(ctx.repo, hash)?;
        if with_body {
            codec::parse(&text, format)
        } else {
            codec::parse_header_only(&text, format)
        }
    })
}

/// The shared walk + decode + filter pipeline behind the two public queries.
#[allow(clippy::too_many_arguments)]
fn query_records_with(
    ctx: &Context<'_>,
    tree: &mut MutableTree,
    base: &str,
    template: &Template,
    filter: &Filter,
    engine: &mut Engine,
    extension: &str,
    mut decode: impl FnMut(ObjectId) -> Result<Value>,
) -> Result<Vec<(String, Value)>> {
    let plan = template.plan_query(&prune_record(filter), engine)?;

    // Candidate (path, blob-hash) pairs the pruning walk surfaces.
    let mut candidates: Vec<(String, ObjectId)> = Vec::new();
    let barg = base_arg(base);
    if let Some(subtree) = tree.get_subtree(ctx, &barg).map_err(map_ht)? {
        walk_query(ctx, subtree, &plan, 0, "", extension, &mut candidates)?;
    }

    // Sorted candidate order keeps results deterministic and git-canonical
    // (the host's `queryTree` sorts at each leaf; cross-subtree order is not
    // contractual — the host tests sort before comparing).
    candidates.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out = Vec::new();
    for (path, hash) in candidates {
        let record = decode(hash)?;
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
    ctx: &Context<'_>,
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
    if let Some(subtree) = tree.get_subtree(ctx, &barg).map_err(map_ht)? {
        walk_query(ctx, subtree, &plan, 0, "", extension, &mut candidates)?;
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

/// Where a walk stands relative to a range-bounded bucket token's lower and
/// upper bounds (spec: "Range-pruned traversal" § boundary partitions). The
/// lower bound constrains a level only while every segment taken so far
/// equals the lower bound's own segment (`on_lo`), and likewise the upper —
/// the classic bounded trie scan. Tracking is scoped to one bucket token;
/// entering a different token's segments resets it.
#[derive(Clone, Copy, Debug)]
struct BoundTrack {
    token: usize,
    on_lo: bool,
    on_hi: bool,
}

impl BoundTrack {
    const FRESH: BoundTrack = BoundTrack {
        token: usize::MAX,
        on_lo: true,
        on_hi: true,
    };

    /// The tracking state in force for `bounds` — reset if they belong to a
    /// different bucket token than the one being tracked.
    fn entering(self, bounds: &Bounds) -> BoundTrack {
        if self.token == bounds.token {
            self
        } else {
            BoundTrack {
                token: bounds.token,
                ..BoundTrack::FRESH
            }
        }
    }

    /// Is the child `name` within `bounds` given this state?
    fn admits(self, bounds: &Bounds, name: &str) -> bool {
        let below = self.on_lo && bounds.lo.as_deref().is_some_and(|lo| name < lo);
        let above = self.on_hi && bounds.hi.as_deref().is_some_and(|hi| name > hi);
        !below && !above
    }

    /// The state after descending into the admitted child `name`.
    fn descend(self, bounds: &Bounds, name: &str) -> BoundTrack {
        BoundTrack {
            token: self.token,
            on_lo: self.on_lo && bounds.lo.as_deref() == Some(name),
            on_hi: self.on_hi && bounds.hi.as_deref() == Some(name),
        }
    }
}

/// Recursive port of the host `Template.queryTree`, extended with the
/// range-bounded case. At each component:
/// - **leaf, renderable** → fetch exactly `<rendered><ext>` if it's a blob;
/// - **leaf, bounded** → list this tree's direct record blobs whose bare name
///   the bounds admit;
/// - **leaf, un-renderable** → list this tree's record blobs (recursive
///   component: the whole blob-map; else: direct children), skipping a record's
///   own attachment files;
/// - **intermediate, renderable** → descend into that one subtree;
/// - **intermediate, bounded** → descend into each subtree the bounds admit,
///   tightening the boundary tracking per child;
/// - **intermediate, un-renderable** → expand into every subtree.
fn walk_query(
    ctx: &Context<'_>,
    tree: &mut MutableTree,
    plan: &[QueryComponentPlan],
    depth: usize,
    prefix: &str,
    extension: &str,
    out: &mut Vec<(String, ObjectId)>,
) -> Result<()> {
    walk_query_tracked(ctx, tree, plan, depth, prefix, extension, out, BoundTrack::FRESH)
}

#[allow(clippy::too_many_arguments)]
fn walk_query_tracked(
    ctx: &Context<'_>,
    tree: &mut MutableTree,
    plan: &[QueryComponentPlan],
    depth: usize,
    prefix: &str,
    extension: &str,
    out: &mut Vec<(String, ObjectId)>,
    track: BoundTrack,
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
            if let Some(Child::Blob { hash, .. }) = tree.get_child(ctx, &leaf).map_err(map_ht)? {
                out.push((join_path(prefix, rendered), *hash));
            }
            return Ok(());
        }
        if let Some(bounds) = &comp.bounds {
            // Bounded leaf (the bucket is the whole path): this tree's direct
            // record blobs within the bounds. A bucket is never recursive.
            let track = track.entering(bounds);
            tree.ensure_children(ctx).map_err(map_ht)?;
            for (name, child) in tree.children.as_ref().unwrap().iter() {
                if let Child::Blob { hash, .. } = child {
                    if !name.ends_with(extension) {
                        continue;
                    }
                    let bare = &name[..name.len() - extension.len()];
                    if track.admits(bounds, bare) {
                        out.push((join_path(prefix, bare), *hash));
                    }
                }
            }
            return Ok(());
        }
        if comp.recursive {
            // Recursive leaf: every blob beneath this tree (the host's
            // `getBlobMap`), skipping any path under an already-yielded record
            // (its attachment files).
            let blob_map = tree.get_blob_map(ctx).map_err(map_ht)?;
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
            tree.ensure_children(ctx).map_err(map_ht)?;
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
        if let Some(next) = tree.get_subtree(ctx, rendered).map_err(map_ht)? {
            let child_prefix = join_path(prefix, rendered);
            return walk_query_tracked(
                ctx,
                next,
                plan,
                depth + 1,
                &child_prefix,
                extension,
                out,
                track,
            );
        }
        return Ok(());
    }

    // Bounded or un-renderable intermediate → expand across the subtrees
    // (all of them, or only those the bounds admit).
    let track = match &comp.bounds {
        Some(bounds) => track.entering(bounds),
        None => track,
    };
    tree.ensure_children(ctx).map_err(map_ht)?;
    let names: Vec<String> = tree
        .children
        .as_ref()
        .unwrap()
        .iter()
        .filter(|(n, c)| {
            matches!(c, Child::Tree(_))
                && comp.bounds.as_ref().is_none_or(|b| track.admits(b, n))
        })
        .map(|(n, _)| n.clone())
        .collect();
    for name in names {
        if let Some(Child::Tree(sub)) = tree.children.as_mut().unwrap().get_mut(&name) {
            let child_prefix = join_path(prefix, &name);
            let child_track = match &comp.bounds {
                Some(bounds) => track.descend(bounds, &name),
                None => track,
            };
            walk_query_tracked(
                ctx,
                sub,
                plan,
                depth + 1,
                &child_prefix,
                extension,
                out,
                child_track,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree-op context over a test-lifetime cache (holo-tree 0.5).
    fn tctx(repo: &gix::Repository) -> holo_tree::Context<'_> {
        holo_tree::Context::new(repo, Box::leak(Box::new(holo_tree::TreeCache::new())))
    }
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
    fn seed_people(ctx: &Context<'_>) -> String {
        let mut tree = MutableTree::empty();
        let items = vec![
            ("jane".to_string(), rec(&[("slug", s("jane")), ("email", s("jane@x.org")), ("team", s("eng"))])),
            ("bob".to_string(), rec(&[("slug", s("bob")), ("email", s("bob@y.org")), ("team", s("eng"))])),
            ("amy".to_string(), rec(&[("slug", s("amy")), ("email", s("amy@z.org")), ("team", s("design"))])),
        ];
        write_records(ctx, &mut tree, "people", &items, TOML_EXTENSION)
            .unwrap()
            .tree_hash
    }

    #[test]
    fn empty_filter_returns_all_records_sorted() {
        let (_d, repo) = temp_repo();
        let hash = seed_people(&tctx(&repo));
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ slug }}", &mut eng).unwrap();
        let out =
            query_records(&tctx(&repo), &mut tree, "people", &template, &Filter::new(), &mut eng, TOML_EXTENSION)
                .unwrap();
        let paths: Vec<&str> = out.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["amy", "bob", "jane"]);
    }

    #[test]
    fn equality_filter_prunes_to_one_leaf() {
        let (_d, repo) = temp_repo();
        let hash = seed_people(&tctx(&repo));
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ slug }}", &mut eng).unwrap();
        let mut filter = Filter::new();
        filter.push("slug", FilterPred::Equals(s("jane")));
        let out =
            query_records(&tctx(&repo), &mut tree, "people", &template, &filter, &mut eng, TOML_EXTENSION)
                .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "jane");
    }

    #[test]
    fn non_path_equality_filter_scans_then_matches() {
        let (_d, repo) = temp_repo();
        let hash = seed_people(&tctx(&repo));
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ slug }}", &mut eng).unwrap();
        let mut filter = Filter::new();
        filter.push("team", FilterPred::Equals(s("eng")));
        let out =
            query_records(&tctx(&repo), &mut tree, "people", &template, &filter, &mut eng, TOML_EXTENSION)
                .unwrap();
        let paths: Vec<&str> = out.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["bob", "jane"]);
    }

    #[test]
    fn predicate_escape_hatch_filters_natively_in_the_engine() {
        let (_d, repo) = temp_repo();
        let hash = seed_people(&tctx(&repo));
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
            query_records(&tctx(&repo), &mut tree, "people", &template, &filter, &mut eng, TOML_EXTENSION)
                .unwrap();
        let paths: Vec<&str> = out.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["bob"]);
    }

    #[test]
    fn date_bucket_prunes_when_field_supplied_and_wildcards_when_absent() {
        // Bucketed template: one bucket token = two real tree levels.
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let dt = |s: &str| Value::Datetime(s.parse().unwrap());
        let items = vec![
            ("2026/03/a".to_string(), rec(&[("publishedAt", dt("2026-03-09T12:00:00Z")), ("slug", s("a"))])),
            ("2026/04/b".to_string(), rec(&[("publishedAt", dt("2026-04-01T00:00:00Z")), ("slug", s("b"))])),
            ("2025/12/c".to_string(), rec(&[("publishedAt", dt("2025-12-31T09:00:00Z")), ("slug", s("c"))])),
        ];
        let hash = write_records(&tctx(&repo), &mut tree, "posts", &items, TOML_EXTENSION)
            .unwrap()
            .tree_hash;
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template =
            Template::compile("${{ publishedAt: YYYY/MM }}/${{ slug }}", &mut eng).unwrap();

        // Datetime equality filter reaches the bucket components via
        // prune_record and descends the exact rendered bucket path.
        let q = rec(&[("publishedAt", dt("2026-03-09T12:00:00Z"))]);
        let paths =
            query_candidate_paths(&tctx(&repo), &mut tree, "posts", &template, &q, &mut eng, TOML_EXTENSION)
                .unwrap();
        assert_eq!(paths, vec!["2026/03/a"]);

        // No bucket field in the query → bucket segments are wildcards.
        let all = query_candidate_paths(
            &tctx(&repo),
            &mut tree,
            "posts",
            &template,
            &Value::Table(IndexMap::new()),
            &mut eng,
            TOML_EXTENSION,
        )
        .unwrap();
        assert_eq!(all, vec!["2025/12/c", "2026/03/a", "2026/04/b"]);

        // End-to-end: a datetime equality filter both prunes AND matches
        // (core datetime equality is structural).
        let mut filter = Filter::new();
        filter.push("publishedAt", FilterPred::Equals(dt("2026-03-09T12:00:00Z")));
        let out =
            query_records(&tctx(&repo), &mut tree, "posts", &template, &filter, &mut eng, TOML_EXTENSION)
                .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "2026/03/a");
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
        let hash = write_records(&tctx(&repo), &mut tree, "people", &items, TOML_EXTENSION)
            .unwrap()
            .tree_hash;
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ domain }}/${{ username }}", &mut eng).unwrap();

        let q = rec(&[("domain", s("af.mil"))]);
        let paths =
            query_candidate_paths(&tctx(&repo), &mut tree, "people", &template, &q, &mut eng, TOML_EXTENSION)
                .unwrap();
        assert_eq!(paths, vec!["af.mil/cobol", "af.mil/grandma"]);

        // No fields supplied → expand across all subtrees.
        let all = query_candidate_paths(
            &tctx(&repo),
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

    // ── range filters + range-pruned traversal ────────────────────────────────

    fn dt(s: &str) -> Value {
        Value::Datetime(s.parse().unwrap())
    }
    fn range_table(pairs: &[(&str, Value)]) -> IndexMap<String, Value> {
        let mut m = IndexMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }
    fn range_pred(pairs: &[(&str, Value)]) -> FilterPred {
        FilterPred::Range(Range::from_table(&range_table(pairs)).unwrap())
    }

    #[test]
    fn compare_values_orders_by_kind_and_is_incomparable_across_kinds() {
        use Ordering::*;
        assert_eq!(compare_values(&Value::Integer(3), &Value::Integer(5)), Some(Less));
        assert_eq!(compare_values(&Value::Integer(30), &Value::Float(30.0)), Some(Equal));
        assert_eq!(compare_values(&Value::Float(2.5), &Value::Integer(2)), Some(Greater));
        assert_eq!(compare_values(&s("b"), &s("a")), Some(Greater));
        assert_eq!(
            compare_values(&dt("2026-01-01T00:00:00Z"), &dt("2025-12-31T19:00:00-05:00")),
            Some(Equal)
        );
        // Datetime field vs ISO-string bound: chronological; date-only bound
        // is its midnight.
        assert_eq!(compare_values(&dt("2026-03-09T12:00:00Z"), &s("2026-03-09")), Some(Greater));
        assert_eq!(compare_values(&dt("2026-03-09T00:00:00Z"), &s("2026-03-09")), Some(Equal));
        // Incomparable pairings.
        assert_eq!(compare_values(&s("18"), &Value::Integer(18)), None);
        assert_eq!(compare_values(&Value::Integer(18), &s("18")), None);
        assert_eq!(compare_values(&dt("2026-03-09T00:00:00Z"), &s("tomorrow")), None);
        assert_eq!(compare_values(&dt("07:32:00"), &dt("2026-03-09T00:00:00Z")), None);
        assert_eq!(compare_values(&Value::Boolean(true), &Value::Boolean(false)), None);
    }

    #[test]
    fn range_from_table_validates_the_operator_vocabulary() {
        let r = Range::from_table(&range_table(&[("$gte", Value::Integer(1)), ("$lt", Value::Integer(9))]))
            .unwrap();
        assert!(r.lower.as_ref().unwrap().inclusive);
        assert!(!r.upper.as_ref().unwrap().inclusive);
        assert_eq!(r.to_table(), rec(&[("$gte", Value::Integer(1)), ("$lt", Value::Integer(9))]));

        for bad in [
            range_table(&[("$gte", Value::Integer(1)), ("foo", Value::Integer(2))]),
            range_table(&[("$in", Value::Integer(1))]),
            range_table(&[("$gt", Value::Integer(1)), ("$gte", Value::Integer(2))]),
        ] {
            assert!(matches!(Range::from_table(&bad), Err(Error::ConfigInvalid { .. })));
        }
        assert!(!is_range_table(&IndexMap::new()));
    }

    #[test]
    fn range_matches_each_kind_and_rejects_absent_or_mismatched_fields() {
        let r = Range::from_table(&range_table(&[("$gte", Value::Integer(18)), ("$lt", Value::Integer(65))]))
            .unwrap();
        assert!(r.matches(Some(&Value::Integer(18))));
        assert!(r.matches(Some(&Value::Float(64.5))));
        assert!(!r.matches(Some(&Value::Integer(65))));
        assert!(!r.matches(Some(&Value::Integer(17))));
        assert!(!r.matches(Some(&s("30"))));
        assert!(!r.matches(None));

        let r = Range::from_table(&range_table(&[("$gt", s("2026-01-01")), ("$lte", s("2026-03-31"))])).unwrap();
        assert!(r.matches(Some(&dt("2026-02-01T00:00:00Z"))));
        assert!(!r.matches(Some(&dt("2026-01-01T00:00:00Z"))));
        assert!(r.matches(Some(&dt("2026-03-31T00:00:00Z"))));
        assert!(!r.matches(Some(&dt("2026-03-31T00:00:01Z"))));
        // String field vs string bound is lexicographic.
        assert!(r.matches(Some(&s("2026-02-15"))));
        assert!(!r.matches(Some(&s("2025-12-31"))));
    }

    /// A `${{ d: YYYY/MM/DD }}/${{ slug }}` corpus straddling a year boundary.
    fn seed_daily(ctx: &Context<'_>) -> String {
        let mut tree = MutableTree::empty();
        let items: Vec<(String, Value)> = [
            ("2025/10/05/a", "2025-10-05T10:00:00Z"),
            ("2025/11/19/b", "2025-11-19T23:59:59Z"),
            ("2025/11/20/c", "2025-11-20T00:00:00Z"),
            ("2025/11/25/d", "2025-11-25T12:00:00Z"),
            ("2025/12/31/e", "2025-12-31T23:00:00Z"),
            ("2026/01/15/f", "2026-01-15T08:00:00Z"),
            ("2026/02/03/g", "2026-02-03T00:00:00Z"),
            ("2026/02/03/h", "2026-02-03T09:00:00Z"),
            ("2026/02/04/i", "2026-02-04T00:00:00Z"),
            ("2026/06/01/j", "2026-06-01T00:00:00Z"),
        ]
        .iter()
        .map(|(p, when)| {
            let slug = p.rsplit('/').next().unwrap();
            ((*p).to_string(), rec(&[("d", dt(when)), ("slug", s(slug))]))
        })
        .collect();
        write_records(ctx, &mut tree, "posts", &items, TOML_EXTENSION)
            .unwrap()
            .tree_hash
    }

    #[test]
    fn range_bounded_walk_visits_exactly_the_in_range_partitions_across_a_year_boundary() {
        let (_d, repo) = temp_repo();
        let hash = seed_daily(&tctx(&repo));
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ d: YYYY/MM/DD }}/${{ slug }}", &mut eng).unwrap();

        // Candidate set: inclusive at the date level on both ends. Note the
        // upper bound's own day (02/03) is visited even for `$lt` midnight.
        let q = rec(&[("d", rec(&[("$gte", s("2025-11-20")), ("$lt", dt("2026-02-03T00:00:00Z"))]))]);
        let paths =
            query_candidate_paths(&tctx(&repo), &mut tree, "posts", &template, &q, &mut eng, TOML_EXTENSION).unwrap();
        assert_eq!(
            paths,
            vec!["2025/11/20/c", "2025/11/25/d", "2025/12/31/e", "2026/01/15/f", "2026/02/03/g", "2026/02/03/h"]
        );

        // End to end: the record filter applies the exact `$lt` cutoff.
        let mut filter = Filter::new();
        filter.push("d", range_pred(&[("$gte", s("2025-11-20")), ("$lt", dt("2026-02-03T00:00:00Z"))]));
        let out = query_records(&tctx(&repo), &mut tree, "posts", &template, &filter, &mut eng, TOML_EXTENSION).unwrap();
        let slugs: Vec<&str> = out.iter().map(|(p, _)| p.rsplit('/').next().unwrap()).collect();
        assert_eq!(slugs, vec!["c", "d", "e", "f"]);
    }

    #[test]
    fn one_sided_ranges_prune_one_side() {
        let (_d, repo) = temp_repo();
        let hash = seed_daily(&tctx(&repo));
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ d: YYYY/MM/DD }}/${{ slug }}", &mut eng).unwrap();

        let q = rec(&[("d", rec(&[("$gt", s("2026-02-03"))]))]);
        let paths =
            query_candidate_paths(&tctx(&repo), &mut tree, "posts", &template, &q, &mut eng, TOML_EXTENSION).unwrap();
        assert_eq!(paths, vec!["2026/02/03/g", "2026/02/03/h", "2026/02/04/i", "2026/06/01/j"]);

        let q = rec(&[("d", rec(&[("$lte", s("2025-11-19"))]))]);
        let paths =
            query_candidate_paths(&tctx(&repo), &mut tree, "posts", &template, &q, &mut eng, TOML_EXTENSION).unwrap();
        assert_eq!(paths, vec!["2025/10/05/a", "2025/11/19/b"]);

        // `$gt` on the day's midnight excludes that day's records at the
        // record level while the walk still visits the partition.
        let mut filter = Filter::new();
        filter.push("d", range_pred(&[("$gt", s("2026-02-03T09:00:00Z"))]));
        let out = query_records(&tctx(&repo), &mut tree, "posts", &template, &filter, &mut eng, TOML_EXTENSION).unwrap();
        let slugs: Vec<&str> = out.iter().map(|(p, _)| p.rsplit('/').next().unwrap()).collect();
        assert_eq!(slugs, vec!["i", "j"]);
    }

    #[test]
    fn range_on_a_non_bucket_field_does_not_prune_but_still_filters() {
        let (_d, repo) = temp_repo();
        let hash = seed_people(&tctx(&repo));
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ slug }}", &mut eng).unwrap();

        // Candidate walk is the full set (string range on a plain field widens).
        let q = rec(&[("slug", rec(&[("$gte", s("b"))]))]);
        let paths =
            query_candidate_paths(&tctx(&repo), &mut tree, "people", &template, &q, &mut eng, TOML_EXTENSION).unwrap();
        assert_eq!(paths, vec!["amy", "bob", "jane"]);

        // …but the record-level range still applies.
        let mut filter = Filter::new();
        filter.push("slug", range_pred(&[("$gte", s("b"))]));
        let out = query_records(&tctx(&repo), &mut tree, "people", &template, &filter, &mut eng, TOML_EXTENSION).unwrap();
        let paths: Vec<&str> = out.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["bob", "jane"]);
    }

    #[test]
    fn bounded_leaf_when_the_bucket_is_the_entire_path() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let items: Vec<(String, Value)> = ["2026/01/30", "2026/01/31", "2026/02/01", "2026/02/02"]
            .iter()
            .map(|p| ((*p).to_string(), rec(&[("day", dt(&p.replace('/', "-")))])))
            .collect();
        let hash = write_records(&tctx(&repo), &mut tree, "rollups", &items, TOML_EXTENSION).unwrap().tree_hash;
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ day: YYYY/MM/DD }}", &mut eng).unwrap();

        let q = rec(&[("day", rec(&[("$gte", s("2026-01-31")), ("$lte", s("2026-02-01"))]))]);
        let paths =
            query_candidate_paths(&tctx(&repo), &mut tree, "rollups", &template, &q, &mut eng, TOML_EXTENSION).unwrap();
        assert_eq!(paths, vec!["2026/01/31", "2026/02/01"]);
    }

    #[test]
    fn boundary_tracking_resets_between_distinct_bucket_tokens() {
        // `${{ a: YYYY }}/${{ b: YYYY/MM }}/${{ slug }}`: a range on `b` must
        // not inherit "on the lower bound's prefix" from `a`'s segment.
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let items: Vec<(String, Value)> = [
            ("2020/2026/01/x", "2020-01-01", "2026-01-15"),
            ("2020/2026/03/y", "2020-01-01", "2026-03-15"),
            ("2021/2026/01/z", "2021-01-01", "2026-01-15"),
        ]
        .iter()
        .map(|(p, a, b)| {
            let slug = p.rsplit('/').next().unwrap();
            ((*p).to_string(), rec(&[("a", dt(a)), ("b", dt(b)), ("slug", s(slug))]))
        })
        .collect();
        let hash = write_records(&tctx(&repo), &mut tree, "x", &items, TOML_EXTENSION).unwrap().tree_hash;
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ a: YYYY }}/${{ b: YYYY/MM }}/${{ slug }}", &mut eng).unwrap();

        // a ∈ [2020, …) → both years; b ∈ (…, 2026-02] → only the /01 months.
        let q = rec(&[
            ("a", rec(&[("$gte", s("2020-06-01"))])),
            ("b", rec(&[("$lte", s("2026-02-28"))])),
        ]);
        let paths =
            query_candidate_paths(&tctx(&repo), &mut tree, "x", &template, &q, &mut eng, TOML_EXTENSION).unwrap();
        assert_eq!(paths, vec!["2020/2026/01/x", "2021/2026/01/z"]);
    }

    // ── format-aware query (spec: rust-core.md "Query traversal + filtering") ──

    fn md_format() -> FormatConfig {
        FormatConfig {
            kind: crate::config::FormatKind::Markdown,
            body: Some("body".into()),
            title: None,
            normalize: true,
        }
    }

    /// Seed `posts/<ring>/<slug>.md` markdown records with frontmatter + body.
    fn seed_markdown(ctx: &Context<'_>) -> String {
        let fmt = md_format();
        let mut tree = MutableTree::empty();
        for (ring, slug, body) in [("a", "one", "# One\n"), ("a", "two", "# Two\n"), ("b", "three", "# Three\n")] {
            let record = rec(&[("ring", s(ring)), ("slug", s(slug)), ("body", s(body))]);
            let text = codec::serialize(&record, &fmt).unwrap();
            tree.write_child_bytes(ctx, &format!("posts/{ring}/{slug}.md"), text.as_bytes()).unwrap();
        }
        tree.write(ctx).unwrap().to_string()
    }

    #[test]
    fn format_query_decodes_markdown_candidates_with_and_without_body() {
        let (_d, repo) = temp_repo();
        let hash = seed_markdown(&tctx(&repo));
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ ring }}/${{ slug }}", &mut eng).unwrap();
        let fmt = md_format();

        // Pruned to one ring; full records carry the body.
        let mut filter = Filter::new();
        filter.push("ring", FilterPred::Equals(s("a")));
        let out = query_records_format(&tctx(&repo), &mut tree, "posts", &template, &filter, &mut eng, ".md", &fmt, true)
            .unwrap();
        let paths: Vec<&str> = out.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["a/one", "a/two"]);
        let Value::Table(first) = &out[0].1 else { panic!() };
        assert_eq!(first.get("body"), Some(&s("# One")));

        // Lazy-body: the body field is absent, frontmatter intact, filter still applies.
        let mut filter = Filter::new();
        filter.push("slug", FilterPred::Equals(s("three")));
        let out = query_records_format(&tctx(&repo), &mut tree, "posts", &template, &filter, &mut eng, ".md", &fmt, false)
            .unwrap();
        assert_eq!(out.len(), 1);
        let Value::Table(r) = &out[0].1 else { panic!() };
        assert!(!r.contains_key("body"));
        assert_eq!(r.get("ring"), Some(&s("b")));

        // A TOML-format read of the same tree would be a parse error — the
        // codec selection is what makes `.md` blobs readable.
        assert!(query_records(&tctx(&repo), &mut tree, "posts", &template, &Filter::new(), &mut eng, ".md").is_err());
    }
}
