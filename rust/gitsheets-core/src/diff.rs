//! Record diff + patch semantics — RFC 6902 (JSON Patch) generation and
//! RFC 7396 (JSON Merge Patch) application, natively in the core.
//!
//! Per [`specs/rust-core.md`](../../../specs/rust-core.md), "diff + patch
//! semantics" lives in the core so every binding agrees. This is the
//! **behavior-preserving** Rust port of the two JS implementations:
//!
//! - **RFC 6902 `create_patch`** mirrors the `rfc6902` npm package's
//!   `createPatch`, which `Sheet.diffFrom` uses to turn a src/dst record pair
//!   into a JSON Patch. The object diff, the Levenshtein array diff (with its
//!   exact cost/tie-break and `/-` append-token padding), the wholesale-replace
//!   fallback, and the top-level null handling (added ⇒ `replace "" <record>`,
//!   deleted ⇒ `replace "" null`) all match the library op-for-op.
//! - **RFC 7396 `apply_merge_patch`** mirrors `packages/gitsheets/src/patch.ts`
//!   (`mergePatch`), the inline merge `Sheet.patch` applies: `null` deletes a
//!   key, an object merges recursively, anything else replaces wholesale; see
//!   [`specs/behaviors/patch-semantics.md`](../../../specs/behaviors/patch-semantics.md).
//!
//! ## The one representational wrinkle: JSON null
//!
//! The core [`Value`] has no null (TOML has none), but both algorithms need a
//! null sentinel — RFC 6902 at the top level (a deleted record diffs to
//! `replace "" null`), RFC 7396 as the per-key delete marker. So:
//!
//! - `create_patch` takes `Option<&Value>` (`None` = JSON null) and a [`PatchOp`]
//!   carries a [`PatchValue`] that distinguishes *absent* (a `remove` op, no
//!   `value` key), *null* (a `replace`/`add` whose value is JSON null), and a
//!   real [`Value`].
//! - the merge patch is a dedicated [`MergePatch`] tree whose `Delete` variant
//!   is the null marker; a binding marshals a host partial (which *can* hold
//!   nulls) into it.
//!
//! ## Enumerated divergences vs the JS libraries
//!
//! - **Datetimes in a diff.** `Value::Datetime` is compared by its canonical
//!   TOML string here, so a changed datetime field emits a `replace`. The JS
//!   `rfc6902` sees a `Date` *object*, finds no own-enumerable keys, and emits
//!   *nothing* on a change (a latent quirk). Equal datetimes produce no op in
//!   both. Parity fixtures stay JSON-representable, so this is theoretical.
//! - **Int vs float.** `1` and `1.0` are numerically equal here (as in JS,
//!   where both parse to the single `number` 1), so a `1` ⇒ `1.0` change emits
//!   no op in either.

use indexmap::IndexMap;

use crate::value::Value;

// ── RFC 6902: createPatch ────────────────────────────────────────────────────

/// The op kinds `createPatch` produces (it never emits move/copy/test).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatchOpKind {
    Add,
    Remove,
    Replace,
}

impl PatchOpKind {
    /// The wire string (`"add"` / `"remove"` / `"replace"`).
    pub fn as_str(self) -> &'static str {
        match self {
            PatchOpKind::Add => "add",
            PatchOpKind::Remove => "remove",
            PatchOpKind::Replace => "replace",
        }
    }
}

/// The `value` of a [`PatchOp`], distinguishing the three JSON shapes a binding
/// must reproduce: a `remove` carries no `value` key ([`PatchValue::Absent`]),
/// a `replace`/`add` to JSON null carries `value: null` ([`PatchValue::Null`]),
/// and everything else carries a real [`Value`].
#[derive(Clone, Debug, PartialEq)]
pub enum PatchValue {
    /// No `value` key — only on `remove`.
    Absent,
    /// `value: null` — a deleted record's top-level `replace`.
    Null,
    /// A concrete value.
    Value(Value),
}

