"""Default-branch and submodule binding (specs/api/python-binding.md
"Default-branch binding", specs/behaviors/default-branch.md "Python binding").

Every test runs with an isolated git config (no global / system config unless
the test writes one) and no inherited GITSHEETS_* variables.
"""

from __future__ import annotations

import os
import subprocess

import pytest

import gitsheets

T = 1_700_000_000
AUTHOR = ("Jane Doe", "jane@x.org")


@pytest.fixture(autouse=True)
def _isolated_git(monkeypatch, tmp_path):
    for key in (
        "GITSHEETS_BRANCH",
        "GITSHEETS_SUBMODULE",
        "GITSHEETS_STAGE_POINTER",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_NAMESPACE",
    ):
        monkeypatch.delenv(key, raising=False)
    global_cfg = tmp_path / "gitconfig-global"
    global_cfg.write_text("")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_cfg))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_AUTHOR_NAME", "Seed")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "seed@x.org")
    monkeypatch.setenv("GIT_COMMITTER_NAME", "Seed")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "seed@x.org")
    monkeypatch.setenv("GIT_ALLOW_PROTOCOL", "file")


def git(cwd, *args) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def rev(cwd, ref):
    proc = subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref], cwd=cwd, capture_output=True, text=True)
    return proc.stdout.strip() or None


PEOPLE = "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n"


def make_repo(path) -> str:
    """A repo on `main` with one commit holding the people sheet config."""
    path = str(path)
    git(None, "init", "-q", "-b", "main", path)
    os.makedirs(os.path.join(path, ".gitsheets"))
    with open(os.path.join(path, ".gitsheets", "people.toml"), "w") as fh:
        fh.write(PEOPLE)
    git(path, "add", ".")
    git(path, "commit", "-q", "-m", "seed")
    return path


def gd(repo) -> str:
    return os.path.join(repo, ".git")


def upsert_people(git_dir, slug, **kw):
    with gitsheets.transact(git_dir, f"add {slug}", T, author=AUTHOR, **kw) as tx:
        tx.write_file(".gitsheets/people.toml", PEOPLE)
        tx.open_sheet("people", ".gitsheets/people.toml")
        tx.upsert("people", {"slug": slug})
    return tx.result


# ── resolution tiers ──────────────────────────────────────────────────────────


def test_default_is_heads_branch(tmp_path):
    repo = make_repo(tmp_path / "r")
    b = gitsheets.resolve_binding(repo)
    assert isinstance(b, str) and isinstance(b, gitsheets.Binding)
    assert b == b.git_dir == os.path.realpath(gd(repo))
    assert (b.branch, b.submodule, b.stage_pointer, b.ref) == ("main", None, False, "refs/heads/main")


def test_config_env_option_precedence(tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "r")
    git(repo, "config", "gitsheets.branch", "from-config")
    assert gitsheets.resolve_binding(repo).branch == "from-config"
    monkeypatch.setenv("GITSHEETS_BRANCH", "from-env")
    assert gitsheets.resolve_binding(repo).branch == "from-env"
    assert gitsheets.resolve_binding(repo, branch="refs/heads/opt").branch == "opt"
    # False opts out: HEAD's branch, env and config unread.
    assert gitsheets.resolve_binding(repo, branch=False).branch == "main"
    # An empty variable is unset, not an opt-out.
    monkeypatch.setenv("GITSHEETS_BRANCH", "")
    assert gitsheets.resolve_binding(repo).branch == "from-config"


def test_global_config_tier(tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "r")
    subprocess.run(["git", "config", "--global", "gitsheets.branch", "g"], check=True)
    assert gitsheets.resolve_binding(repo).branch == "g"
    git(repo, "config", "gitsheets.branch", "")  # local empty overrides global: unset
    assert gitsheets.resolve_binding(repo).branch == "main"


@pytest.mark.parametrize("bad", ["refs/tags/v1", "v1", "HEAD", "-x", "a..b"])
def test_non_branch_refused(tmp_path, bad):
    repo = make_repo(tmp_path / "r")
    git(repo, "tag", "v1")
    with pytest.raises(gitsheets.ConfigError) as exc:
        gitsheets.resolve_binding(repo, branch=bad)
    assert exc.value.code == "config_invalid"
    assert "resolve_binding(branch=)" in str(exc.value)


