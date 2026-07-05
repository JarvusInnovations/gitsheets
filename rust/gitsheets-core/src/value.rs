//! The TOML-faithful core value type — gitsheets' lingua franca.
//!
//! Every later plan (TOML parse/serialize, normalization, validation, query,
//! the `Sheet`/`Transaction` state machine) speaks this type, and every
//! language binding marshals its host objects to and from it. The cardinal
//! rule, from [`specs/rust-core.md`](../../../specs/rust-core.md): **the core
//! preserves whatever determines on-disk bytes** — so the value type keeps the
//! distinctions a host language might flatten (integer vs float, and the four
//! distinct TOML datetime kinds), even when a binding can only surface a
//! lossier idiomatic shape.

use indexmap::IndexMap;

/// A TOML-faithful value.
///
/// The variants mirror TOML's type set exactly. Two distinctions are
/// load-bearing for on-disk bytes and must never collapse in the core:
///
/// - [`Value::Integer`] (`i64`) vs [`Value::Float`] (`f64`): `1` and `1.0`
///   serialize to different bytes, so they are different values.
/// - The four [`Datetime`] kinds (see [`DatetimeKind`]): offset-datetime,
///   local-datetime, local-date, and local-time each serialize differently.
///
/// Tables preserve insertion order (`IndexMap`); canonical key ordering is a
/// normalization concern applied at serialize time, not a property of the
/// value itself.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    String(String),
    Integer(i64),
    Float(f64),
    Boolean(bool),
    Datetime(Datetime),
    Array(Vec<Value>),
    Table(IndexMap<String, Value>),
}

impl Value {
    /// A short, stable name for the value's kind — handy for diagnostics and
    /// for tests asserting the boundary preserved a distinction.
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::String(_) => "string",
            Value::Integer(_) => "integer",
            Value::Float(_) => "float",
            Value::Boolean(_) => "boolean",
            Value::Datetime(_) => "datetime",
            Value::Array(_) => "array",
            Value::Table(_) => "table",
        }
    }
}

// ── marshal-boundary null diagnostics ────────────────────────────────────────
//
// TOML has no `null`, so a host-language null (JS `null`/`undefined`, Python
// `None`) never crosses the FFI — each binding resolves it during its
// host→core marshal, per the contract in
// `specs/behaviors/normalization.md` § "Null / undefined handling":
//
// 1. a null-valued **table key** is dropped, recursively (absent key ==
//    cleared optional field — the 1.x `@iarna/toml` semantics);
// 2. a null **array element** is an error (dropping an element would silently
//    shift the remaining elements — a data mutation, not an omission);
// 3. a null in any other value position (a whole record, a scalar) is an
//    error.
//
// The drop/reject *recursion* necessarily lives in each binding (only the
// binding can see host values), but the messages are minted here so the
// contract's diagnostics read identically from every host language.

/// The rejection message for rule 2 — a null array element. `null_name` is the
/// host language's spelling ("null/undefined", "None").
pub fn null_array_element_msg(null_name: &str, index: usize) -> String {
    format!(
        "cannot marshal {null_name} as an array element (index {index}): TOML arrays cannot \
         contain nulls, and dropping the element would silently shift the rest of the array — \
         remove the element instead (null-valued keys are dropped; array elements are not)"
    )
}

/// The rejection message for rule 3 — a null where a value itself is required
/// (a whole record, a scalar position). `null_name` as above.
pub fn null_value_msg(null_name: &str) -> String {
    format!(
        "cannot marshal {null_name} to a TOML value: TOML has no null — null-valued keys are \
         dropped from records, but a value itself cannot be {null_name}"
    )
}

/// The four distinct TOML datetime kinds. They serialize to different bytes, so
/// the core keeps them distinguishable even though a binding (e.g. Node) may
/// surface them all as one host type (a JS `Date`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatetimeKind {
    /// `1979-05-27T07:32:00Z` / `1979-05-27T00:32:00-07:00`
    OffsetDatetime,
    /// `1979-05-27T07:32:00` (no offset)
    LocalDatetime,
    /// `1979-05-27`
    LocalDate,
    /// `07:32:00`
    LocalTime,
}

