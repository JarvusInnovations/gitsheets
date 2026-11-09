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

/// The stamp field naming the partition's source tree.
pub const SOURCE_TREE_FIELD: &str = "sourceTree";
/// The stamp field naming the `.gitsheets/` tree the record was computed under.
pub const CONFIG_TREE_FIELD: &str = "configTree";

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
    /// The `.gitsheets/` directory both configs live in (the `configTree`).
    config_dir: String,
    /// The number of path segments a source record path has (`None` when the
    /// source template is recursive): what lies beyond it is the prefix.
    source_segments: Option<usize>,
    /// The number of path segments a rollup record path has.
    rollup_segments: usize,
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
        PartitionKind::Dotted(f) => format!("the dotted field reference ${{{{ {f} }}}} — only a top-level field can be a partition key"),
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

        // Disjoint data subtrees, against what rollups depend on: every
        // rollup's source and every other rollup in the same `.gitsheets/`
        // directory (specs/behaviors/rollups.md). Ordinary sheets may overlap.
        let r = join_path(&[&config.root]);
        if join_path(&[&source.root]).is_empty() {
            return Err(invalid(
                config_path,
                format!(
                    "from = {:?}: the source sheet is rooted at '.', so every rollup root would sit inside the partition it stamps — give the source sheet a `root`",
                    rollup.from
                ),
            ));
        }
        let overlaps = |other: &str| {
            r.is_empty() || other.is_empty() || r == other || r.starts_with(&format!("{other}/")) || other.starts_with(&format!("{r}/"))
        };
        let own = config_path.rsplit('/').next().unwrap_or(config_path).trim_end_matches(".toml").to_string();
        let mut configs: BTreeMap<String, SheetConfig> = BTreeMap::new();
        for name in discover_sheets(ctx, tree, open_root)? {
            if name == own {
                continue;
            }
            let other_path = join_path(&[&dir, &format!("{name}.toml")]);
            let Some((_, bytes)) = record::read_blob_entry(ctx, tree, &other_path)? else { continue };
            let Ok(text) = String::from_utf8(bytes) else { continue };
            let Ok(raw) = canonical::parse(&text) else { continue };
            if let Ok(c) = config::parse_config(&raw, &other_path) {
                configs.insert(name, c);
            }
        }
        let mut sources: BTreeSet<String> = BTreeSet::from([rollup.from.clone()]);
        for c in configs.values() {
            if let Some(other) = &c.rollup {
                sources.insert(other.from.clone());
            }
        }
        for (name, c) in &configs {
            let role = if c.rollup.is_some() {
                "rollup sheet"
            } else if sources.contains(name) {
                "rollup source"
            } else {
                continue;
            };
            if overlaps(&join_path(&[&c.root])) {
                return Err(invalid(
                    config_path,
                    format!(
                        "root {:?} overlaps {role} {name:?}'s root {:?} — a rollup's records must live outside every rollup source's and every other rollup's data subtree (and vice versa)",
                        config.root, c.root
                    ),
                ));
            }
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
                if matches!(r, PartitionKind::Other | PartitionKind::Dotted(_)) {
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
                    PartitionKind::Other | PartitionKind::Dotted(_) => unreachable!(),
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
            let stamp = spec.name == SOURCE_TREE_FIELD || spec.name == CONFIG_TREE_FIELD;
            if stamp || top_keys.contains(&spec.name.as_str()) {
                return Err(invalid(
                    config_path,
                    format!(
                        "aggregate {:?} collides with {} — rollup records carry the partition's key fields and the `{SOURCE_TREE_FIELD}` / `{CONFIG_TREE_FIELD}` stamp",
                        spec.name,
                        if stamp { "a stamp field".to_string() } else { format!("the key field {:?}", spec.name) }
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
            config_dir: dir.clone(),
            source_segments: (!source_template.has_recursive()).then(|| source_template.component_count()),
            rollup_segments: rollup_template.component_count(),
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

/// A stored record's `(sourceTree, configTree)` stamp.
fn stamp_of(text: &str) -> Option<(String, String)> {
    match canonical::parse(text).ok()? {
        Value::Table(t) => match (t.get(SOURCE_TREE_FIELD), t.get(CONFIG_TREE_FIELD)) {
            (Some(Value::String(s)), Some(Value::String(c))) => Some((s.clone(), c.clone())),
            _ => None,
        },
        _ => None,
    }
}

/// The id of the subtree at `path` in `tree` (written when dirty); the empty
/// tree when absent.
fn dir_tree_id(ctx: &Context<'_>, tree: &mut MutableTree, path: &str) -> Result<ObjectId> {
    match tree.get_subtree(ctx, &record::base_arg(path)).map_err(record::map_ht)? {
        Some(sub) => query::subtree_id(ctx, sub),
        None => Ok(holo_tree::tree::empty_tree_id()),
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

    /// The current `configTree`: the `.gitsheets/` directory's tree id.
    fn config_tree_id(&self, ctx: &Context<'_>, tree: &mut MutableTree) -> Result<ObjectId> {
        dir_tree_id(ctx, tree, &self.rollup.as_ref().expect("rollup sheet").config_dir)
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
            for (seg, part) in segs.iter().zip(&def.parts) {
                match part {
                    KeyPart::Literal(_) => {}
                    KeyPart::Field(f) => {
                        // The first record (canonical order) that carries the
                        // field is authoritative.
                        let found = rows.iter().find_map(|(_, r)| match r {
                            Value::Table(t) => t.get(f),
                            _ => None,
                        });
                        let Some(v) = found else {
                            return Err(Error::AggregationFailed {
                                message: format!(
                                    "rollup {:?} partition {record_path:?}: no record carries the key field {f:?}",
                                    self.name
                                ),
                                sheet: self.name.clone(),
                                aggregate: f.clone(),
                                partition: Some(record_path.clone()),
                            });
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
        let config_tree = self.config_tree_id(ctx, tree)?;
        rec.insert(CONFIG_TREE_FIELD.to_string(), Value::String(config_tree.to_string()));
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
            let config_tree = self.config_tree_id(ctx, tree)?.to_string();
            if stamp_of(&text) == Some((id.to_string(), config_tree)) {
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

/// The id of the subtree at `path` in the tree `root` (`None` when absent).
fn subtree_at(ctx: &Context<'_>, root: ObjectId, path: &str) -> Result<Option<ObjectId>> {
    let mut tree = MutableTree::new(root);
    let barg = record::base_arg(path);
    match tree.get_subtree(ctx, &barg).map_err(record::map_ht)? {
        Some(sub) => Ok(Some(sub.write(ctx).map_err(record::map_ht)?)),
        None => Ok(None),
    }
}

/// A child entry's hash and whether it is a tree.
type Entry = (ObjectId, bool);

/// The hash of a child entry, and whether it is a tree.
fn entry_of(child: &Child) -> Entry {
    match child {
        Child::Tree(t) => (t.hash, true),
        Child::Blob { hash, .. } => (*hash, false),
        Child::Commit { hash } => (*hash, false),
    }
}

/// Every blob path (relative) that differs between two clean trees,
/// descending only into subtrees whose ids differ.
fn changed_blobs(
    ctx: &Context<'_>,
    old: Option<&mut MutableTree>,
    new: Option<&mut MutableTree>,
    prefix: &str,
    out: &mut BTreeSet<String>,
) -> Result<()> {
    let (mut old, mut new) = (old, new);
    let mut entries: BTreeMap<String, (Option<Entry>, Option<Entry>)> = BTreeMap::new();
    if let Some(t) = old.as_deref_mut() {
        t.ensure_children(ctx).map_err(record::map_ht)?;
        for (name, c) in t.children.as_ref().expect("loaded") {
            entries.entry(name.clone()).or_default().0 = Some(entry_of(c));
        }
    }
    if let Some(t) = new.as_deref_mut() {
        t.ensure_children(ctx).map_err(record::map_ht)?;
        for (name, c) in t.children.as_ref().expect("loaded") {
            entries.entry(name.clone()).or_default().1 = Some(entry_of(c));
        }
    }
    for (name, (o, n)) in entries {
        if o == n {
            continue;
        }
        let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let blob_side = matches!(o, Some((_, false))) || matches!(n, Some((_, false)));
        if blob_side {
            out.insert(path.clone());
        }
        let tree_side = matches!(o, Some((_, true))) || matches!(n, Some((_, true)));
        if tree_side {
            let o_sub = match old.as_deref_mut().and_then(|t| t.children.as_mut()).and_then(|c| c.get_mut(&name)) {
                Some(Child::Tree(sub)) => Some(sub),
                _ => None,
            };
            let n_sub = match new.as_deref_mut().and_then(|t| t.children.as_mut()).and_then(|c| c.get_mut(&name)) {
                Some(Child::Tree(sub)) => Some(sub),
                _ => None,
            };
            changed_blobs(ctx, o_sub, n_sub, &path, out)?;
        }
    }
    Ok(())
}

/// Changed blob paths under `base` between the trees `old` and `new`.
fn changed_under(ctx: &Context<'_>, old: ObjectId, new: ObjectId, base: &str) -> Result<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    let (o, n) = (subtree_at(ctx, old, base)?, subtree_at(ctx, new, base)?);
    if o != n {
        let mut ot = o.map(MutableTree::new);
        let mut nt = n.map(MutableTree::new);
        changed_blobs(ctx, ot.as_mut(), nt.as_mut(), "", &mut out)?;
    }
    Ok(out)
}

/// What the pass needs to map paths for one rollup sheet (from its prefix-less
/// resolution).
struct PassShape {
    /// `open_root/source.root` and `open_root/rollup.root` — no prefix.
    source_base: String,
    rollup_base: String,
    source_segments: Option<usize>,
    rollup_segments: usize,
    depth: usize,
    whole: Option<String>,
    ext: String,
}

impl PassShape {
    /// The `(prefix, partition)` a changed source path (relative to the
    /// source root) belongs to. A record file's prefix is the leading
    /// segments beyond what the template renders; any other file maps
    /// through the record whose attachment directory holds it (`exists`
    /// says whether a record file is present at a relative path).
    fn map_source(&self, rel: &str, mut exists: impl FnMut(&str) -> bool) -> Option<(String, String)> {
        let segs: Vec<&str> = rel.split('/').collect();
        let k = match self.source_segments {
            None => 0,
            Some(t) if rel.ends_with(&self.ext) && segs.len() >= t => segs.len() - t,
            Some(t) => (0..segs.len().saturating_sub(t)).find(|&k| {
                let candidate = format!("{}{}", segs[..k + t].join("/"), self.ext);
                exists(&candidate)
            })?,
        };
        (segs.len() >= k + self.depth).then(|| (segs[..k].join("/"), segs[k..k + self.depth].join("/")))
    }

    /// The `(prefix, partition)` a changed rollup path (relative to the
    /// rollup root) names — `partition = None` when it can name none (a
    /// stray file to delete).
    fn map_rollup(&self, rel: &str) -> Option<(String, Option<String>)> {
        let record = rel.strip_suffix(ROLLUP_EXTENSION)?;
        let segs: Vec<&str> = record.split('/').collect();
        if segs.len() < self.rollup_segments {
            return None;
        }
        let k = segs.len() - self.rollup_segments;
        let path = segs[k..].join("/");
        let partition = match &self.whole {
            Some(w) => (&path == w).then(String::new),
            None => Some(path),
        };
        Some((segs[..k].join("/"), partition))
    }
}

/// Run the rollup pass (`specs/behaviors/rollups.md` "Maintenance at commit")
/// over `tree`, the tree about to be committed, for every rollup sheet
/// declared in `<open_root>/.gitsheets/`. `compare` lists the `(old, new)`
/// tree-id pairs whose differences mark work (`old = None`: no parent —
/// everything is touched): each changed source path regenerates its
/// `(prefix, partition)`; with `heal`, each changed rollup path does too (a
/// merge or a sync replay: no unresolved or stale rollup blob survives). A
/// change to the `.gitsheets/` directory regenerates every `(prefix,
/// partition)`. A rollup sheet is resolved only when it has work, so an
/// invalid rollup config fails only the commits that touch it. Errors abort
/// the caller's commit.
pub fn run_pass(
    ctx: &Context<'_>,
    tree: &mut MutableTree,
    compare: &[(Option<ObjectId>, ObjectId)],
    open_root: &str,
    heal: bool,
) -> Result<()> {
    let config_dir = join_path(&[open_root, ".gitsheets"]);
    let mut config_changed = false;
    for (old, new) in compare {
        match old {
            None => config_changed = true,
            Some(old) => {
                if subtree_at(ctx, *old, &config_dir)? != subtree_at(ctx, *new, &config_dir)? {
                    config_changed = true;
                }
            }
        }
    }
    for name in rollup_sheet_names(ctx, tree, open_root)? {
        let config_path = join_path(&[open_root, ".gitsheets", &format!("{name}.toml")]);
        let mut work = config_changed;
        if !work {
            // Cheap: the two roots from the parsed configs, no resolution.
            let Some((source_base, rollup_base)) = light_bases(ctx, tree, open_root, &config_path)? else {
                continue;
            };
            for (old, new) in compare {
                let Some(old) = old else { continue };
                if subtree_at(ctx, *old, &source_base)? != subtree_at(ctx, *new, &source_base)?
                    || (heal && subtree_at(ctx, *old, &rollup_base)? != subtree_at(ctx, *new, &rollup_base)?)
                {
                    work = true;
                    break;
                }
            }
        }
        if !work {
            continue;
        }

        let (key, sheet) = open_cached(ctx, tree, &name, &config_path, open_root, "")?;
        let shape = {
            let def = sheet.rollup.as_ref().expect("rollup sheet");
            PassShape {
                source_base: def.source_base.clone(),
                rollup_base: sheet.base.clone(),
                source_segments: def.source_segments,
                rollup_segments: def.rollup_segments,
                depth: def.depth(),
                whole: def.whole.clone(),
                ext: def.source_format.extension().to_string(),
            }
        };
        cache_put(key, sheet);

        // prefix → touched partitions (None = everything) + stray rollup paths.
        let mut touched: BTreeMap<String, Option<BTreeSet<String>>> = BTreeMap::new();
        let mut strays: BTreeSet<String> = BTreeSet::new();
        if config_changed {
            touched.insert(String::new(), None);
            for prefix in enumerate_prefixes(ctx, tree, &shape)? {
                touched.insert(prefix, None);
            }
        } else {
            for (old, new) in compare {
                let Some(old) = old else { continue };
                let mut old_tree = MutableTree::new(*old);
                let mut new_tree = MutableTree::new(*new);
                for rel in changed_under(ctx, *old, *new, &shape.source_base)? {
                    let mapped = shape.map_source(&rel, |candidate| {
                        let full = join_path(&[&shape.source_base, candidate]);
                        matches!(record::tree_entry_hash(ctx, &mut new_tree, &full), Ok(Some(_)))
                            || matches!(record::tree_entry_hash(ctx, &mut old_tree, &full), Ok(Some(_)))
                    });
                    if let Some((prefix, partition)) = mapped {
                        if let Some(set) = touched.entry(prefix).or_insert_with(|| Some(BTreeSet::new())) {
                            set.insert(partition);
                        }
                    }
                }
                if heal {
                    for rel in changed_under(ctx, *old, *new, &shape.rollup_base)? {
                        match shape.map_rollup(&rel) {
                            Some((prefix, Some(partition))) => {
                                if let Some(set) = touched.entry(prefix).or_insert_with(|| Some(BTreeSet::new())) {
                                    set.insert(partition);
                                }
                            }
                            _ if rel.ends_with(ROLLUP_EXTENSION) => {
                                strays.insert(join_path(&[&shape.rollup_base, &rel]));
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        for (prefix, partitions) in touched {
            let (key, mut sheet) = open_cached(ctx, tree, &name, &config_path, open_root, &prefix)?;
            let result = match &partitions {
                None => sheet.materialize(ctx, tree).map(|_| ()),
                Some(set) => sheet.regenerate(ctx, tree, set),
            };
            cache_put(key, sheet);
            result?;
        }
        for path in strays {
            if record::tree_entry_hash(ctx, tree, &path)?.is_some() {
                tree.delete_child_deep(ctx, &path).map_err(record::map_ht)?;
            }
        }
    }
    Ok(())
}

/// Every prefix the source and rollup roots hold records under (for a full
/// regenerate). A recursive source template has no prefixes.
fn enumerate_prefixes(ctx: &Context<'_>, tree: &mut MutableTree, shape: &PassShape) -> Result<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    let Some(t) = shape.source_segments else {
        return Ok(out);
    };
    for (base, ext, n) in [
        (&shape.source_base, shape.ext.as_str(), t),
        (&shape.rollup_base, ROLLUP_EXTENSION, shape.rollup_segments),
    ] {
        let Some(sub) = tree.get_subtree(ctx, &record::base_arg(base)).map_err(record::map_ht)? else {
            continue;
        };
        for (path, _) in sub.get_blob_map(ctx).map_err(record::map_ht)? {
            let Some(stem) = path.strip_suffix(ext) else { continue };
            let segs: Vec<&str> = stem.split('/').collect();
            if segs.len() > n {
                out.insert(segs[..segs.len() - n].join("/"));
            }
        }
    }
    Ok(out)
}

/// The (prefix-less) source and rollup data bases of a rollup config, from
/// the parsed configs alone — `None` when either does not parse (nothing to
/// do unless the configs changed, which resolves the sheet properly).
fn light_bases(ctx: &Context<'_>, tree: &mut MutableTree, open_root: &str, config_path: &str) -> Result<Option<(String, String)>> {
    let parse = |tree: &mut MutableTree, path: &str| -> Result<Option<SheetConfig>> {
        let Some((_, bytes)) = record::read_blob_entry(ctx, tree, path)? else { return Ok(None) };
        let Ok(text) = String::from_utf8(bytes) else { return Ok(None) };
        let Ok(raw) = canonical::parse(&text) else { return Ok(None) };
        Ok(config::parse_config(&raw, path).ok())
    };
    let Some(cfg) = parse(tree, config_path)? else { return Ok(None) };
    let Some(rollup) = cfg.rollup.as_ref() else { return Ok(None) };
    let dir = config_path.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
    let Some(source) = parse(tree, &join_path(&[dir, &format!("{}.toml", rollup.from)]))? else {
        return Ok(None);
    };
    Ok(Some((join_path(&[open_root, &source.root]), join_path(&[open_root, &cfg.root]))))
}

fn cache_put(key: Option<PassKey>, sheet: Sheet) {
    if let Some(key) = key {
        PASS_SHEETS.with(|c| {
            let mut c = c.borrow_mut();
            if c.len() >= PASS_SHEETS_CAP {
                c.clear();
            }
            c.insert(key, sheet);
        });
    }
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
const PASS_SHEETS_CAP: usize = 256;

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
    open_root: &str,
    heal: bool,
) -> Result<ObjectId> {
    let cache = holo_tree::TreeCache::new();
    let ctx = Context::new(repo, &cache);
    let mut tree = MutableTree::new(tree_id);
    run_pass(&ctx, &mut tree, compare, open_root, heal)?;
    tree.write(&ctx).map_err(record::map_ht)
}

#[cfg(test)]
#[path = "rollup_tests.rs"]
mod tests;
