//! `gitsheets-py` — the Python (pyo3) binding for `gitsheets-core`.
//!
//! Scaffold only; the marshalling boundary + entry points land in the next
//! commit.

use pyo3::prelude::*;

#[pymodule]
fn _gitsheets(_m: &Bound<'_, PyModule>) -> PyResult<()> {
    Ok(())
}
