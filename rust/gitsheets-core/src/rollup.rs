//! Rollup sheets — committed, stamped per-partition aggregates
//! (`specs/behaviors/rollups.md`).
//!
//! A rollup sheet is a sheet config with a `[gitsheet.rollup]` table: its
//! records are aggregates over a **source** sheet, one per **partition** (a
//! proper prefix of the source's path template, or the whole sheet), each
//! stamped with the git tree id of the partition it summarizes (`sourceTree`).
//! This module owns:
//!
//! - **Resolution at sheet-open** ([`RollupDef::resolve`]): the source config,
//!   the prefix check, the allowed component kinds, and every other
//!   `config_invalid` case — so every binding reports them at open.
//! - **The canonical computation** of one partition's record
//!   ([`Sheet::compute_partition`]): the partition's records, read body-less in
//!   canonical path order, folded by [`crate::aggregate`], plus the key fields
//!   and the stamp, normalized and serialized like any record.
//! - **Reads through the source** ([`Sheet::rollup_query`] /
//!   [`Sheet::rollup_get`]): walk the source at the partition depth (pruned by
//!   the filter), serve a stored record whose stamp matches, recompute
//!   transiently otherwise.
//! - **Materializing** ([`Sheet::rollup_survey`] / [`Sheet::materialize`]).
//! - **The commit-time pass** ([`run_pass`]) a transaction, a merge, and each
//!   sync replay run before their tree is committed.

use std::collections::{BTreeMap, BTreeSet};

use holo_tree::{Child, Context, MutableTree, ObjectId};
use indexmap::IndexMap;

use crate::aggregate::{self, Prepared};
use crate::canonical;
use crate::codec;
use crate::config::{self, FormatConfig, FormatKind, SheetConfig};
use crate::engine::Engine;
use crate::error::{Error, Result};
use crate::path_template::{self, BucketUnit, PartitionKind, Template};
use crate::query::{self, Filter};
use crate::record;
use crate::sheet::{join_path, Sheet};
use crate::store::discover_sheets;
use crate::value::{Datetime, Value};

/// The stamp field every rollup record carries.
pub const SOURCE_TREE_FIELD: &str = "sourceTree";

/// How a read of a rollup sheet treats a stored record whose stamp no longer
/// matches its partition (`opts.stale`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Stale {
    /// Recompute stale or missing partitions transiently (the default).
    #[default]
    Recompute,
    /// Serve the stored records exactly as committed.
    Serve,
}

impl Stale {
    /// Parse the wire form (`recompute` / `serve`).
    pub fn parse(s: &str) -> Option<Stale> {
        match s {
            "recompute" => Some(Stale::Recompute),
            "serve" => Some(Stale::Serve),
            _ => None,
        }
    }
}

/// A partition's state against its stored rollup record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RollupStatus {
    Fresh,
    /// The stored bytes differ from the recomputed record.
    Stale,
    /// A partition with records and no stored rollup record.
    Missing,
    /// A stored rollup record with no partition (or an empty one).
    Orphaned,
}

impl RollupStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RollupStatus::Fresh => "fresh",
            RollupStatus::Stale => "stale",
            RollupStatus::Missing => "missing",
            RollupStatus::Orphaned => "orphaned",
        }
    }
}

/// One partition's survey entry: its rollup record path, status, and (for
/// `Stale` / `Missing`) the bytes a materialize would write.
#[derive(Clone, Debug)]
pub struct SurveyEntry {
    pub path: String,
    pub status: RollupStatus,
    pub next_text: Option<String>,
}

/// What [`Sheet::materialize`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MaterializeOutcome {
    /// Rollup record paths written (stale or missing).
    pub recomputed: Vec<String>,
    /// Rollup record paths deleted (orphaned).
    pub deleted: Vec<String>,
}

impl MaterializeOutcome {
    pub fn is_empty(&self) -> bool {
        self.recomputed.is_empty() && self.deleted.is_empty()
    }
}

/// One partition component, as a key-field source.
#[derive(Clone, Debug)]
enum KeyPart {
    Literal(String),
    Field(String),
    Bucket { field: Vec<String>, unit: BucketUnit, token: usize },
}

/// A resolved `[gitsheet.rollup]`: everything a rollup sheet needs to read
/// through, compute, and maintain its partitions. Held on the [`Sheet`].
pub struct RollupDef {
    /// The source sheet's name.
    pub source: String,
    /// The source config blob's tree path.
    pub source_config_path: String,
    /// The rollup config blob's tree path.
    pub config_path: String,
    /// The source's effective data base (`open_root/source.root/prefix`).
    source_base: String,
    /// The source's path template, compiled into the owning sheet's engine.
    source_template: Template,
    source_format: FormatConfig,
    /// A whole-sheet rollup's literal record path; `None` for a partitioned one.
    whole: Option<String>,
    /// The partition components (empty for a whole-sheet rollup).
    parts: Vec<KeyPart>,
    prepared: Prepared,
}

fn invalid(config_path: &str, message: impl std::fmt::Display) -> Error {
    Error::ConfigInvalid {
        message: format!("{config_path}: [gitsheet.rollup] {message}"),
    }
}

/// The bucket-unit runs a partition token may stop at: a whole format, or a
/// calendar `YYYY/MM/DD` cut at `YYYY` / `YYYY/MM`. `YYYY/WW` only whole.
fn allowed_units(units: &[BucketUnit]) -> bool {
    use BucketUnit::*;
    matches!(
        units,
        [CalendarYear] | [CalendarYear, Month] | [CalendarYear, Month, Day] | [IsoWeekYear, IsoWeek]
    )
}

