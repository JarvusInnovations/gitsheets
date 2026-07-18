"""Schema contracts — Python binding surface.

Proves specs/behaviors/contracts.md through the Python binding: `implements`
naming an absent contract fails sheet-open with `ContractError`
(`contract_missing`); a vendored document violating a document requirement
fails with `contract_invalid`, naming the rule; `allOf` composition names the
contract on a failing write and lets a conforming write through;
`canonical_contract_hash` agrees across data/JSON/TOML input.
"""

from __future__ import annotations

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
