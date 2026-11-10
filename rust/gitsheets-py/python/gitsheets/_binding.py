"""Default-branch and submodule binding — the Python mirror of ``openRepo``.

Node resolves the binding in the host (``repository.ts`` / ``submodule.ts``)
with ``git`` subprocesses, not in the core, so this module ports that
resolution line for line under the same environment hygiene as
``git-exec.ts``: every ``git`` run names its git dir in ``GIT_DIR`` and drops
the variables that would redirect it. Reading config through ``git`` itself
keeps includes and the local-over-global layering identical to Node and the
CLI. See specs/behaviors/default-branch.md "Python binding" and
specs/api/python-binding.md "Default-branch binding".
"""

from __future__ import annotations

import os
import subprocess
from typing import Optional, Union

from . import _gitsheets as _core

EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

_REDIRECTING = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_NAMESPACE")

_SUBMODULE_OPTION = "resolve_binding(submodule=)"
_BRANCH_OPTION = "resolve_binding(branch=)"


# ── errors ────────────────────────────────────────────────────────────────────

_STATUS = {
    "config_missing": 500,
    "config_invalid": 500,
    "commit_failed": 500,
    "pointer_stage_failed": 500,
    "parent_moved": 409,
    "ref_not_found": 404,
}


def _error(cls: type, code: str, message: str, **attrs: object) -> Exception:
    """A typed gitsheets exception carrying the discriminants the core's
    error mapping attaches (``code`` / ``status`` / ``gitsheets_class``)."""
    err = cls(message)
    err.code = code  # type: ignore[attr-defined]
    err.status = _STATUS.get(code, 500)  # type: ignore[attr-defined]
    err.gitsheets_class = cls.__name__  # type: ignore[attr-defined]
    for key, value in attrs.items():
        setattr(err, key, value)
    return err


# ── git subprocesses ──────────────────────────────────────────────────────────


class _GitFailed(Exception):
    def __init__(self, returncode: int, stderr: str) -> None:
        super().__init__(stderr)
        self.returncode = returncode
        self.stderr = stderr


def _clean_env() -> dict:
    env = dict(os.environ)
    for key in _REDIRECTING:
        env.pop(key, None)
    return env