def test_commit_hash_refused(tmp_path):
    repo = make_repo(tmp_path / "r")
    with pytest.raises(gitsheets.ConfigError) as exc:
        gitsheets.resolve_binding(repo, branch=rev(repo, "HEAD"))
    assert exc.value.code == "config_invalid"


def test_remote_only_refused_unborn_allowed(tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "r")
    git(repo, "remote", "add", "origin", "https://example.invalid/x.git")
    git(repo, "update-ref", "refs/remotes/origin/data", "HEAD")
    monkeypatch.setenv("GITSHEETS_BRANCH", "data")
    with pytest.raises(gitsheets.ConfigError) as exc:
        gitsheets.resolve_binding(repo)
    assert exc.value.code == "config_invalid"
    assert "git branch data origin/data" in str(exc.value)
    assert gitsheets.resolve_binding(repo, branch="fresh").branch == "fresh"


def test_detached_head(tmp_path):
    repo = make_repo(tmp_path / "r")
    git(repo, "checkout", "-q", "--detach")
    b = gitsheets.resolve_binding(repo)
    assert b.branch is None and b.ref == "HEAD"


def test_true_is_a_type_error(tmp_path):
    repo = make_repo(tmp_path / "r")
    with pytest.raises(TypeError):
        gitsheets.resolve_binding(repo, branch=True)


def test_discovers_from_cwd_and_inherited_git_dir(tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "r")
    monkeypatch.chdir(repo)
    assert gitsheets.resolve_binding().git_dir == os.path.realpath(gd(repo))
    other = make_repo(tmp_path / "o")
    monkeypatch.setenv("GIT_DIR", gd(other))
    assert gitsheets.resolve_binding().git_dir == os.path.realpath(gd(other))


# ── defaults that follow the binding ──────────────────────────────────────────


def test_transact_commits_to_bound_tip(tmp_path):
    repo = make_repo(tmp_path / "r")
    git(repo, "branch", "data")
    main_before = rev(repo, "main")
    git(repo, "config", "gitsheets.branch", "data")
    result = upsert_people(gd(repo), "jane")
    assert result["ref_name"] == "refs/heads/data"
    assert result["parent_commit_hash"] == main_before
    assert rev(repo, "data") == result["commit_hash"]
    assert rev(repo, "main") == main_before


def test_transact_bootstraps_unborn_bound_branch(tmp_path):
    repo = make_repo(tmp_path / "r")
    b = gitsheets.resolve_binding(repo, branch="data")
    # A block that stages nothing commits nothing, and creates no branch.
    with gitsheets.transact(b, "nothing", T, author=AUTHOR) as tx:
        pass
    assert tx.result["commit_hash"] is None
    assert rev(repo, "refs/heads/data") is None
    result = upsert_people(b, "jane")
    assert result["ref_name"] == "refs/heads/data"
    assert result["parent_commit_hash"] is None
    assert git(repo, "rev-list", "--count", "data") == "1"
    assert git(repo, "status", "--porcelain") == ""


def test_transact_unborn_with_other_existing_branch_refused(tmp_path):
    repo = make_repo(tmp_path / "r")
    b = gitsheets.resolve_binding(repo, branch="data")
    with pytest.raises(gitsheets.TransactionError) as exc:
        with gitsheets.transact(b, "x", T, author=AUTHOR, branch="main"):
            pass
    assert exc.value.code == "commit_failed"


def test_transact_explicit_parent_ignores_binding(tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "r")
    monkeypatch.setenv("GITSHEETS_BRANCH", "data")
    result = upsert_people(gd(repo), "jane", parent="refs/heads/main")
    assert result["ref_name"] == "refs/heads/main"
    assert rev(repo, "refs/heads/data") is None


def test_reads_default_to_bound_tree(tmp_path):
    repo = make_repo(tmp_path / "r")
    git(repo, "config", "gitsheets.branch", "data")
    # Unborn: the empty tree.
    assert gitsheets.record_list(gd(repo), None, "people") == []
    assert gitsheets.core_discover_sheets(gd(repo), None, ".") == []
    upsert_people(gd(repo), "jane")
    rows = gitsheets.record_list(gd(repo), None, "people")
    assert [(r["path"], r["record"]["slug"]) for r in rows] == [("jane", "jane")]
    assert gitsheets.tree_entry_hash(gd(repo), None, "people/jane.toml") is not None
    assert gitsheets.tree_entry_hash(gd(repo), tree_ref=None, path="people/jane.toml") is not None
    assert gitsheets.core_discover_sheets(gd(repo), None, ".") == ["people"]
    # An explicit ref keeps its meaning: HEAD is still main, without jane.
    assert gitsheets.tree_entry_hash(gd(repo), "HEAD", "people/jane.toml") is None


