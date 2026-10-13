"""Tidy release-please changelog entries in place, for each file given as an argument.

- release-please links every "#123" to this repository's issues, but for commits merged from
  upstream the number refers to an upstream pull request, so those links are repointed.
- Merge commits repeat their pull request's title, so release-please lists the same change
  twice; repeated entries within a version section are dropped.
"""

import os
import re
import subprocess
import sys

REPOSITORY = os.environ["GITHUB_REPOSITORY"]
UPSTREAM_REPOSITORY = os.environ["UPSTREAM_REPOSITORY"]

COMMIT_LINK = re.compile(rf"https://github\.com/{re.escape(REPOSITORY)}/commit/([0-9a-f]{{40}})")
ISSUE_LINK = re.compile(rf"\[#(\d+)\]\(https://github\.com/{re.escape(REPOSITORY)}/issues/\d+\)")


def is_upstream_commit(sha: str) -> bool:
    result = subprocess.run(["git", "merge-base", "--is-ancestor", sha, "upstream/main"], capture_output=True)

    return result.returncode == 0


def fix_line(line: str) -> str:
    match = COMMIT_LINK.search(line)

    if match is None or not is_upstream_commit(match.group(1)):
        return line

    upstream_name = UPSTREAM_REPOSITORY.split("/")[1]

    return ISSUE_LINK.sub(
        lambda m: f"[{upstream_name}#{m.group(1)}](https://github.com/{UPSTREAM_REPOSITORY}/pull/{m.group(1)})",
        line,
    )


ENTRY = re.compile(r"^\* (.+?) \(\[")


def tidy(text: str) -> str:
    lines = []
    seen = set()

    for line in text.splitlines(keepends=True):
        if line.startswith("## "):
            seen = set()

        entry = ENTRY.match(line)

        if entry:
            if entry.group(1) in seen:
                continue

            seen.add(entry.group(1))

        lines.append(fix_line(line))

    return "".join(lines)


for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as file:
        text = file.read()

    fixed = tidy(text)

    if fixed != text:
        with open(path, "w", encoding="utf-8") as file:
            file.write(fixed)

        print(f"Tidied {path}")
