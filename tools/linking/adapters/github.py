"""GitHub repositories and gists: a repository card from the REST API.

Applies to github.com/<owner>/<repo> exactly (a trailing slash, .git, a query
or a fragment allowed; not /blob/, /tree/, /wiki/ or other deeper paths, and
not GitHub's own pages such as /blog/ or /features/), and to
gist.github.com/<user>/<id> and gist.github.com/<id>.

With GITHUB_TOKEN in the environment (the nightly job exports it from
`gh auth token`) requests carry it as a bearer token, to api.github.com over
https only; it is never printed or recorded. Without one the API allows 60
requests an hour, and the first rate-limit answer stops the method for the
run (StopMethod), saying so.
"""

import re
from urllib.parse import urlsplit

from .base import AdapterError, StopMethod, cached, get_json, text, web_url

METHOD = "github"
KIND = "repository"
VERSION = 1
REPO_FIELDS = ("full_name", "description", "language", "stars", "license", "archived", "pushed", "homepage", "fork")
GIST_FIELDS = ("full_name", "description", "files", "language")
SHAPES = (REPO_FIELDS, GIST_FIELDS)
MEDIA = None

API = "https://api.github.com"
ACCEPT = "application/vnd.github+json"
GIST_CAP = 4 * 1024 * 1024  # a gist answer carries its files' text
MAX_FILES = 50
OWNER_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})")
REPO_RE = re.compile(r"[A-Za-z0-9_.-]{1,100}")
GIST_RE = re.compile(r"[0-9a-f]{20,40}")
# First path segments that are GitHub's own pages, not owners.
RESERVED = frozenset(
    """
    about apps blog codespaces collections contact customer-stories dashboard enterprise events explore
    features github-copilot home issues join login logout marketplace mobile new notifications orgs
    organizations partners password_reset premium-support pricing pulls readme resources search security
    settings showcases site solutions sponsors stars team topics trending users watching
    """.split()
)


def match(url):
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower()
    except ValueError:
        return None
    segments = [segment for segment in parts.path.split("/") if segment]
    if host in ("github.com", "www.github.com") and len(segments) == 2:
        owner, repo = segments
        if repo.endswith(".git"):
            repo = repo[:-4]
        if owner.lower() in RESERVED or repo in (".", ".."):
            return None
        if OWNER_RE.fullmatch(owner) and REPO_RE.fullmatch(repo):
            return {"owner": owner, "repo": repo}
    if host == "gist.github.com" and 1 <= len(segments) <= 2 and GIST_RE.fullmatch(segments[-1]):
        if len(segments) == 2 and not OWNER_RE.fullmatch(segments[0]):
            return None
        return {"gist": segments[-1]}
    return None


def _headers(ctx):
    headers = {"X-GitHub-Api-Version": "2022-11-28"}
    if ctx.github_token:
        headers["Authorization"] = f"Bearer {ctx.github_token}"
    return headers


def _get(ctx, url, cap=None):
    try:
        if cap is None:
            return get_json(ctx, url, accept=ACCEPT, headers=_headers(ctx))[0]
        return get_json(ctx, url, accept=ACCEPT, headers=_headers(ctx), cap=cap)[0]
    except AdapterError as error:
        limited = error.headers.get("x-ratelimit-remaining") == "0" or "retry-after" in error.headers
        if error.status in (403, 429) and limited:
            how = "with the token" if ctx.github_token else "without a token (set GITHUB_TOKEN)"
            raise StopMethod(f"GitHub rate limit reached {how}; the rest wait for the next run") from None
        if error.status == 401:
            raise StopMethod("GitHub refused the token (HTTP 401)") from None
        raise


def _repo(ctx, owner, repo):
    doc = _get(ctx, f"{API}/repos/{owner}/{repo}")
    if not isinstance(doc, dict) or not isinstance(doc.get("full_name"), str):
        raise AdapterError("not a repository answer")
    license_ = doc.get("license") if isinstance(doc.get("license"), dict) else {}
    stars = doc.get("stargazers_count")
    return {
        "full_name": text(doc["full_name"]),
        "description": text(doc.get("description")),
        "language": text(doc.get("language")),
        "stars": stars if isinstance(stars, int) and not isinstance(stars, bool) else None,
        "license": text(license_.get("spdx_id")),
        "archived": bool(doc.get("archived")),
        "pushed": doc.get("pushed_at") if isinstance(doc.get("pushed_at"), str) else None,
        "homepage": web_url(doc.get("homepage")),
        "fork": bool(doc.get("fork")),
    }


def _gist(ctx, gist):
    doc = _get(ctx, f"{API}/gists/{gist}", cap=GIST_CAP)
    if not isinstance(doc, dict) or not isinstance(doc.get("files"), dict):
        raise AdapterError("not a gist answer")
    files = [name for name in doc["files"] if isinstance(name, str)]
    first = doc["files"][files[0]] if files else {}
    return {
        "full_name": f"gist/{gist}",
        "description": text(doc.get("description")),
        "files": [text(name, 200) for name in files[:MAX_FILES]],
        "language": text(first.get("language")) if isinstance(first, dict) else None,
    }


def fetch(link, ctx):
    found = match(link["url"])
    if "gist" in found:
        return cached(ctx, (METHOD, "gist", found["gist"]), lambda: _gist(ctx, found["gist"]))
    key = (METHOD, found["owner"].lower(), found["repo"].lower())
    return cached(ctx, key, lambda: _repo(ctx, found["owner"], found["repo"]))
