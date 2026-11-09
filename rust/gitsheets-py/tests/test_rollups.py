"""Rollup sheets from the Python binding (specs/behaviors/rollups.md).

The commit-time rollup pass lives in the shared core transaction, so a Python
``transact`` maintains rollups with no extra call. The headline assertion is
the cross-binding one: the same ledger committed from Python and from Node
over the same seed yields byte-identical commits — records *and* rollup
blobs. The explicit surface is ``record_query(sheet=…, stale=…)``,
``rollup_status``, ``Transaction.materialize_rollups``, and the error mapping
(``TransactionError`` ``sheet_derived``, ``AggregationError`` with
``partition``, ``ConfigError`` at open). The Node side runs through
``_node_writer.mjs`` and is skipped when the napi addon isn't built.
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

UTC = dt.timezone.utc

TX_CONFIG = "[gitsheet]\nroot = 'transactions'\npath = '${{ postedAt: YYYY/MM }}/${{ id }}'\n"
MONTHLY = """[gitsheet]
root = 'transactions-monthly'
path = '${{ postedAt: YYYY/MM }}'

[gitsheet.rollup]
from = 'transactions'

[gitsheet.rollup.aggregates]
count = { count = true }
total = { sum = 'amountCents' }
rate = { sum = 'rate' }
meanRate = { avg = 'rate' }
latest = { max = 'postedAt' }
statuses = { distinct = 'status' }
byStatus = { sum = 'amountCents', groupBy = 'status' }
ids = { reduce = 'acc.push(record.id); return acc;', initial = [] }
"""
TOTALS = """[gitsheet]
root = 'totals'
path = 'all'

[gitsheet.rollup]
from = 'transactions'