def _git(git_dir: str, args: list, work_tree: Optional[str] = None) -> str:
    """``git <args>`` against the repository at ``git_dir``; stdout, or
    :class:`_GitFailed` on a non-zero exit (``execFile``'s contract)."""
    env = _clean_env()
    env["GIT_DIR"] = git_dir
    if work_tree is not None:
        env["GIT_WORK_TREE"] = work_tree
    proc = subprocess.run(
        ["git", *args],
        cwd=work_tree if work_tree is not None else git_dir,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise _GitFailed(proc.returncode, proc.stderr)
    return proc.stdout


def _git_or_none(git_dir: str, args: list) -> Optional[str]:
    try:
        return _git(git_dir, args).strip()
    except _GitFailed:
        return None


def _resolve_git_dir(git_dir: Optional[str]) -> str:
    """The absolute git dir for ``git_dir`` (or discovered from the cwd). An
    explicit path is discovered from that path alone; with none, an inherited
    ``GIT_DIR`` names the repository, as it does for git itself."""
    cwd = git_dir if git_dir is not None else os.getcwd()
    env = _clean_env() if git_dir is not None else dict(os.environ)
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--absolute-git-dir"],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        raise _error(_core.ConfigError, "config_missing", f"could not find a git repository at {cwd}: {exc}") from exc
    if proc.returncode != 0:
        raise _error(
            _core.ConfigError,
            "config_missing",
            f"could not find a git repository at {cwd}: {proc.stderr.strip()}",
        )
    return proc.stdout.strip()


def _resolve_commit(git_dir: str, ref: str) -> Optional[str]:
    return _git_or_none(git_dir, ["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"]) or None


def _head_branch_ref(git_dir: str) -> Optional[str]:
    """The ref ``HEAD`` points at (``refs/heads/main``), or ``None`` when detached."""
    return _git_or_none(git_dir, ["symbolic-ref", "--quiet", "HEAD"]) or None


def _head_branch(git_dir: str) -> Optional[str]:
    ref = _head_branch_ref(git_dir)
    if ref is not None and ref.startswith("refs/heads/"):
        return ref[len("refs/heads/"):]
    return None


def _config_value(git_dir: str, key: str) -> Optional[str]:
    return _git_or_none(git_dir, ["config", "--get", key])


# ── branch tiers ──────────────────────────────────────────────────────────────


def _assert_not_remote_only(git_dir: str, name: str, source: str) -> None:
    """Refuse a branch that exists only as a remote-tracking ref: it is not
    unborn, and gitsheets never creates a local branch from a remote one."""
    out = _git_or_none(git_dir, ["remote"])
    if out is None:
        return
    for remote in (r.strip() for r in out.split("\n")):
        if not remote:
            continue
        if _resolve_commit(git_dir, f"refs/remotes/{remote}/{name}") is not None:
            raise _error(
                _core.ConfigError,
                "config_invalid",
                f"{source}: branch {_q(name)} exists only as {remote}/{name} — create the local branch first: git branch {name} {remote}/{name}",
            )


def _validate_branch_name(git_dir: str, raw: str, source: str) -> str:
    def invalid(why: str) -> Exception:
        return _error(
            _core.ConfigError,
            "config_invalid",
            f"{source}: {_q(raw)} {why} — the default branch must be a branch name (e.g. 'data')",
        )

    name = raw
    if name.startswith("refs/"):
        if not name.startswith("refs/heads/"):
            raise invalid("is not a branch ref")
        name = name[len("refs/heads/"):]
    if name == "" or name == "HEAD" or name.startswith("-"):
        raise invalid("is not a valid branch name")
    try:
        _git(git_dir, ["check-ref-format", f"refs/heads/{name}"])
    except _GitFailed:
        raise invalid("is not a valid branch name") from None
    if _resolve_commit(git_dir, f"refs/heads/{name}") is not None:
        return name
    _assert_not_remote_only(git_dir, name, source)
    if _git_or_none(git_dir, ["rev-parse", "--verify", "--quiet", name]):
        raise invalid("names a tag, commit, or other ref, not a branch")
    return name  # unborn: the bootstrap path


def _resolve_default_branch(git_dir: str, explicit: Union[str, bool, None]) -> Optional[str]:
    if explicit is False:
        return _head_branch(git_dir)
    if explicit is not None:
        return _validate_branch_name(git_dir, _as_str(explicit, "branch"), _BRANCH_OPTION)
    env = os.environ.get("GITSHEETS_BRANCH")
    if env:
        return _validate_branch_name(git_dir, env, "GITSHEETS_BRANCH")
    configured = _config_value(git_dir, "gitsheets.branch")
    if configured:
        return _validate_branch_name(git_dir, configured, "git config gitsheets.branch")
    return _head_branch(git_dir)


# ── submodule tiers ───────────────────────────────────────────────────────────


def _normalize_submodule_path(raw: str, source: str) -> str:
    path = raw.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    path = path.rstrip("/")
    if (
        path in ("", ".")
        or os.path.isabs(raw)
        or any(seg in ("..", "", ".git") for seg in path.split("/"))
    ):
        raise _error(
            _core.ConfigError,
            "config_invalid",
            f"{source}: {_q(raw)} is not a submodule path — pass the path relative to the superproject root, as in .gitmodules (e.g. 'data')",
        )
    return path


def _resolve_submodule_path(super_git_dir: str, explicit: Union[str, bool, None]) -> Optional[tuple]:
    if explicit is False:
        return None
    if explicit is not None:
        return _normalize_submodule_path(_as_str(explicit, "submodule"), _SUBMODULE_OPTION), _SUBMODULE_OPTION
    env = os.environ.get("GITSHEETS_SUBMODULE")
    if env:
        return _normalize_submodule_path(env, "GITSHEETS_SUBMODULE"), "GITSHEETS_SUBMODULE"
    configured = _config_value(super_git_dir, "gitsheets.submodule") or ""
    if configured:
        source = "git config gitsheets.submodule"
        return _normalize_submodule_path(configured, source), source
    return None


def _parse_git_boolean(raw: str) -> Optional[bool]:
    v = raw.strip().lower()
    if v in ("true", "yes", "on", "1"):
        return True
    if v in ("false", "no", "off", "0"):
        return False
    return None


def _resolve_stage_pointer(super_git_dir: str, explicit: Optional[bool]) -> bool:
    if explicit is not None:
        return bool(explicit)
    env = os.environ.get("GITSHEETS_STAGE_POINTER")
    if env:
        parsed = _parse_git_boolean(env)
        if parsed is None:
            raise _error(
                _core.ConfigError,
                "config_invalid",
                f"GITSHEETS_STAGE_POINTER: {_q(env)} is not a boolean — use true/false, yes/no, on/off, or 1/0",
            )
        return parsed
    try:
        return _git(super_git_dir, ["config", "--type=bool", "--get", "gitsheets.stagePointer"]).strip() == "true"
    except _GitFailed as exc:
        if exc.returncode == 1:
            return False
        raise _error(
            _core.ConfigError,
            "config_invalid",
            f"git config gitsheets.stagePointer: not a boolean — use true/false, yes/no, on/off, or 1/0: {exc.stderr.strip()}",
        ) from None


def _superproject_work_tree(git_dir: str) -> Optional[str]:
    if _config_value(git_dir, "core.bare") == "true":
        return None
    configured = _config_value(git_dir, "core.worktree")
    if configured:
        return os.path.normpath(os.path.join(git_dir, configured))
    if os.path.basename(git_dir) == ".git":
        return os.path.dirname(git_dir)
    try:
        with open(os.path.join(git_dir, "gitdir"), encoding="utf8") as fh:
            recorded = fh.read().strip()
        if recorded:
            return os.path.dirname(os.path.normpath(os.path.join(git_dir, recorded)))
    except OSError:
        pass
    return None


def _gitmodules_entries(super_git_dir: str, work_tree: Optional[str]) -> list:
    if work_tree is not None and os.path.isfile(os.path.join(work_tree, ".gitmodules")):
        source = ["-f", os.path.join(work_tree, ".gitmodules")]
    else:
        source = ["--blob", "HEAD:.gitmodules"]
    out = _git_or_none(super_git_dir, ["config", *source, "--get-regexp", "^submodule\\."])
    if out is None:
        return []
    by_name: dict = {}
    for line in out.split("\n"):
        sp = line.find(" ")
        if sp == -1:
            continue
        key, value = line[:sp], line[sp + 1:]
        dot = key.rfind(".")
        name = key[len("submodule."):dot]
        by_name.setdefault(name, {})[key[dot + 1:]] = value
    return [
        {"name": name, "path": fields["path"].rstrip("/")}
        for name, fields in by_name.items()
        if "path" in fields
    ]


def _is_git_dir(path: str) -> bool:
    return os.path.isfile(os.path.join(path, "HEAD")) and os.path.isdir(os.path.join(path, "objects"))


def _locate_submodule_git_dir(super_git_dir: str, work_tree: Optional[str], path: str, name: str, source: str) -> str:
    if work_tree is not None:
        dotgit = os.path.join(work_tree, path, ".git")
        if os.path.isdir(dotgit):
            return dotgit
        if os.path.isfile(dotgit):
            try:
                with open(dotgit, encoding="utf8") as fh:
                    for line in fh.read().strip().split("\n"):
                        if line.startswith("gitdir:"):
                            target = os.path.normpath(os.path.join(work_tree, path, line[len("gitdir:"):].strip()))
                            if _is_git_dir(target):
                                return target
                            break
            except OSError:
                pass
    modules = os.path.join(super_git_dir, "modules", name)
    if _is_git_dir(modules):
        return modules
    raise _error(
        _core.ConfigError,
        "config_missing",
        f"{source}: no repository for submodule {_q(path)} (no {path}/.git, no modules/{name}) — set it up with: git sheet submodule init {path}",
    )


# ── the Binding value ─────────────────────────────────────────────────────────


class Binding(str):
    """A resolved default-branch binding.

    The string value is the **bound git dir** (the submodule's in submodule
    mode), so a ``Binding`` passes anywhere a ``git_dir`` goes; the
    resolution rides along as read-only attributes. Returned by
    :func:`resolve_binding`. See specs/api/python-binding.md.
    """

    __slots__ = ("_branch", "_submodule", "_stage_pointer", "_super_git_dir", "_super_work_tree")

    def __new__(
        cls,
        git_dir: str,
        branch: Optional[str],
        submodule: Optional[str] = None,
        stage_pointer: bool = False,
        superproject_git_dir: Optional[str] = None,
        superproject_work_tree: Optional[str] = None,
    ) -> "Binding":
        self = super().__new__(cls, git_dir)
        self._branch = branch
        self._submodule = submodule
        self._stage_pointer = bool(stage_pointer) and submodule is not None
        self._super_git_dir = superproject_git_dir
        self._super_work_tree = superproject_work_tree
        return self

    @property
    def git_dir(self) -> str:
        return str.__str__(self)

    @property
    def branch(self) -> Optional[str]:
        return self._branch

    @property
    def submodule(self) -> Optional[str]:
        return self._submodule

    @property
    def stage_pointer(self) -> bool:
        return self._stage_pointer

    @property
    def superproject_git_dir(self) -> Optional[str]:
        return self._super_git_dir

    @property
    def superproject_work_tree(self) -> Optional[str]:
        return self._super_work_tree

    @property
    def ref(self) -> str:
        """``refs/heads/<branch>``, or ``'HEAD'`` when bound to a detached ``HEAD``."""
        return f"refs/heads/{self._branch}" if self._branch is not None else "HEAD"

    def __repr__(self) -> str:
        return (
            f"Binding(git_dir={self.git_dir!r}, branch={self._branch!r}, "
            f"submodule={self._submodule!r}, stage_pointer={self._stage_pointer!r})"
        )

    def __reduce__(self):  # keep the attributes across pickling
        return (
            Binding,
            (self.git_dir, self._branch, self._submodule, self._stage_pointer, self._super_git_dir, self._super_work_tree),
        )


def resolve_binding(
    git_dir: Optional[str] = None,
    *,
    branch: Union[str, bool, None] = None,
    submodule: Union[str, bool, None] = None,
    stage_pointer: Optional[bool] = None,
) -> Binding:
    """Resolve the repository's default-branch / submodule binding, exactly
    as ``openRepo({ gitDir, branch, submodule, stagePointer })`` does.

    ``branch`` / ``submodule``: ``None`` resolves ``GITSHEETS_*`` → the
    ``gitsheets.*`` git config → the default; a value sets it; ``False`` opts
    out (``HEAD``'s branch / no submodule) without reading env or config.
    ``stage_pointer``: ``None`` resolves ``GITSHEETS_STAGE_POINTER`` → the
    superproject's ``gitsheets.stagePointer`` → ``False``.

    Raises ``ConfigError`` (``config_invalid`` / ``config_missing``) for a
    refused binding: a tag, commit, or remote-only branch, a bad submodule
    path, a path that is not a submodule, or a submodule with no git dir.
    """
    if isinstance(git_dir, Binding):
        git_dir = git_dir.git_dir
    if branch is True or submodule is True:
        raise TypeError("branch= / submodule= take a name, None (resolve), or False (opt out) — not True")
    resolved = _resolve_git_dir(git_dir)
    sub = _resolve_submodule_path(resolved, submodule)
    if sub is None:
        return Binding(resolved, _resolve_default_branch(resolved, branch))
    path, source = sub
    work_tree = _superproject_work_tree(resolved)
    entry = next((e for e in _gitmodules_entries(resolved, work_tree) if e["path"] == path), None)
    if entry is None:
        raise _error(
            _core.ConfigError,
            "config_invalid",
            f"{source}: {_q(path)} is not a submodule of this repository (no .gitmodules entry with path = {path}) — add one with: git sheet submodule init {path} --url <url>",
        )
    sub_git_dir = _locate_submodule_git_dir(resolved, work_tree, path, entry["name"], source)
    return Binding(
        sub_git_dir,
        _resolve_default_branch(sub_git_dir, branch),
        submodule=path,
        stage_pointer=_resolve_stage_pointer(resolved, stage_pointer),
        superproject_git_dir=resolved,
        superproject_work_tree=work_tree,
    )


def as_binding(git_dir: str) -> Binding:
    """``git_dir`` itself when it is a :class:`Binding`, else its resolution."""
    return git_dir if isinstance(git_dir, Binding) else resolve_binding(git_dir)


# ── what the defaults resolve to ──────────────────────────────────────────────


def default_tree(binding: Binding) -> str:
    """The tree reads default to: the default branch's tree, the empty tree
    when it is unborn, ``HEAD``'s tree when bound to a detached ``HEAD``."""
    out = _git_or_none(binding.git_dir, ["rev-parse", "--verify", "--quiet", f"{binding.ref}^{{tree}}"])
    return out or EMPTY_TREE_HASH


def default_tip(binding: Binding) -> str:
    """What ``tag_set`` with no target tags: the default branch's tip ref, or
    ``HEAD`` when bound to a detached ``HEAD``."""
    return binding.ref


def default_start(binding: Binding) -> tuple:
    """Where a transaction with no ``parent`` starts (Node's ``#defaultStart``):
    ``('tip', ref)``, ``('unborn', ref)`` — bootstrapped by an orphan commit —
    or ``('as-given', None)``: let the core resolve ``HEAD`` (detached, or
    ``HEAD``'s own unborn branch, which the core already handles)."""
    if binding.branch is None:
        return ("as-given", None)
    ref = f"refs/heads/{binding.branch}"
    if _resolve_commit(binding.git_dir, ref) is not None:
        return ("tip", ref)
    if _head_branch_ref(binding.git_dir) == ref:
        return ("as-given", None)
    # A remote-tracking copy may have been fetched since the binding resolved.
    _assert_not_remote_only(binding.git_dir, binding.branch, "the default branch")
    return ("unborn", ref)


def branch_exists(git_dir: str, branch: str) -> bool:
    ref = branch if branch.startswith("refs/") else f"refs/heads/{branch}"
    return _resolve_commit(git_dir, ref) is not None


def head_branch_ref(git_dir: str) -> Optional[str]:
    return _head_branch_ref(git_dir)


def advance_detached_head(git_dir: str, new_commit: str, old_commit: str, reason: str) -> None:
    """Advance a detached ``HEAD`` from ``old_commit`` to ``new_commit`` by
    compare-and-swap — the one place gitsheets moves ``HEAD`` itself. A
    ``HEAD`` that became a symref is left alone (``commit_failed``); one at
    another commit is ``parent_moved``. Both name the written commit."""
    symref = _head_branch_ref(git_dir)
    if symref is not None:
        raise _error(
            _core.TransactionError,
            "commit_failed",
            f"HEAD became {symref} during the transaction, so it was left alone; commit {new_commit} was written but is on no ref — recover it with: git merge {new_commit} (or git branch <name> {new_commit})",
        )
    try:
        _git(git_dir, ["update-ref", "--no-deref", "-m", reason, "HEAD", new_commit, old_commit])
    except _GitFailed:
        raise _error(
            _core.TransactionError,
            "parent_moved",
            f"detached HEAD moved during the transaction (expected {old_commit}); commit {new_commit} was written but HEAD was not advanced — recover it with: git cherry-pick {new_commit}",
        ) from None


def stage_gitlink(binding: Binding, commit: str) -> None:
    """Point the superproject's index entry for the submodule at ``commit``
    (``160000 <commit> <path>``). Never commits. A failure is
    ``TransactionError`` (``pointer_stage_failed``) carrying ``commit_hash``:
    the data commit has landed, so the caller must not retry the write."""
    assert binding.superproject_git_dir is not None and binding.submodule is not None
    try:
        _git(
            binding.superproject_git_dir,
            ["update-index", "--add", "--cacheinfo", f"160000,{commit},{binding.submodule}"],
            work_tree=binding.superproject_work_tree,
        )
    except _GitFailed as exc:
        raise _error(
            _core.TransactionError,
            "pointer_stage_failed",
            f"the data commit {commit} landed in submodule {binding.submodule}, but the superproject pointer could not be staged (stage_pointer) — do not retry the write; stage it by hand: git add {binding.submodule}: {exc.stderr.strip()}",
            commit_hash=commit,
        ) from None


def _q(value: str) -> str:
    """JSON-style quoting, matching Node's ``JSON.stringify`` in messages."""
    import json

    return json.dumps(value)


def _as_str(value: object, knob: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{knob}= takes a str, None (resolve), or False (opt out); got {type(value).__name__}")
    return value
