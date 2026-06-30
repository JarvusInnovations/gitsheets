//! The `Sheet` half of the orchestration state machine.
//!
//! A [`Sheet`] is a compiled sheet definition: the parsed [`SheetConfig`] plus
//! the path [`Template`], the [`CompiledSchema`], the array-field sort
//! comparators, and the secondary-index registry — **compiled once on open** and
//! reused across every operation (the persistent-handle contract from
//! [`specs/rust-core.md`](../../../specs/rust-core.md)). It composes the lower
//! primitives ([`crate::canonical`], [`crate::path_template`],
//! [`crate::validation`], [`crate::record`], [`crate::index`]) into the
//! upsert / willChange / delete / clear pipeline of
//! [`specs/api/sheet.md`](../../../specs/api/sheet.md), behavior-preserving
//! against `packages/gitsheets/src/sheet.ts`.
//!
//! ## The two-phase consumer-validator protocol
//!
//! The consumer's runtime validator (Standard Schema / Zod / Pydantic) runs
//! **host-side** and stays in the binding — the core never calls back into the
//! host mid-operation (re-entrancy hazard). The write is therefore split into:
//!
//! 1. **[`Sheet::prepare_upsert`]** *(non-mutating)* — body guard, JSON-Schema
//!    shape validation, canonical normalization, path render, unique-index
//!    conflict check, and canonical serialization, returning an
//!    [`UpsertCandidate`]. No tree mutation.
//! 2. **host gate** — the binding runs the consumer validator on the candidate's
//!    normalized record; a rejection throws *before* phase 3, so no bytes are
//!    written.
//! 3. **[`Sheet::stage_upsert`]** *(mutating)* — rename-delete + blob write into
//!    the transaction tree.
//!
//! Because phases 1 and 3 are separate calls with **no core lock held between
//! them**, the host callback never re-enters the core while it holds state. A
//! transforming validator is supported by re-invoking `prepare_upsert` on the
//! transformed record before `stage_upsert` (prepare is idempotent and cheap).

use std::collections::HashMap;

use holo_tree::MutableTree;
use indexmap::IndexMap;

use crate::canonical;
use crate::codec;
use crate::config::{self, SheetConfig, SortRule};
use crate::engine::{Engine, SnippetError, SnippetHandle};
use crate::error::{Error, Result};
use crate::index::{MultiIndex, UniqueIndex};
use crate::path_template::Template;
use crate::record::{self};
use crate::validation::CompiledSchema;
use crate::value::Value;

/// A secondary-index definition (`defineIndex`).
struct IndexDef {
    name: String,
    unique: bool,
    key_handle: SnippetHandle,
}

/// Built indexes cached against a single tree hash. Invalidated (dropped) when
/// the sheet's data tree moves — the `#ensureIndexBuilt` state machine from
/// `sheet.ts`, now keyed by the data subtree's hash.
struct IndexCache {
    tree_hash: String,
    unique: HashMap<String, UniqueIndex>,
    multi: HashMap<String, MultiIndex>,
}

/// The candidate an upsert would write — the output of phase 1 of the two-phase
/// protocol. Carries everything `stage_upsert` needs plus the willChange info.
#[derive(Clone, Debug)]
pub struct UpsertCandidate {
    /// The sheet-relative path the record renders to (no extension).
    pub record_path: String,
    /// The path the record was previously stored at (rename source), if any.
    pub previous_path: Option<String>,
    /// The canonical bytes that would be written.
    pub next_text: String,
    /// The normalized record (post shape-validation + canonical normalization).
    pub normalized: Value,
}

/// The result of [`Sheet::will_change`] — pre-flight idempotency for upsert.
#[derive(Clone, Debug)]
pub struct WillChange {
    pub changed: bool,
    pub path: String,
    pub current_blob_hash: Option<String>,
    pub next_text: String,
}

/// The result of [`Sheet::stage_upsert`].
#[derive(Clone, Debug)]
pub struct StageOutcome {
    pub blob_hash: String,
    pub path: String,
}

/// A compiled sheet handle.
///
/// Holds a `!Send` boa [`Engine`] (path/sort/index snippets), so it is
/// constructed and used on its owning thread — the thread-confinement the spec
/// requires. The data tree it operates on is passed in per call (owned by the
/// [`Transaction`](crate::transaction::Transaction)); the Sheet itself never
/// owns a tree.
pub struct Sheet {
    name: String,
    config: SheetConfig,
    /// Effective data base: `join(open_root, config.root, prefix)`.
    base: String,
    template: Template,
    schema: Option<CompiledSchema>,
    /// Per-field array-sort comparators, keyed by field name. `All(false)` rules
    /// have no entry (they are a no-op).
    sort_handles: IndexMap<String, SnippetHandle>,
    indexes: Vec<IndexDef>,
    index_cache: Option<IndexCache>,
    engine: Engine,
}

