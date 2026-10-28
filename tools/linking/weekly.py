"""Read a pinned Weekly main archive without using anyone's working checkout."""

import contextlib
import io
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path

REPOSITORY = "https://github.com/jthingelstad/weekly.thingelstad.com.git"
ARCHIVE = "apps/site/archive"


class ArchiveError(ValueError):
    """The published source could not be established; do not replace the join."""


@contextlib.contextmanager
def published_archive(repository=REPOSITORY):
    """Fetch main once, resolve its commit, then export only that immutable tree.

    A failed fetch never falls back to a cached branch or working files. Git
    errors stay generic so credential helpers cannot leak into tool output.
    The repository argument exists for offline tests with a local repository.
    """
    with tempfile.TemporaryDirectory(prefix="links-weekly-") as temporary:
        work = Path(temporary)
        repo = work / "repository"
        source = work / "source"

        def git(*arguments):
            return subprocess.run(
                ["git", *arguments],
                check=True,
                capture_output=True,
                timeout=90,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            ).stdout

        try:
            git("init", "--quiet", str(repo))
            git(
                "-C",
                str(repo),
                "fetch",
                "--quiet",
                "--depth=1",
                "--no-tags",
                "--no-recurse-submodules",
                str(repository),
                "refs/heads/main",
            )
            revision = (
                git("-C", str(repo), "rev-parse", "--verify", "FETCH_HEAD^{commit}")
                .decode()
                .strip()
            )
            if not re.fullmatch(r"[a-f0-9]{40}", revision):
                raise ArchiveError("Weekly main did not resolve to a full source revision.")
            exported = git("-C", str(repo), "archive", "--format=tar", revision, ARCHIVE)
            source.mkdir()
            with tarfile.open(fileobj=io.BytesIO(exported), mode="r:") as archive:
                archive.extractall(source, filter="data")
        except (OSError, subprocess.SubprocessError, tarfile.TarError):
            raise ArchiveError(
                "Could not read Weekly published main; the existing join was left unchanged."
            ) from None
        yield source / ARCHIVE, revision
