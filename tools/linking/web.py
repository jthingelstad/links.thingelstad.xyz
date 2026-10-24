"""The one HTTP client the enrichment tools use: paced, polite, and bodiless.

docs/DATA.md, "Enrichment (phase 2)". Every request is a GET with the
LinkingThings User-Agent and a 15 second timeout. Requests to one host are at
least a second apart (six seconds for the Wayback Machine), counted from the
end of the previous request. urllib never follows a redirect here: follow()
walks the chain itself, up to five hops, so the chain is recorded. A body is
read only from a 2xx response, never past the cap, and is handed back only to
callers that parse it (RDAP and CDX JSON); a page body is read and dropped.
A 429 or 5xx is retried once after a longer wait, never more. A host that
resolves to a private, loopback or other non-public address is not fetched.
"""

import contextlib
import http.client
import http.cookiejar
import ipaddress
import socket
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

USER_AGENT = "LinkingThings/0.1 (+https://links.thingelstad.xyz)"
TIMEOUT_SECONDS = 15
PAGE_CAP = 256 * 1024  # never read more of a page than this
MAX_REDIRECTS = 5
SPACING_SECONDS = 1.0  # per host, end of one request to the start of the next
SLOW_HOSTS = {"web.archive.org": 6.0}  # bursts get the IP blocked
RETRY_WAIT_SECONDS = 10.0  # before the one retry of a 429 or 5xx
SLOW_RETRY_SECONDS = {"web.archive.org": 60.0}  # the archive gets a longer pause
MAX_RETRY_WAIT_SECONDS = 60.0  # the most a Retry-After header can ask for
READ_CHUNK = 16 * 1024

# Query parameters whose values are blanked in a recorded URL: a redirect can
# land on a signed or session URL, and data/ is public.
SENSITIVE_PARAMS = frozenset(
    {
        "access_token",
        "api_key",
        "apikey",
        "auth",
        "auth_token",
        "code",
        "jsessionid",
        "key",
        "password",
        "phpsessid",
        "secret",
        "session",
        "sessionid",
        "sid",
        "sig",
        "signature",
        "state",
        "ticket",
        "token",
    }
)
SENSITIVE_PREFIXES = ("x-amz-", "x-goog-")
REDACTED = "REDACTED"