def test_tag_set_defaults_to_bound_tip(tmp_path):
    repo = make_repo(tmp_path / "r")
    git(repo, "config", "gitsheets.branch", "data")
    result = upsert_people(gd(repo), "jane")
    assert gitsheets.tag_set(gd(repo), "v1") == result["commit_hash"]
    assert gitsheets.tag_set(gd(repo), "v0", "HEAD") == rev(repo, "main")


# ── submodule mode ────────────────────────────────────────────────────────────


def make_super(tmp_path):
    data = make_repo(tmp_path / "data-origin")
    sup = make_repo(tmp_path / "super")
    git(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", data, "data")
    git(sup, "commit", "-q", "-m", "add data submodule")
    return sup


def test_submodule_tiers(tmp_path, monkeypatch):
    sup = make_super(tmp_path)
    git(sup, "config", "gitsheets.submodule", "./data/")
    b = gitsheets.resolve_binding(sup)
    assert b.submodule == "data"
    assert b.git_dir == os.path.realpath(os.path.join(gd(sup), "modules", "data"))
    assert b.branch == "main"
    assert b.superproject_git_dir == os.path.realpath(gd(sup))
    assert os.path.realpath(b.superproject_work_tree) == os.path.realpath(sup)
    # The branch tiers resolve inside the submodule.
    git(os.path.join(sup, "data"), "config", "gitsheets.branch", "records")
    assert gitsheets.resolve_binding(sup).branch == "records"
    assert gitsheets.resolve_binding(sup, branch=False).branch == "main"
    # submodule=False opts out.
    off = gitsheets.resolve_binding(sup, submodule=False)
    assert off.submodule is None and off.git_dir == os.path.realpath(gd(sup))


@pytest.mark.parametrize("bad", ["", ".", "/abs", "a/../b", "a//b", "data/.git"])
def test_bad_submodule_path(tmp_path, bad):
    sup = make_super(tmp_path)
    with pytest.raises(gitsheets.ConfigError) as exc:
        gitsheets.resolve_binding(sup, submodule=bad)
    assert exc.value.code == "config_invalid"


def test_not_a_submodule(tmp_path, monkeypatch):
    sup = make_super(tmp_path)
    monkeypatch.setenv("GITSHEETS_SUBMODULE", "nope")
    with pytest.raises(gitsheets.ConfigError) as exc:
        gitsheets.resolve_binding(sup)
    assert exc.value.code == "config_invalid"
    assert str(exc.value).startswith("GITSHEETS_SUBMODULE:")


def test_submodule_symref_commit_and_stage_pointer(tmp_path):
    sup = make_super(tmp_path)
    b = gitsheets.resolve_binding(sup, submodule="data", stage_pointer=True)
    assert b.stage_pointer is True
    result = upsert_people(b, "jane")
    assert result["ref_name"] == "refs/heads/main"
    staged = git(sup, "ls-files", "-s", "data").split()[1]
    assert staged == result["commit_hash"]


def test_submodule_detached_head_advances_by_cas(tmp_path, monkeypatch):
    sup = make_super(tmp_path)
    data = os.path.join(sup, "data")
    git(data, "checkout", "-q", "--detach")
    monkeypatch.setenv("GITSHEETS_SUBMODULE", "data")
    before_main = rev(data, "main")
    result = upsert_people(sup, "jane")
    assert result["ref_name"] == "HEAD"
    assert rev(data, "HEAD") == result["commit_hash"]
    assert rev(data, "main") == before_main
    # Not staged without stage_pointer: the superproject reports new commits.
    assert git(sup, "ls-files", "-s", "data").split()[1] == before_main


def test_stage_pointer_tiers(tmp_path, monkeypatch):
    sup = make_super(tmp_path)
    git(sup, "config", "gitsheets.stagePointer", "yes")
    assert gitsheets.resolve_binding(sup, submodule="data").stage_pointer is True
    monkeypatch.setenv("GITSHEETS_STAGE_POINTER", "off")
    assert gitsheets.resolve_binding(sup, submodule="data").stage_pointer is False
    monkeypatch.setenv("GITSHEETS_STAGE_POINTER", "maybe")
    with pytest.raises(gitsheets.ConfigError):
        gitsheets.resolve_binding(sup, submodule="data")