/// One RFC 6902 operation. `path` is a JSON Pointer.
#[derive(Clone, Debug, PartialEq)]
pub struct PatchOp {
    pub op: PatchOpKind,
    pub path: String,
    pub value: PatchValue,
}

/// A node in the diff: a real [`Value`] or JSON `null`. `null` only ever appears
/// at the top level (a record that is absent on one side); record *fields* are
/// always real values, since the core has no null.
#[derive(Clone, Copy)]
enum Node<'a> {
    Null,
    Val(&'a Value),
}

/// Generate an RFC 6902 JSON Patch transforming `src` into `dst`, matching the
/// `rfc6902` package's `createPatch`. `None` on either side is JSON null — so
/// `create_patch(None, Some(r))` is an "added" record (`replace "" <r>`) and
/// `create_patch(Some(r), None)` is "deleted" (`replace "" null`).
pub fn create_patch(src: Option<&Value>, dst: Option<&Value>) -> Vec<PatchOp> {
    let a = src.map_or(Node::Null, Node::Val);
    let b = dst.map_or(Node::Null, Node::Val);
    diff_any(a, b, "")
}

/// A JSON-Pointer "type" tag, matching `rfc6902`'s `objectType` (`null` is its
/// own type, distinct from `object`).
enum JsonType {
    Null,
    Array,
    Object,
    Scalar,
}

fn node_type(node: Node<'_>) -> JsonType {
    match node {
        Node::Null => JsonType::Null,
        Node::Val(Value::Array(_)) => JsonType::Array,
        Node::Val(Value::Table(_)) => JsonType::Object,
        Node::Val(_) => JsonType::Scalar,
    }
}

/// `===`-equivalent equality (the `input === output` short-circuit in
/// `diffAny`): primitives by value, with numbers cross-comparing int/float and
/// datetimes compared by their canonical string. Compound values are never
/// strict-equal (they recurse and yield `[]` when deeply equal).
fn nodes_strict_equal(a: Node<'_>, b: Node<'_>) -> bool {
    match (a, b) {
        (Node::Null, Node::Null) => true,
        (Node::Val(x), Node::Val(y)) => match (x, y) {
            (Value::String(p), Value::String(q)) => p == q,
            (Value::Boolean(p), Value::Boolean(q)) => p == q,
            (Value::Integer(p), Value::Integer(q)) => p == q,
            (Value::Float(p), Value::Float(q)) => p == q,
            (Value::Integer(p), Value::Float(q)) | (Value::Float(q), Value::Integer(p)) => {
                (*p as f64) == *q
            }
            (Value::Datetime(p), Value::Datetime(q)) => p.to_toml_string() == q.to_toml_string(),
            _ => false,
        },
        _ => false,
    }
}

fn node_to_patch_value(node: Node<'_>) -> PatchValue {
    match node {
        Node::Null => PatchValue::Null,
        Node::Val(v) => PatchValue::Value(v.clone()),
    }
}

fn diff_any(input: Node<'_>, output: Node<'_>, ptr: &str) -> Vec<PatchOp> {
    if nodes_strict_equal(input, output) {
        return Vec::new();
    }
    match (node_type(input), node_type(output)) {
        (JsonType::Array, JsonType::Array) => {
            let (Node::Val(Value::Array(a)), Node::Val(Value::Array(b))) = (input, output) else {
                unreachable!()
            };
            diff_arrays(a, b, ptr)
        }
        (JsonType::Object, JsonType::Object) => {
            let (Node::Val(Value::Table(a)), Node::Val(Value::Table(b))) = (input, output) else {
                unreachable!()
            };
            diff_objects(a, b, ptr)
        }
        // Materially different and not both-array / both-object: replace whole.
        _ => vec![PatchOp {
            op: PatchOpKind::Replace,
            path: ptr.to_string(),
            value: node_to_patch_value(output),
        }],
    }
}

