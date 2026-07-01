//! Native ICU collation for declarative `sort = true`.
//!
//! Declarative `sort = true` (locale-sensitive string-array sorting) is **native**
//! — it does NOT route through the boa engine. boa is built without `Intl`, so its
//! `localeCompare` falls back to code-unit comparison and diverges from V8 /
//! `node:vm` on non-ASCII / mixed-case input (e.g. `["B","a"]` sorts to `["a","B"]`
//! under V8 but `["B","a"]` under boa's code-unit order). This module uses the
//! ICU4X collator — the same ICU/CLDR lineage V8 uses — configured to match the
//! exact options the JS oracle passes:
//!
//! ```js
//! String(a).localeCompare(String(b), undefined, {
//!   sensitivity: 'base',     // → Strength::Primary
//!   ignorePunctuation: true, // → AlternateHandling::Shifted
//!   numeric: true,           // → CollationNumericOrdering::True
//! })
//! ```
//!
//! The locale is `undefined`, i.e. the host default — `en-US` in Node. The CLDR
//! `en` collation carries no tailoring over the CLDR root, so the **root** collator
//! (default preferences) is byte-identical to `en-US` here and is deterministic
//! across hosts (no dependency on a runtime's resolved default locale). That
//! determinism is the point: the collator's order defines the canonical bytes of
//! sorted arrays, so it is part of the canonical-behavior contract and the crate
//! version is pinned exactly (see `Cargo.toml`).

use std::cmp::Ordering;
use std::sync::OnceLock;

use icu_collator::{
    options::{AlternateHandling, CollatorOptions, Strength},
    preferences::CollationNumericOrdering,
    Collator, CollatorBorrowed, CollatorPreferences,
};

use crate::value::Value;

/// The process-wide collator matching V8's `localeCompare` with
/// `{ sensitivity: 'base', ignorePunctuation: true, numeric: true }`.
///
/// Built once from the baked-in (`compiled_data`) CLDR collation data; the
/// configuration is fixed (root locale, no per-sheet locale in v1.0).
fn collator() -> &'static CollatorBorrowed<'static> {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR.get_or_init(|| {
        // numeric:true is a BCP47 `kn` *preference*, not a `CollatorOptions` field.
        let mut prefs = CollatorPreferences::default();
        prefs.numeric_ordering = Some(CollationNumericOrdering::True);

        let mut options = CollatorOptions::default();
        // sensitivity:'base' → only base letters distinguished (case + accents
        // folded). The crate documents this exact ECMA-402 mapping.
        options.strength = Some(Strength::Primary);
        // ignorePunctuation:true → variable (punctuation/whitespace) elements are
        // shifted below the primary level and thus ignored at Primary strength.
        options.alternate_handling = Some(AlternateHandling::Shifted);

        Collator::try_new(prefs, options)
            .expect("baked CLDR root collation data is always present (compiled_data)")
    })
}

/// Compare two strings with the locale collator (the `sort = true` order).
pub fn compare(a: &str, b: &str) -> Ordering {
    collator().compare(a, b)
}

/// Stable in-place sort of an array under the locale collator — the native
/// replacement for the boa `String(a).localeCompare(String(b), …)` comparator.
///
/// Each element is coerced to a string the way JS `String(value)` would before
/// comparison; the spec ([`normalization.md`]) scopes `sort = true` to arrays of
/// strings, so the coercion only matters for misconfigured non-string arrays,
/// where it mirrors `String()` for scalars.
///
/// `slice::sort_by` is a stable sort, matching `Array.prototype.sort`'s stability,
/// so base-equal elements (`é`/`e`, `B`/`b`) keep their input order.
///
/// [`normalization.md`]: ../../../../specs/behaviors/normalization.md
pub fn sort_array(items: &mut [Value]) {
    // Pair each element with its coerced comparison key once (so the key is
    // computed n times, not on every comparison), stable-sort the pairs, then
    // write the elements back in order.
    let mut paired: Vec<(String, Value)> = items
        .iter()
        .map(|v| (js_string_coerce(v), v.clone()))
        .collect();
    paired.sort_by(|a, b| compare(&a.0, &b.0));
    for (slot, (_, v)) in items.iter_mut().zip(paired) {
        *slot = v;
    }
}