/// A TOML datetime, backed by [`toml::value::Datetime`] so the precise on-disk
/// form (and its `Display` bytes) is retained for byte-faithful
/// re-serialization. The [`DatetimeKind`] is derived from which components are
/// present, exactly as TOML defines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Datetime(pub toml::value::Datetime);

impl Datetime {
    /// Which of the four TOML datetime kinds this value is.
    pub fn kind(&self) -> DatetimeKind {
        let Datetime(dt) = self;
        match (dt.date.is_some(), dt.time.is_some(), dt.offset.is_some()) {
            (true, true, true) => DatetimeKind::OffsetDatetime,
            (true, true, false) => DatetimeKind::LocalDatetime,
            (true, false, _) => DatetimeKind::LocalDate,
            (false, true, _) => DatetimeKind::LocalTime,
            // A datetime with neither date nor time is not constructible from
            // any TOML source; treat it as a local-date for total-ness.
            (false, false, _) => DatetimeKind::LocalDate,
        }
    }

    /// The canonical TOML string form (the on-disk bytes for this datetime).
    pub fn to_toml_string(&self) -> String {
        self.0.to_string()
    }
}

impl std::fmt::Display for Datetime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::str::FromStr for Datetime {
    type Err = toml::value::DatetimeParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<toml::value::Datetime>().map(Datetime)
    }
}

impl From<toml::value::Datetime> for Datetime {
    fn from(dt: toml::value::Datetime) -> Self {
        Datetime(dt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> Datetime {
        s.parse::<Datetime>().expect("parse datetime")
    }

    #[test]
    fn integer_and_float_are_distinct_values() {
        // `1` and `1.0` serialize to different bytes — they must not be equal.
        assert_ne!(Value::Integer(1), Value::Float(1.0));
        assert_eq!(Value::Integer(1).type_name(), "integer");
        assert_eq!(Value::Float(1.0).type_name(), "float");
    }

    #[test]
    fn the_four_datetime_kinds_are_distinguished() {
        assert_eq!(dt("1979-05-27T07:32:00Z").kind(), DatetimeKind::OffsetDatetime);
        assert_eq!(
            dt("1979-05-27T00:32:00-07:00").kind(),
            DatetimeKind::OffsetDatetime
        );
        assert_eq!(dt("1979-05-27T07:32:00").kind(), DatetimeKind::LocalDatetime);
        assert_eq!(dt("1979-05-27").kind(), DatetimeKind::LocalDate);
        assert_eq!(dt("07:32:00").kind(), DatetimeKind::LocalTime);
    }

    #[test]
    fn datetime_kinds_serialize_to_distinct_bytes() {
        // The whole reason the core keeps them distinct: their bytes differ.
        let forms = [
            "1979-05-27T07:32:00Z",
            "1979-05-27T07:32:00",
            "1979-05-27",
            "07:32:00",
        ];
        let rendered: Vec<String> = forms.iter().map(|s| dt(s).to_toml_string()).collect();
        for (i, a) in rendered.iter().enumerate() {
            for b in rendered.iter().skip(i + 1) {
                assert_ne!(a, b, "datetime kinds must render to different bytes");
            }
        }
    }

    #[test]
    fn null_diagnostics_name_the_host_null_and_the_index() {
        let msg = null_array_element_msg("null/undefined", 3);
        assert!(msg.contains("index 3"), "must name the offending index");
        assert!(msg.contains("null/undefined"), "must use the host spelling");
        assert!(
            msg.contains("remove the element"),
            "must tell the consumer the actionable fix"
        );

        let msg = null_value_msg("None");
        assert!(msg.contains("None"), "must use the host spelling");
        assert!(
            msg.contains("null-valued keys are dropped"),
            "must state the key-drop rule so the boundary reads consistently"
        );
    }

    #[test]
    fn nested_tables_compare_structurally() {
        let mut inner = IndexMap::new();
        inner.insert("n".to_string(), Value::Integer(2));
        let mut a = IndexMap::new();
        a.insert("inner".to_string(), Value::Table(inner.clone()));
        let mut b = IndexMap::new();
        b.insert("inner".to_string(), Value::Table(inner));
        assert_eq!(Value::Table(a), Value::Table(b));
    }
}