/// JSON-Pointer append: `ptr.add(token)`, escaping `~`→`~0` and `/`→`~1`.
fn ptr_add(ptr: &str, token: &str) -> String {
    let escaped = token.replace('~', "~0").replace('/', "~1");
    format!("{ptr}/{escaped}")
}

fn diff_objects(input: &IndexMap<String, Value>, output: &IndexMap<String, Value>, ptr: &str) -> Vec<PatchOp> {
    let mut ops = Vec::new();
    // keys in input but not output -> remove
    for key in input.keys() {
        if !output.contains_key(key) {
            ops.push(PatchOp {
                op: PatchOpKind::Remove,
                path: ptr_add(ptr, key),
                value: PatchValue::Absent,
            });
        }
    }
    // keys in output but not input -> add
    for (key, val) in output {
        if !input.contains_key(key) {
            ops.push(PatchOp {
                op: PatchOpKind::Add,
                path: ptr_add(ptr, key),
                value: PatchValue::Value(val.clone()),
            });
        }
    }
    // keys in both -> recurse (input iteration order, matching rfc6902)
    for (key, in_val) in input {
        if let Some(out_val) = output.get(key) {
            ops.extend(diff_any(Node::Val(in_val), Node::Val(out_val), &ptr_add(ptr, key)));
        }
    }
    ops
}

/// Intermediate (index-relative) array operation from the Levenshtein DP, before
/// the padding pass rewrites indices into JSON-Pointer paths.
#[derive(Clone)]
enum ArrayOp {
    Remove { index: i64 },
    Add { index: i64, value: Value },
    Replace { index: i64, original: Value, value: Value },
}

/// Levenshtein array diff — a faithful port of `rfc6902`'s `diffArrays`,
/// including the memoized `dist`, the cost/stable-tie-break (`remove` < `add` <
/// `replace`), and the padding pass that turns add indices into the `/-`
/// append token at the tail.
fn diff_arrays(input: &[Value], output: &[Value], ptr: &str) -> Vec<PatchOp> {
    let input_len = input.len() as i64;
    let output_len = output.len() as i64;
    let max_length = input.len().max(output.len()).max(1) as i64;

    let mut memo: std::collections::HashMap<i64, (Vec<ArrayOp>, i64)> = std::collections::HashMap::new();

    let array_operations = dist(input_len, output_len, input, output, max_length, &mut memo).0;

    // Padding pass: rewrite index-relative ops into pointer-pathed PatchOps.
    let mut padding: i64 = 0;
    let mut ops: Vec<PatchOp> = Vec::new();
    for aop in array_operations {
        match aop {
            ArrayOp::Add { index, value } => {
                let padded_index = index + 1 + padding;
                let token = if padded_index < input_len + padding {
                    padded_index.to_string()
                } else {
                    "-".to_string()
                };
                ops.push(PatchOp {
                    op: PatchOpKind::Add,
                    path: ptr_add(ptr, &token),
                    value: PatchValue::Value(value),
                });
                padding += 1;
            }
            ArrayOp::Remove { index } => {
                ops.push(PatchOp {
                    op: PatchOpKind::Remove,
                    path: ptr_add(ptr, &(index + padding).to_string()),
                    value: PatchValue::Absent,
                });
                padding -= 1;
            }
            ArrayOp::Replace { index, original, value } => {
                let replace_ptr = ptr_add(ptr, &(index + padding).to_string());
                ops.extend(diff_any(Node::Val(&original), Node::Val(&value), &replace_ptr));
            }
        }
    }
    ops
}

