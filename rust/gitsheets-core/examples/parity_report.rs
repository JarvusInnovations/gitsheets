//! Parity report: walk a directory of canonical `.toml` records, run each
//! through `parse` → `serialize`, and classify how the fresh canonical bytes
//! differ from the on-disk (`@iarna` + sort-keys) bytes.
//!
//! Usage: `cargo run -p gitsheets-core --example parity_report -- <dir>`
//!
//! Diagnostic companion to the `corpus_parity` integration test: it enumerates
//! every divergence class so a human can confirm each is a sanctioned,
//! data-lossless re-baseline reformatting (#196), and dumps anything
//! *unexplained* for investigation.

use std::path::{Path, PathBuf};

fn main() {
    let dir = std::env::args().nth(1).expect("usage: parity_report <dir>");
    let mut files = Vec::new();
    collect_toml(Path::new(&dir), &mut files);
    files.sort();

    let mut identical = 0usize;
    let mut integer_only = 0usize;
    let mut requote_only = 0usize;
    let mut mixed = 0usize; // both integer + requote lines
    let mut multiline_structural = 0usize; // value-equal, line layout differs
    let mut unexplained: Vec<PathBuf> = Vec::new();
    let mut lossy: Vec<PathBuf> = Vec::new();
    let mut not_idempotent: Vec<PathBuf> = Vec::new();
    let mut parse_errors: Vec<(PathBuf, String)> = Vec::new();

    for path in &files {
        let original = std::fs::read_to_string(path).expect("read");
        let value = match gitsheets_core::parse(&original) {
            Ok(v) => v,
            Err(e) => {
                parse_errors.push((path.clone(), e.to_string()));
                continue;
            }
        };
        let serialized = gitsheets_core::serialize(&value).expect("serialize");

        // (1) data-losslessness: re-parsing fresh bytes yields the same value.
        let reparsed = gitsheets_core::parse(&serialized).expect("reparse");
        if reparsed != value {
            lossy.push(path.clone());
        }
        // (2) idempotence: serializing again is a no-op.
        let serialized2 = gitsheets_core::serialize(&reparsed).expect("serialize2");
        if serialized2 != serialized {
            not_idempotent.push(path.clone());
        }

        match classify(&value, &original, &serialized) {
            Class::Identical => identical += 1,
            Class::IntegerOnly => integer_only += 1,
            Class::RequoteOnly => requote_only += 1,
            Class::Mixed => mixed += 1,
            Class::MultilineStructural => multiline_structural += 1,
            Class::Unexplained => unexplained.push(path.clone()),
        }
    }

    println!("corpus dir:           {dir}");
    println!("total .toml files:    {}", files.len());
    println!("byte-identical:       {identical}");
    println!("integer-underscore:   {integer_only}");
    println!("string-requote:       {requote_only}");
    println!("mixed (int+requote):  {mixed}");
    println!("multiline-structural: {multiline_structural}");
    println!("UNEXPLAINED diff:     {}", unexplained.len());
    println!("LOSSY (data loss!):   {}", lossy.len());
    println!("NOT idempotent:       {}", not_idempotent.len());
    println!("parse errors:         {}", parse_errors.len());

    for (p, e) in parse_errors.iter().take(20) {
        println!("  PARSE ERR {}: {e}", p.display());
    }
    for p in lossy.iter().take(20) {
        println!("  LOSSY {}", p.display());
    }
    for p in not_idempotent.iter().take(20) {
        println!("  NOT-IDEMPOTENT {}", p.display());
    }
    for path in unexplained.iter().take(8) {
        println!("\n===== UNEXPLAINED: {} =====", path.display());
        let original = std::fs::read_to_string(path).expect("read");
        let value = gitsheets_core::parse(&original).expect("parse");
        let serialized = gitsheets_core::serialize(&value).expect("serialize");
        let (ol, sl) = (original.lines().count(), serialized.lines().count());
        if ol != sl {
            println!("  LINE COUNT DIFFERS: on-disk {ol} vs fresh {sl}");
        }
        for (i, (a, b)) in original.lines().zip(serialized.lines()).enumerate() {
            if a != b {
                println!("  line {i}:\n    on-disk: {a:?}\n    fresh:   {b:?}");
            }
        }
    }
}

enum Class {
    Identical,
    IntegerOnly,
    RequoteOnly,
    Mixed,
    /// Value-equal but the physical-line layout differs — multiline strings
    /// ending in `"`: @iarna uses a `\`-line-continuation before the closing
    /// delimiter, the toml crate uses adjacent quotes (`UAE""""`). Same string.
    MultilineStructural,
    /// The actual value changed — a real bug. Must be zero.
    Unexplained,
}

/// Classify how `serialized` differs from `original`. `value` is the already-
/// parsed `original`, reused to prove value-equality. Every divergence must be
/// a *value-preserving* reformatting; the bucket records which kind.
fn classify(value: &gitsheets_core::Value, original: &str, serialized: &str) -> Class {
    if original == serialized {
        return Class::Identical;
    }
    // The airtight guarantee: the fresh bytes carry the same value. If not,
    // it's a genuine data-loss bug, not a reformatting.
    if gitsheets_core::parse(serialized).ok().as_ref() != Some(value) {
        return Class::Unexplained;
    }
    let a_lines: Vec<&str> = original.lines().collect();
    let b_lines: Vec<&str> = serialized.lines().collect();
    // Layout-changing reformatting (multiline trailing-quote handling). Already
    // proven value-equal above.
    if a_lines.len() != b_lines.len() {
        return Class::MultilineStructural;
    }
    let mut saw_integer = false;
    let mut saw_requote = false;
    for (a, b) in a_lines.iter().zip(b_lines.iter()) {
        if a == b {
            continue;
        }
        // Integer digit-group underscore drop: `k = 31_618` -> `k = 31618`.
        if strip_digit_group_underscores(a) == *b {
            saw_integer = true;
            continue;
        }
        // String requote: same key→value, value-preserving quoting change,
        // e.g. @iarna escaped-basic `"...\"..."` -> toml triple-quoted.
        if same_single_line_kv(a, b) {
            saw_requote = true;
            continue;
        }
        // Value-equal overall but this single line isn't independently a
        // value-preserving kv (e.g. interacts with a multiline block).
        return Class::MultilineStructural;
    }
    match (saw_integer, saw_requote) {
        (true, false) => Class::IntegerOnly,
        (false, true) => Class::RequoteOnly,
        (true, true) => Class::Mixed,
        (false, false) => Class::Identical, // unreachable: original != serialized
    }
}

/// True iff both lines are standalone `key = value` TOML that parse to the same
/// value — i.e. a pure value-preserving reformatting on that line.
fn same_single_line_kv(a: &str, b: &str) -> bool {
    match (gitsheets_core::parse(a), gitsheets_core::parse(b)) {
        (Ok(va), Ok(vb)) => va == vb,
        _ => false,
    }
}

fn strip_digit_group_underscores(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    for (i, &c) in bytes.iter().enumerate() {
        if c == b'_'
            && i > 0
            && i + 1 < bytes.len()
            && bytes[i - 1].is_ascii_digit()
            && bytes[i + 1].is_ascii_digit()
        {
            continue;
        }
        out.push(c as char);
    }
    out
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
