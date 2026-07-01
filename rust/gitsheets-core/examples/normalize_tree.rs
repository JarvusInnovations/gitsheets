//! Re-normalize every `.toml` record under a directory, in place, through the
//! canonical serializer (`gitsheets_core::serialize`). One-shot for the
//! deliberate canonical-form re-baseline (#196): read each record, parse it,
//! re-serialize it fresh, and write the result back. Idempotent — a second run
//! produces zero changes.
//!
//! Usage: `cargo run -p gitsheets-core --example normalize_tree -- <dir>`
//!
//! Prints one line per file that changed plus a summary. Refuses to write any
//! file whose fresh bytes don't re-parse to the same value (a data-loss guard),
//! so a parse or serialize bug can never silently rewrite a record's meaning.

use std::path::{Path, PathBuf};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: normalize_tree <dir>");
    let mut files = Vec::new();
    collect_toml(Path::new(&dir), &mut files);
    files.sort();

    let mut changed = 0usize;
    let mut unchanged = 0usize;

    for path in &files {
        let original = std::fs::read_to_string(path).expect("read");
        let value = gitsheets_core::parse(&original)
            .unwrap_or_else(|e| panic!("{}: parse failed: {e}", path.display()));
        let serialized = gitsheets_core::serialize(&value)
            .unwrap_or_else(|e| panic!("{}: serialize failed: {e}", path.display()));

        // Data-loss guard: the fresh bytes must carry the same value.
        let reparsed = gitsheets_core::parse(&serialized)
            .unwrap_or_else(|e| panic!("{}: reparse failed: {e}", path.display()));
        assert!(
            reparsed == value,
            "{}: refusing to write — re-serialization changed the value",
            path.display()
        );

        if serialized == original {
            unchanged += 1;
            continue;
        }
        std::fs::write(path, &serialized).expect("write");
        changed += 1;
        println!("normalized {}", path.display());
    }

    println!(
        "\n{} file(s) re-normalized, {} already canonical ({} total)",
        changed,
        unchanged,
        files.len()
    );
}

fn collect_toml(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_toml(&path, out);
        } else if path.extension().is_some_and(|e| e == "toml") {
            out.push(path);
        }
    }
}