fn describe(kind: &PartitionKind) -> String {
    match kind {
        PartitionKind::Literal(t) => format!("literal {t:?}"),
        PartitionKind::Field(f) => format!("${{{{ {f} }}}}"),
        PartitionKind::Bucket { field, .. } => format!("a date bucket on {:?}", field.join(".")),
        PartitionKind::Other => "an expression / multi-reference / recursive component".into(),
    }
}

impl RollupDef {
    /// Resolve a rollup sheet's `[gitsheet.rollup]` against its source, read
    /// from the same tree and `.gitsheets/` directory. Every problem is
    /// [`Error::ConfigInvalid`] (`specs/behaviors/rollups.md` "Declaration").
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn resolve(
        ctx: &Context<'_>,
        tree: &mut MutableTree,
        config_path: &str,
        config: &SheetConfig,
        rollup_template: &Template,
        open_root: &str,
        prefix: &str,
        engine: &mut Engine,
    ) -> Result<RollupDef> {
        let rollup = config.rollup.as_ref().expect("resolve on a rollup sheet");
        if config.format.kind != FormatKind::Toml {
            return Err(invalid(
                config_path,
                "a rollup sheet stores TOML records — [gitsheet.format] must be type = \"toml\"",
            ));
        }

        // The source: a sibling config in the same `.gitsheets/` directory.
        let dir = match config_path.rsplit_once('/') {
            Some((d, _)) => d.to_string(),
            None => ".".to_string(),
        };
        let source_config_path = join_path(&[&dir, &format!("{}.toml", rollup.from)]);
        let bytes = tree
            .read_blob(ctx, &source_config_path)
            .map_err(record::map_ht)?
            .ok_or_else(|| {
                invalid(
                    config_path,
                    format!("from = {:?}: no source sheet config at {source_config_path}", rollup.from),
                )
            })?;
        let text = String::from_utf8(bytes)
            .map_err(|e| invalid(config_path, format!("source config is not UTF-8: {e}")))?;
        let source = config::parse_config(&canonical::parse(&text)?, &source_config_path)?;
        if source.rollup.is_some() {
            return Err(invalid(
                config_path,
                format!("from = {:?} names a rollup sheet — rollups over rollups are not allowed", rollup.from),
            ));
        }

        // Disjoint data subtrees: a rollup record under the source root would
        // change the very partition it summarizes.
        let r = join_path(&[&config.root]);
        let s = join_path(&[&source.root]);
        if r.is_empty() || s.is_empty() || r == s || r.starts_with(&format!("{s}/")) || s.starts_with(&format!("{r}/")) {
            return Err(invalid(
                config_path,
                format!(
                    "root {:?} overlaps the source's root {:?} — a rollup's records must live outside its source's data subtree (and vice versa)",
                    config.root, source.root
                ),
            ));
        }

        let source_template = Template::compile(&source.path, engine)?;
        let rk = rollup_template.partition_kinds();
        let sk = source_template.partition_kinds();

        let mut whole = None;
        let mut parts = Vec::new();
        if rk.iter().all(|k| matches!(k, PartitionKind::Literal(_))) {
            // A whole-sheet rollup: literal components only, one record.
            whole = Some(
                rk.iter()
                    .map(|k| match k {
                        PartitionKind::Literal(t) => t.as_str(),
                        _ => unreachable!(),
                    })
                    .collect::<Vec<_>>()
                    .join("/"),
            );
        } else {
            if rk.len() >= sk.len() {
                return Err(invalid(
                    config_path,
                    format!(
                        "path {:?} must be a proper prefix of the source's path {:?} — a partition is a subtree, so at least one source component must remain below it",
                        config.path, source.path
                    ),
                ));
            }
            for (i, (r, s)) in rk.iter().zip(&sk).enumerate() {
                if matches!(r, PartitionKind::Other) {
                    return Err(invalid(
                        config_path,
                        format!(
                            "path {:?}: component {i} is {} — only literal, plain-field (${{{{ field }}}}), and date-bucket components can form a partition",
                            config.path,
                            describe(r)
                        ),
                    ));
                }
                let same = match (r, s) {
                    (PartitionKind::Literal(a), PartitionKind::Literal(b)) => a == b,
                    (PartitionKind::Field(a), PartitionKind::Field(b)) => a == b,
                    (
                        PartitionKind::Bucket { field: fa, unit: ua, .. },
                        PartitionKind::Bucket { field: fb, unit: ub, .. },
                    ) => fa == fb && ua == ub,
                    _ => false,
                };
                if !same {
                    return Err(invalid(
                        config_path,
                        format!(
                            "path {:?} is not a prefix of the source's path {:?}: component {i} is {} in the rollup but {} in the source",
                            config.path,
                            source.path,
                            describe(r),
                            describe(s)
                        ),
                    ));
                }
                parts.push(match r {
                    PartitionKind::Literal(t) => KeyPart::Literal(t.clone()),
                    PartitionKind::Field(f) => KeyPart::Field(f.clone()),
                    PartitionKind::Bucket { field, unit, token } => KeyPart::Bucket {
                        field: field.clone(),
                        unit: *unit,
                        token: *token,
                    },
                    PartitionKind::Other => unreachable!(),
                });
            }
            // Each bucket token in the partition must stop at an allowed run.
            let mut tokens: BTreeMap<usize, Vec<BucketUnit>> = BTreeMap::new();
            for p in &parts {
                if let KeyPart::Bucket { unit, token, .. } = p {
                    tokens.entry(*token).or_default().push(*unit);
                }
            }
            for units in tokens.values() {
                if !allowed_units(units) {
                    return Err(invalid(
                        config_path,
                        format!(
                            "path {:?}: a date bucket may be cut at YYYY or YYYY/MM of a YYYY/MM/DD source, but a YYYY/WW bucket only whole (its YYYY is the ISO week-year)",
                            config.path
                        ),
                    ));
                }
            }
        }

        // Key fields: one per non-literal component (a bucket token is one).
        let mut keys: Vec<String> = Vec::new();
        let mut seen_tokens = BTreeSet::new();
        for p in &parts {
            let key = match p {
                KeyPart::Literal(_) => continue,
                KeyPart::Field(f) => f.clone(),
                KeyPart::Bucket { field, token, .. } => {
                    if !seen_tokens.insert(*token) {
                        continue;
                    }
                    field.join(".")
                }
            };
            if keys.contains(&key) {
                return Err(invalid(
                    config_path,
                    format!("path {:?} references the key field {key:?} twice", config.path),
                ));
            }
            keys.push(key);
        }
        let top_keys: Vec<&str> = keys.iter().map(|k| k.split('.').next().unwrap_or(k)).collect();
        for spec in &rollup.aggregates.specs {
            if spec.name == SOURCE_TREE_FIELD || top_keys.contains(&spec.name.as_str()) {
                return Err(invalid(
                    config_path,
                    format!(
                        "aggregate {:?} collides with {} — rollup records carry the partition's key fields and `{SOURCE_TREE_FIELD}`",
                        spec.name,
                        if spec.name == SOURCE_TREE_FIELD { "the stamp field".to_string() } else { format!("the key field {:?}", spec.name) }
                    ),
                ));
            }
        }
        if let Some(body) = &source.format.body {
            rollup
                .aggregates
                .check_body_field(body, None)
                .map_err(|e| invalid(config_path, e.message()))?;
        }
        let prepared = rollup
            .aggregates
            .clone()
            .prepare()
            .map_err(|e| invalid(config_path, e.message()))?;

        Ok(RollupDef {
            source: rollup.from.clone(),
            source_config_path,
            config_path: config_path.to_string(),
            source_base: join_path(&[open_root, &source.root, prefix]),
            source_template,
            source_format: source.format.clone(),
            whole,
            parts,
            prepared,
        })
    }