/// Coerce a [`Value`] to the string `String(value)` yields in JS — the coercion
/// the prior boa comparator applied via `String(a)`. Strings pass through;
/// scalars match JS exactly; composite values fall back to JS's degenerate forms
/// (they do not occur for a spec-conformant `sort = true` field).
fn js_string_coerce(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Integer(i) => i.to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Float(f) => js_number_to_string(*f),
        Value::Datetime(d) => d.to_string(),
        // JS: String([a, b]) === a.join(',') with String() of each element.
        Value::Array(items) => items
            .iter()
            .map(js_string_coerce)
            .collect::<Vec<_>>()
            .join(","),
        // JS: String({}) === "[object Object]".
        Value::Table(_) => "[object Object]".to_string(),
    }
}

/// `String(number)` per ECMAScript: integral finite values render without a
/// fractional part, NaN/±Infinity render as their JS spellings. The general
/// shortest-round-trip case matches Rust's `f64` Display for the values a TOML
/// float carries.
fn js_number_to_string(f: f64) -> String {
    if f.is_nan() {
        "NaN".to_string()
    } else if f.is_infinite() {
        if f > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        }
    } else if f == f.trunc() && f.abs() < 1e21 {
        // Integral floats print without a decimal point in JS (String(2.0) === "2").
        format!("{}", f as i64)
    } else {
        f.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sort a list of `&str` via the public `sort_array` and collect back.
    fn sorted(input: &[&str]) -> Vec<String> {
        let mut items: Vec<Value> = input.iter().map(|s| Value::String((*s).to_string())).collect();
        sort_array(&mut items);
        items
            .into_iter()
            .map(|v| match v {
                Value::String(s) => s,
                _ => unreachable!(),
            })
            .collect()
    }

    #[test]
    fn matches_v8_localecompare_on_the_boa_divergent_cases() {
        // These are exactly the inputs the boa (code-unit) path got wrong. Each
        // expected order is V8's `localeCompare(b, undefined, { sensitivity:
        // 'base', ignorePunctuation: true, numeric: true })`, verified against
        // `node` during development.

        // `["B","a"]`: code-unit puts 'B'(0x42) before 'a'(0x61); V8 base-folds
        // case so 'a' < 'B'. This is the headline divergence.
        assert_eq!(sorted(&["B", "a"]), vec!["a", "B"]);

        // Accents fold at base sensitivity; stable sort preserves input order for
        // base-equal elements (é before e because é came first).
        assert_eq!(sorted(&["é", "e", "z"]), vec!["é", "e", "z"]);
        assert_eq!(sorted(&["z", "é", "e"]), vec!["é", "e", "z"]);

        // numeric:true → "2" < "10" (not code-point "10" < "2").
        assert_eq!(sorted(&["10", "2", "1"]), vec!["1", "2", "10"]);
        assert_eq!(sorted(&["file10", "file2", "file1"]), vec!["file1", "file2", "file10"]);

        // ignorePunctuation:true → hyphen/space ignored: "co-op" == "coop" == "co op".
        assert_eq!(sorted(&["coop", "co-op", "co op"]), vec!["coop", "co-op", "co op"]);

        // Mixed case + accents + digits together (Äpfel base-folds to "apfel",
        // and "apfel" < "apple" at the third letter).
        assert_eq!(
            sorted(&["Banana", "apple", "Äpfel", "10", "2"]),
            vec!["2", "10", "Äpfel", "apple", "Banana"]
        );
    }

    #[test]
    fn compare_is_a_total_order_signum() {
        use std::cmp::Ordering;
        assert_eq!(compare("a", "B"), Ordering::Less);
        assert_eq!(compare("B", "a"), Ordering::Greater);
        assert_eq!(compare("e", "é"), Ordering::Equal); // base-equal
        assert_eq!(compare("apple", "apple"), Ordering::Equal);
    }

    #[test]
    fn js_string_coercion_matches_string_for_scalars() {
        assert_eq!(js_string_coerce(&Value::String("hi".into())), "hi");
        assert_eq!(js_string_coerce(&Value::Integer(42)), "42");
        assert_eq!(js_string_coerce(&Value::Integer(-7)), "-7");
        assert_eq!(js_string_coerce(&Value::Boolean(true)), "true");
        assert_eq!(js_string_coerce(&Value::Boolean(false)), "false");
        // String(2.0) === "2"; String(1.5) === "1.5".
        assert_eq!(js_string_coerce(&Value::Float(2.0)), "2");
        assert_eq!(js_string_coerce(&Value::Float(1.5)), "1.5");
    }
}
