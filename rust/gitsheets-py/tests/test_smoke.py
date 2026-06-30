"""Smoke + behavior tests for the gitsheets Python binding.

Covers marshalling type fidelity, record CRUD over holo-tree, the full
upsert→commit transaction with the two-phase consumer-validator protocol, the
embedded JS engine, diff/patch, and typed error mapping.
"""

from __future__ import annotations

import datetime as dt
import os
import shutil
import subprocess
import tempfile

import pytest

import gitsheets


# ── fixtures / helpers ─────────────────────────────────────────────────────────


def _git(args, cwd=None):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture()
def fresh_repo():
    d = tempfile.mkdtemp(prefix="gitsheets-py-")
    _git(["init", "-q", d])
    try:
        yield d, os.path.join(d, ".git")
    finally:
        shutil.rmtree(d, ignore_errors=True)


PEOPLE_CONFIG = "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n"


@pytest.fixture()
def seeded_repo():
    """A repo with .gitsheets/people.toml committed on `main`."""
    d = tempfile.mkdtemp(prefix="gitsheets-py-")
    _git(["init", "-q", "-b", "main", d])
    _git(["config", "user.name", "Seed"], cwd=d)
    _git(["config", "user.email", "seed@x.org"], cwd=d)
    os.makedirs(os.path.join(d, ".gitsheets"))
    with open(os.path.join(d, ".gitsheets", "people.toml"), "w") as fh:
        fh.write(PEOPLE_CONFIG)
    _git(["add", ".gitsheets/people.toml"], cwd=d)
    _git(["commit", "-q", "-m", "init"], cwd=d)
    try:
        yield d, os.path.join(d, ".git")
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ── marshalling fidelity ───────────────────────────────────────────────────────


def test_roundtrip_preserves_int_float_str_bool_nested():
    record = {
        "slug": "jane",
        "count": 7,
        "ratio": 1.5,
        "active": True,
        "tags": ["a", "b"],
        "nested": {"city": "Philly", "zip": "19103"},
    }
    [out] = gitsheets.roundtrip([record])
    assert out == record
    # int vs float stay distinct types across the boundary.
    assert isinstance(out["count"], int) and not isinstance(out["count"], bool)
    assert isinstance(out["ratio"], float)
    assert isinstance(out["active"], bool)


def test_int_and_float_are_distinct():
    [out] = gitsheets.roundtrip([{"i": 1, "f": 1.0}])
    assert isinstance(out["i"], int)
    assert isinstance(out["f"], float)
    # canonical serialization keeps them distinct (1 vs 1.0).
    [text] = gitsheets.serialize_records([{"i": 1, "f": 1.0}])
    assert "i = 1\n" in text
    assert "f = 1.0\n" in text


def test_large_int_keeps_precision():
    big = 9_007_199_254_740_993  # 2^53 + 1, lossy as a JS number
    [out] = gitsheets.roundtrip([{"n": big}])
    assert out["n"] == big


def test_int_out_of_i64_range_raises_overflow():
    with pytest.raises(OverflowError):
        gitsheets.roundtrip([{"n": 2**64}])


def test_datetime_roundtrips_as_same_utc_instant():
    when = dt.datetime(2026, 6, 26, 12, 0, 0, tzinfo=dt.timezone.utc)
    [out] = gitsheets.roundtrip([{"when": when}])
    assert isinstance(out["when"], dt.datetime)
    assert out["when"] == when
    # serializes to the canonical offset-datetime form.
    [text] = gitsheets.serialize_records([{"when": when}])
    assert "when = 2026-06-26T12:00:00Z\n" in text


def test_naive_datetime_is_treated_as_utc():
    naive = dt.datetime(2026, 6, 26, 12, 0, 0)
    [text] = gitsheets.serialize_records([{"when": naive}])
    assert "when = 2026-06-26T12:00:00Z\n" in text


# ── record CRUD over holo-tree ──────────────────────────────────────────────────


def test_record_write_read_roundtrip(fresh_repo):
    _, git_dir = fresh_repo
    rec = {"email": "jane@x.org", "slug": "jane", "tags": ["a", "b"], "age": 30}
    out = gitsheets.record_write(git_dir, gitsheets.EMPTY_TREE_HASH, "people", ["jane"], [rec])
    assert len(out["tree_hash"]) == 40
    assert len(out["blob_hashes"][0]) == 40
    read = gitsheets.record_read(git_dir, out["tree_hash"], "people", ["jane"])
    assert read[0] == rec


def test_record_list_sorted(fresh_repo):
    _, git_dir = fresh_repo
    out = gitsheets.record_write(
        git_dir, gitsheets.EMPTY_TREE_HASH, "people", ["zoe", "amy"], [{"slug": "zoe"}, {"slug": "amy"}]
    )
    listed = gitsheets.record_list(git_dir, out["tree_hash"], "people")
    assert [e["path"] for e in listed] == ["amy", "zoe"]