/// Cheapest op sequence from `input[0..i]` to `output[0..j]` (rfc6902 `dist`).
fn dist(
    i: i64,
    j: i64,
    input: &[Value],
    output: &[Value],
    max_length: i64,
    memo: &mut std::collections::HashMap<i64, (Vec<ArrayOp>, i64)>,
) -> (Vec<ArrayOp>, i64) {
    if i == 0 && j == 0 {
        return (Vec::new(), 0);
    }
    let key = i * max_length + j;
    if let Some(cached) = memo.get(&key) {
        return cached.clone();
    }

    let result = if i > 0
        && j > 0
        && diff_any(
            Node::Val(&input[(i - 1) as usize]),
            Node::Val(&output[(j - 1) as usize]),
            "",
        )
        .is_empty()
    {
        // equal element -> no op, diagonal step
        dist(i - 1, j - 1, input, output, max_length, memo)
    } else {
        let mut alternatives: Vec<(Vec<ArrayOp>, i64)> = Vec::new();
        if i > 0 {
            let (mut ops, cost) = dist(i - 1, j, input, output, max_length, memo);
            ops.push(ArrayOp::Remove { index: i - 1 });
            alternatives.push((ops, cost + 1));
        }
        if j > 0 {
            let (mut ops, cost) = dist(i, j - 1, input, output, max_length, memo);
            ops.push(ArrayOp::Add {
                index: i - 1,
                value: output[(j - 1) as usize].clone(),
            });
            alternatives.push((ops, cost + 1));
        }
        if i > 0 && j > 0 {
            let (mut ops, cost) = dist(i - 1, j - 1, input, output, max_length, memo);
            ops.push(ArrayOp::Replace {
                index: i - 1,
                original: input[(i - 1) as usize].clone(),
                value: output[(j - 1) as usize].clone(),
            });
            alternatives.push((ops, cost + 1));
        }
        // stable sort by cost; first lowest wins (remove < add < replace on ties)
        alternatives.sort_by_key(|(_, cost)| *cost);
        alternatives.into_iter().next().expect("at least one alternative when i>0 or j>0")
    };

    memo.insert(key, result.clone());
    result
}

// ── RFC 7396: merge patch ────────────────────────────────────────────────────

/// A JSON Merge Patch (RFC 7396), the structured form of `Sheet.patch`'s
/// `partial`. `Delete` is the `null` marker (remove the key); `Replace` swaps a
/// value wholesale (scalars, arrays, datetimes); `Merge` recurses into a table.
/// A binding marshals a host partial — which *can* carry nulls — into this tree.
#[derive(Clone, Debug, PartialEq)]
pub enum MergePatch {
    Delete,
    Replace(Value),
    Merge(IndexMap<String, MergePatch>),
}

