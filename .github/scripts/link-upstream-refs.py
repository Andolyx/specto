"""Point issue/PR references of upstream commits at the upstream repository.

release-please links every "#123" in the changelog to this repository's issues, but for
commits merged from upstream the number refers to an upstream pull request. Each file
given as an argument is rewritten in place.
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


for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as file:
        text = file.read()

    fixed = "".join(fix_line(line) for line in text.splitlines(keepends=True))

    if fixed != text:
        with open(path, "w", encoding="utf-8") as file:
            file.write(fixed)

        print(f"Fixed upstream references in {path}")
