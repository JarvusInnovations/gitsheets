"""Commit-shape options from Python (specs/api/python-binding.md "Commit
shape"): also_parents, replace, allow_empty, commit_read, the new codes."""

from __future__ import annotations

import os
import subprocess
import tempfile

import pytest

import gitsheets


# A fixed identity: CI runners have no git config user.
_ENV = dict(
    os.environ,
    GIT_AUTHOR_NAME="S",
    GIT_AUTHOR_EMAIL="s@x.org",
    GIT_COMMITTER_NAME="S",
    GIT_COMMITTER_EMAIL="s@x.org",
)


def _git(cwd, *args) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, env=_ENV).stdout.decode().strip()


@pytest.fixture()
def repo():
    d = tempfile.mkdtemp(prefix="gs-shape-")
    _git(d, "init", "-q", "-b", "main")
    _git(d, "-c", "user.name=S", "-c", "user.email=s@x.org", "commit", "-q", "--allow-empty", "-m", "init")
    yield d


def _tx(git_dir, message, **kw):
    with gitsheets.transact(git_dir, message, 1_700_000_000, author=("Loop", "loop@x.org"), **kw) as tx:
        pass
    return tx.result


def test_extra_parent_empty_commit_and_commit_read(repo):
    gd = os.path.join(repo, ".git")
    base = _git(repo, "rev-parse", "HEAD")
    other = _git(repo, "commit-tree", "-m", "other", "4b825dc642cb6eb9a060e54bf8d69288fbee4904")
    r = _tx(gd, "cycle 1\n\nbody", trailers=[("State", "0")], also_parents=[other], allow_empty=True)
    assert r["commit_hash"] is not None
    info = gitsheets.commit_read(gd)
    assert info["hash"] == r["commit_hash"]
    assert info["branch"] == "refs/heads/main"
    assert info["parents"] == [base, other]
    assert info["subject"] == "cycle 1"
    assert info["body"] == "body"
    assert info["trailers"][0] == {"key": "State", "value": "0"}
    assert set(info["author"]) == {"name", "email", "date"}
    assert gitsheets.commit_read(gd, base)["branch"] is None


def test_replace_and_its_errors(repo):
    gd = os.path.join(repo, ".git")
    base = _git(repo, "rev-parse", "HEAD")
    first = _tx(gd, "a", allow_empty=True)["commit_hash"]
    with pytest.raises(gitsheets.TransactionError) as e:
        _tx(gd, "x", replace=base, allow_empty=True)
    assert e.value.code == "tip_mismatch"
    assert e.value.expected == base and e.value.actual == first
    r = _tx(gd, "a reworded", replace=first, allow_empty=True)
    assert r["replaced_commit_hash"] == first
    assert _git(repo, "rev-parse", "HEAD~1") == base
    _git(repo, "update-ref", "refs/remotes/origin/main", r["commit_hash"])
    with pytest.raises(gitsheets.TransactionError) as e:
        _tx(gd, "x", replace=r["commit_hash"], allow_empty=True)
    assert e.value.code == "tip_published"


def test_bad_inputs(repo):
    gd = os.path.join(repo, ".git")
    with pytest.raises(gitsheets.TransactionError) as e:
        _tx(gd, "x", trailers=[("bad key", "v")], allow_empty=True)
    assert e.value.code == "trailer_invalid"
    with pytest.raises(gitsheets.RefError) as e:
        _tx(gd, "x", also_parents=["1234567890123456789012345678901234567890"], allow_empty=True)
    assert e.value.code == "parent_not_found"


def test_commit_read_unborn_is_none():
    d = tempfile.mkdtemp(prefix="gs-unborn-")
    _git(d, "init", "-q", "-b", "main")
    assert gitsheets.commit_read(os.path.join(d, ".git")) is None
