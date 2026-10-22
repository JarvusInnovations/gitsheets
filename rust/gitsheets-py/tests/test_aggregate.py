"""Ad-hoc aggregation from the Python binding (specs/behaviors/aggregation.md).

``record_aggregate`` mirrors ``record_query``'s batch shape plus the sheet name
and an ``aggregates`` dict. The fold runs in the shared core, so the headline
assertion is the cross-binding one: the same fixture repo aggregated from Node
and from Python serializes to identical canonical TOML. The Node side runs via
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

TEMPLATE = "${{ postedAt: YYYY/MM }}/${{ id }}"
UTC = dt.timezone.utc

LEDGER = [
    {"id": "a", "postedAt": dt.datetime(2026, 1, 5, tzinfo=UTC), "status": "posted", "amountCents": 1000, "rate": 0.1},
    {"id": "b", "postedAt": dt.datetime(2026, 1, 20, tzinfo=UTC), "status": "posted", "amountCents": 2500, "rate": 0.2},
    {"id": "c", "postedAt": dt.datetime(2026, 2, 10, tzinfo=UTC), "status": "pending", "amountCents": -500, "rate": 0.3},
    {"id": "d", "postedAt": dt.datetime(2026, 2, 11, tzinfo=UTC), "status": "void", "amountCents": 7},
    {"id": "z", "postedAt": dt.datetime(2025, 12, 31, tzinfo=UTC), "status": "posted", "amountCents": 99, "rate": 9.5},
]

# Mirrored in _node_writer.mjs (AGGREGATE_SPEC) — keep the two in lockstep.
AGGREGATE_SPEC = {
    "n": {"count": True},
    "total": {"sum": "amountCents"},
    "rate": {"sum": "rate"},
    "meanRate": {"avg": "rate"},
    "lo": {"min": "amountCents"},
    "latest": {"max": "postedAt"},
    "firstId": {"min": "id"},
    "statuses": {"distinct": "status"},
    "byStatus": {"count": True, "groupBy": "status"},
    "rateByStatus": {"sum": "rate", "groupBy": "status"},
    "posted": {"sum": "amountCents", "where": {"status": "posted"}},
    "order": {"reduce": "return acc + record.id;", "initial": ""},
    "stats": {
        "reduce": "acc.n += 1; acc.cents += record.amountCents; acc.ids.push(record.id); return acc;",
        "initial": {"n": 0, "cents": 0, "ids": []},
        "finalize": "return { mean: acc.cents / acc.n, ids: acc.ids, third: 1 / 3 };",
    },
}

FILTER = {"postedAt": {"$gte": "2026-01-01"}}


def _git(args, cwd=None):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def _path(r):
    return f"{r['postedAt'].year}/{r['postedAt'].month:02d}/{r['id']}"


@pytest.fixture()
def ledger():
    d = tempfile.mkdtemp(prefix="gs-agg-")
    try:
        _git(["init", "-q", d])
        git_dir = os.path.join(d, ".git")
        res = gitsheets.record_write(
            git_dir, gitsheets.EMPTY_TREE_HASH, "ledger", [_path(r) for r in LEDGER], LEDGER
        )
        yield git_dir, res["tree_hash"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _agg(git_dir, tree, aggregates, filter=None, **kw):
    return gitsheets.record_aggregate(
        git_dir, tree, "ledger", "ledger", TEMPLATE, filter if filter is not None else {}, aggregates, **kw
    )


def test_every_form_over_the_filtered_set(ledger):
    r = _agg(*ledger, AGGREGATE_SPEC, FILTER)
    assert r["n"] == 4
    assert r["total"] == 3007 and isinstance(r["total"], int)
    assert r["rate"] == 0.0 + 0.1 + 0.2 + 0.3
    assert r["meanRate"] == (0.0 + 0.1 + 0.2 + 0.3) / 3
    assert r["lo"] == -500
    assert r["latest"] == dt.datetime(2026, 2, 11, tzinfo=UTC)
    assert r["firstId"] == "a"
    assert r["statuses"] == ["pending", "posted", "void"]
    assert r["byStatus"] == {"pending": 1, "posted": 2, "void": 1}
    # `void` (d) carries no rate → not a group of the sum.
    assert r["rateByStatus"] == {"pending": 0.3, "posted": 0.0 + 0.1 + 0.2}
    assert r["posted"] == 3500
    assert r["order"] == "abcd"
    assert r["stats"] == {"mean": 3007 / 4, "ids": ["a", "b", "c", "d"], "third": 1 / 3}


def test_omission_rules(ledger):
    r = _agg(
        *ledger,
        {"n": {"count": True}, "t": {"sum": "amountCents"}, "m": {"max": "rate"}, "g": {"count": True, "groupBy": "status"}},
        {"status": "nope"},
    )
    assert r == {"n": 0, "t": 0, "g": {}}


def test_paths_restrict_the_contributing_set(ledger):
    r = _agg(*ledger, {"order": {"reduce": "return acc + record.id;", "initial": ""}}, paths=["2026/02/c", "2025/12/z"])
    assert r == {"order": "zc"}


@pytest.mark.parametrize(
    "aggregates",
    [
        {"x": {"count": False}},
        {"x": {"sum": "a", "max": "b"}},
        {"x": {"reduce": "return acc;"}},
        {"x": {"reduce": "return (", "initial": 0}},
        {"x": {"count": True, "where": {"a": {"$in": 1}}}},
        {"x": {"count": True, "groupBy": 3}},
        "nope",
    ],
)
def test_malformed_spec_raises_type_error(ledger, aggregates):
    with pytest.raises(TypeError):
        _agg(*ledger, aggregates)


def test_body_field_reference_raises_type_error(ledger):
    with pytest.raises(TypeError):
        _agg(*ledger, {"x": {"distinct": "body"}}, extension=".md", body_field="body")


@pytest.mark.parametrize(
    "aggregates",
    [
        {"bad": {"reduce": "throw new Error('boom');", "initial": 0}},
        {"bad": {"reduce": "return undefined;", "initial": 0}},
        {"bad": {"max": "mixed"}},
    ],
)
def test_data_dependent_failure_raises_aggregation_error(ledger, aggregates):
    git_dir, tree = ledger
    mixed = gitsheets.record_write(
        git_dir, tree, "ledger", ["2026/01/a", "2026/01/b"],
        [dict(LEDGER[0], mixed=1), dict(LEDGER[1], mixed="one")],
    )["tree_hash"]
    with pytest.raises(gitsheets.AggregationError) as info:
        _agg(git_dir, mixed, aggregates)
    err = info.value
    assert isinstance(err, gitsheets.GitsheetsError)
    assert err.code == "aggregation_failed"
    assert err.status == 422
    assert err.sheet == "ledger"
    assert err.aggregate == "bad"
    assert err.partition is None


def _napi_built() -> bool:
    if shutil.which("node") is None or not os.path.exists(_NAPI_BINDING):
        return False
    return any(f.endswith(".node") for f in os.listdir(_NAPI_DIR))


@pytest.mark.skipif(not _napi_built(), reason="napi addon not built (run `npm run build` in rust/gitsheets-napi)")
def test_aggregate_results_byte_identical_across_bindings(ledger):
    """Node and Python aggregate the same repo to the same canonical TOML bytes.

    The fixture keeps every float result non-integral: the Node binding
    surfaces numbers as JS ``number``, so an integral float would come back
    across its boundary as an integer before serialization (a host-projection
    limit, not a core divergence).
    """
    git_dir, tree = ledger
    py_toml = gitsheets.serialize_records([_agg(git_dir, tree, AGGREGATE_SPEC, FILTER)])[0]
    env = dict(os.environ, GITSHEETS_NAPI_BINDING=_NAPI_BINDING)
    proc = subprocess.run(
        ["node", _NODE_WRITER, "aggregate", git_dir, tree], capture_output=True, env=env, cwd=_HERE
    )
    assert proc.returncode == 0, proc.stderr.decode()
    node_toml = json.loads(proc.stdout.decode())["toml"]
    assert py_toml == node_toml, "aggregate results diverged across bindings"