    /// The source's effective data base.
    pub fn source_base(&self) -> &str {
        &self.source_base
    }

    /// The partition depth in the source template (0 for a whole-sheet rollup).
    fn depth(&self) -> usize {
        self.parts.len()
    }

    /// The partition path (under the source base) a rollup record path names,
    /// or `None` when it can name no partition.
    fn partition_of(&self, record_path: &str) -> Option<String> {
        match &self.whole {
            Some(w) => (record_path == w).then(String::new),
            None => {
                let n = record_path.split('/').count();
                (n == self.depth() && !record_path.is_empty()).then(|| record_path.to_string())
            }
        }
    }

    /// The rollup record path of a partition path.
    fn record_path_of(&self, partition: &str) -> String {
        match &self.whole {
            Some(w) => w.clone(),
            None => partition.to_string(),
        }
    }

    /// Whether a partition path's segments are names its components could
    /// have rendered (literals exact, bucket segments well-formed).
    fn segments_plausible(&self, partition: &str) -> bool {
        if self.whole.is_some() {
            return partition.is_empty();
        }
        let segs: Vec<&str> = partition.split('/').collect();
        segs.len() == self.parts.len()
            && segs.iter().zip(&self.parts).all(|(seg, part)| match part {
                KeyPart::Literal(t) => seg == t,
                KeyPart::Field(_) => !seg.is_empty(),
                KeyPart::Bucket { unit, .. } => path_template::parse_bucket_segment(seg, *unit).is_some(),
            })
    }
}

/// Set nested `path` in `table` to `value`, creating intermediate tables.
fn insert_nested(table: &mut IndexMap<String, Value>, path: &[String], value: Value) {
    match path {
        [] => {}
        [last] => {
            table.insert(last.clone(), value);
        }
        [head, rest @ ..] => {
            let entry = table
                .entry(head.clone())
                .or_insert_with(|| Value::Table(IndexMap::new()));
            if !matches!(entry, Value::Table(_)) {
                *entry = Value::Table(IndexMap::new());
            }
            if let Value::Table(inner) = entry {
                insert_nested(inner, rest, value);
            }
        }
    }
}

fn local_date(date: chrono::NaiveDate) -> Value {
    use chrono::Datelike;
    Value::Datetime(Datetime(toml::value::Datetime {
        date: Some(toml::value::Date {
            year: date.year() as u16,
            month: date.month() as u8,
            day: date.day() as u8,
        }),
        time: None,
        offset: None,
    }))
}

