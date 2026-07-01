//! Canonical-form parity harness — the **gate** for the bytes-authority.
//!
//! Two layers:
//!
//! 1. **Committed fixtures** (always run, incl. CI). A small representative
//!    subset of the real CodeForPhilly corpus plus a synthetic datetime/number
//!    record, each as an on-disk `@iarna`-canonical `*.input.toml` paired with
//!    its fresh-canonical `*.expected.toml` golden. The test pins the exact
//!    bytes the Rust `toml` serializer produces (catching any future formatting
//!    drift) and proves every divergence is value-preserving and idempotent.
//!
//! 2. **Full external corpus** (opt-in via `GITSHEETS_PARITY_CORPUS=<dir>`).
//!    Walks every `.toml` under the directory and asserts the airtight
//!    invariants over all of it: parse succeeds, re-parsing the fresh bytes is
//!    data-identical (lossless), and serialization is an idempotent fixpoint.
//!    This is the full 4,310+-record (now ~29.5k) parity run from
//!    [#196](https://github.com/JarvusInnovations/gitsheets/issues/196); CI runs
//!    only the fixtures (no external corpus on the runner), and the full run is
//!    executed locally — see the plan's Notes for the recorded result.
//!
//! ## What the corpus parity established (run locally on origin/published)
//!
//! Across **29,556** record files: **0** data-loss, **0** non-idempotent,
//! **0** parse errors. Every byte divergence from the `@iarna` on-disk bytes is
//! one of three *value-preserving* reformattings introduced by serializing
//! fresh through the `toml` crate's default formatting:
//!
//! - **integer digit-group underscores dropped** (`31_618` → `31618`) — the
//!   sanctioned #196 change;
//! - **string requote** — strings containing `"` *and* `'` (so not literal-
//!   quotable) move from `@iarna`'s escaped single-line basic string
//!   (`"…\"…"`) to the `toml` crate's readable triple-quoted form;
//! - **multiline trailing-quote layout** — a multiline string ending in `"`
//!   uses adjacent quotes before the delimiter (`UAE""""`) instead of
//!   `@iarna`'s `\`-line-continuation.
//!
//! None is the single-line re-escaping #196 says to avoid; all move *toward*
//! the readable form. (The `canonical-rebaseline` plan documents all three in
//! `normalization.md` and applies them to the live corpus.)

use std::path::{Path, PathBuf};

use gitsheets_core::{parse, serialize, Value};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Parse → serialize → reparse must be data-identical, and serializing the
/// reparsed value must reproduce the same bytes (idempotent fixpoint).
fn assert_lossless_and_idempotent(input: &str, label: &str) -> String {
    let value = parse(input).unwrap_or_else(|e| panic!("{label}: parse failed: {e}"));
    let serialized = serialize(&value).unwrap_or_else(|e| panic!("{label}: serialize failed: {e}"));
    let reparsed = parse(&serialized).unwrap_or_else(|e| panic!("{label}: reparse failed: {e}"));
    assert_eq!(
        reparsed, value,
        "{label}: serialization lost or changed data"
    );
    let serialized2 = serialize(&reparsed).expect("re-serialize");
    assert_eq!(
        serialized2, serialized,
        "{label}: serialization is not idempotent"
    );
    serialized
}

#[test]
fn committed_fixtures_match_their_canonical_golden() {
    let dir = fixtures_dir();
    let mut inputs: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("fixtures dir")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".input.toml"))
        .collect();
    inputs.sort();
    assert!(
        !inputs.is_empty(),
        "expected committed fixtures in {}",
        dir.display()
    );

    for input_path in inputs {
        let stem = input_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .replace(".input.toml", "");
        let expected_path = dir.join(format!("{stem}.expected.toml"));
        let input = std::fs::read_to_string(&input_path).expect("read input");
        let expected = std::fs::read_to_string(&expected_path)
            .unwrap_or_else(|_| panic!("missing golden {}", expected_path.display()));

        // The fresh canonical bytes must match the committed golden exactly.
        let serialized = assert_lossless_and_idempotent(&input, &stem);
        assert_eq!(
            serialized,
            expected,
            "{stem}: fresh canonical bytes drifted from the committed golden \
             ({}). If this is an intended toml-crate formatting change, \
             regenerate the golden.",
            expected_path.display()
        );

        // The on-disk @iarna bytes and the fresh bytes must carry the same
        // value (value-preserving reformatting only).
        assert_eq!(
            parse(&input).unwrap(),
            parse(&expected).unwrap(),
            "{stem}: input and golden disagree on value"
        );
    }
}

#[test]
fn integer_underscores_normalize_away_in_a_real_record() {
    let dir = fixtures_dir();
    let input = std::fs::read_to_string(dir.join("integer_underscore.input.toml")).unwrap();
    let out = serialize(&parse(&input).unwrap()).unwrap();
    assert!(
        input.contains("legacyId = 31_618"),
        "fixture has the underscore form"
    );
    assert!(
        out.contains("legacyId = 31618"),
        "fresh drops the underscore"
    );
    assert!(!out.contains("31_618"), "no underscore survives");
}

#[test]
fn multiline_bodies_stay_triple_quoted_not_single_line_escaped() {
    let dir = fixtures_dir();
    // laddr's markdown overview is a multiline triple-quoted string; it must
    // stay triple-quoted (and byte-identical), never collapse to one escaped
    // line (the outcome #196 says to avoid).
    let input = std::fs::read_to_string(dir.join("identical_multiline_body.input.toml")).unwrap();
    let out = serialize(&parse(&input).unwrap()).unwrap();
    assert!(
        out.contains("overview = \"\"\""),
        "body stays triple-quoted"
    );
    assert_eq!(
        out, input,
        "an already-canonical multiline body is byte-stable"
    );
}

/// Opt-in full-corpus parity: set `GITSHEETS_PARITY_CORPUS` to a directory of
/// canonical `.toml` records (e.g. a checkout of the CodeForPhilly
/// `origin/published` tree). Asserts the airtight invariants over every file.
#[test]
fn full_corpus_parity_when_pointed_at_one() {
    let Ok(dir) = std::env::var("GITSHEETS_PARITY_CORPUS") else {
        eprintln!(
            "GITSHEETS_PARITY_CORPUS not set — skipping full-corpus parity (fixtures cover CI)"
        );
        return;
    };
    let mut files = Vec::new();
    collect_toml(Path::new(&dir), &mut files);
    assert!(!files.is_empty(), "no .toml files under {dir}");

    let mut identical = 0usize;
    let mut reformatted = 0usize;
    for path in &files {
        let original = std::fs::read_to_string(path).expect("read");
        let label = path.display().to_string();
        let value: Value =
            parse(&original).unwrap_or_else(|e| panic!("{label}: parse failed: {e}"));
        let serialized = assert_lossless_and_idempotent(&original, &label);
        if serialized == original {
            identical += 1;
        } else {
            reformatted += 1;
            // Already proven value-preserving by assert_lossless_and_idempotent
            // (reparse == value). Belt-and-suspenders: the on-disk value equals
            // the fresh value.
            assert_eq!(parse(&serialized).unwrap(), value, "{label}: value changed");
        }
    }
    eprintln!(
        "full-corpus parity: {} files, {identical} byte-identical, {reformatted} value-preserving reformat, 0 data-loss",
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