class FetchError(Exception):
    """A request that produced no HTTP response. str() is the short reason."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class Gate:
    """At most one request per `spacing` seconds per key (a host, or "dns").

    The spacing runs from the end of one request to the start of the next, so a
    slow server never sees requests closer together than the floor.
    """

    def __init__(self, *, sleep=time.sleep, clock=time.monotonic):
        self._sleep = sleep
        self._clock = clock
        self._last = {}

    @contextlib.contextmanager
    def slot(self, key, spacing):
        last = self._last.get(key)
        if last is not None:
            wait = spacing - (self._clock() - last)
            if wait > 0:
                self._sleep(wait)
        try:
            yield
        finally:
            self._last[key] = self._clock()


class Response:
    __slots__ = ("status", "headers", "body")

    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers  # lower-case names
        self.body = body


def iri_to_uri(url):
    """A URL safe to put on the wire: IDNA host, non-ASCII and spaces escaped.

    Existing percent escapes are kept; the fragment is dropped (it is never sent).
    """
    parts = urlsplit(url)
    netloc = parts.netloc
    if not netloc.isascii():
        host = parts.hostname or ""
        try:
            ascii_host = host.encode("idna").decode("ascii")
        except UnicodeError:
            ascii_host = quote(host, safe="")
        netloc = netloc.lower().replace(host, ascii_host)
    path = quote(parts.path, safe="/%:@!$&'()*+,;=-._~") or "/"
    query = quote(parts.query, safe="/?%:@!$&'()*+,;=-._~")
    return urlunsplit((parts.scheme, netloc, path, query, ""))


def redact_url(url):
    """url with the values of credential-looking query parameters blanked."""
    parts = urlsplit(url)
    if not parts.query:
        return url
    kept = []
    changed = False
    for param in parts.query.split("&"):
        name, eq, _value = param.partition("=")
        lowered = name.lower()
        if eq and (lowered in SENSITIVE_PARAMS or lowered.startswith(SENSITIVE_PREFIXES)):
            kept.append(f"{name}={REDACTED}")
            changed = True
        else:
            kept.append(param)
    if not changed:
        return url
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(kept), parts.fragment))


def media_type(value):
    """"text/html; charset=utf-8" -> "text/html"; None when absent or empty."""
    if not value:
        return None
    kind = value.split(";", 1)[0].strip().lower()
    return kind or None


def describe_error(error):
    """A short, stable reason for a failed request (no addresses, no bodies)."""
    if isinstance(error, urllib.error.URLError) and not isinstance(error, urllib.error.HTTPError):
        reason = error.reason
        if isinstance(reason, BaseException):
            error = reason
        else:
            return f"network: {reason}"
    if isinstance(error, socket.gaierror):
        if error.errno in (socket.EAI_NONAME, getattr(socket, "EAI_NODATA", socket.EAI_NONAME)):
            return "dns: name does not resolve"
        return f"dns: {error.strerror or error}"
    if isinstance(error, ssl.SSLCertVerificationError):
        detail = (error.verify_message or "certificate verify failed").rstrip(".")
        return f"tls: {detail}"
    if isinstance(error, ssl.SSLError):
        return f"tls: {error.reason or type(error).__name__}"
    if isinstance(error, (TimeoutError, socket.timeout)):
        return "timeout"
    if isinstance(error, ConnectionRefusedError):
        return "connection refused"
    if isinstance(error, ConnectionResetError):
        return "connection reset"
    if isinstance(error, http.client.RemoteDisconnected):
        return "connection closed without a response"
    if isinstance(error, http.client.InvalidURL) or isinstance(error, ValueError):
        return "invalid URL"
    if isinstance(error, http.client.HTTPException):
        return f"bad response: {type(error).__name__}"
    if isinstance(error, OSError):
        return f"network: {error.strerror or type(error).__name__}"
    return type(error).__name__


# Response headers that say the answer came from a bot wall, not the page. The
# record keeps the status; the note tells a reader the page may well be there.
BOT_WALLS = (
    ("cf-mitigated", "challenge", "Cloudflare challenge"),
    ("x-vercel-mitigated", "challenge", "Vercel challenge"),
    ("x-datadome", "protected", "DataDome"),
)


def bot_wall(headers):
    """The name of the bot wall that answered, or None."""
    for header, value, name in BOT_WALLS:
        if (headers.get(header) or "").strip().lower() == value:
            return name
    return None


def http_error(status, headers):
    wall = bot_wall(headers)
    return f"HTTP {status} ({wall})" if wall else f"HTTP {status}"


def retry_wait(retry_after, floor=RETRY_WAIT_SECONDS):
    """Seconds before the one retry: Retry-After (in seconds) if longer, capped."""
    try:
        seconds = float(retry_after)
    except (TypeError, ValueError):
        seconds = 0.0
    return min(max(seconds, floor), max(MAX_RETRY_WAIT_SECONDS, floor))


def should_retry(status, headers=None):
    """A 429 or 5xx earns its one retry, unless a bot wall sent it: a challenge
    answers the same way ten seconds later, and asking again is not polite."""
    if headers and bot_wall(headers):
        return False
    return status == 429 or 500 <= status <= 599


class _NoRaise(urllib.request.HTTPErrorProcessor):
    """Hand every response back as it came: no redirect, no HTTPError."""

    def http_response(self, request, response):
        return response

    https_response = http_response


_SSL_CONTEXT = ssl.create_default_context()


def urllib_transport(url, headers, timeout, jar):
    """The real transport: one GET, redirects not followed, cookies kept for the chain."""
    opener = urllib.request.build_opener(
        _NoRaise,
        urllib.request.HTTPSHandler(context=_SSL_CONTEXT),
        urllib.request.HTTPCookieProcessor(jar),
    )
    request = urllib.request.Request(url, headers=headers, method="GET")
    return opener.open(request, timeout=timeout)


def public_address_check(host, port, resolve=socket.getaddrinfo):
    """Raise FetchError unless every address host resolves to is public."""
    try:
        infos = resolve(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as error:
        raise FetchError(describe_error(error)) from None
    except UnicodeError:
        raise FetchError("invalid URL") from None
    if not infos:
        raise FetchError("dns: name does not resolve")
    for info in infos:
        address = info[4][0].split("%", 1)[0]
        try:
            if not ipaddress.ip_address(address).is_global:
                raise FetchError("resolves to a non-public address; not fetched")
        except ValueError:
            raise FetchError("dns: unusable address") from None


class Client:
    """GET with pacing, the public-address guard and one retry.

    transport(url, headers, timeout, jar) returns a response with .status,
    .headers, .read(n) and .close(), or raises; tests pass a fake. resolve is
    socket.getaddrinfo or a fake; None skips the guard.
    """

    def __init__(
        self,
        *,
        transport=urllib_transport,
        resolve=socket.getaddrinfo,
        gate=None,
        sleep=time.sleep,
        clock=time.monotonic,
        user_agent=USER_AGENT,
    ):
        self._transport = transport
        self._resolve = resolve
        self._sleep = sleep
        self._clock = clock
        self.gate = gate or Gate(sleep=sleep, clock=clock)
        self.user_agent = user_agent
        self.requests = 0  # every request sent, retries included

    def _read(self, response, cap, deadline):
        chunks, total = [], 0
        while total < cap and self._clock() < deadline:
            chunk = response.read(min(READ_CHUNK, cap - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        return b"".join(chunks)

    def get(self, url, *, cap=PAGE_CAP, accept="*/*", timeout=TIMEOUT_SECONDS, jar=None, extra_headers=None):
        """One GET (and at most one retry). Returns a Response or raises FetchError.

        extra_headers (an Authorization header, say) are sent as given; follow()
        decides which hops get them.
        """
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https"):
            raise FetchError("not an http or https URL")
        try:
            host = (parts.hostname or "").lower()
            port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError:
            raise FetchError("invalid URL") from None
        if not host:
            raise FetchError("invalid URL")
        if self._resolve is not None:
            public_address_check(host, port, self._resolve)
        wire = iri_to_uri(url)
        headers = {**(extra_headers or {}), "User-Agent": self.user_agent, "Accept": accept}
        jar = jar if jar is not None else http.cookiejar.CookieJar()
        spacing = SLOW_HOSTS.get(host, SPACING_SECONDS)
        for attempt in (1, 2):
            with self.gate.slot(host, spacing):
                self.requests += 1
                try:
                    response = self._transport(wire, headers, timeout, jar)
                except Exception as error:  # noqa: BLE001 - every failure becomes a short reason
                    raise FetchError(describe_error(error)) from None
                try:
                    status = int(response.status)
                    names = {name.lower(): value for name, value in response.headers.items()}
                    body = b""
                    if cap and 200 <= status < 300:
                        try:
                            body = self._read(response, cap, self._clock() + timeout)
                        except Exception as error:  # noqa: BLE001
                            raise FetchError(describe_error(error) + " while reading") from None
                finally:
                    response.close()
            if attempt == 1 and should_retry(status, names):
                floor = SLOW_RETRY_SECONDS.get(host, RETRY_WAIT_SECONDS)
                self._sleep(retry_wait(names.get("retry-after"), floor))
                continue
            return Response(status, names, body)
        raise AssertionError("unreachable")

    def follow(self, url, *, max_redirects=MAX_REDIRECTS, cap=PAGE_CAP, accept="*/*", timeout=TIMEOUT_SECONDS):
        """GET url and walk its redirects. Returns (result, body).

        result: status (of the last response, None when none came back), alive
        (2xx at the end), final_url (the URL of the last request), redirects
        ([{"status", "url"}] in order, url being where each hop pointed),
        content_type (of the last response), and error when not alive.
        Recorded URLs pass through redact_url. body is the last response's
        body (empty unless it was a 2xx); callers that do not parse it drop it.
        """
        result, body, _headers = self.fetch(
            url, max_redirects=max_redirects, cap=cap, accept=accept, timeout=timeout
        )
        return result, body

    def fetch(
        self,
        url,
        *,
        max_redirects=MAX_REDIRECTS,
        cap=PAGE_CAP,
        accept="*/*",
        timeout=TIMEOUT_SECONDS,
        extra_headers=None,
    ):
        """follow(), plus the last response's headers (lower-case names, {} when none came back).

        extra_headers go only to https hops on the host of url itself, so a
        token never follows a redirect to another host or onto plain http.
        """
        redirects = []
        current = url
        origin = (urlsplit(url).hostname or "").lower()
        jar = http.cookiejar.CookieJar()
        for hop in range(max_redirects + 1):
            parts = urlsplit(current)
            same_origin = parts.scheme == "https" and (parts.hostname or "").lower() == origin
            try:
                response = self.get(
                    current, cap=cap, accept=accept, timeout=timeout, jar=jar,
                    extra_headers=extra_headers if same_origin else None,
                )
            except FetchError as error:
                return _result(None, current, redirects, None, error.reason), b"", {}
            location = response.headers.get("location")
            if 300 <= response.status < 400 and location:
                target = urljoin(current, location.strip())
                redirects.append({"status": response.status, "url": redact_url(target)})
                if urlsplit(target).scheme not in ("http", "https"):
                    return (
                        _result(response.status, current, redirects, None, "redirect to a non-web URL"),
                        b"",
                        response.headers,
                    )
                if hop == max_redirects:
                    return (
                        _result(response.status, current, redirects, None, f"more than {max_redirects} redirects"),
                        b"",
                        response.headers,
                    )
                current = target
                continue
            status = response.status
            kind = media_type(response.headers.get("content-type"))
            if 200 <= status < 300:
                return _result(status, current, redirects, kind, None), response.body, response.headers
            return (
                _result(status, current, redirects, kind, http_error(status, response.headers)),
                b"",
                response.headers,
            )
        raise AssertionError("unreachable")


def _result(status, final_url, redirects, content_type, error):
    result = {
        "status": status,
        "alive": error is None and status is not None and 200 <= status < 300,
        "final_url": redact_url(final_url),
        "redirects": list(redirects),
        "content_type": content_type,
    }
    if not result["alive"]:
        result["error"] = error or (http_error(status, {}) if status is not None else "no response")
    return result
