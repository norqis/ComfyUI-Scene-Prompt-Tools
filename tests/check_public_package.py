"""Fail fast when a public package check finds private or generated content."""

from __future__ import annotations

import re
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_TERMS = (
    r"meta[ _-]?(?:camp|champ)",
    "scene[ _-]?prompt" + "er",
    "scene" + "Prompt" + "er",
    r"(?<![A-Za-z])[A-Za-z]:[\\\\/]",
)
FORBIDDEN = re.compile("|".join(FORBIDDEN_TERMS), re.IGNORECASE)
SKIP_SUFFIXES = {".pyc", ".png", ".jpg", ".jpeg", ".gif", ".zip"}
ALLOWED_NOREPLY_EMAILS = {"noreply@github.com"}
HISTORY_BASE_ENV = "SCENE_PROMPT_HISTORY_BASE_SHA"
HISTORY_HEAD_ENV = "SCENE_PROMPT_HISTORY_HEAD_SHA"
SYNTHETIC_MERGE_ENV = "SCENE_PROMPT_SYNTHETIC_MERGE_REF"
PRE_PUBLIC_NODE_ALIASES = {
    "Scene" + "Prompter": "ScenePrompt",
    "Scene" + "PrompterExpand": "ScenePromptExpand",
    "Scene" + "PrompterQueue": "ScenePromptQueue",
    "Scene" + "PrompterMerge": "ScenePromptMerge",
}


def tracked_files():
    result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, stdout=subprocess.PIPE
    )
    return [Path(name) for name in result.stdout.decode("utf-8").split("\0") if name]


def history_privacy_failures(records):
    """Return errors for author/committer addresses unsafe for public history."""
    failures = []
    for commit, author, committer in records:
        for role, address in (("author", author), ("committer", committer)):
            normalized = address.strip().casefold()
            if normalized and normalized not in ALLOWED_NOREPLY_EMAILS and not normalized.endswith("@users.noreply.github.com"):
                failures.append(f"public history has a non-noreply {role} email in {commit}: {address}")
    return failures


def history_revision_range(environment=None):
    environment = os.environ if environment is None else environment
    base = environment.get(HISTORY_BASE_ENV, "").strip()
    head = environment.get(HISTORY_HEAD_ENV, "").strip()
    if not base and not head:
        return "HEAD"
    if not base or not head:
        raise ValueError("Both history base and head SHA values are required.")
    if set(base) == {"0"}:
        return head
    return f"{base}..{head}"


def reachable_history(revision=None):
    revision = history_revision_range() if revision is None else revision
    result = subprocess.run(
        ["git", "log", "--format=%H%x00%ae%x00%ce", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    return [tuple(line.split("\0")) for line in result.stdout.decode("utf-8").splitlines() if line]


def synthetic_merge_metadata(environment=None):
    environment = os.environ if environment is None else environment
    revision = environment.get(SYNTHETIC_MERGE_ENV, "").strip()
    if not revision:
        return []
    result = subprocess.run(
        ["git", "show", "-s", "--format=%H%x00%ae%x00%ce", revision],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise ValueError(f"Synthetic merge ref is unavailable: {revision}")
    output = result.stdout.decode("utf-8").strip()
    if not output:
        raise ValueError(f"Synthetic merge ref is unavailable: {revision}")
    return [tuple(output.split("\0"))]


def main():
    try:
        privacy_records = reachable_history() + synthetic_merge_metadata()
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    failures = history_privacy_failures(privacy_records)
    files = tracked_files()
    for path in files:
        if path.parts and path.parts[0] == "data":
            failures.append(f"custom-node data files must not be tracked: {path}")
        if path.suffix.lower() in SKIP_SUFFIXES:
            failures.append(f"generated or binary file must not be tracked: {path}")
            continue
        target = ROOT / path
        if not target.is_file():
            failures.append(f"tracked file is missing: {path}")
            continue
        content = target.read_text(encoding="utf-8", errors="replace")
        if path == Path("__init__.py"):
            for old_name, current_name in PRE_PUBLIC_NODE_ALIASES.items():
                alias = f'"{old_name}": {current_name},'
                if content.count(alias) != 1:
                    failures.append(f"missing or duplicate pre-public node alias in {path}: {old_name}")
                content = content.replace(alias, "")
        if FORBIDDEN.search(content):
            failures.append(f"forbidden public text in {path}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