fn stamp_of(text: &str) -> Option<String> {
    match canonical::parse(text).ok()? {
        Value::Table(t) => match t.get(SOURCE_TREE_FIELD) {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn with_partition(err: Error, partition: &str) -> Error {
    match err {
        Error::AggregationFailed {
            message,
            sheet,
            aggregate,
            partition: None,
        } => Error::AggregationFailed {
            message: format!("{message} (partition {partition:?})"),
            sheet,
            aggregate,
            partition: Some(partition.to_string()),
        },
        other => other,
    }
}

const ROLLUP_EXTENSION: &str = ".toml";

/// One bucket token's field and its rendered `(unit, value)` segments.
type TokenSegments = (Vec<String>, Vec<(BucketUnit, u32)>);

/// Body-less decodes of source record blobs, keyed by blob id and format.
/// A blob id names immutable bytes, so an entry never goes stale; the cache
/// lets a long-lived process recompute a touched partition by re-reading
/// only the records that changed since the last commit, while still folding
/// over every record in canonical order (the result is the plain fold, bit
/// for bit). Cleared wholesale when it reaches [`PARSED_CACHE_CAP`] entries.
type ParsedCache = std::sync::Mutex<std::collections::HashMap<(ObjectId, String), Value>>;
static PARSED: std::sync::OnceLock<ParsedCache> = std::sync::OnceLock::new();
const PARSED_CACHE_CAP: usize = 200_000;

fn parsed_header(ctx: &Context<'_>, hash: ObjectId, format: &FormatConfig) -> Result<Value> {
    let key = (hash, format!("{:?}|{:?}", format.kind, format.body));
    let cache = PARSED.get_or_init(Default::default);
    if let Some(v) = cache.lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(v);
    }
    let text = record::read_blob_text(ctx.repo, hash)?;
    let value = codec::parse_header_only(&text, format)?;
    if let Ok(mut c) = cache.lock() {
        if c.len() >= PARSED_CACHE_CAP {
            c.clear();
        }
        c.insert(key, value.clone());
    }
    Ok(value)
}

impl Sheet {
    /// Whether this is a rollup sheet.
    pub fn is_rollup(&self) -> bool {
        self.rollup.is_some()
    }

    /// The resolved rollup definition, for a rollup sheet.
    pub fn rollup_def(&self) -> Option<&RollupDef> {
        self.rollup.as_ref()
    }

    /// Refuse a write to a rollup sheet (`TransactionError` `sheet_derived`).
    pub(crate) fn ensure_writable(&self) -> Result<()> {
        match &self.rollup {
            None => Ok(()),
            Some(def) => Err(Error::SheetDerived {
                message: format!(
                    "sheet {:?} is a rollup of {:?}: its records are regenerated from the source at every commit gitsheets produces, and are never written directly (specs/behaviors/rollups.md)",
                    self.name, def.source
                ),
            }),
        }
    }

    fn rollup_full_path(&self, record_path: &str) -> String {
        format!("{}{ROLLUP_EXTENSION}", join_path(&[&self.base, record_path]))
    }

    fn stored_rollup_text(
        &self,
        ctx: &Context<'_>,
        tree: &mut MutableTree,
        record_path: &str,
    ) -> Result<Option<String>> {
        let full = self.rollup_full_path(record_path);
        match record::read_blob_entry(ctx, tree, &full)? {
            None => Ok(None),
            Some((_, bytes)) => Ok(Some(String::from_utf8(bytes).map_err(|e| Error::ConfigInvalid {
                message: format!("rollup record at {full} is not valid UTF-8: {e}"),
            })?)),
        }
    }

    /// The partitions under `tree` the `prune` record admits (the filter's
    /// prune record; an empty table admits all): `(partition path, tree id)`
    /// in sorted order, implausible names dropped.
    fn rollup_partitions(
        &mut self,
        ctx: &Context<'_>,
        tree: &mut MutableTree,
        prune: &Value,
    ) -> Result<Vec<(String, ObjectId)>> {
        let def = self.rollup.as_ref().expect("rollup sheet");
        let barg = record::base_arg(&def.source_base);
        let Some(base) = tree.get_subtree(ctx, &barg).map_err(record::map_ht)? else {
            return Ok(Vec::new());
        };
        let plan = def.source_template.plan_query(prune, &mut self.engine)?;
        let found = query::walk_partitions(ctx, base, &plan, def.depth())?;
        Ok(found.into_iter().filter(|(p, _)| def.segments_plausible(p)).collect())
    }

    /// The tree id of one partition in `tree`, or `None` when it is absent,
    /// empty, or not a plausible partition name.
    fn partition_id(
        &self,
        ctx: &Context<'_>,
        tree: &mut MutableTree,
        partition: &str,
    ) -> Result<Option<ObjectId>> {
        let def = self.rollup.as_ref().expect("rollup sheet");
        if !def.segments_plausible(partition) {
            return Ok(None);
        }
        let barg = record::base_arg(&join_path(&[&def.source_base, partition]));
        let Some(sub) = tree.get_subtree(ctx, &barg).map_err(record::map_ht)? else {
            return Ok(None);
        };
        let id = query::subtree_id(ctx, sub)?;
        Ok((id != holo_tree::tree::empty_tree_id()).then_some(id))
    }

    /// Compute one partition's rollup record (the canonical computation):
    /// the partition's records read body-less in canonical path order, the
    /// aggregates folded over them, the key fields and `sourceTree` added,
    /// schema-validated, normalized, and serialized. `None` when the partition
    /// holds no records, or is not a partition (its record would not render
    /// back to its own path). Returns the record (re-parsed from its bytes)
    /// and the bytes.
    pub(crate) fn compute_partition(
        &mut self,
        ctx: &Context<'_>,
        tree: &mut MutableTree,
        partition: &str,
        id: ObjectId,
    ) -> Result<Option<(Value, String)>> {
        let record_path = self.rollup.as_ref().expect("rollup sheet").record_path_of(partition);
        let rows = {
            let def = self.rollup.as_ref().expect("rollup sheet");
            let barg = record::base_arg(&join_path(&[&def.source_base, partition]));
            let Some(sub) = tree.get_subtree(ctx, &barg).map_err(record::map_ht)? else {
                return Ok(None);
            };
            let wildcard = def
                .source_template
                .plan_query(&Value::Table(IndexMap::new()), &mut self.engine)?;
            let ext = def.source_format.extension();
            let cands = query::candidates_in(ctx, sub, &wildcard, def.depth(), partition, ext)?;
            let mut rows = Vec::with_capacity(cands.len());
            for (path, hash) in cands {
                rows.push((path, parsed_header(ctx, hash, &def.source_format)?));
            }
            rows.sort_by(|a, b| format!("{}{ext}", a.0).as_bytes().cmp(format!("{}{ext}", b.0).as_bytes()));
            rows
        };
        if rows.is_empty() {
            return Ok(None);
        }

        let def = self.rollup.as_ref().expect("rollup sheet");
        let ext = def.source_format.extension();
        let aggs = aggregate::fold_rows(&self.name, &rows, ext, None, &def.prepared, &mut self.engine)
            .map_err(|e| with_partition(e, &record_path))?;

        let mut rec: IndexMap<String, Value> = IndexMap::new();
        if def.whole.is_none() {
            let segs: Vec<&str> = partition.split('/').collect();
            let mut tokens: BTreeMap<usize, TokenSegments> = BTreeMap::new();
            let first = match &rows[0].1 {
                Value::Table(t) => Some(t),
                _ => None,
            };
            for (seg, part) in segs.iter().zip(&def.parts) {
                match part {
                    KeyPart::Literal(_) => {}
                    KeyPart::Field(f) => {
                        let Some(v) = first.and_then(|t| t.get(f)) else {
                            return Ok(None);
                        };
                        rec.insert(f.clone(), v.clone());
                    }
                    KeyPart::Bucket { field, unit, token } => {
                        let Some(n) = path_template::parse_bucket_segment(seg, *unit) else {
                            return Ok(None);
                        };
                        let entry = tokens.entry(*token).or_insert_with(|| (field.clone(), Vec::new()));
                        entry.1.push((*unit, n));
                    }
                }
            }
            for (field, segments) in tokens.into_values() {
                let Some(date) = path_template::period_start(&segments) else {
                    return Ok(None);
                };
                insert_nested(&mut rec, &field, local_date(date));
            }
        }
        rec.insert(SOURCE_TREE_FIELD.to_string(), Value::String(id.to_string()));
        if let Value::Table(t) = aggs {
            for (k, v) in t {
                rec.insert(k, v);
            }
        }
        let rec = Value::Table(rec);

        if let Some(schema) = &self.schema {
            schema.validate_or_error(&rec).map_err(|e| match e {
                Error::ValidationFailed { message, issues } => Error::ValidationFailed {
                    message: format!("rollup {:?} partition {record_path:?}: {message}", self.name),
                    issues,
                },
                other => other,
            })?;
        }
        let normalized = self.normalize_record(&rec)?;
        match self.template.render(&normalized, &mut self.engine) {
            Ok(rendered) if rendered == record_path => {}
            _ => return Ok(None),
        }
        let text = codec::serialize(&normalized, &self.config.format)?;
        let value = canonical::parse(&text)?;
        Ok(Some((value, text)))
    }

    /// A rollup sheet's records in `tree` — the read-through
    /// (`specs/behaviors/rollups.md` "Reads"): partitions pruned by `filter`,
    /// each served from its stored record when the stamp matches and
    /// recomputed (without writing) otherwise; orphans are not yielded.
    /// `Stale::Serve` reads the stored records as committed. The full filter
    /// is applied to each record. Sorted by path.
    pub fn rollup_query(
        &mut self,
        ctx: &Context<'_>,
        tree: &mut MutableTree,
        filter: &Filter,
        stale: Stale,
    ) -> Result<Vec<(String, Value)>> {
        if stale == Stale::Serve {
            return self.query_stored(ctx, tree, filter);
        }
        let prune = query::prune_record(filter);
        let partitions = self.rollup_partitions(ctx, tree, &prune)?;
        let mut out = Vec::new();
        for (partition, id) in partitions {
            if let Some((path, record)) = self.read_partition(ctx, tree, &partition, id)? {
                if query::matches(filter, &record, &mut self.engine)? {
                    out.push((path, record));
                }
            }
        }
        Ok(out)
    }

    /// One partition through the stamp: the stored record when fresh, else
    /// the transient recomputation.
    fn read_partition(
        &mut self,
        ctx: &Context<'_>,
        tree: &mut MutableTree,
        partition: &str,
        id: ObjectId,
    ) -> Result<Option<(String, Value)>> {
        let record_path = self.rollup.as_ref().expect("rollup sheet").record_path_of(partition);
        if let Some(text) = self.stored_rollup_text(ctx, tree, &record_path)? {
            if stamp_of(&text).as_deref() == Some(id.to_string().as_str()) {
                return Ok(Some((record_path, canonical::parse(&text)?)));
            }
        }
        Ok(self
            .compute_partition(ctx, tree, partition, id)?
            .map(|(value, _)| (record_path, value)))
    }

    /// The one rollup record at `record_path`, read through the stamp
    /// (`Stale::Serve`: as stored). `None` when no partition is there.
    pub fn rollup_get(
        &mut self,
        ctx: &Context<'_>,
        tree: &mut MutableTree,
        record_path: &str,
        stale: Stale,
    ) -> Result<Option<Value>> {
        if stale == Stale::Serve {
            return match self.stored_rollup_text(ctx, tree, record_path)? {
                Some(text) => Ok(Some(canonical::parse(&text)?)),
                None => Ok(None),
            };
        }
        let Some(partition) = self.rollup.as_ref().expect("rollup sheet").partition_of(record_path) else {
            return Ok(None);
        };
        let Some(id) = self.partition_id(ctx, tree, &partition)? else {
            return Ok(None);
        };
        Ok(self.read_partition(ctx, tree, &partition, id)?.map(|(_, v)| v))
    }

    /// The stored rollup records, read like any sheet's (`Stale::Serve`).
    fn query_stored(
        &mut self,
        ctx: &Context<'_>,
        tree: &mut MutableTree,
        filter: &Filter,
    ) -> Result<Vec<(String, Value)>> {
        query::query_records_format(
            ctx,
            tree,
            &self.base,
            &self.template,
            filter,
            &mut self.engine,
            ROLLUP_EXTENSION,
            &self.config.format,
            true,
        )
    }

    /// Every stored rollup record path in `tree`.
    fn stored_rollup_paths(&mut self, ctx: &Context<'_>, tree: &mut MutableTree) -> Result<Vec<String>> {
        query::query_candidate_paths(
            ctx,
            tree,
            &self.base,
            &self.template,
            &Value::Table(IndexMap::new()),
            &mut self.engine,
            ROLLUP_EXTENSION,
        )
    }

    /// Recompute every partition and compare against the stored records:
    /// one entry per partition or stored record, `Fresh` included, sorted by
    /// path (`specs/behaviors/rollups.md` "Materializing explicitly").
    pub fn rollup_survey(&mut self, ctx: &Context<'_>, tree: &mut MutableTree) -> Result<Vec<SurveyEntry>> {
        let partitions = self.rollup_partitions(ctx, tree, &Value::Table(IndexMap::new()))?;
        let mut entries: BTreeMap<String, SurveyEntry> = BTreeMap::new();
        for (partition, id) in partitions {
            let record_path = self.rollup.as_ref().expect("rollup sheet").record_path_of(&partition);
            let stored = self.stored_rollup_text(ctx, tree, &record_path)?;
            let entry = match (self.compute_partition(ctx, tree, &partition, id)?, stored) {
                (Some((_, next)), None) => SurveyEntry { path: record_path.clone(), status: RollupStatus::Missing, next_text: Some(next) },
                (Some((_, next)), Some(cur)) if cur == next => SurveyEntry { path: record_path.clone(), status: RollupStatus::Fresh, next_text: None },
                (Some((_, next)), Some(_)) => SurveyEntry { path: record_path.clone(), status: RollupStatus::Stale, next_text: Some(next) },
                (None, Some(_)) => SurveyEntry { path: record_path.clone(), status: RollupStatus::Orphaned, next_text: None },
                (None, None) => continue,
            };
            entries.insert(record_path, entry);
        }
        for path in self.stored_rollup_paths(ctx, tree)? {
            entries.entry(path.clone()).or_insert(SurveyEntry {
                path,
                status: RollupStatus::Orphaned,
                next_text: None,
            });
        }
        Ok(entries.into_values().collect())
    }

    /// Recompute every stale or missing rollup record and delete orphaned
    /// ones in `tree` (`specs/behaviors/rollups.md` "Materializing
    /// explicitly"). Returns the rollup record paths touched; empty when
    /// everything was fresh (and `tree` is untouched).
    pub fn materialize(&mut self, ctx: &Context<'_>, tree: &mut MutableTree) -> Result<MaterializeOutcome> {
        let mut out = MaterializeOutcome::default();
        for entry in self.rollup_survey(ctx, tree)? {
            match entry.status {
                RollupStatus::Fresh => {}
                RollupStatus::Stale | RollupStatus::Missing => {
                    let full = self.rollup_full_path(&entry.path);
                    tree.write_child(ctx, &full, entry.next_text.as_deref().unwrap_or_default())
                        .map_err(record::map_ht)?;
                    out.recomputed.push(entry.path);
                }
                RollupStatus::Orphaned => {
                    let full = self.rollup_full_path(&entry.path);
                    tree.delete_child_deep(ctx, &full).map_err(record::map_ht)?;
                    out.deleted.push(entry.path);
                }
            }
        }
        Ok(out)
    }

    /// Regenerate the rollup records of `partitions` (paths under the source
    /// base) in `tree`: write each recomputed record, delete the record of a
    /// partition that is gone or empty. The incremental half of the pass.
    fn regenerate(
        &mut self,
        ctx: &Context<'_>,
        tree: &mut MutableTree,
        partitions: &BTreeSet<String>,
    ) -> Result<()> {
        for partition in partitions {
            let record_path = self.rollup.as_ref().expect("rollup sheet").record_path_of(partition);
            let full = self.rollup_full_path(&record_path);
            let computed = match self.partition_id(ctx, tree, partition)? {
                Some(id) => self.compute_partition(ctx, tree, partition, id)?,
                None => None,
            };
            match computed {
                Some((_, text)) => {
                    if self.stored_rollup_text(ctx, tree, &record_path)?.as_deref() != Some(text.as_str()) {
                        tree.write_child(ctx, &full, &text).map_err(record::map_ht)?;
                    }
                }
                None => {
                    if record::tree_entry_hash(ctx, tree, &full)?.is_some() {
                        tree.delete_child_deep(ctx, &full).map_err(record::map_ht)?;
                    }
                }
            }
        }
        Ok(())
    }
}

// ── the commit-time pass ───────────────────────────────────────────────────────

/// The `(name, tree id)` of each direct subtree of `tree`.
fn child_trees(ctx: &Context<'_>, tree: &mut MutableTree) -> Result<BTreeMap<String, ObjectId>> {
    tree.ensure_children(ctx).map_err(record::map_ht)?;
    let mut out = BTreeMap::new();
    for (name, child) in tree.children.as_mut().expect("children loaded").iter_mut() {
        if let Child::Tree(t) = child {
            let id = if t.dirty { t.write(ctx).map_err(record::map_ht)? } else { t.hash };
            out.insert(name.clone(), id);
        }
    }
    Ok(out)
}

/// The partition paths (at `depth`) whose subtree differs between `old` and
/// `new` — descending only into children whose ids differ.
fn diff_partitions(
    ctx: &Context<'_>,
    old: Option<&mut MutableTree>,
    new: Option<&mut MutableTree>,
    level: usize,
    depth: usize,
    prefix: &str,
    out: &mut BTreeSet<String>,
) -> Result<()> {
    if level == depth {
        out.insert(prefix.to_string());
        return Ok(());
    }
    let (mut old, mut new) = (old, new);
    let old_children = match old.as_deref_mut() {
        Some(t) => child_trees(ctx, t)?,
        None => BTreeMap::new(),
    };
    let new_children = match new.as_deref_mut() {
        Some(t) => child_trees(ctx, t)?,
        None => BTreeMap::new(),
    };
    let names: BTreeSet<&String> = old_children.keys().chain(new_children.keys()).collect();
    for name in names {
        if old_children.get(name) == new_children.get(name) {
            continue;
        }
        let child_prefix = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let o = match old.as_deref_mut() {
            Some(t) => match t.children.as_mut().and_then(|c| c.get_mut(name)) {
                Some(Child::Tree(sub)) => Some(sub),
                _ => None,
            },
            None => None,
        };
        let n = match new.as_deref_mut() {
            Some(t) => match t.children.as_mut().and_then(|c| c.get_mut(name)) {
                Some(Child::Tree(sub)) => Some(sub),
                _ => None,
            },
            None => None,
        };
        diff_partitions(ctx, o, n, level + 1, depth, &child_prefix, out)?;
    }
    Ok(())
}

/// The id of the subtree at `path` in the tree `root` (`None` when absent).
fn subtree_at(ctx: &Context<'_>, root: ObjectId, path: &str) -> Result<Option<ObjectId>> {
    let mut tree = MutableTree::new(root);
    let barg = record::base_arg(path);
    match tree.get_subtree(ctx, &barg).map_err(record::map_ht)? {
        Some(sub) => Ok(Some(sub.write(ctx).map_err(record::map_ht)?)),
        None => Ok(None),
    }
}

/// Run the rollup pass (`specs/behaviors/rollups.md` "Maintenance at commit")
/// over `tree`, the tree about to be committed. `compare` lists the
/// `(old, new)` tree-id pairs whose source differences mark partitions
/// touched (`old = None`: no parent — everything is touched); `scopes` the
/// `(open_root, prefix)` pairs to discover rollup sheets in. A rollup or
/// source config that differs across a pair regenerates the whole rollup
/// sheet. Errors (an `AggregationError`, a `ValidationError` against a rollup
/// schema, a rollup config problem) abort the caller's commit.
pub fn run_pass(
    ctx: &Context<'_>,
    tree: &mut MutableTree,
    compare: &[(Option<ObjectId>, ObjectId)],
    scopes: &[(String, String)],
) -> Result<()> {
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    for (open_root, prefix) in scopes {
        let key = (join_path(&[open_root]), join_path(&[prefix]));
        if !seen.insert(key) {
            continue;
        }
        for name in rollup_sheet_names(ctx, tree, open_root)? {
            let config_path = join_path(&[open_root, ".gitsheets", &format!("{name}.toml")]);
            let (key, mut sheet) = open_cached(ctx, tree, &name, &config_path, open_root, prefix)?;
            let def = sheet.rollup.as_ref().expect("rollup sheet");
            let configs = [def.config_path.clone(), def.source_config_path.clone()];
            let source_base = def.source_base.clone();
            let depth = def.depth();
            let whole = def.whole.is_some();

            let mut full = false;
            let mut touched: BTreeSet<String> = BTreeSet::new();
            for (old, new) in compare {
                let Some(old) = old else {
                    full = true;
                    break;
                };
                let mut old_tree = MutableTree::new(*old);
                let mut new_tree = MutableTree::new(*new);
                for path in &configs {
                    if record::tree_entry_hash(ctx, &mut old_tree, path)? != record::tree_entry_hash(ctx, &mut new_tree, path)? {
                        full = true;
                    }
                }
                if full {
                    break;
                }
                let old_base = subtree_at(ctx, *old, &source_base)?;
                let new_base = subtree_at(ctx, *new, &source_base)?;
                if old_base == new_base {
                    continue;
                }
                if whole {
                    touched.insert(String::new());
                    continue;
                }
                let mut o = old_base.map(MutableTree::new);
                let mut n = new_base.map(MutableTree::new);
                diff_partitions(ctx, o.as_mut(), n.as_mut(), 0, depth, "", &mut touched)?;
            }
            let result = if full {
                sheet.materialize(ctx, tree).map(|_| ())
            } else if !touched.is_empty() {
                sheet.regenerate(ctx, tree, &touched)
            } else {
                Ok(())
            };
            if let Some(key) = key {
                PASS_SHEETS.with(|c| {
                    let mut c = c.borrow_mut();
                    if c.len() >= PASS_SHEETS_CAP {
                        c.clear();
                    }
                    c.insert(key, sheet);
                });
            }
            result?;
        }
    }
    Ok(())
}

/// What a compiled rollup [`Sheet`] depends on: its scope and the exact
/// config blobs (its own and its source's) it was compiled from.
type PassKey = (String, String, String, ObjectId, ObjectId);

thread_local! {
    /// Rollup sheets compiled by earlier passes on this thread, reused while
    /// their config blobs are unchanged — opening one (engine, template,
    /// schema) costs more than regenerating a typical partition.
    static PASS_SHEETS: std::cell::RefCell<std::collections::HashMap<PassKey, Sheet>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}
const PASS_SHEETS_CAP: usize = 64;

/// Open a rollup sheet for the pass, reusing a compiled one when its configs
/// are unchanged. A sheet that declares contracts (whose documents could
/// change under an unchanged config) is opened fresh and not cached.
fn open_cached(
    ctx: &Context<'_>,
    tree: &mut MutableTree,
    name: &str,
    config_path: &str,
    open_root: &str,
    prefix: &str,
) -> Result<(Option<PassKey>, Sheet)> {
    let key = (|| -> Result<Option<PassKey>> {
        let Some((config_blob, bytes)) = record::read_blob_entry(ctx, tree, config_path)? else {
            return Ok(None);
        };
        let Ok(text) = String::from_utf8(bytes) else { return Ok(None) };
        let Ok(cfg) = config::parse_config(&canonical::parse(&text)?, config_path) else {
            return Ok(None);
        };
        let Some(rollup) = cfg.rollup.as_ref().filter(|_| cfg.implements.is_empty()) else {
            return Ok(None);
        };
        let dir = config_path.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
        let source_path = join_path(&[dir, &format!("{}.toml", rollup.from)]);
        let Some(source_blob) = record::tree_entry_hash(ctx, tree, &source_path)? else {
            return Ok(None);
        };
        Ok(Some((
            config_path.to_string(),
            open_root.to_string(),
            prefix.to_string(),
            record::parse_oid(&config_blob)?,
            source_blob,
        )))
    })()?;
    if let Some(k) = &key {
        if let Some(sheet) = PASS_SHEETS.with(|c| c.borrow_mut().remove(k)) {
            return Ok((key, sheet));
        }
    }
    let sheet = Sheet::open(ctx, tree, name, config_path, open_root, prefix)?;
    Ok((key, sheet))
}

/// The names of the rollup sheets declared under `open_root` in `tree` (a
/// cheap text check before parsing, since the pass runs on every commit).
pub fn rollup_sheet_names(ctx: &Context<'_>, tree: &mut MutableTree, open_root: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for name in discover_sheets(ctx, tree, open_root)? {
        let config_path = join_path(&[open_root, ".gitsheets", &format!("{name}.toml")]);
        let Some((_, bytes)) = record::read_blob_entry(ctx, tree, &config_path)? else {
            continue;
        };
        let Ok(text) = String::from_utf8(bytes) else { continue };
        if !text.contains("rollup") {
            continue;
        }
        let Ok(raw) = canonical::parse(&text) else { continue };
        let is_rollup = matches!(&raw, Value::Table(t) if matches!(t.get("gitsheet"), Some(Value::Table(g)) if g.contains_key("rollup")));
        if is_rollup {
            out.push(name);
        }
    }
    Ok(out)
}

/// The data bases (`open_root/root`, no prefix) of the rollup sheets declared
/// under `open_root` in the tree `tree_id` — the paths a sheet-aware merge and
/// a sync replay exclude from conflict classification.
pub fn rollup_bases(repo: &gix::Repository, tree_id: ObjectId, open_root: &str) -> Result<Vec<String>> {
    let cache = holo_tree::TreeCache::new();
    let ctx = Context::new(repo, &cache);
    let mut tree = MutableTree::new(tree_id);
    let mut out = Vec::new();
    for name in rollup_sheet_names(&ctx, &mut tree, open_root)? {
        let config_path = join_path(&[open_root, ".gitsheets", &format!("{name}.toml")]);
        let Some((_, bytes)) = record::read_blob_entry(&ctx, &mut tree, &config_path)? else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if let Ok(cfg) = config::parse_config(&canonical::parse(&text)?, &config_path) {
            out.push(join_path(&[open_root, &cfg.root]));
        }
    }
    Ok(out)
}

/// Whether `path` lies under one of `bases`.
pub fn under_any(path: &str, bases: &[String]) -> bool {
    bases.iter().any(|b| !b.is_empty() && (path == b || path.starts_with(&format!("{b}/"))))
}

/// Run the pass over a committed tree id, returning the resulting tree id —
/// the entry point for merge and sync, which hold tree ids rather than a
/// transaction's private tree.
pub fn run_pass_on_tree(
    repo: &gix::Repository,
    tree_id: ObjectId,
    compare: &[(Option<ObjectId>, ObjectId)],
    scopes: &[(String, String)],
) -> Result<ObjectId> {
    let cache = holo_tree::TreeCache::new();
    let ctx = Context::new(repo, &cache);
    let mut tree = MutableTree::new(tree_id);
    run_pass(&ctx, &mut tree, compare, scopes)?;
    tree.write(&ctx).map_err(record::map_ht)
}

#[cfg(test)]
#[path = "rollup_tests.rs"]
mod tests;
