"""Data tools for Linking Things (links.thingelstad.xyz).

The modules here implement docs/DATA.md. The command-line entry points are
tools/sync.py, tools/join_issues.py and tools/validate_data.py.
"""

from pathlib import Path

# The repository root: tools/linking/__init__.py -> tools/linking -> tools -> root.
ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT / "data"
RAW_EXPORT = ROOT / "pinboard" / "posts_all.json"
