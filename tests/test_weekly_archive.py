"""Source freshness is a pinned tree, never a worker's successful exit code."""

import contextlib
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import join_issues  # noqa: E402
from linking.weekly import ARCHIVE, ArchiveError, published_archive  # noqa: E402


def git(repository, *arguments):
    return subprocess.check_output(
        [
            "git",
            "-C",
            str(repository),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            *arguments,
        ],
        stderr=subprocess.DEVNULL,
        text=True,
    ).strip()


class PublishedArchiveTest(unittest.TestCase):
    def test_main_is_pinned_independently_of_a_stale_dirty_working_branch(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary) / "weekly"
            repo.mkdir()
            git(repo, "init", "--quiet", "--initial-branch=main")
            archive = repo / ARCHIVE
            archive.mkdir(parents=True)
            (archive / "353.md").write_text("old issue")
            git(repo, "add", ".")
            git(repo, "commit", "--quiet", "-m", "Baseline")
            baseline = git(repo, "rev-parse", "HEAD")
            git(repo, "branch", "active-work")
            (archive / "354.md").write_text("published issue")
            git(repo, "add", ".")
            git(repo, "commit", "--quiet", "-m", "Published")
            published = git(repo, "rev-parse", "HEAD")
            git(repo, "switch", "--quiet", "active-work")
            (archive / "353.md").write_text("another worker's uncommitted edit")

            with published_archive(repo) as (exported, revision):
                self.assertEqual(revision, published)
                self.assertEqual((exported / "354.md").read_text(), "published issue")
                self.assertEqual((exported / "353.md").read_text(), "old issue")
                # Moving the remote ref after resolution cannot change this round.
                git(repo, "update-ref", "refs/heads/main", baseline)
                self.assertEqual((exported / "354.md").read_text(), "published issue")
            self.assertFalse(exported.exists())
            self.assertEqual(git(repo, "branch", "--show-current"), "active-work")
            self.assertEqual((archive / "353.md").read_text(), "another worker's uncommitted edit")
            self.assertFalse((archive / "354.md").exists())

    def test_zero_exit_without_a_source_revision_is_not_freshness(self):
        # A tool can return zero while failing to establish its source, as in
        # the separately reported WT backfill. No source means no derived write.
        with patch("linking.weekly.subprocess.run", return_value=SimpleNamespace(stdout=b"")):
            with self.assertRaisesRegex(ArchiveError, "full source revision"):
                with published_archive():
                    self.fail("No source should be yielded")

    def test_a_failed_fetch_leaves_the_existing_join_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / "issues.json"
            out.write_text("existing derived bytes\n")
            with patch(
                "join_issues.published_archive", side_effect=ArchiveError("Source fetch failed")
            ):
                with contextlib.redirect_stderr(io.StringIO()) as error:
                    result = join_issues.main(["--out", str(out)])
            self.assertEqual(result, 1)
            self.assertIn("Source fetch failed", error.getvalue())
            self.assertEqual(out.read_text(), "existing derived bytes\n")


if __name__ == "__main__":
    unittest.main()