/// Apply an RFC 7396 merge patch to `target` (`None` ⇒ the key/record is
/// absent), returning the merged value or `None` when the result is a deletion.
/// Faithful to `patch.ts`'s `mergePatch`: `Delete` removes, `Merge` recurses
/// into a fresh copy of the target table (or `{}` when absent/non-table), and
/// `Replace` swaps wholesale.
pub fn apply_merge_patch(target: Option<&Value>, patch: &MergePatch) -> Option<Value> {
    match patch {
        MergePatch::Delete => None,
        MergePatch::Replace(v) => Some(v.clone()),
        MergePatch::Merge(fields) => {
            let mut base: IndexMap<String, Value> = match target {
                Some(Value::Table(t)) => t.clone(),
                _ => IndexMap::new(),
            };
            for (key, sub) in fields {
                match sub {
                    MergePatch::Delete => {
                        base.shift_remove(key);
                    }
                    _ => {
                        // Non-delete always yields a value (mergePatch only
                        // returns null for a null patch, handled above).
                        let merged = apply_merge_patch(base.get(key), sub)
                            .expect("non-delete merge patch yields a value");
                        base.insert(key.clone(), merged);
                    }
                }
            }
            Some(Value::Table(base))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::parse;

    fn rec(toml: &str) -> Value {
        parse(toml).expect("parse record")
    }

    /// Compact JSON-ish rendering of a patch for golden assertions against the
    /// captured `rfc6902` output.
    fn render(ops: &[PatchOp]) -> String {
        let parts: Vec<String> = ops
            .iter()
            .map(|op| {
                let val = match &op.value {
                    PatchValue::Absent => String::new(),
                    PatchValue::Null => ",value:null".into(),
                    PatchValue::Value(v) => format!(",value:{}", render_value(v)),
                };
                format!("{{{},{}{}}}", op.op.as_str(), op.path, val)
            })
            .collect();
        format!("[{}]", parts.join(","))
    }

    fn render_value(v: &Value) -> String {
        match v {
            Value::String(s) => format!("\"{s}\""),
            Value::Integer(i) => i.to_string(),
            Value::Float(f) => f.to_string(),
            Value::Boolean(b) => b.to_string(),
            Value::Datetime(d) => format!("\"{}\"", d.to_toml_string()),
            Value::Array(a) => {
                let items: Vec<String> = a.iter().map(render_value).collect();
                format!("[{}]", items.join(","))
            }
            Value::Table(t) => {
                let items: Vec<String> =
                    t.iter().map(|(k, v)| format!("{k}:{}", render_value(v))).collect();
                format!("{{{}}}", items.join(","))
            }
        }
    }

    #[test]
    fn create_patch_added_is_top_level_replace() {
        let dst = rec("email = 'j@x.org'\nslug = 'jane'\n");
        assert_eq!(render(&create_patch(None, Some(&dst))), "[{replace,,value:{email:\"j@x.org\",slug:\"jane\"}}]");
    }

    #[test]
    fn create_patch_deleted_is_replace_null() {
        let src = rec("email = 'j@x.org'\nslug = 'jane'\n");
        assert_eq!(render(&create_patch(Some(&src), None)), "[{replace,,value:null}]");
    }

    #[test]
    fn create_patch_field_change_add_remove() {
        // change
        let a = rec("email = 'old'\nname = 'Jane'\nslug = 'jane'\n");
        let b = rec("email = 'new'\nname = 'Jane'\nslug = 'jane'\n");
        assert_eq!(render(&create_patch(Some(&a), Some(&b))), "[{replace,/email,value:\"new\"}]");
        // add
        let a = rec("slug = 'jane'\n");
        let b = rec("email = 'new'\nslug = 'jane'\n");
        assert_eq!(render(&create_patch(Some(&a), Some(&b))), "[{add,/email,value:\"new\"}]");
        // remove
        let a = rec("email = 'x'\nslug = 'jane'\n");
        let b = rec("slug = 'jane'\n");
        assert_eq!(render(&create_patch(Some(&a), Some(&b))), "[{remove,/email}]");
    }

    #[test]
    fn create_patch_nested_objects() {
        let a = rec("[a]\ncity = 'P'\nzip = '1'\n");
        let b = rec("[a]\ncity = 'P'\nzip = '2'\n");
        assert_eq!(render(&create_patch(Some(&a), Some(&b))), "[{replace,/a/zip,value:\"2\"}]");
    }

    #[test]
    fn create_patch_arrays_match_rfc6902() {
        // append
        let a = rec("tags = ['a', 'b']\n");
        let b = rec("tags = ['a', 'b', 'c']\n");
        assert_eq!(render(&create_patch(Some(&a), Some(&b))), "[{add,/tags/-,value:\"c\"}]");
        // replace element
        let b = rec("tags = ['a', 'x']\n");
        assert_eq!(render(&create_patch(Some(&a), Some(&b))), "[{replace,/tags/1,value:\"x\"}]");
        // remove (a,b,c -> a): two removes both at /tags/1
        let a3 = rec("tags = ['a', 'b', 'c']\n");
        let b1 = rec("tags = ['a']\n");
        assert_eq!(render(&create_patch(Some(&a3), Some(&b1))), "[{remove,/tags/1},{remove,/tags/1}]");
        // whole replace (a,b -> x): replace /tags/0, remove /tags/1
        let bx = rec("tags = ['x']\n");
        assert_eq!(render(&create_patch(Some(&a), Some(&bx))), "[{replace,/tags/0,value:\"x\"},{remove,/tags/1}]");
    }

    #[test]
    fn create_patch_noop_is_empty() {
        let a = rec("a = 1\nb = 2\n");
        let b = rec("a = 1\nb = 2\n");
        assert!(create_patch(Some(&a), Some(&b)).is_empty());
    }

    #[test]
    fn create_patch_int_float_equal_is_noop() {
        let a = rec("x = 1\n");
        let b = rec("x = 1.0\n");
        assert!(create_patch(Some(&a), Some(&b)).is_empty());
    }

    // ── RFC 7396 ──

    fn merge(fields: &[(&str, MergePatch)]) -> MergePatch {
        let mut m = IndexMap::new();
        for (k, v) in fields {
            m.insert((*k).to_string(), v.clone());
        }
        MergePatch::Merge(m)
    }

    #[test]
    fn merge_patch_updates_a_field() {
        let target = rec("email = 'jane@old.org'\nfullName = 'Jane'\nslug = 'jane'\n");
        let patch = merge(&[("email", MergePatch::Replace(Value::String("jane@new.org".into())))]);
        let out = apply_merge_patch(Some(&target), &patch).unwrap();
        let expected = rec("email = 'jane@new.org'\nfullName = 'Jane'\nslug = 'jane'\n");
        assert_eq!(out, expected);
    }

    #[test]
    fn merge_patch_deletes_a_field() {
        let target = rec("bio = 'Hello!'\nemail = 'jane@x.org'\nslug = 'jane'\n");
        let patch = merge(&[("bio", MergePatch::Delete)]);
        let out = apply_merge_patch(Some(&target), &patch).unwrap();
        let expected = rec("email = 'jane@x.org'\nslug = 'jane'\n");
        assert_eq!(out, expected);
    }

    #[test]
    fn merge_patch_replaces_array_atomically() {
        let target = rec("slug = 'jane'\ntags = ['foo', 'bar']\n");
        let patch = merge(&[(
            "tags",
            MergePatch::Replace(Value::Array(vec![Value::String("baz".into())])),
        )]);
        let out = apply_merge_patch(Some(&target), &patch).unwrap();
        let expected = rec("slug = 'jane'\ntags = ['baz']\n");
        assert_eq!(out, expected);
    }

    #[test]
    fn merge_patch_merges_nested_objects() {
        let target = rec("slug = 'jane'\n[address]\ncity = 'Philly'\nzip = '19103'\n");
        let patch = merge(&[(
            "address",
            merge(&[("zip", MergePatch::Replace(Value::String("19104".into())))]),
        )]);
        let out = apply_merge_patch(Some(&target), &patch).unwrap();
        let expected = rec("slug = 'jane'\n[address]\ncity = 'Philly'\nzip = '19104'\n");
        assert_eq!(out, expected);
    }

    #[test]
    fn merge_patch_deletes_a_nested_field() {
        let target = rec("slug = 'jane'\n[address]\ncity = 'Philly'\nzip = '19103'\n");
        let patch = merge(&[("address", merge(&[("zip", MergePatch::Delete)]))]);
        let out = apply_merge_patch(Some(&target), &patch).unwrap();
        let expected = rec("slug = 'jane'\n[address]\ncity = 'Philly'\n");
        assert_eq!(out, expected);
    }

    #[test]
    fn merge_patch_partial_object_merges_not_replaces() {
        // The patch-semantics.md "surprising" case: a sub-object merges, so the
        // sibling key survives.
        let target = rec("slug = 'jane'\n[address]\ncity = 'Philly'\nzip = '19103'\n");
        let patch = merge(&[(
            "address",
            merge(&[("city", MergePatch::Replace(Value::String("Pittsburgh".into())))]),
        )]);
        let out = apply_merge_patch(Some(&target), &patch).unwrap();
        let expected = rec("slug = 'jane'\n[address]\ncity = 'Pittsburgh'\nzip = '19103'\n");
        assert_eq!(out, expected);
    }
}
