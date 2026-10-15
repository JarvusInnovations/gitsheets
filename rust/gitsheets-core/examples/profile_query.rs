//! Phase profile of a body-less markdown query — where the time goes on a
//! large content-typed sheet. Run against a repo whose sheet lives under
//! `<base>` with template `<template>` and `.md` records:
//!
//!   cargo run --release --example profile_query -- <git_dir> [base] [template] [iterations]
//!
//! Phases, each timed in isolation over the same candidate set:
//!   open_repo · resolve_tree · Engine::new · Template::compile · candidate walk ·
//!   blob reads only · header-only parse only · full parse only · the real
//!   query_records_format (walk + read + parse + filter) with and without body.

use std::time::Instant;

use gitsheets_core::codec;
use gitsheets_core::config::{FormatConfig, FormatKind};
use gitsheets_core::engine::Engine;
use gitsheets_core::path_template::Template;
use gitsheets_core::query::{query_candidate_paths, query_records_format, Filter};
use gitsheets_core::record::{open_repo, read_blob_entry, resolve_tree, Context, TreeCache};
use gitsheets_core::value::Value;

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let git_dir = args.get(1).expect("usage: profile_query <git_dir> [base] [template] [iters]");
    let base = args.get(2).map(String::as_str).unwrap_or("people");
    let template_src = args.get(3).map(String::as_str).unwrap_or("${{ ring }}/${{ id }}");
    let iters: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(3);
    let format = FormatConfig {
        kind: FormatKind::Markdown,
        body: Some("body".into()),
        title: None,
        normalize: true,
    };

    for iter in 0..iters {
        println!("── iteration {} ──", iter + 1);
        let t = Instant::now();
        let repo = open_repo(git_dir).unwrap();
        println!("{:<34} {:8.1} ms", "open_repo", ms(t));

        let cache = TreeCache::new();
        let ctx = Context::new(&repo, &cache);
        let t = Instant::now();
        let mut tree = resolve_tree(&repo, "HEAD").unwrap();
        println!("{:<34} {:8.1} ms", "resolve_tree(HEAD)", ms(t));

        let t = Instant::now();
        let mut engine = Engine::new().unwrap();
        println!("{:<34} {:8.1} ms", "Engine::new (boa)", ms(t));

        let t = Instant::now();
        let template = Template::compile(template_src, &mut engine).unwrap();
        println!("{:<34} {:8.1} ms", "Template::compile", ms(t));

        let t = Instant::now();
        let paths = query_candidate_paths(&ctx, &mut tree, base, &template, &Value::Table(Default::default()), &mut engine, ".md")
            .unwrap();
        println!("{:<34} {:8.1} ms  ({} candidates)", "candidate walk", ms(t), paths.len());

        let t = Instant::now();
        let mut texts: Vec<String> = Vec::with_capacity(paths.len());
        let mut bytes_total = 0usize;
        for p in &paths {
            let (_, bytes) = read_blob_entry(&ctx, &mut tree, &format!("{base}/{p}.md")).unwrap().unwrap();
            bytes_total += bytes.len();
            texts.push(String::from_utf8(bytes).unwrap());
        }
        println!("{:<34} {:8.1} ms  ({:.1} MB)", "blob reads only (by path)", ms(t), bytes_total as f64 / 1e6);

        let t = Instant::now();
        for text in &texts {
            codec::parse_header_only(text, &format).unwrap();
        }
        println!("{:<34} {:8.1} ms", "parse_header_only only", ms(t));

        let t = Instant::now();
        for text in &texts {
            codec::parse(text, &format).unwrap();
        }
        println!("{:<34} {:8.1} ms", "parse (full, with body) only", ms(t));

        let t = Instant::now();
        let rows = query_records_format(&ctx, &mut tree, base, &template, &Filter::new(), &mut engine, ".md", &format, false)
            .unwrap();
        println!("{:<34} {:8.1} ms  ({} rows)", "query_records_format(body=false)", ms(t), rows.len());

        let t = Instant::now();
        let rows = query_records_format(&ctx, &mut tree, base, &template, &Filter::new(), &mut engine, ".md", &format, true)
            .unwrap();
        println!("{:<34} {:8.1} ms  ({} rows)", "query_records_format(body=true)", ms(t), rows.len());
    }
}
