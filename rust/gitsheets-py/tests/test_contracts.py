"""Schema contracts — Python binding surface.

Proves specs/behaviors/contracts.md through the Python binding: `implements`
naming an absent contract fails sheet-open with `ContractError`
(`contract_missing`); a vendored document violating a document requirement
fails with `contract_invalid`, naming the rule; `allOf` composition names the
contract on a failing write and lets a conforming write through;
`canonical_contract_hash` agrees across data/JSON/TOML input.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import tempfile

import pytest

import gitsheets

CONTRACT_NAME = "example.com/people/v1"


def _git(args, cwd=None):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def _canonical_toml(doc: dict) -> str:
    """Canonicalize `doc` through the SAME encoder `load_contract` checks
    vendored bytes against, so a hand-authored fixture never trips the
    canonical-bytes check for reasons unrelated to what a test is naming."""
    return gitsheets.serialize_records([doc])[0]


SHEET_WITH_IMPLEMENTS = (
    "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n"
    f"implements = ['{CONTRACT_NAME}']\n"
)

CONFORMING_CONTRACT = _canonical_toml(
    {
        "$id": f"https://{CONTRACT_NAME}",
        "type": "object",
        "required": ["email"],
        "properties": {"email": {"type": "string"}},
    }
)


@pytest.fixture()
def repo_with_implements():
    """A repo with `.gitsheets/people.toml` declaring `implements`, with no
    vendored contract committed yet."""
    d = tempfile.mkdtemp(prefix="gitsheets-py-contracts-")
    _git(["init", "-q", "-b", "main", d])
    _git(["config", "user.name", "Seed"], cwd=d)
    _git(["config", "user.email", "seed@x.org"], cwd=d)
    os.makedirs(os.path.join(d, ".gitsheets"))
    with open(os.path.join(d, ".gitsheets", "people.toml"), "w") as fh:
        fh.write(SHEET_WITH_IMPLEMENTS)
    _git(["add", ".gitsheets/people.toml"], cwd=d)
    _git(["commit", "-q", "-m", "init"], cwd=d)
    try:
        yield d, os.path.join(d, ".git")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _vendor_contract(repo_dir: str, contract_toml: str) -> None:
    contract_dir = os.path.join(repo_dir, ".gitsheets/contracts/example.com/people")
    os.makedirs(contract_dir, exist_ok=True)
    with open(os.path.join(contract_dir, "v1.toml"), "w") as fh:
        fh.write(contract_toml)
    _git(["add", ".gitsheets/contracts"], cwd=repo_dir)
    _git(["commit", "-q", "-m", "vendor contract"], cwd=repo_dir)


def test_implements_naming_an_absent_contract_is_contract_missing(repo_with_implements):
    d, git_dir = repo_with_implements
    with gitsheets.transact(
        git_dir, "open", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main"
    ) as tx:
        with pytest.raises(gitsheets.ContractError) as ei:
            tx.open_sheet("people", ".gitsheets/people.toml")
    err = ei.value
    assert err.code == "contract_missing"
    assert err.gitsheets_class == "ContractError"


def test_document_requirement_violation_is_contract_invalid(repo_with_implements):
    d, git_dir = repo_with_implements
    # $id mismatched against the derived path.
    bad = _canonical_toml({"$id": "https://example.com/people/v2", "type": "object"})
    _vendor_contract(d, bad)
    with gitsheets.transact(
        git_dir, "open", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main"
    ) as tx:
        with pytest.raises(gitsheets.ContractError) as ei:
            tx.open_sheet("people", ".gitsheets/people.toml")
    err = ei.value
    assert err.code == "contract_invalid"
    assert "$id" in str(err)


def test_contract_required_field_missing_names_the_contract(repo_with_implements):
    d, git_dir = repo_with_implements
    _vendor_contract(d, CONFORMING_CONTRACT)
    with gitsheets.transact(
        git_dir, "bad write", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main"
    ) as tx:
        tx.open_sheet("people", ".gitsheets/people.toml")
        with pytest.raises(gitsheets.ValidationError) as ei:
            tx.upsert("people", {"slug": "jane"})  # missing `email`
    err = ei.value
    assert err.code == "validation_failed"
    required_issue = next(i for i in err.issues if i["code"] == "required")
    assert required_issue["contract"] == CONTRACT_NAME

    # A conforming write, with an extra local field the contract never
    # mentions, succeeds.
    with gitsheets.transact(
        git_dir, "good write", 1_700_000_001, author=("J", "j@x.org"), branch="refs/heads/main"
    ) as tx:
        tx.open_sheet("people", ".gitsheets/people.toml")
        tx.upsert("people", {"slug": "jane", "email": "jane@x.org", "extra": "z"})
    assert tx.result["commit_hash"]


def test_canonical_contract_hash_agrees_across_data_json_and_toml():
    data = {"$id": f"https://{CONTRACT_NAME}", "type": "object"}
    json_text = json.dumps(data)
    toml_text = f"'$id' = 'https://{CONTRACT_NAME}'\ntype = 'object'\n"

    from_data = gitsheets.canonical_contract_hash(data)
    from_json = gitsheets.canonical_contract_hash(json_text, format="json")
    from_toml = gitsheets.canonical_contract_hash(toml_text, format="toml")

    assert from_data == from_json == from_toml
    assert len(from_data) == 64


def test_canonical_contract_hash_requires_a_format_for_string_input():
    with pytest.raises(ValueError, match="format"):
        gitsheets.canonical_contract_hash("a = 1\n")


# ── verify_sheet_contract: the two-rung consumer verification ladder ────────
#
# Mirrors rust/gitsheets-napi/test/contracts.mjs's `verifySheetContract` suite
# — same fixtures, same five cases (rung-1 zero-record-read pass, rung-1 miss
# falling through to a rung-2 pass, a rung-2 failure's per-record issues,
# `declared` mode's fail-fast, `structural` mode's duck typing).

NO_IMPLEMENTS = "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n"


@contextlib.contextmanager
def _setup_repo(sheet_config: str, contract_toml: str | None = None, contract_name: str = CONTRACT_NAME):
    """A repo with `.gitsheets/people.toml` (`sheet_config`) committed on
    `main`. When `contract_toml` is given, also vendors it at
    `contract_name`'s derived path in the same commit. Yields
    `(repo_dir, git_dir)`; cleans up the tempdir on exit."""
    d = tempfile.mkdtemp(prefix="gitsheets-py-contracts-")
    try:
        _git(["init", "-q", "-b", "main", d])
        _git(["config", "user.name", "Seed"], cwd=d)
        _git(["config", "user.email", "seed@x.org"], cwd=d)
        os.makedirs(os.path.join(d, ".gitsheets"), exist_ok=True)
        with open(os.path.join(d, ".gitsheets", "people.toml"), "w") as fh:
            fh.write(sheet_config)
        _git(["add", ".gitsheets/people.toml"], cwd=d)
        if contract_toml is not None:
            path = os.path.join(d, ".gitsheets", "contracts", f"{contract_name}.toml")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as fh:
                fh.write(contract_toml)
            _git(["add", ".gitsheets/contracts"], cwd=d)
        _git(["commit", "-q", "-m", "init"], cwd=d)
        yield d, os.path.join(d, ".git")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _write_record(repo_dir: str, root: str, slug: str, fields: dict) -> None:
    rd = os.path.join(repo_dir, root)
    os.makedirs(rd, exist_ok=True)
    with open(os.path.join(rd, f"{slug}.toml"), "w") as fh:
        fh.write(gitsheets.serialize_records([{"slug": slug, **fields}])[0])


def _write_garbage(repo_dir: str, root: str, slug: str) -> None:
    rd = os.path.join(repo_dir, root)
    os.makedirs(rd, exist_ok=True)
    with open(os.path.join(rd, f"{slug}.toml"), "w") as fh:
        fh.write("not [ valid toml")


def _consumer_doc(name: str, required: list) -> dict:
    return {
        "$id": f"https://{name}",
        "type": "object",
        "required": required,
        "properties": {field: {"type": "string"} for field in required},
    }


def test_verify_rung1_passes_with_zero_record_reads():
    with _setup_repo(SHEET_WITH_IMPLEMENTS, CONFORMING_CONTRACT) as (d, git_dir):
        # A garbage record that would blow up `Sheet.list` if rung 1 ever fell
        # through to reading records — proves the zero-record-read claim.
        _write_garbage(d, "people", "garbage")
        _git(["add", "people"], cwd=d)
        _git(["commit", "-q", "-m", "garbage"], cwd=d)

        doc = _consumer_doc(CONTRACT_NAME, ["email"])
        report = gitsheets.verify_sheet_contract(git_dir, "HEAD", "people", doc)
        assert report["name"] == CONTRACT_NAME
        assert report["rung"] == "declared"
        assert report["conforming"] is True
        assert report["issues"] == []


def test_verify_rung1_miss_on_newer_producer_version_falls_through_to_rung2_pass():
    name_v1_1 = "example.com/people/v1.1"
    sheet_config = (
        "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n"
        f"implements = ['{name_v1_1}']\n"
    )
    contract_v1_1 = _canonical_toml(_consumer_doc(name_v1_1, ["email"]))
    with _setup_repo(sheet_config, contract_v1_1, contract_name=name_v1_1) as (d, git_dir):
        _write_record(d, "people", "jane", {"email": "jane@x.org"})
        _git(["add", "people"], cwd=d)
        _git(["commit", "-q", "-m", "add jane"], cwd=d)

        # The consumer still holds v1 — a rung-1 miss (name not declared) that
        # falls through to a rung-2 pass (the data satisfies v1 too).
        doc_v1 = _consumer_doc(CONTRACT_NAME, ["email"])
        report = gitsheets.verify_sheet_contract(git_dir, "HEAD", "people", doc_v1)
        assert report["rung"] == "structural"
        assert report["conforming"] is True


def test_verify_rung2_failure_reports_record_and_field_issues():
    with _setup_repo(NO_IMPLEMENTS) as (d, git_dir):  # contract-unaware
        _write_record(d, "people", "jane", {"email": "jane@x.org"})
        _write_record(d, "people", "bob", {})  # missing email
        _git(["add", "people"], cwd=d)
        _git(["commit", "-q", "-m", "add people"], cwd=d)

        doc = _consumer_doc(CONTRACT_NAME, ["email"])
        with pytest.raises(gitsheets.ContractError) as ei:
            gitsheets.verify_sheet_contract(git_dir, "HEAD", "people", doc)
        err = ei.value
        assert err.code == "contract_unsatisfied"
        assert err.contract == CONTRACT_NAME
        issue = next(i for i in err.issues if i["record"] == "bob")
        assert issue["contract"] == CONTRACT_NAME
        assert issue["code"] == "required"
        assert not any(i["record"] == "jane" for i in err.issues)


def test_verify_declared_mode_fails_fast_without_reading_records():
    with _setup_repo(NO_IMPLEMENTS) as (d, git_dir):  # not declared
        _write_garbage(d, "people", "garbage")
        _git(["add", "people"], cwd=d)
        _git(["commit", "-q", "-m", "garbage"], cwd=d)

        doc = _consumer_doc(CONTRACT_NAME, ["email"])
        with pytest.raises(gitsheets.ContractError) as ei:
            gitsheets.verify_sheet_contract(git_dir, "HEAD", "people", doc, mode="declared")
        err = ei.value
        assert err.code == "contract_unsatisfied"
        # Declared mode never scans records, so there are no per-record
        # issues — `raise_core_error` only sets `.issues` when non-empty (the
        # same convention every other typed exception follows).
        assert getattr(err, "issues", []) == []


def test_verify_structural_mode_duck_types_a_contract_unaware_sheet():
    with _setup_repo(NO_IMPLEMENTS) as (d, git_dir):  # no implements at all
        _write_record(d, "people", "jane", {"email": "jane@x.org"})
        _git(["add", "people"], cwd=d)
        _git(["commit", "-q", "-m", "add jane"], cwd=d)

        doc = _consumer_doc(CONTRACT_NAME, ["email"])
        report = gitsheets.verify_sheet_contract(git_dir, "HEAD", "people", doc, mode="structural")
        assert report["rung"] == "structural"
        assert report["conforming"] is True