# ── transaction lifecycle + two-phase consumer-validator protocol ───────────────


def test_full_upsert_commits(seeded_repo):
    d, git_dir = seeded_repo
    with gitsheets.transact(
        git_dir,
        "people: add jane",
        1_700_000_000,
        offset_minutes=-300,
        author=("Jane Doe", "jane@x.org"),
        branch="refs/heads/main",
        trailers=[("Action", "person.create")],
    ) as tx:
        tx.open_sheet("people", ".gitsheets/people.toml")
        tx.upsert("people", {"slug": "jane", "email": "jane@x.org"})
    assert len(tx.result["commit_hash"]) == 40
    assert tx.result["ref_name"] == "refs/heads/main"
    blob = subprocess.run(
        ["git", "--git-dir", git_dir, "show", f"{tx.result['commit_hash']}:people/jane.toml"],
        check=True,
        capture_output=True,
    ).stdout.decode()
    assert blob == 'email = "jane@x.org"\nslug = "jane"\n'


def test_consumer_validator_rejects_before_write(seeded_repo):
    d, git_dir = seeded_repo

    def validate(record):
        if not record.get("email"):
            raise ValueError("email is required")

    with pytest.raises(ValueError, match="email is required"):
        with gitsheets.transact(
            git_dir, "bad", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main"
        ) as tx:
            tx.open_sheet("people", ".gitsheets/people.toml")
            tx.upsert("people", {"slug": "bad"}, validate=validate)

    # Nothing was committed: people/bad.toml never landed.
    res = subprocess.run(
        ["git", "--git-dir", git_dir, "show", "HEAD:people/bad.toml"], capture_output=True
    )
    assert res.returncode != 0


def test_pydantic_validator_integration(seeded_repo):
    pydantic = pytest.importorskip("pydantic")

    class Person(pydantic.BaseModel):
        slug: str
        email: str

    d, git_dir = seeded_repo
    with gitsheets.transact(
        git_dir, "add jane", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main"
    ) as tx:
        tx.open_sheet("people", ".gitsheets/people.toml")
        tx.upsert("people", {"slug": "jane", "email": "jane@x.org"}, validate=Person.model_validate)
    assert tx.result["commit_hash"]


def test_reupsert_identical_is_noop(seeded_repo):
    d, git_dir = seeded_repo
    for _ in range(2):
        with gitsheets.transact(
            git_dir, "add", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main"
        ) as tx:
            tx.open_sheet("people", ".gitsheets/people.toml")
            tx.upsert("people", {"slug": "jane", "email": "j@x.org"})
    # second finalize is a no-op (tree-hash equality → no new commit).
    assert tx.result["commit_hash"] is None


# ── embedded JS engine ──────────────────────────────────────────────────────────


def test_run_comparator_uses_core_engine():
    # Descending numeric sort comparator.
    assert gitsheets.run_comparator("return b.age - a.age", {"age": 1}, {"age": 5}) > 0
    assert gitsheets.run_comparator("return b.age - a.age", {"age": 5}, {"age": 1}) < 0


def test_compiled_definition_render_and_compare():
    d = gitsheets.CompiledDefinition("people/${{ slug }}", "return a.n - b.n")
    assert d.render_path({"slug": "jane"}) == "people/jane"
    assert d.compare({"n": 1}, {"n": 2}) < 0


# ── diff / patch ────────────────────────────────────────────────────────────────


def test_create_patch_and_merge_patch():
    ops = gitsheets.create_patch({"a": 1, "b": 2}, {"a": 1, "b": 20})
    assert ops == [{"op": "replace", "path": "/b", "value": 20}]
    merged = gitsheets.apply_merge_patch({"slug": "jane", "bio": "hi"}, {"bio": None})
    assert merged == {"slug": "jane"}


# ── typed error mapping ─────────────────────────────────────────────────────────


def test_simulate_core_error_maps_to_typed_exception():
    with pytest.raises(gitsheets.ValidationError) as ei:
        gitsheets.simulate_core_error("validation_failed")
    err = ei.value
    assert err.code == "validation_failed"
    assert err.gitsheets_class == "ValidationError"
    assert isinstance(err, gitsheets.GitsheetsError)
    assert err.issues and err.issues[0]["path"] == ["email"]


def test_index_conflict_error_carries_paths():
    with pytest.raises(gitsheets.IndexError) as ei:
        gitsheets.simulate_core_error("index_unique_conflict")
    assert ei.value.conflicting_paths == ["people/by-email/a@b.com"]
