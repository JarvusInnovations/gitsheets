//! Sheet configuration — parsing `.gitsheets/<name>.toml` into a [`SheetConfig`].
//!
//! This is the first half of the `Sheet` state machine: turning the persisted
//! `[gitsheet]` definition block into the typed shape the upsert/query pipeline
//! composes (path template source, field sort rules, JSON Schema, storage
//! format). A behavior-preserving Rust port of `loadConfig` in
//! `packages/gitsheets/src/sheet.ts`, per `specs/api/sheet.md` and
//! `specs/api/store.md`.
//!
//! Config parsing is a **definition** concern, so malformed/missing config maps
//! to the `ConfigError` taxonomy ([`Error::ConfigMissing`] /
//! [`Error::ConfigInvalid`]) — never a record error.

use crate::error::{Error, Result};
use crate::value::Value;
use indexmap::IndexMap;

/// A sort rule for an array-valued field (`[gitsheet.fields.<name>] sort = …`).
/// Mirrors the JS `SortRule` union: a boolean, a list of field names (ASC each),
/// a `{field: "ASC"|"DESC"}` directive map, or a raw-JS comparator body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SortRule {
    /// `true` → natural/locale-ish ascending; `false` → leave order untouched.
    All(bool),
    /// `["a", "b"]` → compare by each field, ascending.
    Fields(Vec<String>),
    /// `{a = "ASC", b = "DESC"}` → compare by each field in the given direction.
    Directives(Vec<(String, SortDir)>),
    /// A raw-JS comparator body `(a, b) => { <rule> }` — the escape hatch.
    Raw(String),
}

/// A sort direction in a `{field: dir}` directive map.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortDir {
    Asc,
    Desc,
}

/// Per-field configuration (`[gitsheet.fields.<name>]`). Only `sort` is
/// meaningful in v1.0.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FieldConfig {
    pub sort: Option<SortRule>,
}

/// The storage format a sheet's records are written as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormatKind {
    Toml,
    Markdown,
    Mdx,
}

impl FormatKind {
    /// The file extension (with leading dot) records of this format are written
    /// as. Matches the JS `Format.extension`.
    pub fn extension(self) -> &'static str {
        match self {
            FormatKind::Toml => ".toml",
            FormatKind::Markdown => ".md",
            FormatKind::Mdx => ".mdx",
        }
    }

    fn from_type(s: &str) -> Result<Self> {
        match s {
            "toml" => Ok(FormatKind::Toml),
            "markdown" => Ok(FormatKind::Markdown),
            "mdx" => Ok(FormatKind::Mdx),
            other => Err(Error::ConfigInvalid {
                message: format!("unknown sheet format {other:?} — registered: toml, markdown, mdx"),
            }),
        }
    }
}

/// Resolved `[gitsheet.format]` config. Defaults to `type = "toml"`.
#[derive(Clone, Debug, PartialEq)]
pub struct FormatConfig {
    pub kind: FormatKind,
    /// The field holding the body text (markdown/mdx only).
    pub body: Option<String>,
    /// The field denormalized from the body's first H1 (markdown/mdx only).
    pub title: Option<String>,
    /// Whether to normalize the body on write with the native
    /// `dprint-plugin-markdown` formatter (markdown/mdx only). Defaults to
    /// `true`; `normalize = false` frames the body verbatim. See
    /// [`crate::codec::normalize_body`].
    pub normalize: bool,
}

impl FormatConfig {
    pub fn extension(&self) -> &'static str {
        self.kind.extension()
    }
}

/// A parsed sheet definition.
#[derive(Clone, Debug, PartialEq)]
pub struct SheetConfig {
    /// The data subtree this sheet's records live under (default `.`).
    pub root: String,
    /// The path-template source (`gitsheet.path`).
    pub path: String,
    /// Per-field config, keyed by field name.
    pub fields: IndexMap<String, FieldConfig>,
    /// The `[gitsheet.schema]` JSON Schema, if present.
    pub schema: Option<Value>,
    /// The storage format.
    pub format: FormatConfig,
}

fn as_table(v: &Value) -> Option<&IndexMap<String, Value>> {
    match v {
        Value::Table(t) => Some(t),
        _ => None,
    }
}

fn as_str(v: &Value) -> Option<&str> {
    match v {
        Value::String(s) => Some(s.as_str()),
        _ => None,
    }
}