impl Sheet {
    /// Open a sheet by reading + parsing its `.gitsheets/<name>.toml` config from
    /// `tree`, then compiling the template, schema, and sort comparators once.
    ///
    /// `config_blob_path` is the full tree path to the config blob
    /// (`<open_root>/.gitsheets/<name>.toml`). `open_root` is the
    /// `Repository.openSheet({ root })` scoping (default `"."`); `prefix` is the
    /// optional sub-prefix under `config.root`. A missing config is
    /// [`Error::ConfigMissing`].
    pub fn open(
        repo: &gix::Repository,
        tree: &mut MutableTree,
        name: &str,
        config_blob_path: &str,
        open_root: &str,
        prefix: &str,
    ) -> Result<Self> {
        let bytes = tree
            .read_blob(repo, config_blob_path)
            .map_err(record::map_ht)?
            .ok_or_else(|| Error::ConfigMissing {
                message: format!("sheet config not found at {config_blob_path}"),
            })?;
        let text = String::from_utf8(bytes).map_err(|e| Error::ConfigInvalid {
            message: format!("{config_blob_path}: config is not valid UTF-8: {e}"),
        })?;
        let raw = canonical::parse(&text)?;
        let config = config::parse_config(&raw, config_blob_path)?;

        let base = join_path(&[open_root, &config.root, prefix]);

        let mut engine = Engine::new()?;
        let template = Template::compile(&config.path, &mut engine)?;

        // Body↔template collision: the body field must not also identify the
        // record. Checked here (not in `parse_config`) because it needs the
        // compiled template's field names — matching the JS guard against
        // `Template.getFieldNames()`.
        if let Some(body) = &config.format.body {
            if template.get_field_names().iter().any(|f| f == body) {
                return Err(Error::ConfigInvalid {
                    message: format!(
                        "{config_blob_path}: [gitsheet.format].body = {body:?} collides with the path template — the body field cannot also identify the record"
                    ),
                });
            }
        }

        let schema = match &config.schema {
            Some(s) => Some(CompiledSchema::compile(s)?),
            None => None,
        };

        // Compile array-field sort comparators once.
        let mut sort_handles = IndexMap::new();
        for (field, fcfg) in &config.fields {
            if let Some(rule) = &fcfg.sort {
                if let Some(src) = comparator_source(rule) {
                    let handle = engine.compile(&src)?;
                    sort_handles.insert(field.clone(), handle);
                }
            }
        }

        Ok(Sheet {
            name: name.to_string(),
            config,
            base,
            template,
            schema,
            sort_handles,
            indexes: Vec::new(),
            index_cache: None,
            engine,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn config(&self) -> &SheetConfig {
        &self.config
    }

    /// The effective data base where this sheet's records live.
    pub fn base(&self) -> &str {
        &self.base
    }

    fn extension(&self) -> &'static str {
        self.config.format.extension()
    }

    /// Read every record under the sheet's base, decoding each through the
    /// format codec ([`crate::codec`]). `with_body` is the lazy-body switch: a
    /// markdown record read with `with_body = false` omits the (potentially
    /// large) body field, matching `Format.parseHeaderOnly`. No-op distinction
    /// for TOML sheets. Returns sheet-relative paths in sorted order.
    fn read_all(
        &self,
        repo: &gix::Repository,
        tree: &mut MutableTree,
        with_body: bool,
    ) -> Result<Vec<(String, Value)>> {
        let texts = record::list_record_texts(repo, tree, &self.base, self.extension())?;
        let mut out = Vec::with_capacity(texts.len());
        for (path, text) in texts {
            let record = if with_body {
                codec::parse(&text, &self.config.format)?
            } else {
                codec::parse_header_only(&text, &self.config.format)?
            };
            out.push((path, record));
        }
        Ok(out)
    }

    /// Render the path a record maps to (raw record, not normalized) — matches
    /// `Sheet.pathForRecord`. Used to resolve a record's path for delete.
    pub fn path_for_record(&mut self, record: &Value) -> Result<String> {
        self.template.render(record, &mut self.engine)
    }

    /// Apply canonical normalization — array-field sorts then deep key sort —
    /// without validating or writing. Matches `Sheet.normalizeRecord`.
    pub fn normalize_record(&mut self, record: &Value) -> Result<Value> {
        let mut out = record.clone();
        if let Value::Table(map) = &mut out {
            for (field, handle) in &self.sort_handles {
                if let Some(Value::Array(items)) = map.get_mut(field) {
                    sort_array(&mut self.engine, *handle, items)?;
                }
            }
        }
        Ok(canonical::normalize(&out))
    }

    // ── two-phase upsert ────────────────────────────────────────────────────

    /// Phase 1 of the upsert protocol *(non-mutating)*: body guard, JSON-Schema
    /// shape validation, canonical normalization, path render, unique-index
    /// conflict check, and canonical serialization. Returns the candidate the
    /// binding hands to the consumer validator before phase 3.
    ///
    /// `previous_path` is the record's prior storage path (rename source) — the
    /// host's `RECORD_PATH_KEY` annotation, passed explicitly since symbols are
    /// a host concern. `allow_missing_body` opts a markdown sheet out of the
    /// body-presence guard.
    pub fn prepare_upsert(
        &mut self,
        repo: &gix::Repository,
        tree: &mut MutableTree,
        record: &Value,
        previous_path: Option<String>,
        allow_missing_body: bool,
    ) -> Result<UpsertCandidate> {
        // Body-presence guard (markdown/mdx only): an upsert is a full-record
        // replace, so a record that omits the body field would silently erase
        // the on-disk body. Require explicit opt-in. Mirrors `Sheet.#prepareUpsert`
        // (the JS guard throws `TypeError`; the core surfaces it through the
        // typed taxonomy as `validation_failed` — see the plan Notes).
        if let Some(body_field) = &self.config.format.body {
            let present = matches!(record, Value::Table(t) if t.get(body_field).is_some());
            if !present && !allow_missing_body {
                return Err(Error::ValidationFailed {
                    message: format!(
                        "upsert: record is missing the body field {body_field:?}. Pass allowMissingBody: true to opt in, or use Sheet.patch for body-preserving frontmatter updates."
                    ),
                    issues: Vec::new(),
                });
            }
        }

        // JSON-Schema shape validation (the core's persisted-shape pass). The
        // consumer Standard Schema validator runs host-side between phases.
        if let Some(schema) = &self.schema {
            schema.validate_or_error(record)?;
        }

        let normalized = self.normalize_record(record)?;
        let record_path = self.template.render(&normalized, &mut self.engine)?;
        if record_path.is_empty() {
            return Err(Error::PathRenderFailed {
                message: format!(
                    "could not generate any path for record in sheet \"{}\"",
                    self.name
                ),
            });
        }

        // Pre-write unique-index conflict check (against the built index for the
        // current tree) — throws before any mutation.
        self.check_unique_conflicts(repo, tree, &normalized, &record_path)?;

        // Serialize through the format codec: TOML records → canonical TOML;
        // markdown/mdx → frontmatter + body (with title-from-H1 enforcement).
        let next_text = codec::serialize(&normalized, &self.config.format)?;

        Ok(UpsertCandidate {
            record_path,
            previous_path,
            next_text,
            normalized,
        })
    }

    /// Phase 3 *(mutating)*: rename-delete the old path (if the record moved) and
    /// write the candidate's bytes into `tree`. Returns the blob hash + path.
    /// Invalidates the index cache (the tree just changed).
    pub fn stage_upsert(
        &mut self,
        repo: &gix::Repository,
        tree: &mut MutableTree,
        candidate: &UpsertCandidate,
    ) -> Result<StageOutcome> {
        if let Some(prev) = &candidate.previous_path {
            if prev != &candidate.record_path {
                let old_full = join_record_path(&self.base, prev, self.extension());
                // Best effort — the old path may not exist.
                let _ = tree.delete_child_deep(repo, &old_full).map_err(record::map_ht);
            }
        }
        let full = join_record_path(&self.base, &candidate.record_path, self.extension());
        let blob_id = tree
            .write_child(repo, &full, &candidate.next_text)
            .map_err(record::map_ht)?;
        self.index_cache = None;
        Ok(StageOutcome {
            blob_hash: blob_id.to_string(),
            path: candidate.record_path.clone(),
        })
    }

    /// Pre-flight idempotency check for upsert *(non-mutating)*. Runs the same
    /// phase-1 pipeline, then compares the resulting bytes to the existing blob.
    /// Matches `Sheet.willChange`.
    pub fn will_change(
        &mut self,
        repo: &gix::Repository,
        tree: &mut MutableTree,
        record: &Value,
        previous_path: Option<String>,
        allow_missing_body: bool,
    ) -> Result<WillChange> {
        let candidate = self.prepare_upsert(repo, tree, record, previous_path, allow_missing_body)?;
        let full = join_record_path(&self.base, &candidate.record_path, self.extension());
        match read_blob_text(repo, tree, &full)? {
            None => Ok(WillChange {
                changed: true,
                path: candidate.record_path,
                current_blob_hash: None,
                next_text: candidate.next_text,
            }),
            Some((hash, current_text)) => Ok(WillChange {
                changed: current_text != candidate.next_text,
                path: candidate.record_path,
                current_blob_hash: Some(hash),
                next_text: candidate.next_text,
            }),
        }
    }

    /// Delete a record by its already-resolved sheet-relative path *(mutating)*.
    /// Throws [`Error::RecordNotFound`] when the path doesn't exist. Cascade-
    /// deletes the record's attachment directory. Matches `Sheet.delete`.
    pub fn delete_at_path(
        &mut self,
        repo: &gix::Repository,
        tree: &mut MutableTree,
        record_path: &str,
    ) -> Result<()> {
        let full = join_record_path(&self.base, record_path, self.extension());
        let existed = tree
            .read_blob(repo, &full)
            .map_err(record::map_ht)?
            .is_some();
        if !existed {
            return Err(Error::RecordNotFound {
                message: format!("{}: no record at {record_path}", self.name),
            });
        }
        tree.delete_child_deep(repo, &full).map_err(record::map_ht)?;
        // Cascade-delete the attachment directory at `<recordPath>/`, if any.
        let attach_dir = join_path(&[&self.base, record_path]);
        let _ = tree.delete_child_deep(repo, &attach_dir).map_err(record::map_ht);
        self.index_cache = None;
        Ok(())
    }

    /// `O(1)` clear of the sheet's data subtree *(mutating)*. Matches
    /// `Sheet.clear`.
    pub fn clear(&mut self, repo: &gix::Repository, tree: &mut MutableTree) -> Result<()> {
        let base_arg = if self.base.is_empty() { "." } else { &self.base };
        tree.clear_children(repo, base_arg).map_err(record::map_ht)?;
        self.index_cache = None;
        Ok(())
    }

    /// List every record under the sheet's base, in sorted path order, decoded
    /// through the format codec. `with_body` is the lazy-body switch for
    /// markdown sheets (`false` omits the body field — the `withBody: false`
    /// path); it is a no-op for TOML sheets.
    pub fn list(
        &self,
        repo: &gix::Repository,
        tree: &mut MutableTree,
        with_body: bool,
    ) -> Result<Vec<(String, Value)>> {
        self.read_all(repo, tree, with_body)
    }

    // ── indexing ─────────────────────────────────────────────────────────────

    /// Declare a secondary index. `key_snippet` is the full keyFn source
    /// (e.g. `(r) => r.email.toLowerCase()`), compiled once into the engine.
    pub fn define_index(&mut self, name: &str, unique: bool, key_snippet: &str) -> Result<()> {
        let key_handle = self.engine.compile(key_snippet)?;
        self.indexes.push(IndexDef {
            name: name.to_string(),
            unique,
            key_handle,
        });
        self.index_cache = None;
        Ok(())
    }

    /// Look up a record by a unique index. Builds the index against the current
    /// tree on demand (cached). [`Error::IndexNotDefined`] if undeclared.
    pub fn find_by_unique_index(
        &mut self,
        repo: &gix::Repository,
        tree: &mut MutableTree,
        name: &str,
        key: &str,
    ) -> Result<Option<Value>> {
        self.ensure_indexes_built(repo, tree)?;
        let cache = self.index_cache.as_ref().expect("built");
        let idx = cache.unique.get(name).ok_or_else(|| Error::IndexNotDefined {
            message: format!("index {name:?} is not defined on sheet {:?}", self.name),
        })?;
        Ok(idx.lookup(key).cloned())
    }

    /// Look up records by a non-unique index. Builds on demand (cached).
    pub fn find_by_multi_index(
        &mut self,
        repo: &gix::Repository,
        tree: &mut MutableTree,
        name: &str,
        key: &str,
    ) -> Result<Vec<Value>> {
        self.ensure_indexes_built(repo, tree)?;
        let cache = self.index_cache.as_ref().expect("built");
        let idx = cache.multi.get(name).ok_or_else(|| Error::IndexNotDefined {
            message: format!("index {name:?} is not defined on sheet {:?}", self.name),
        })?;
        Ok(idx.lookup(key).iter().map(|(_, r)| r.clone()).collect())
    }

    /// The `#ensureIndexBuilt` state machine: build every declared index against
    /// the current data-tree hash once, and rebuild only when the hash moves.
    fn ensure_indexes_built(
        &mut self,
        repo: &gix::Repository,
        tree: &mut MutableTree,
    ) -> Result<()> {
        let tree_hash = self.data_tree_hash(repo, tree)?;
        if let Some(cache) = &self.index_cache {
            if cache.tree_hash == tree_hash {
                return Ok(());
            }
        }
        // Index builds always use body-less reads (the body isn't a record
        // identifier): a keyFn referencing the body field sees it absent and the
        // record degenerates out of the index. Matches the JS contract in
        // specs/behaviors/content-types.md#indexes.
        let records = self.read_all(repo, tree, false)?;
        let mut unique = HashMap::new();
        let mut multi = HashMap::new();
        for def in &self.indexes {
            if def.unique {
                unique.insert(
                    def.name.clone(),
                    UniqueIndex::build(&records, def.key_handle, &mut self.engine)?,
                );
            } else {
                multi.insert(
                    def.name.clone(),
                    MultiIndex::build(&records, def.key_handle, &mut self.engine)?,
                );
            }
        }
        self.index_cache = Some(IndexCache {
            tree_hash,
            unique,
            multi,
        });
        Ok(())
    }

    /// The hash of the sheet's data subtree (the cache key). Falls back to the
    /// empty-tree hash when the subtree doesn't exist yet.
    fn data_tree_hash(&self, repo: &gix::Repository, tree: &mut MutableTree) -> Result<String> {
        let base_arg = if self.base.is_empty() { "." } else { &self.base };
        match tree.get_subtree(repo, base_arg).map_err(record::map_ht)? {
            Some(sub) => Ok(sub.write(repo).map_err(record::map_ht)?.to_string()),
            None => Ok(record::EMPTY_TREE_HASH.to_string()),
        }
    }

    /// Pre-write unique-index conflict check against the built indexes for the
    /// current tree. Only declared **unique** indexes are checked. A key already
    /// owned by a *different* path is [`Error::IndexUniqueConflict`].
    fn check_unique_conflicts(
        &mut self,
        repo: &gix::Repository,
        tree: &mut MutableTree,
        normalized: &Value,
        record_path: &str,
    ) -> Result<()> {
        if !self.indexes.iter().any(|d| d.unique) {
            return Ok(());
        }
        self.ensure_indexes_built(repo, tree)?;
        // Collect conflicts first to release the immutable cache borrow before
        // re-borrowing the engine for key computation.
        let defs: Vec<(String, SnippetHandle)> = self
            .indexes
            .iter()
            .filter(|d| d.unique)
            .map(|d| (d.name.clone(), d.key_handle))
            .collect();
        for (name, handle) in defs {
            let key = match self.engine.call_index_key(handle, normalized) {
                Ok(Some(k)) => k,
                Ok(None) => continue,
                Err(SnippetError::UndefinedReference(m) | SnippetError::Other(m)) => {
                    return Err(Error::ConfigInvalid {
                        message: format!("index keyFn failed: {m}"),
                    })
                }
            };
            let owner_path = self
                .index_cache
                .as_ref()
                .and_then(|c| c.unique.get(&name))
                .and_then(|idx| idx.lookup_path(&key));
            if let Some(owner) = owner_path {
                if owner != record_path {
                    return Err(Error::IndexUniqueConflict {
                        message: format!(
                            "unique index \"{name}\" on sheet \"{}\": key {key:?} is already used by {owner}",
                            self.name
                        ),
                        conflicting_paths: vec![owner.to_string(), record_path.to_string()],
                    });
                }
            }
        }
        Ok(())
    }
}

// ── comparator source generation (matches the JS `buildSorter`) ───────────────

/// Generate the comparator JS source for a sort rule, or `None` for `All(false)`
/// (a no-op). Mirrors `buildSorter` in `sheet.ts` so the engine runs the same
/// comparator the host's `node:vm` path would.
fn comparator_source(rule: &SortRule) -> Option<String> {
    match rule {
        SortRule::All(true) => Some(
            "(a, b) => ( String(a).localeCompare(String(b), undefined, { sensitivity: 'base', ignorePunctuation: true, numeric: true }) )".to_string(),
        ),
        SortRule::All(false) => None,
        SortRule::Raw(rule) => Some(format!("(a, b) => {{ {rule} }}")),
        SortRule::Fields(fields) => {
            let directives: Vec<(&str, i32)> = fields.iter().map(|f| (f.as_str(), 1)).collect();
            Some(directive_comparator(&directives))
        }
        SortRule::Directives(dirs) => {
            let directives: Vec<(&str, i32)> = dirs
                .iter()
                .map(|(f, d)| (f.as_str(), if *d == config::SortDir::Asc { 1 } else { -1 }))
                .collect();
            Some(directive_comparator(&directives))
        }
    }
}

fn directive_comparator(directives: &[(&str, i32)]) -> String {
    let mut lines = String::new();
    for (field, sign) in directives {
        let key = json_string(field);
        lines.push_str(&format!(
            "if ((a[{key}]) < (b[{key}])) return {}; if ((a[{key}]) > (b[{key}])) return {}; ",
            -sign, sign
        ));
    }
    lines.push_str("return 0;");
    format!("(a, b) => {{ {lines} }}")
}

/// JSON-encode a string for embedding as a JS object key literal.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Stable in-place sort of an array via an engine comparator. Insertion sort —
/// stable and fine for the small arrays sheet fields hold; each comparison runs
/// the compiled JS comparator (`< 0` ⇒ a before b, matching `Array.sort`).
fn sort_array(engine: &mut Engine, handle: SnippetHandle, items: &mut [Value]) -> Result<()> {
    let n = items.len();
    for i in 1..n {
        let mut j = i;
        while j > 0 {
            let cmp = compare_via(engine, handle, &items[j - 1], &items[j])?;
            if cmp > 0.0 {
                items.swap(j - 1, j);
                j -= 1;
            } else {
                break;
            }
        }
    }
    Ok(())
}

fn compare_via(engine: &mut Engine, handle: SnippetHandle, a: &Value, b: &Value) -> Result<f64> {
    let result = engine
        .call(handle, &[a.clone(), b.clone()])
        .map_err(|e| match e {
            SnippetError::UndefinedReference(m) | SnippetError::Other(m) => Error::ConfigInvalid {
                message: format!("array-field sort comparator failed: {m}"),
            },
        })?;
    engine.to_number(&result)
}

// ── path helpers ──────────────────────────────────────────────────────────────

/// Join tree-path segments, dropping empties / `.` / stray slashes. Matches the
/// JS `joinTreePath`.
pub fn join_path(parts: &[&str]) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in parts {
        for p in seg.split('/') {
            let p = p.trim_matches('/');
            if !p.is_empty() && p != "." {
                out.push(p);
            }
        }
    }
    out.join("/")
}

/// Join `base` + `record_path` + `extension` into a full tree path.
fn join_record_path(base: &str, record_path: &str, extension: &str) -> String {
    format!("{}{}", join_path(&[base, record_path]), extension)
}

/// Read a blob's hash + UTF-8 text at a full tree path. `None` when absent.
fn read_blob_text(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    full: &str,
) -> Result<Option<(String, String)>> {
    let hash = match tree.get_child(repo, full).map_err(record::map_ht)? {
        Some(holo_tree::Child::Blob { hash, .. }) => *hash,
        _ => return Ok(None),
    };
    let bytes = tree
        .read_blob(repo, full)
        .map_err(record::map_ht)?
        .ok_or_else(|| Error::RecordNotFound {
            message: format!("blob vanished at {full}"),
        })?;
    let text = String::from_utf8(bytes).map_err(|e| Error::ConfigInvalid {
        message: format!("record at {full} is not valid UTF-8: {e}"),
    })?;
    Ok(Some((hash.to_string(), text)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{write_records, TOML_EXTENSION};
    use indexmap::IndexMap;

    fn temp_repo() -> (tempfile::TempDir, gix::Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        (dir, repo)
    }

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

    /// A tree pre-loaded with a `.gitsheets/people.toml` config blob.
    fn tree_with_config(repo: &gix::Repository, config: Value) -> MutableTree {
        let mut tree = MutableTree::empty();
        write_records(repo, &mut tree, ".gitsheets", &[("people".into(), config)], TOML_EXTENSION)
            .unwrap();
        tree.write(repo).unwrap();
        tree
    }

    fn config(path: &str, root: &str) -> Value {
        let mut gs = IndexMap::new();
        gs.insert("path".to_string(), s(path));
        gs.insert("root".to_string(), s(root));
        let mut top = IndexMap::new();
        top.insert("gitsheet".to_string(), Value::Table(gs));
        Value::Table(top)
    }

    fn open(repo: &gix::Repository, tree: &mut MutableTree) -> Sheet {
        Sheet::open(repo, tree, "people", ".gitsheets/people.toml", ".", "").unwrap()
    }

    #[test]
    fn open_resolves_config_and_base() {
        let (_d, repo) = temp_repo();
        let mut tree = tree_with_config(&repo, config("${{ slug }}", "people"));
        let sheet = open(&repo, &mut tree);
        assert_eq!(sheet.name(), "people");
        assert_eq!(sheet.base(), "people");
    }

    #[test]
    fn missing_config_is_config_missing() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let err = Sheet::open(&repo, &mut tree, "ghost", ".gitsheets/ghost.toml", ".", "")
            .err()
            .unwrap();
        assert_eq!(err.code(), "config_missing");
    }

    #[test]
    fn prepare_renders_normalizes_and_serializes() {
        let (_d, repo) = temp_repo();
        let mut tree = tree_with_config(&repo, config("${{ slug }}", "people"));
        let mut sheet = open(&repo, &mut tree);
        let r = rec(&[("slug", s("jane")), ("email", s("jane@x.org"))]);
        let cand = sheet.prepare_upsert(&repo, &mut tree, &r, None, false).unwrap();
        assert_eq!(cand.record_path, "jane");
        // canonical bytes: keys sorted.
        assert_eq!(cand.next_text, "email = \"jane@x.org\"\nslug = \"jane\"\n");
    }

    #[test]
    fn will_change_true_then_false_after_stage() {
        let (_d, repo) = temp_repo();
        let mut tree = tree_with_config(&repo, config("${{ slug }}", "people"));
        let mut sheet = open(&repo, &mut tree);
        let r = rec(&[("slug", s("jane")), ("email", s("jane@x.org"))]);

        let wc = sheet.will_change(&repo, &mut tree, &r, None, false).unwrap();
        assert!(wc.changed);
        assert_eq!(wc.current_blob_hash, None);

        let cand = sheet.prepare_upsert(&repo, &mut tree, &r, None, false).unwrap();
        sheet.stage_upsert(&repo, &mut tree, &cand).unwrap();

        let wc2 = sheet.will_change(&repo, &mut tree, &r, None, false).unwrap();
        assert!(!wc2.changed, "byte-identical re-upsert is a no-op");
        assert!(wc2.current_blob_hash.is_some());
    }

    #[test]
    fn stage_rename_deletes_old_path() {
        let (_d, repo) = temp_repo();
        let mut tree = tree_with_config(&repo, config("${{ slug }}", "people"));
        let mut sheet = open(&repo, &mut tree);
        // Write at slug=jane.
        let r1 = rec(&[("slug", s("jane"))]);
        let c1 = sheet.prepare_upsert(&repo, &mut tree, &r1, None, false).unwrap();
        sheet.stage_upsert(&repo, &mut tree, &c1).unwrap();
        // Re-upsert with new slug, carrying previous_path=jane → old deleted.
        let r2 = rec(&[("slug", s("jane-doe"))]);
        let c2 = sheet
            .prepare_upsert(&repo, &mut tree, &r2, Some("jane".into()), false)
            .unwrap();
        sheet.stage_upsert(&repo, &mut tree, &c2).unwrap();
        let listed = sheet.list(&repo, &mut tree, true).unwrap();
        let paths: Vec<&str> = listed.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["jane-doe"]);
    }

    #[test]
    fn delete_missing_is_record_not_found() {
        let (_d, repo) = temp_repo();
        let mut tree = tree_with_config(&repo, config("${{ slug }}", "people"));
        let mut sheet = open(&repo, &mut tree);
        let err = sheet.delete_at_path(&repo, &mut tree, "ghost").err().unwrap();
        assert_eq!(err.code(), "record_not_found");
    }

    #[test]
    fn delete_removes_existing_record() {
        let (_d, repo) = temp_repo();
        let mut tree = tree_with_config(&repo, config("${{ slug }}", "people"));
        let mut sheet = open(&repo, &mut tree);
        let r = rec(&[("slug", s("jane"))]);
        let c = sheet.prepare_upsert(&repo, &mut tree, &r, None, false).unwrap();
        sheet.stage_upsert(&repo, &mut tree, &c).unwrap();
        sheet.delete_at_path(&repo, &mut tree, "jane").unwrap();
        assert!(sheet.list(&repo, &mut tree, true).unwrap().is_empty());
    }

    #[test]
    fn clear_empties_the_subtree() {
        let (_d, repo) = temp_repo();
        let mut tree = tree_with_config(&repo, config("${{ slug }}", "people"));
        let mut sheet = open(&repo, &mut tree);
        for slug in ["a", "b", "c"] {
            let r = rec(&[("slug", s(slug))]);
            let c = sheet.prepare_upsert(&repo, &mut tree, &r, None, false).unwrap();
            sheet.stage_upsert(&repo, &mut tree, &c).unwrap();
        }
        assert_eq!(sheet.list(&repo, &mut tree, true).unwrap().len(), 3);
        sheet.clear(&repo, &mut tree).unwrap();
        assert!(sheet.list(&repo, &mut tree, true).unwrap().is_empty());
    }

    #[test]
    fn normalize_applies_array_field_sort() {
        // Field `tags` sorts ascending (declarative `true`).
        let mut gs = IndexMap::new();
        gs.insert("path".to_string(), s("${{ slug }}"));
        gs.insert("root".to_string(), s("people"));
        let mut fields = IndexMap::new();
        let mut tags = IndexMap::new();
        tags.insert("sort".to_string(), Value::Boolean(true));
        fields.insert("tags".to_string(), Value::Table(tags));
        gs.insert("fields".to_string(), Value::Table(fields));
        let mut top = IndexMap::new();
        top.insert("gitsheet".to_string(), Value::Table(gs));

        let (_d, repo) = temp_repo();
        let mut tree = tree_with_config(&repo, Value::Table(top));
        let mut sheet = open(&repo, &mut tree);
        let r = rec(&[
            ("slug", s("jane")),
            ("tags", Value::Array(vec![s("charlie"), s("alpha"), s("bravo")])),
        ]);
        let norm = sheet.normalize_record(&r).unwrap();
        let Value::Table(m) = norm else { panic!() };
        let Value::Array(items) = &m["tags"] else { panic!() };
        let got: Vec<&str> = items
            .iter()
            .map(|v| match v {
                Value::String(s) => s.as_str(),
                _ => "?",
            })
            .collect();
        assert_eq!(got, vec!["alpha", "bravo", "charlie"]);
    }

    #[test]
    fn unique_index_conflict_blocks_upsert() {
        let (_d, repo) = temp_repo();
        let mut tree = tree_with_config(&repo, config("${{ slug }}", "people"));
        let mut sheet = open(&repo, &mut tree);
        sheet
            .define_index("byEmail", true, "(r) => ( r.email )")
            .unwrap();

        // Stage jane@x.org as slug=jane.
        let r1 = rec(&[("slug", s("jane")), ("email", s("dup@x.org"))]);
        let c1 = sheet.prepare_upsert(&repo, &mut tree, &r1, None, false).unwrap();
        sheet.stage_upsert(&repo, &mut tree, &c1).unwrap();

        // A different slug claiming the same email → conflict.
        let r2 = rec(&[("slug", s("bob")), ("email", s("dup@x.org"))]);
        let err = sheet
            .prepare_upsert(&repo, &mut tree, &r2, None, false)
            .err()
            .unwrap();
        assert_eq!(err.code(), "index_unique_conflict");
        assert_eq!(err.conflicting_paths(), &["jane".to_string(), "bob".to_string()]);

        // The same slug re-claiming its own email is fine (no conflict).
        let r3 = rec(&[("slug", s("jane")), ("email", s("dup@x.org"))]);
        assert!(sheet.prepare_upsert(&repo, &mut tree, &r3, None, false).is_ok());
    }

    #[test]
    fn find_by_index_lookup() {
        let (_d, repo) = temp_repo();
        let mut tree = tree_with_config(&repo, config("${{ slug }}", "people"));
        let mut sheet = open(&repo, &mut tree);
        sheet.define_index("byTeam", false, "(r) => ( r.team )").unwrap();
        for (slug, team) in [("a", "eng"), ("b", "eng"), ("c", "design")] {
            let r = rec(&[("slug", s(slug)), ("team", s(team))]);
            let c = sheet.prepare_upsert(&repo, &mut tree, &r, None, false).unwrap();
            sheet.stage_upsert(&repo, &mut tree, &c).unwrap();
        }
        assert_eq!(sheet.find_by_multi_index(&repo, &mut tree, "byTeam", "eng").unwrap().len(), 2);
        assert_eq!(sheet.find_by_multi_index(&repo, &mut tree, "byTeam", "design").unwrap().len(), 1);
        let err = sheet
            .find_by_multi_index(&repo, &mut tree, "nope", "x")
            .err()
            .unwrap();
        assert_eq!(err.code(), "index_not_defined");
    }

    // ── markdown / content-typed sheets ──────────────────────────────────────

    /// A tree pre-loaded with a markdown `posts` sheet config.
    fn markdown_tree(repo: &gix::Repository, title: bool) -> MutableTree {
        let mut gs = IndexMap::new();
        gs.insert("path".to_string(), s("${{ slug }}"));
        gs.insert("root".to_string(), s("posts"));
        let mut fmt = IndexMap::new();
        fmt.insert("type".to_string(), s("markdown"));
        fmt.insert("body".to_string(), s("body"));
        if title {
            fmt.insert("title".to_string(), s("title"));
        }
        gs.insert("format".to_string(), Value::Table(fmt));
        let mut top = IndexMap::new();
        top.insert("gitsheet".to_string(), Value::Table(gs));
        let mut tree = MutableTree::empty();
        write_records(repo, &mut tree, ".gitsheets", &[("people".into(), Value::Table(top))], TOML_EXTENSION).unwrap();
        tree.write(repo).unwrap();
        tree
    }

    #[test]
    fn markdown_upsert_writes_md_and_round_trips() {
        let (_d, repo) = temp_repo();
        let mut tree = markdown_tree(&repo, false);
        let mut sheet = open(&repo, &mut tree);
        let r = rec(&[("slug", s("hello")), ("title", s("Hello")), ("body", s("# Hello\n\nFirst post.\n"))]);
        let cand = sheet.prepare_upsert(&repo, &mut tree, &r, None, false).unwrap();
        assert_eq!(cand.record_path, "hello");
        assert!(cand.next_text.starts_with("+++\n"));
        assert!(cand.next_text.contains("+++\n\n# Hello\n\nFirst post.\n"));
        sheet.stage_upsert(&repo, &mut tree, &cand).unwrap();

        // Stored at posts/hello.md (not .toml).
        let listed = sheet.list(&repo, &mut tree, true).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].0, "hello");
        let Value::Table(m) = &listed[0].1 else { panic!() };
        assert_eq!(m.get("body"), Some(&s("# Hello\n\nFirst post.")));
        assert_eq!(m.get("title"), Some(&s("Hello")));
    }

    #[test]
    fn markdown_list_without_body_omits_body() {
        let (_d, repo) = temp_repo();
        let mut tree = markdown_tree(&repo, false);
        let mut sheet = open(&repo, &mut tree);
        let r = rec(&[("slug", s("a")), ("title", s("A")), ("body", s("HUGE BODY"))]);
        let cand = sheet.prepare_upsert(&repo, &mut tree, &r, None, false).unwrap();
        sheet.stage_upsert(&repo, &mut tree, &cand).unwrap();

        let with = sheet.list(&repo, &mut tree, true).unwrap();
        assert_eq!(with[0].1.type_name(), "table");
        let Value::Table(m) = &with[0].1 else { panic!() };
        assert_eq!(m.get("body"), Some(&s("HUGE BODY")));

        let without = sheet.list(&repo, &mut tree, false).unwrap();
        let Value::Table(m2) = &without[0].1 else { panic!() };
        assert_eq!(m2.get("body"), None);
        assert_eq!(m2.get("title"), Some(&s("A")));
    }

    #[test]
    fn markdown_missing_body_guard_and_opt_in() {
        let (_d, repo) = temp_repo();
        let mut tree = markdown_tree(&repo, false);
        let mut sheet = open(&repo, &mut tree);

        // Missing body without opt-in → validation_failed.
        let r = rec(&[("slug", s("a")), ("title", s("A"))]);
        let err = sheet.prepare_upsert(&repo, &mut tree, &r, None, false).err().unwrap();
        assert_eq!(err.code(), "validation_failed");
        assert!(err.message().contains("missing the body field"));

        // With allow_missing_body → writes an empty body.
        let cand = sheet.prepare_upsert(&repo, &mut tree, &r, None, true).unwrap();
        sheet.stage_upsert(&repo, &mut tree, &cand).unwrap();
        let listed = sheet.list(&repo, &mut tree, true).unwrap();
        let Value::Table(m) = &listed[0].1 else { panic!() };
        assert_eq!(m.get("body"), Some(&s("")));
    }

    #[test]
    fn markdown_title_from_h1_derivation_and_disagreement() {
        let (_d, repo) = temp_repo();
        let mut tree = markdown_tree(&repo, true);
        let mut sheet = open(&repo, &mut tree);

        // Derives title from the body H1 when omitted.
        let r = rec(&[("slug", s("hello")), ("body", s("# Hello, world\n\nA post."))]);
        let cand = sheet.prepare_upsert(&repo, &mut tree, &r, None, false).unwrap();
        sheet.stage_upsert(&repo, &mut tree, &cand).unwrap();
        let listed = sheet.list(&repo, &mut tree, false).unwrap(); // body-less still has title
        let Value::Table(m) = &listed[0].1 else { panic!() };
        assert_eq!(m.get("title"), Some(&s("Hello, world")));
        assert_eq!(m.get("body"), None);

        // Disagreeing supplied title throws.
        let bad = rec(&[("slug", s("x")), ("title", s("X")), ("body", s("# Y\n\nbody"))]);
        let err = sheet.prepare_upsert(&repo, &mut tree, &bad, None, false).err().unwrap();
        assert_eq!(err.code(), "validation_failed");
    }

    #[test]
    fn markdown_reupsert_is_idempotent() {
        let (_d, repo) = temp_repo();
        let mut tree = markdown_tree(&repo, false);
        let mut sheet = open(&repo, &mut tree);
        let r = rec(&[("slug", s("a")), ("title", s("A")), ("body", s("body bytes"))]);
        let cand = sheet.prepare_upsert(&repo, &mut tree, &r, None, false).unwrap();
        sheet.stage_upsert(&repo, &mut tree, &cand).unwrap();

        // Read back the full record and re-upsert it → no byte change.
        let listed = sheet.list(&repo, &mut tree, true).unwrap();
        let wc = sheet.will_change(&repo, &mut tree, &listed[0].1, None, false).unwrap();
        assert!(!wc.changed, "byte-identical markdown re-upsert is a no-op");
    }
}