[gitsheet.rollup.aggregates]
n = { count = true }
stats = { reduce = 'acc.cents += record.amountCents; acc.n += 1; return acc;', initial = { cents = 0, n = 0 }, finalize = 'return { mean: acc.cents / acc.n, third: 1 / 3, epoch: new Date(0) };' }
"""

# Mirrored in _node_writer.mjs (ROLLUP_LEDGER) — keep the two in lockstep.
LEDGER = [
    {"id": "a", "postedAt": dt.datetime(2026, 1, 5, tzinfo=UTC), "status": "posted", "amountCents": 1000, "rate": 0.1},
    {"id": "b", "postedAt": dt.datetime(2026, 1, 20, tzinfo=UTC), "status": "posted", "amountCents": 2500, "rate": 0.2},
    {"id": "c", "postedAt": dt.datetime(2026, 2, 10, tzinfo=UTC), "status": "pending", "amountCents": -500, "rate": 0.3},
    {"id": "k-1", "postedAt": dt.datetime(2026, 2, 11, tzinfo=UTC), "status": "void", "amountCents": 7, "rate": 0.7},
    {"id": "k", "postedAt": dt.datetime(2026, 2, 12, tzinfo=UTC), "status": "posted", "amountCents": 99, "rate": 9.5},
]

_ENV = dict(
    os.environ,
    GIT_AUTHOR_NAME="Seed",
    GIT_AUTHOR_EMAIL="seed@x.org",
    GIT_COMMITTER_NAME="Seed",
    GIT_COMMITTER_EMAIL="seed@x.org",
    GIT_AUTHOR_DATE="2020-01-01T00:00:00Z",
    GIT_COMMITTER_DATE="2020-01-01T00:00:00Z",
)


def _git(args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, env=_ENV).stdout.decode()


def _napi_built() -> bool:
    if shutil.which("node") is None or not os.path.exists(_NAPI_BINDING):
        return False
    return any(f.endswith(".node") for f in os.listdir(_NAPI_DIR))


def _run_node(*args) -> dict:
    env = dict(os.environ, GITSHEETS_NAPI_BINDING=_NAPI_BINDING)
    proc = subprocess.run(["node", _NODE_WRITER, *args], capture_output=True, env=env, cwd=_HERE)
    if proc.returncode != 0:
        raise AssertionError(f"node helper failed: {proc.stderr.decode()}")
    return json.loads(proc.stdout.decode())


def _seed(extra: dict[str, str] | None = None) -> str:
    """A repo on `main` whose seed commit declares the sheets (plain git)."""
    d = tempfile.mkdtemp(prefix="gs-roll-") + "/repo"
    os.makedirs(os.path.join(d, ".gitsheets"))
    _git(["init", "-q", "-b", "main", d], cwd=os.path.dirname(d))
    files = {"transactions": TX_CONFIG, "transactions-monthly": MONTHLY, "totals": TOTALS, **(extra or {})}
    for name, text in files.items():
        with open(os.path.join(d, ".gitsheets", f"{name}.toml"), "w") as fh:
            fh.write(text)
    _git(["add", "."], cwd=d)
    _git(["commit", "-q", "-m", "init"], cwd=d)
    return d


def _commit_ledger(git_dir: str, ledger=LEDGER) -> dict:
    with gitsheets.transact(
        git_dir, "ledger", 1_700_000_000, author=("Jane Doe", "jane@x.org"), branch="refs/heads/main"
    ) as tx:
        tx.open_sheet("transactions", ".gitsheets/transactions.toml")
        for r in ledger:
            tx.upsert("transactions", r)
    return tx.result  # type: ignore[attr-defined]


@pytest.fixture()
def repo():
    d = _seed()
    try:
        yield d
    finally:
        shutil.rmtree(os.path.dirname(d), ignore_errors=True)


def test_python_commits_carry_rollups(repo):
    git_dir = os.path.join(repo, ".git")
    _commit_ledger(git_dir)
    feb = _git(["show", "HEAD:transactions-monthly/2026/02.toml"], repo)
    stamp = _git(["rev-parse", "HEAD:transactions/2026/02"], repo).strip()
    assert f'sourceTree = "{stamp}"' in feb
    assert "count = 3\n" in feb
    assert "postedAt = 2026-02-01\n" in feb
    # Canonical path order: k-1.toml sorts before k.toml.
    assert 'ids = ["c", "k-1", "k"]' in feb
    totals = _git(["show", "HEAD:totals/all.toml"], repo)
    assert "n = 5\n" in totals
    assert "epoch = 1970-01-01T00:00:00.000Z" in totals or "epoch = 1970-01-01T00:00:00Z" in totals


@pytest.mark.skipif(not _napi_built(), reason="napi addon not built (run `npm run build` in rust/gitsheets-napi)")
def test_rollup_commit_bytes_identical_across_bindings():
    seed = _seed()
    py_dir = tempfile.mkdtemp(prefix="gs-py-") + "/repo"
    node_dir = tempfile.mkdtemp(prefix="gs-node-") + "/repo"
    try:
        shutil.copytree(seed, py_dir)
        shutil.copytree(seed, node_dir)
        py = _commit_ledger(os.path.join(py_dir, ".git"))
        node = _run_node("commit-rollups", os.path.join(node_dir, ".git"))
        for path in [
            "transactions-monthly/2026/01.toml",
            "transactions-monthly/2026/02.toml",
            "totals/all.toml",
        ]:
            assert _git(["rev-parse", f"HEAD:{path}"], py_dir) == _git(["rev-parse", f"HEAD:{path}"], node_dir), path
        assert py["tree_hash"] == node["treeHash"], "rollup trees diverged across bindings"
        assert py["commit_hash"] == node["commitHash"], "rollup commits diverged across bindings"

        # The read-through agrees too, on a stale tree (a raw commit the pass
        # never saw).
        for d in (py_dir, node_dir):
            os.makedirs(os.path.join(d, "transactions", "2026", "02"), exist_ok=True)
            _git(["reset", "-q", "--hard"], d)
            with open(os.path.join(d, "transactions", "2026", "02", "z.toml"), "w") as fh:
                fh.write('amountCents = 1\nid = "z"\npostedAt = 2026-02-28T00:00:00Z\nrate = 0.05\nstatus = "posted"\n')
            _git(["add", "."], d)
            _git(["commit", "-q", "-m", "raw"], d)
        py_rows = gitsheets.record_query(
            os.path.join(py_dir, ".git"), "HEAD", "", "", {}, sheet="transactions-monthly"
        )
        node_rows = _run_node("rollup-query", os.path.join(node_dir, ".git"), "HEAD", "transactions-monthly")["rows"]
        assert [r["path"] for r in py_rows] == [r["path"] for r in node_rows]
        assert gitsheets.serialize_records([r["record"] for r in py_rows]) == [r["toml"] for r in node_rows]
    finally:
        for d in (seed, py_dir, node_dir):
            shutil.rmtree(os.path.dirname(d), ignore_errors=True)


def test_stale_reads_status_and_materialize(repo):
    git_dir = os.path.join(repo, ".git")
    _commit_ledger(git_dir)
    _git(["reset", "-q", "--hard"], repo)
    _git(["rm", "-q", "transactions/2026/01/a.toml", "transactions/2026/01/b.toml"], repo)
    with open(os.path.join(repo, "transactions", "2026", "02", "z.toml"), "w") as fh:
        fh.write('amountCents = 1\nid = "z"\npostedAt = 2026-02-28T00:00:00Z\nrate = 0.05\nstatus = "posted"\n')
    _git(["add", "."], repo)
    _git(["commit", "-q", "-m", "raw"], repo)

    rows = gitsheets.record_query(git_dir, "HEAD", "", "", {}, sheet="transactions-monthly")
    assert [r["path"] for r in rows] == ["2026/02"]  # orphaned January not yielded
    assert rows[0]["record"]["count"] == 4
    served = gitsheets.record_query(git_dir, "HEAD", "", "", {}, sheet="transactions-monthly", stale="serve")
    assert [r["record"]["count"] for r in served] == [2, 3]
    ranged = gitsheets.record_query(
        git_dir, "HEAD", "", "", {"postedAt": {"$gte": "2026-02-01"}}, sheet="transactions-monthly"
    )
    assert [r["path"] for r in ranged] == ["2026/02"]

    assert gitsheets.rollup_status(git_dir, "HEAD", "transactions-monthly") == [
        {"path": "2026/01", "status": "orphaned"},
        {"path": "2026/02", "status": "stale"},
    ]
    with gitsheets.transact(git_dir, "repair", 1_700_000_100, author=("J", "j@x.org"), branch="refs/heads/main") as tx:
        tx.open_sheet("transactions-monthly", ".gitsheets/transactions-monthly.toml")
        out = tx.materialize_rollups("transactions-monthly")
    assert out == {"recomputed": ["2026/02"], "deleted": ["2026/01"]}
    assert tx.result["commit_hash"] is not None  # type: ignore[attr-defined]
    assert gitsheets.rollup_status(git_dir, "HEAD", "transactions-monthly") == []

    # Fresh: no commit.
    with gitsheets.transact(git_dir, "noop", 1_700_000_200, author=("J", "j@x.org"), branch="refs/heads/main") as tx:
        tx.open_sheet("transactions-monthly", ".gitsheets/transactions-monthly.toml")
        assert tx.materialize_rollups("transactions-monthly") == {"recomputed": [], "deleted": []}
    assert tx.result["commit_hash"] is None  # type: ignore[attr-defined]


def test_errors_map_to_the_python_taxonomy(repo):
    git_dir = os.path.join(repo, ".git")
    _commit_ledger(git_dir)
    with pytest.raises(gitsheets.TransactionError) as e:
        with gitsheets.transact(git_dir, "x", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main") as tx:
            tx.open_sheet("transactions-monthly", ".gitsheets/transactions-monthly.toml")
            tx.upsert("transactions-monthly", {"postedAt": "2026-03-01", "count": 1})
    assert e.value.code == "sheet_derived"

    with pytest.raises(TypeError):
        with gitsheets.transact(git_dir, "x", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main") as tx:
            tx.open_sheet("transactions", ".gitsheets/transactions.toml")
            tx.materialize_rollups("transactions")
    with pytest.raises(TypeError):
        gitsheets.rollup_status(git_dir, "HEAD", "transactions")
    with pytest.raises(TypeError):
        gitsheets.record_query(git_dir, "HEAD", "", "", {}, stale="serve")


def test_aggregation_error_names_the_partition_and_aborts():
    bad = MONTHLY.replace("latest = { max = 'postedAt' }", "latest = { max = 'note' }")
    d = _seed({"transactions-monthly": bad})
    try:
        git_dir = os.path.join(d, ".git")
        before = _git(["rev-parse", "HEAD"], d)
        ledger = [dict(LEDGER[0], note="x"), dict(LEDGER[1], note=5)]
        with pytest.raises(gitsheets.AggregationError) as e:
            _commit_ledger(git_dir, ledger)
        assert e.value.code == "aggregation_failed"
        assert e.value.sheet == "transactions-monthly"
        assert e.value.aggregate == "latest"
        assert e.value.partition == "2026/01"
        assert _git(["rev-parse", "HEAD"], d) == before
    finally:
        shutil.rmtree(os.path.dirname(d), ignore_errors=True)


def test_reduce_cannot_read_the_clock():
    clock = TOTALS.replace("return { mean: acc.cents / acc.n, third: 1 / 3, epoch: new Date(0) };", "return Date.now();")
    d = _seed({"totals": clock})
    try:
        with pytest.raises(gitsheets.AggregationError):
            _commit_ledger(os.path.join(d, ".git"))
    finally:
        shutil.rmtree(os.path.dirname(d), ignore_errors=True)


def test_a_bad_rollup_config_is_a_config_error_at_open():
    bad = "[gitsheet]\nroot = 'bad'\npath = '${{ id }}'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\nn = { count = true }\n"
    d = _seed({"bad": bad})
    try:
        git_dir = os.path.join(d, ".git")
        with pytest.raises(gitsheets.ConfigError) as e:
            gitsheets.rollup_status(git_dir, "HEAD", "bad")
        assert e.value.code == "config_invalid"
        with pytest.raises(gitsheets.ConfigError):
            with gitsheets.transact(git_dir, "x", 1_700_000_000, author=("J", "j@x.org"), branch="refs/heads/main") as tx:
                tx.open_sheet("bad", ".gitsheets/bad.toml")
    finally:
        shutil.rmtree(os.path.dirname(d), ignore_errors=True)