/// Parse a sheet config from the already-parsed config-file [`Value`]. `source`
/// names the config path for diagnostics (e.g. `.gitsheets/users.toml`).
///
/// Mirrors `loadConfig` (`sheet.ts`): requires a `[gitsheet]` table with a
/// non-empty `path`; reads `root` (default `.`), `fields.<f>.sort`, `schema`,
/// and `[gitsheet.format]`; enforces the body-field rules (markdown requires a
/// body; the body field must not collide with the path template).
pub fn parse_config(raw: &Value, source: &str) -> Result<SheetConfig> {
    let top = as_table(raw).ok_or_else(|| Error::ConfigInvalid {
        message: format!("{source}: config is not a table"),
    })?;
    let gitsheet = top
        .get("gitsheet")
        .and_then(as_table)
        .ok_or_else(|| Error::ConfigInvalid {
            message: format!("{source}: missing [gitsheet] table"),
        })?;

    // path (required, non-empty)
    let path = gitsheet
        .get("path")
        .and_then(as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::ConfigInvalid {
            message: format!("{source}: gitsheet.path must be a non-empty string"),
        })?
        .to_string();

    // root (default ".")
    let root = match gitsheet.get("root") {
        None => ".".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => {
            return Err(Error::ConfigInvalid {
                message: format!("{source}: gitsheet.root must be a string"),
            })
        }
    };

    // fields
    let mut fields: IndexMap<String, FieldConfig> = IndexMap::new();
    if let Some(fields_val) = gitsheet.get("fields") {
        let fields_table = as_table(fields_val).ok_or_else(|| Error::ConfigInvalid {
            message: format!("{source}: gitsheet.fields must be a table"),
        })?;
        for (fname, fcfg) in fields_table {
            let Some(fcfg_table) = as_table(fcfg) else {
                continue;
            };
            let mut entry = FieldConfig::default();
            if let Some(sort) = fcfg_table.get("sort") {
                entry.sort = Some(parse_sort_rule(sort, source, fname)?);
            }
            fields.insert(fname.clone(), entry);
        }
    }

    // schema
    let schema = match gitsheet.get("schema") {
        None => None,
        Some(v @ Value::Table(_)) => Some(v.clone()),
        Some(_) => {
            return Err(Error::ConfigInvalid {
                message: format!(
                    "{source}: gitsheet.schema must be a table representing a JSON Schema"
                ),
            })
        }
    };

    // format
    let format = parse_format(gitsheet.get("format"), source)?;

    // Body-field presence rules. (The body↔template *collision* check needs the
    // compiled template's field names, so it lives in `Sheet::open`.)
    if format.body.is_some() {
        if !matches!(format.kind, FormatKind::Markdown | FormatKind::Mdx) {
            return Err(Error::ConfigInvalid {
                message: format!(
                    "{source}: [gitsheet.format].body only applies to markdown/mdx formats"
                ),
            });
        }
    } else if matches!(format.kind, FormatKind::Markdown | FormatKind::Mdx) {
        return Err(Error::ConfigInvalid {
            message: format!(
                "{source}: [gitsheet.format].body is required when type is \"markdown\" or \"mdx\""
            ),
        });
    }

    Ok(SheetConfig {
        root,
        path,
        fields,
        schema,
        format,
    })
}

fn parse_format(raw: Option<&Value>, source: &str) -> Result<FormatConfig> {
    let Some(raw) = raw else {
        return Ok(FormatConfig {
            kind: FormatKind::Toml,
            body: None,
            title: None,
            normalize: true,
        });
    };
    let table = as_table(raw).ok_or_else(|| Error::ConfigInvalid {
        message: format!("{source}: [gitsheet.format] must be a table"),
    })?;
    let kind = match table.get("type") {
        Some(Value::String(s)) => FormatKind::from_type(s).map_err(|e| Error::ConfigInvalid {
            message: format!("{source}: {}", e.message()),
        })?,
        _ => FormatKind::Toml,
    };
    let body = table.get("body").and_then(as_str).map(|s| s.to_string());
    let title = table.get("title").and_then(as_str).map(|s| s.to_string());
    // normalize: defaults to `true` (native dprint body normalization on write);
    // `normalize = false` frames the body verbatim. A non-boolean value is a
    // config error.
    let normalize = match table.get("normalize") {
        None => true,
        Some(Value::Boolean(b)) => *b,
        Some(_) => {
            return Err(Error::ConfigInvalid {
                message: format!("{source}: [gitsheet.format].normalize must be a boolean"),
            })
        }
    };
    Ok(FormatConfig {
        kind,
        body,
        title,
        normalize,
    })
}

