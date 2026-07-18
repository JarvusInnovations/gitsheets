"""The headline deliverable: cross-binding byte-identical proof.

A record written via the **Python** binding and the same logical record written
via the **Node** (napi) binding — both over the same `gitsheets-core` — must
produce byte-identical trees, blobs, and commits. If these ever diverge it means
something binding-specific leaked into the on-disk bytes (a bytes-authority
leak), which is exactly the failure this binding exists to catch.

The Node side is driven through `_node_writer.mjs` (the napi binding). It is
skipped if the napi addon isn't built or `node` is unavailable; CI builds the
addon so the proof runs for real there.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import subprocess
import tempfile

import pytest

import gitsheets

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_WRITER = os.path.join(_HERE, "_node_writer.mjs")
_NAPI_DIR = os.path.abspath(os.path.join(_HERE, "..", "..", "gitsheets-napi"))
_NAPI_BINDING = os.path.join(_NAPI_DIR, "binding.cjs")


def _napi_built() -> bool:
    if shutil.which("node") is None or not os.path.exists(_NAPI_BINDING):
        return False
    # The compiled addon is gitsheets-core.<triple>.node next to index.js.
    return any(f.endswith(".node") for f in os.listdir(_NAPI_DIR))


pytestmark = pytest.mark.skipif(
    not _napi_built(),
    reason="napi addon not built (run `npm run build` in rust/gitsheets-napi)",
)


def _run_node(*args) -> dict:
    env = dict(os.environ, GITSHEETS_NAPI_BINDING=_NAPI_BINDING)
    proc = subprocess.run(
        ["node", _NODE_WRITER, *args], capture_output=True, env=env, cwd=_HERE
    )
    if proc.returncode != 0:
        raise AssertionError(f"node helper failed: {proc.stderr.decode()}")
    return json.loads(proc.stdout.decode())


def _git(args, cwd=None):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


# Fixtures mirrored from _node_writer.mjs — the same logical data in Python
# natives. The byte-identity is the assertion.
PY_FIXTURES = {
    "basic": {"email": "jane@x.org", "slug": "jane", "tags": ["a", "b"], "age": 30},
    "typed": {
        "slug": "jane",
        "count": 7,
        "ratio": 1.5,
        "when": dt.datetime(2026, 6, 26, 12, 0, 0, tzinfo=dt.timezone.utc),
    },
    # Nullish keys are dropped at the marshal boundary in every binding (the
    # 1.x drop semantics, #232). The JS side also carries `bio: undefined`,
    # which Python expresses by never setting the key — same bytes either way.
    "nullish": {
        "slug": "jane",
        "middleName": None,
        "contact": {"email": "jane@x.org", "phone": None},
        "roles": [{"title": "chair", "until": None}],
    },
}


@pytest.mark.parametrize("fixture", ["basic", "typed", "nullish"])
def test_tree_and_blob_bytes_identical_across_bindings(fixture):
    """record_write from Python and Node yields identical tree + blob hashes."""
    py_dir = tempfile.mkdtemp(prefix="gs-py-")
    node_dir = tempfile.mkdtemp(prefix="gs-node-")
    try:
        _git(["init", "-q", py_dir])
        _git(["init", "-q", node_dir])
        py = gitsheets.record_write(
            os.path.join(py_dir, ".git"),
            gitsheets.EMPTY_TREE_HASH,
            "people",
            ["jane"],
            [PY_FIXTURES[fixture]],
        )
        node = _run_node("record-write", fixture, os.path.join(node_dir, ".git"))
        assert py["tree_hash"] == node["treeHash"], "tree bytes diverged across bindings"
        assert py["blob_hashes"] == node["blobHashes"], "blob bytes diverged across bindings"
    finally:
        shutil.rmtree(py_dir, ignore_errors=True)
        shutil.rmtree(node_dir, ignore_errors=True)


def test_commit_bytes_identical_across_bindings():
    """A full upsert→commit produces the same commit hash from both bindings.

    Both bindings start from an identical seed commit (the same repo copied), get
    identical author/committer/time/message/trailers + the same record, so the
    resulting commit object must be byte-identical.
    """
    seed = tempfile.mkdtemp(prefix="gs-seed-")
    _git(["init", "-q", "-b", "main", seed])
    _git(["config", "user.name", "Seed"], cwd=seed)
    _git(["config", "user.email", "seed@x.org"], cwd=seed)
    os.makedirs(os.path.join(seed, ".gitsheets"))
    with open(os.path.join(seed, ".gitsheets", "people.toml"), "w") as fh:
        fh.write("[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n")
    _git(["add", ".gitsheets/people.toml"], cwd=seed)
    # Fixed identity + date so the seed commit is reproducible (identical in both
    # copies — guaranteed anyway since we copy the dir).
    env = dict(
        os.environ,
        GIT_AUTHOR_DATE="2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE="2020-01-01T00:00:00Z",
    )
    subprocess.run(
        ["git", "commit", "-q", "-m", "init"], cwd=seed, check=True, capture_output=True, env=env
    )

    py_dir = tempfile.mkdtemp(prefix="gs-py-") + "/repo"
    node_dir = tempfile.mkdtemp(prefix="gs-node-") + "/repo"
    try:
        shutil.copytree(seed, py_dir)
        shutil.copytree(seed, node_dir)

        with gitsheets.transact(
            os.path.join(py_dir, ".git"),
            "people: add jane",
            1_700_000_000,
            offset_minutes=-300,
            author=("Jane Doe", "jane@x.org"),
            branch="refs/heads/main",
            trailers=[("Action", "person.create")],
        ) as tx:
            tx.open_sheet("people", ".gitsheets/people.toml")
            tx.upsert("people", {"slug": "jane", "email": "jane@x.org"})
        py_commit = tx.result["commit_hash"]

        node = _run_node("commit", os.path.join(node_dir, ".git"))

        assert py_commit is not None
        assert py_commit == node["commitHash"], "commit bytes diverged across bindings"
        assert tx.result["tree_hash"] == node["treeHash"]
    finally:
        shutil.rmtree(os.path.dirname(py_dir), ignore_errors=True)
        shutil.rmtree(os.path.dirname(node_dir), ignore_errors=True)
        shutil.rmtree(seed, ignore_errors=True)


def test_attachment_commit_bytes_identical_across_bindings():
    """A record + an attachment staged in one transaction produces the same
    commit from both bindings.

    This is the attachment-staging analogue of the commit-parity proof: the
    record upsert AND the attachment blob are placed into the SAME transaction
    tree (atomic), and the fixed binary attachment content is shared with the
    Node side, so the tree + commit bytes must be byte-identical. If they ever
    diverge, either the blob hashing or the tree placement leaked something
    binding-specific.
    """
    # Fixed binary attachment content — mirrored on the Node side in
    # _node_writer.mjs (commit-attachment op).
    attach_bytes = bytes([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0xFF, 0x2A])

    seed = tempfile.mkdtemp(prefix="gs-seed-")
    _git(["init", "-q", "-b", "main", seed])
    _git(["config", "user.name", "Seed"], cwd=seed)
    _git(["config", "user.email", "seed@x.org"], cwd=seed)
    os.makedirs(os.path.join(seed, ".gitsheets"))
    with open(os.path.join(seed, ".gitsheets", "people.toml"), "w") as fh:
        fh.write("[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n")
    _git(["add", ".gitsheets/people.toml"], cwd=seed)
    env = dict(
        os.environ,
        GIT_AUTHOR_DATE="2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE="2020-01-01T00:00:00Z",
    )
    subprocess.run(
        ["git", "commit", "-q", "-m", "init"], cwd=seed, check=True, capture_output=True, env=env
    )

    py_dir = tempfile.mkdtemp(prefix="gs-py-") + "/repo"
    node_dir = tempfile.mkdtemp(prefix="gs-node-") + "/repo"
    try:
        shutil.copytree(seed, py_dir)
        shutil.copytree(seed, node_dir)

        py_git_dir = os.path.join(py_dir, ".git")
        with gitsheets.transact(
            py_git_dir,
            "people: add jane + avatar",
            1_700_000_000,
            offset_minutes=-300,
            author=("Jane Doe", "jane@x.org"),
            branch="refs/heads/main",
            trailers=[("Action", "person.create")],
        ) as tx:
            tx.open_sheet("people", ".gitsheets/people.toml")
            tx.upsert("people", {"slug": "jane", "email": "jane@x.org"})
            py_blob = gitsheets.write_blob(py_git_dir, attach_bytes)
            tx.set_attachment("people", "jane", "avatar.bin", py_blob)
        py_result = tx.result

        node = _run_node("commit-attachment", os.path.join(node_dir, ".git"))

        assert py_result["commit_hash"] is not None
        assert py_blob == node["blobHash"], "attachment blob bytes diverged across bindings"
        assert py_result["tree_hash"] == node["treeHash"], "tree bytes diverged across bindings"
        assert py_result["commit_hash"] == node["commitHash"], "commit bytes diverged across bindings"
    finally:
        shutil.rmtree(os.path.dirname(py_dir), ignore_errors=True)
        shutil.rmtree(os.path.dirname(node_dir), ignore_errors=True)
        shutil.rmtree(seed, ignore_errors=True)


def test_embedded_engine_comparator_identical_across_bindings():
    """The same definition-embedded JS snippet yields identical results."""
    rule = "return (a.name > b.name) - (a.name < b.name)"
    a = {"name": "amy"}
    b = {"name": "zoe"}
    py = gitsheets.run_comparator(rule, a, b)
    node = _run_node("comparator", rule, json.dumps(a), json.dumps(b))
    assert py == node["result"]


def test_canonical_contract_hash_identical_across_bindings():
    """canonical_contract_hash agrees across Python and Node, and across the
    three input forms (parsed data, JSON text, TOML text) within each binding —
    the identity primitive specs/behaviors/contracts.md builds `contracts-cli`
    and `contracts-consumer-verify` on.
    """
    name = "example.com/c/v1"
    data = {"$id": f"https://{name}", "type": "object"}
    json_text = json.dumps(data)
    toml_text = f"'$id' = 'https://{name}'\ntype = 'object'\n"

    py_data = gitsheets.canonical_contract_hash(data)
    py_json = gitsheets.canonical_contract_hash(json_text, format="json")
    py_toml = gitsheets.canonical_contract_hash(toml_text, format="toml")
    assert py_data == py_json == py_toml

    node_data = _run_node("contract-hash", "data", json.dumps(data))["hash"]
    node_json = _run_node("contract-hash", "json", json_text)["hash"]
    node_toml = _run_node("contract-hash", "toml", toml_text)["hash"]
    assert node_data == node_json == node_toml

    assert py_data == node_data, "contract identity diverged across bindings"
