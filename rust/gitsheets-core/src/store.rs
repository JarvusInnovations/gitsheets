//! The `Store` multi-sheet surface.
//!
//! A behavior-preserving Rust port of the discovery + validator-wiring half of
//! `packages/gitsheets/src/store.ts` / `Repository.openSheets`, per
//! [`specs/api/store.md`](../../../specs/api/store.md). The core owns the
//! *bytes-and-consistency* parts of the Store: **sheet discovery** (enumerating
//! `.gitsheets/*.toml`) and the **`config_missing` check** (a declared validator
//! must name a sheet that exists). The typed property surface, the consumer
//! validators themselves, and the `tx.<sheet>` alias ergonomics are host-idiom
//! concerns and stay in the binding — the binding opens a [`Transaction`] and a
//! [`Sheet`] per discovered name and drives the two-phase upsert protocol.
//!
//! [`Transaction`]: crate::transaction::Transaction
//! [`Sheet`]: crate::sheet::Sheet

use holo_tree::MutableTree;

use crate::error::{Error, Result};
use crate::record;
use crate::sheet::join_path;

const TOML_EXTENSION: &str = ".toml";

/// Discover every sheet declared in `<open_root>/.gitsheets/*.toml` in `tree`.
/// Returns the bare sheet names (extension stripped) in sorted (git-canonical)
/// order. A repo with no `.gitsheets/` directory yields an empty list.
///
/// Only *direct* `<name>.toml` children of `.gitsheets/` are sheets — nested
/// files (e.g. a `.gitsheets/sub/x.toml`) are ignored, matching the JS
/// `openSheets` which enumerates the directory's immediate `.toml` blobs.
pub fn discover_sheets(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    open_root: &str,
) -> Result<Vec<String>> {
    let dir = join_path(&[open_root, ".gitsheets"]);
    let dir_arg = if dir.is_empty() { ".".to_string() } else { dir };
    let subtree = match tree.get_subtree(repo, &dir_arg).map_err(record::map_ht)? {
        Some(t) => t,
        None => return Ok(Vec::new()),
    };
    let blob_map = subtree.get_blob_map(repo).map_err(record::map_ht)?;
    let mut names: Vec<String> = Vec::new();
    for (path, _) in blob_map {
        // Direct children only: no nested directory component.
        if path.contains('/') {
            continue;
        }
        if let Some(stripped) = path.strip_suffix(TOML_EXTENSION) {
            if !stripped.is_empty() {
                names.push(stripped.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Verify every name in `validator_names` is present in `declared` (the
/// discovered sheets). A validator naming a sheet with no
/// `.gitsheets/<name>.toml` is [`Error::ConfigMissing`], matching `openStore`.
pub fn check_validators(declared: &[String], validator_names: &[String]) -> Result<()> {
    for name in validator_names {
        if !declared.iter().any(|d| d == name) {
            return Err(Error::ConfigMissing {
                message: format!(
                    "Store opens with validators.{name}, but .gitsheets/{name}.toml is not declared"
                ),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{write_records, TOML_EXTENSION as EXT};
    use crate::value::Value;
    use indexmap::IndexMap;

    fn temp_repo() -> (tempfile::TempDir, gix::Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        (dir, repo)
    }

    fn table(pairs: &[(&str, &str)]) -> Value {
        let mut m = IndexMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), Value::String((*v).to_string()));
        }
        Value::Table(m)
    }

    #[test]
    fn discovers_declared_sheets_sorted() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        // Two config blobs under `.gitsheets/`.
        let mut gs = IndexMap::new();
        gs.insert("path".to_string(), Value::String("${ slug }".to_string()));
        let cfg = Value::Table({
            let mut m = IndexMap::new();
            m.insert("gitsheet".to_string(), Value::Table(gs));
            m
        });
        write_records(&repo, &mut tree, ".gitsheets", &[("users".into(), cfg.clone())], EXT).unwrap();
        write_records(&repo, &mut tree, ".gitsheets", &[("projects".into(), cfg)], EXT).unwrap();

        let names = discover_sheets(&repo, &mut tree, ".").unwrap();
        assert_eq!(names, vec!["projects".to_string(), "users".to_string()]);
    }

    #[test]
    fn empty_repo_yields_no_sheets() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        assert!(discover_sheets(&repo, &mut tree, ".").unwrap().is_empty());
        // A non-sheet write doesn't create `.gitsheets`.
        write_records(&repo, &mut tree, "people", &[("jane".into(), table(&[("slug", "jane")]))], EXT)
            .unwrap();
        assert!(discover_sheets(&repo, &mut tree, ".").unwrap().is_empty());
    }

    #[test]
    fn check_validators_flags_missing_sheet() {
        let declared = vec!["users".to_string()];
        assert!(check_validators(&declared, &["users".to_string()]).is_ok());
        let err = check_validators(&declared, &["projects".to_string()]).unwrap_err();
        assert_eq!(err.code(), "config_missing");
    }
}
