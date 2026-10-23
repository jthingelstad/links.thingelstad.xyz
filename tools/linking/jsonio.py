"""The one JSON format every file under data/ uses, and safe writes."""

import json
import os
import tempfile
from pathlib import Path


def dumps(value):
    """Canonical text: indent 1, UTF-8 characters kept, one trailing newline."""
    return json.dumps(value, ensure_ascii=False, indent=1) + "\n"


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_bytes_atomic(path, data, *, mode=None):
    """Write data to path through a temporary file and a rename.

    A reader (the Astro build, say) sees the old file or the new one, never a
    half-written one. Returns True when the file changed, False when it
    already held exactly these bytes (and was left untouched).
    """
    path = Path(path)
    try:
        if path.read_bytes() == data:
            if mode is not None:
                os.chmod(path, mode)
            return False
    except FileNotFoundError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.chmod(tmp, mode if mode is not None else 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    return True


def write_json(path, value):
    """Write value in the canonical format. Returns True when the file changed."""
    return write_bytes_atomic(path, dumps(value).encode("utf-8"))