fn parse_sort_rule(sort: &Value, source: &str, field: &str) -> Result<SortRule> {
    match sort {
        Value::Boolean(b) => Ok(SortRule::All(*b)),
        Value::String(s) => Ok(SortRule::Raw(s.clone())),
        Value::Array(items) => {
            let mut names = Vec::with_capacity(items.len());
            for it in items {
                match it {
                    Value::String(s) => names.push(s.clone()),
                    _ => {
                        return Err(Error::ConfigInvalid {
                            message: format!(
                                "{source}: gitsheet.fields.{field}.sort[] must be string field names"
                            ),
                        })
                    }
                }
            }
            Ok(SortRule::Fields(names))
        }
        Value::Table(map) => {
            let mut directives = Vec::with_capacity(map.len());
            for (k, v) in map {
                let dir = match v {
                    Value::String(s) if s == "ASC" => SortDir::Asc,
                    Value::String(s) if s == "DESC" => SortDir::Desc,
                    _ => {
                        return Err(Error::ConfigInvalid {
                            message: format!(
                                "{source}: gitsheet.fields.{field}.sort.{k} must be 'ASC' or 'DESC'"
                            ),
                        })
                    }
                };
                directives.push((k.clone(), dir));
            }
            Ok(SortRule::Directives(directives))
        }
        _ => Err(Error::ConfigInvalid {
            message: format!("{source}: gitsheet.fields.{field}.sort has invalid shape"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical;

    fn cfg(toml: &str) -> Result<SheetConfig> {
        let v = canonical::parse(toml).expect("parse toml");
        parse_config(&v, ".gitsheets/test.toml")
    }

    #[test]
    fn parses_minimal_toml_sheet() {
        let c = cfg("[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n").unwrap();
        assert_eq!(c.path, "${{ slug }}");
        assert_eq!(c.root, "people");
        assert_eq!(c.format.kind, FormatKind::Toml);
        assert_eq!(c.format.extension(), ".toml");
    }

    #[test]
    fn defaults_root_to_dot() {
        let c = cfg("[gitsheet]\npath = '${{ slug }}'\n").unwrap();
        assert_eq!(c.root, ".");
    }

    #[test]
    fn missing_gitsheet_table_is_config_invalid() {
        let err = cfg("foo = 1\n").unwrap_err();
        assert_eq!(err.code(), "config_invalid");
    }

    #[test]
    fn empty_path_is_config_invalid() {
        let err = cfg("[gitsheet]\npath = ''\n").unwrap_err();
        assert_eq!(err.code(), "config_invalid");
    }

    #[test]
    fn parses_field_sort_rules() {
        let c = cfg(
            "[gitsheet]\npath = '${{ slug }}'\n[gitsheet.fields.tags]\nsort = true\n[gitsheet.fields.cats]\nsort = ['a', 'b']\n[gitsheet.fields.dirs]\nsort = { a = 'ASC', b = 'DESC' }\n",
        )
        .unwrap();
        assert_eq!(c.fields["tags"].sort, Some(SortRule::All(true)));
        assert_eq!(
            c.fields["cats"].sort,
            Some(SortRule::Fields(vec!["a".into(), "b".into()]))
        );
        assert_eq!(
            c.fields["dirs"].sort,
            Some(SortRule::Directives(vec![
                ("a".into(), SortDir::Asc),
                ("b".into(), SortDir::Desc)
            ]))
        );
    }

    #[test]
    fn markdown_requires_body() {
        let err = cfg("[gitsheet]\npath = '${{ slug }}'\n[gitsheet.format]\ntype = 'markdown'\n")
            .unwrap_err();
        assert_eq!(err.code(), "config_invalid");
        assert!(err.message().contains("body is required"));
    }

    #[test]
    fn body_only_on_markdown() {
        let err = cfg(
            "[gitsheet]\npath = '${{ slug }}'\n[gitsheet.format]\ntype = 'toml'\nbody = 'content'\n",
        )
        .unwrap_err();
        assert_eq!(err.code(), "config_invalid");
    }
    #[test]
    fn markdown_with_valid_body_parses() {
        let c = cfg("[gitsheet]\npath = '${{ slug }}'\n[gitsheet.format]\ntype = 'markdown'\nbody = 'content'\ntitle = 'name'\n")
            .unwrap();
        assert_eq!(c.format.kind, FormatKind::Markdown);
        assert_eq!(c.format.body.as_deref(), Some("content"));
        assert_eq!(c.format.title.as_deref(), Some("name"));
        assert_eq!(c.format.extension(), ".md");
    }

    #[test]
    fn parses_schema_block() {
        let c = cfg("[gitsheet]\npath = '${{ slug }}'\n[gitsheet.schema]\ntype = 'object'\n").unwrap();
        assert!(c.schema.is_some());
    }

    #[test]
    fn normalize_defaults_to_true_when_absent() {
        let c = cfg("[gitsheet]\npath = '${{ slug }}'\n[gitsheet.format]\ntype = 'markdown'\nbody = 'body'\n").unwrap();
        assert!(c.format.normalize);
    }

    #[test]
    fn normalize_false_disables() {
        let c = cfg("[gitsheet]\npath = '${{ slug }}'\n[gitsheet.format]\ntype = 'markdown'\nbody = 'body'\nnormalize = false\n").unwrap();
        assert!(!c.format.normalize);
    }

    #[test]
    fn normalize_non_boolean_is_config_invalid() {
        let err = cfg("[gitsheet]\npath = '${{ slug }}'\n[gitsheet.format]\ntype = 'markdown'\nbody = 'body'\nnormalize = 'yes'\n").unwrap_err();
        assert_eq!(err.code(), "config_invalid");
        assert!(err.message().contains("normalize must be a boolean"));
    }

    #[test]
    fn toml_format_defaults_normalize_true() {
        // The toml-default branch still produces a stable normalize flag.
        let c = cfg("[gitsheet]\npath = '${{ slug }}'\n").unwrap();
        assert!(c.format.normalize);
    }
}
