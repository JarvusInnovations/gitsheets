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


# ── None handling at the marshal boundary ─────────────────────────────────────
# specs/behaviors/normalization.md "Null / undefined handling": None-valued
# keys are dropped recursively (the 1.x drop semantics, #232); a None array
# element or a None value itself is an error.


def test_none_valued_keys_are_dropped_recursively():
    [out] = gitsheets.roundtrip(
        [
            {
                "keep": "v",
                "gone": None,
                "nested": {"x": None, "y": 2},
                "arr": [{"a": None, "b": 1}],
            }
        ]
    )
    assert out == {"keep": "v", "nested": {"y": 2}, "arr": [{"b": 1}]}


def test_none_keys_serialize_byte_identically_to_the_stripped_record():
    [with_nones] = gitsheets.serialize_records(
        [{"slug": "jane", "middleName": None, "contact": {"email": "j@x.org", "phone": None}}]
    )
    [stripped] = gitsheets.serialize_records([{"slug": "jane", "contact": {"email": "j@x.org"}}])
    assert with_nones == stripped
    assert "middleName" not in with_nones
    assert "phone" not in with_nones


def test_none_array_element_raises_with_the_index_named():
    with pytest.raises(ValueError, match=r"array element \(index 1\)"):
        gitsheets.roundtrip([{"tags": ["a", None, "c"]}])


def test_none_record_itself_raises():
    with pytest.raises(ValueError, match="cannot marshal None to a TOML value"):
        gitsheets.roundtrip([None])


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


# ── attachments + blob-write primitive ──────────────────────────────────────────


def _git_blob_hash(data: bytes) -> str:
    import hashlib

    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def test_write_blob_hashes_to_git_blob_hash(fresh_repo):
    _, git_dir = fresh_repo
    data = bytes([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0xFF])
    got = gitsheets.write_blob(git_dir, data)
    assert got == _git_blob_hash(data)


def test_record_and_attachment_commit_atomically(seeded_repo):
    d, git_dir = seeded_repo
    data = b"AVATAR-BYTES"
    with gitsheets.transact(
        git_dir, "add jane + avatar", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main"
    ) as tx:
        tx.open_sheet("people", ".gitsheets/people.toml")
        tx.upsert("people", {"slug": "jane"})
        blob = gitsheets.write_blob(git_dir, data)
        tx.set_attachment("people", "jane", "avatar.bin", blob)
    commit = tx.result["commit_hash"]
    assert commit is not None

    # ONE commit contains BOTH the record and the attachment.
    tree = subprocess.run(
        ["git", "--git-dir", git_dir, "ls-tree", "-r", commit], check=True, capture_output=True
    ).stdout.decode()
    assert "people/jane.toml" in tree
    assert "people/jane/avatar.bin" in tree
    # The staged attachment blob is exactly the bytes we wrote.
    in_tree = subprocess.run(
        ["git", "--git-dir", git_dir, "rev-parse", f"{commit}:people/jane/avatar.bin"],
        check=True, capture_output=True,
    ).stdout.decode().strip()
    assert in_tree == blob == _git_blob_hash(data)


def test_attachment_get_delete_surface(seeded_repo):
    d, git_dir = seeded_repo
    with gitsheets.transact(
        git_dir, "seed", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main"
    ) as tx:
        tx.open_sheet("people", ".gitsheets/people.toml")
        tx.upsert("people", {"slug": "jane"})
        a = gitsheets.write_blob(git_dir, b"A")
        c = gitsheets.write_blob(git_dir, b"C")
        tx.set_attachments("people", "jane", {"avatar.jpg": a, "cover.png": c})
        assert tx.get_attachments("people", "jane") == {"avatar.jpg": a, "cover.png": c}
        assert tx.get_attachment("people", "jane", "avatar.jpg") == a
        assert tx.get_attachment("people", "jane", "nope") is None
        # Strict single-delete of a missing attachment raises.
        with pytest.raises(gitsheets.NotFoundError):
            tx.delete_attachment("people", "jane", "nope.png")
        tx.delete_attachment("people", "jane", "avatar.jpg")
        assert list(tx.get_attachments("people", "jane").keys()) == ["cover.png"]


def test_diff_detects_rename(seeded_repo):
    d, git_dir = seeded_repo

    def person(slug):
        return {
            "bio": "A reasonably long biography line that stays put.",
            "email": "jane@example.org",
            "name": "Jane Q. Doe",
            "slug": slug,
        }

    with gitsheets.transact(
        git_dir, "add jane", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main"
    ) as tx:
        tx.open_sheet("people", ".gitsheets/people.toml")
        tx.upsert("people", person("jane"))
    src = tx.result["commit_hash"]

    with gitsheets.transact(
        git_dir, "rename", 1_700_000_001, author=("J", "j@x.org"), branch="refs/heads/main"
    ) as tx:
        tx.open_sheet("people", ".gitsheets/people.toml")
        tx.upsert("people", person("jane-doe"), previous_path="jane")
    dst = tx.result["commit_hash"]

    diffs = gitsheets.diff_records(git_dir, src, dst, "people")
    assert len(diffs) == 1
    assert diffs[0]["status"] == "renamed"
    assert diffs[0]["path"] == "jane-doe"
    assert diffs[0]["previous_path"] == "jane"


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
