"""The enrichment web client: redirects walked and recorded, the 256 KB cap,
one retry, pacing, and the public-address guard. No network.

Run: python3 -I -m unittest discover -s tests -v
"""

import socket
import ssl
import sys
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from linking import web  # noqa: E402


class FakeClock:
    """A clock that only moves when something sleeps (or a test advances it)."""

    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class FakeResponse:
    def __init__(self, status, headers=None, body=b""):
        self.status = status
        self.headers = dict(headers or {})
        self._body = body
        self._offset = 0
        self.read_sizes = []
        self.closed = False

    def read(self, size):
        self.read_sizes.append(size)
        chunk = self._body[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    @property
    def bytes_read(self):
        return self._offset

    def close(self):
        self.closed = True


class FakeTransport:
    """Answers by URL from a script: each URL maps to a list of responses or
    exceptions, used in order (the last one repeats)."""

    def __init__(self, script):
        self.script = {url: list(answers) if isinstance(answers, list) else [answers] for url, answers in script.items()}
        self.calls = []
        self.responses = []

    def __call__(self, url, headers, timeout, jar):
        self.calls.append((url, dict(headers), timeout))
        answers = self.script.get(url)
        if not answers:
            raise urllib.error.URLError(socket.gaierror(socket.EAI_NONAME, "not known"))
        answer = answers.pop(0) if len(answers) > 1 else answers[0]
        if isinstance(answer, BaseException):
            raise answer
        if isinstance(answer, tuple):
            answer = FakeResponse(*answer)
        self.responses.append(answer)
        return answer


def public_resolver(addresses=None):
    """A getaddrinfo stand-in: every host is 93.184.216.34 unless listed."""
    addresses = addresses or {}

    def resolve(host, port, proto=0):
        address = addresses.get(host, "93.184.216.34")
        if address is None:
            raise socket.gaierror(socket.EAI_NONAME, "not known")
        return [(socket.AF_INET, socket.SOCK_STREAM, proto, "", (address, port))]

    return resolve


def client(script, *, addresses=None):
    clock = FakeClock()
    transport = FakeTransport(script)
    return web.Client(transport=transport, resolve=public_resolver(addresses), sleep=clock.sleep, clock=clock), transport, clock


class FollowTest(unittest.TestCase):
    def test_the_chain_is_recorded_and_relative_locations_resolved(self):
        c, transport, _ = client(
            {
                "http://a.example/post": (301, {"Location": "https://a.example/post"}),
                "https://a.example/post": (302, {"Location": "/2011/post/"}),
                "https://a.example/2011/post/": (200, {"Content-Type": "text/html; charset=UTF-8"}, b"<html>"),
            }
        )
        result, body = c.follow("http://a.example/post")
        self.assertEqual(
            result,
            {
                "status": 200,
                "alive": True,
                "final_url": "https://a.example/2011/post/",
                "redirects": [
                    {"status": 301, "url": "https://a.example/post"},
                    {"status": 302, "url": "https://a.example/2011/post/"},
                ],
                "content_type": "text/html",
            },
        )
        self.assertEqual(body, b"<html>")
        self.assertEqual(len(transport.calls), 3)
        self.assertNotIn("error", result)

    def test_five_redirects_are_followed(self):
        script = {f"https://r.example/{n}": (301, {"Location": f"/{n + 1}"}) for n in range(5)}
        script["https://r.example/5"] = (200, {}, b"ok")
        c, transport, _ = client(script)
        result, _ = c.follow("https://r.example/0")
        self.assertTrue(result["alive"])
        self.assertEqual(len(result["redirects"]), 5)
        self.assertEqual(len(transport.calls), 6)

    def test_a_sixth_redirect_is_not_followed(self):
        script = {f"https://r.example/{n}": (302, {"Location": f"/{n + 1}"}) for n in range(10)}
        c, transport, _ = client(script)
        result, _ = c.follow("https://r.example/0")
        self.assertFalse(result["alive"])
        self.assertEqual(result["error"], "more than 5 redirects")
        self.assertEqual(result["status"], 302)
        self.assertEqual(len(transport.calls), 6)
        self.assertEqual(result["final_url"], "https://r.example/5")

    def test_a_redirect_loop_ends_at_the_limit(self):
        c, transport, _ = client({"https://loop.example/": (301, {"Location": "https://loop.example/"})})
        result, _ = c.follow("https://loop.example/")
        self.assertFalse(result["alive"])
        self.assertEqual(len(transport.calls), 6)

    def test_http_errors_are_dead_with_the_reason(self):
        c, _, _ = client({"https://gone.example/x": (404, {"Content-Type": "text/html"})})
        result, body = c.follow("https://gone.example/x")
        self.assertEqual((result["status"], result["alive"], result["error"]), (404, False, "HTTP 404"))
        self.assertEqual(result["content_type"], "text/html")
        self.assertEqual(body, b"")

    def test_a_cloudflare_challenge_is_named(self):
        c, _, _ = client({"https://cf.example/": (403, {"cf-mitigated": "challenge"})})
        result, _ = c.follow("https://cf.example/")
        self.assertEqual(result["error"], "HTTP 403 (Cloudflare challenge)")

    def test_datadome_and_vercel_walls_are_named(self):
        c, _, _ = client({
            "https://dd.example/": (403, {"x-datadome": "protected", "server": "DataDome"}),
            "https://vc.example/": (429, {"x-vercel-mitigated": "challenge"}),
            "https://plain.example/": (403, {"server": "cloudflare"}),
        })
        self.assertEqual(c.follow("https://dd.example/")[0]["error"], "HTTP 403 (DataDome)")
        self.assertEqual(c.follow("https://vc.example/")[0]["error"], "HTTP 429 (Vercel challenge)")
        self.assertEqual(c.follow("https://plain.example/")[0]["error"], "HTTP 403")

    def test_a_challenge_is_not_retried(self):
        c, transport, clock = client({"https://vc.example/": (429, {"x-vercel-mitigated": "challenge"})})
        c.follow("https://vc.example/")
        self.assertEqual(c.requests, 1)

    def test_a_redirect_that_ends_in_an_error_is_dead(self):
        c, _, _ = client(
            {
                "https://moved.example/a": (301, {"Location": "https://new.example/a"}),
                "https://new.example/a": (410, {}),
            }
        )
        result, _ = c.follow("https://moved.example/a")
        self.assertFalse(result["alive"])
        self.assertEqual(result["final_url"], "https://new.example/a")
        self.assertEqual(result["redirects"], [{"status": 301, "url": "https://new.example/a"}])

    def test_a_3xx_without_location_is_dead(self):
        c, _, _ = client({"https://odd.example/": (300, {})})
        result, _ = c.follow("https://odd.example/")
        self.assertEqual((result["alive"], result["error"]), (False, "HTTP 300"))

    def test_a_redirect_to_an_app_url_stops(self):
        c, transport, _ = client({"https://app.example/": (302, {"Location": "itms-apps://apps.apple.com/app/1"})})
        result, _ = c.follow("https://app.example/")
        self.assertFalse(result["alive"])
        self.assertEqual(result["error"], "redirect to a non-web URL")
        self.assertEqual(len(transport.calls), 1)

    def test_network_failures_have_short_reasons(self):
        cases = [
            (urllib.error.URLError(socket.gaierror(socket.EAI_NONAME, "nodename nor servname")), "dns: name does not resolve"),
            (urllib.error.URLError(TimeoutError("timed out")), "timeout"),
            (TimeoutError("timed out"), "timeout"),
            (urllib.error.URLError(ConnectionRefusedError(61, "Connection refused")), "connection refused"),
            (ConnectionResetError(54, "reset"), "connection reset"),
        ]
        for error, reason in cases:
            c, _, _ = client({"https://x.example/": error})
            result, _ = c.follow("https://x.example/")
            self.assertEqual(result["status"], None)
            self.assertFalse(result["alive"])
            self.assertEqual(result["error"], reason)
            self.assertEqual(result["content_type"], None)

    def test_certificate_errors_name_the_problem(self):
        error = ssl.SSLCertVerificationError(1, "certificate verify failed")
        error.verify_message = "certificate has expired"
        self.assertEqual(web.describe_error(urllib.error.URLError(error)), "tls: certificate has expired")

    def test_the_user_agent_names_the_site(self):
        c, transport, _ = client({"https://x.example/": (200, {}, b"")})
        c.follow("https://x.example/")
        self.assertEqual(transport.calls[0][1]["User-Agent"], "LinkingThings/0.1 (+https://links.thingelstad.xyz)")
        self.assertEqual(transport.calls[0][2], 15)

    def test_recorded_urls_lose_credential_values(self):
        c, _, _ = client(
            {
                "https://s.example/f": (302, {"Location": "https://bucket.example/f?X-Amz-Signature=abc&v=2"}),
                "https://bucket.example/f?X-Amz-Signature=abc&v=2": (200, {}, b""),
            }
        )
        result, _ = c.follow("https://s.example/f")
        self.assertEqual(result["final_url"], "https://bucket.example/f?X-Amz-Signature=REDACTED&v=2")
        self.assertEqual(result["redirects"][0]["url"], "https://bucket.example/f?X-Amz-Signature=REDACTED&v=2")


class CapTest(unittest.TestCase):
    def test_never_reads_more_than_256_kb(self):
        big = FakeResponse(200, {"Content-Type": "text/html"}, b"x" * (3 * 1024 * 1024))
        c, _, _ = client({"https://big.example/": big})
        result, body = c.follow("https://big.example/")
        self.assertTrue(result["alive"])
        self.assertEqual(big.bytes_read, 256 * 1024)
        self.assertLessEqual(sum(big.read_sizes), 256 * 1024)
        self.assertEqual(len(body), 256 * 1024)
        self.assertTrue(big.closed)

    def test_the_last_read_asks_only_for_what_is_left(self):
        big = FakeResponse(200, {}, b"x" * 500_000)
        c, _, _ = client({"https://odd.example/": big})
        _, body = c.follow("https://odd.example/", cap=100_000)
        self.assertEqual(big.bytes_read, 100_000)
        self.assertEqual(len(body), 100_000)
        self.assertTrue(all(size <= 100_000 for size in big.read_sizes))

    def test_a_short_body_is_read_to_its_end(self):
        small = FakeResponse(200, {}, b"hello")
        c, _, _ = client({"https://small.example/": small})
        _, body = c.follow("https://small.example/")
        self.assertEqual(body, b"hello")

    def test_redirect_and_error_bodies_are_not_read(self):
        hop = FakeResponse(301, {"Location": "https://b.example/"}, b"moved" * 1000)
        gone = FakeResponse(404, {}, b"not found" * 1000)
        c, _, _ = client({"https://a.example/": hop, "https://b.example/": gone})
        c.follow("https://a.example/")
        self.assertEqual(hop.read_sizes, [])
        self.assertEqual(gone.read_sizes, [])
        self.assertTrue(hop.closed and gone.closed)

    def test_cap_zero_reads_nothing(self):
        page = FakeResponse(200, {}, b"body")
        c, _, _ = client({"https://h.example/": page})
        c.follow("https://h.example/", cap=0)
        self.assertEqual(page.read_sizes, [])


class RetryTest(unittest.TestCase):
    def test_a_5xx_is_retried_once_after_a_longer_wait(self):
        c, transport, clock = client({"https://busy.example/": [(503, {}), (200, {}, b"ok")]})
        result, _ = c.follow("https://busy.example/")
        self.assertTrue(result["alive"])
        self.assertEqual(len(transport.calls), 2)
        self.assertIn(web.RETRY_WAIT_SECONDS, clock.sleeps)

    def test_a_429_is_retried_once_never_twice(self):
        c, transport, _ = client({"https://slow.example/": [(429, {}), (429, {}), (200, {})]})
        result, _ = c.follow("https://slow.example/")
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual((result["status"], result["alive"]), (429, False))

    def test_retry_after_is_honoured_up_to_a_minute(self):
        self.assertEqual(web.retry_wait("30"), 30.0)
        self.assertEqual(web.retry_wait("3600"), 60.0)
        self.assertEqual(web.retry_wait("1"), web.RETRY_WAIT_SECONDS)
        self.assertEqual(web.retry_wait("Wed, 21 Oct 2026 07:28:00 GMT"), web.RETRY_WAIT_SECONDS)

    def test_a_404_is_not_retried(self):
        c, transport, _ = client({"https://x.example/": [(404, {}), (200, {})]})
        c.follow("https://x.example/")
        self.assertEqual(len(transport.calls), 1)


class PacingTest(unittest.TestCase):
    def test_one_request_a_second_per_host(self):
        c, _, clock = client(
            {
                "https://a.example/1": (200, {}),
                "https://a.example/2": (200, {}),
                "https://b.example/1": (200, {}),
            }
        )
        c.follow("https://a.example/1")
        c.follow("https://b.example/1")
        self.assertEqual(clock.sleeps, [])
        c.follow("https://a.example/2")
        self.assertEqual(clock.sleeps, [1.0])

    def test_the_wayback_machine_gets_six_seconds(self):
        c, _, clock = client({"https://web.archive.org/cdx/search/cdx?a": (200, {}, b"[]")})
        c.follow("https://web.archive.org/cdx/search/cdx?a")
        clock.now += 2
        c.follow("https://web.archive.org/cdx/search/cdx?a")
        self.assertEqual(clock.sleeps, [4.0])

    def test_spacing_counts_from_the_end_of_a_request(self):
        clock = FakeClock()
        gate = web.Gate(sleep=clock.sleep, clock=clock)
        with gate.slot("h", 1.0):
            clock.now += 5  # a slow request
        with gate.slot("h", 1.0):
            pass
        self.assertEqual(clock.sleeps, [1.0])


class GuardTest(unittest.TestCase):
    def test_private_addresses_are_never_fetched(self):
        for address in ("127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "::1", "0.0.0.0"):
            c, transport, _ = client({"http://router.example/": (200, {})}, addresses={"router.example": address})
            result, _ = c.follow("http://router.example/")
            self.assertEqual(result["error"], "resolves to a non-public address; not fetched", address)
            self.assertEqual(transport.calls, [])

    def test_a_redirect_into_a_private_network_stops_there(self):
        c, transport, _ = client(
            {"https://pub.example/": (302, {"Location": "http://intranet.example/"})},
            addresses={"intranet.example": "10.0.0.5"},
        )
        result, _ = c.follow("https://pub.example/")
        self.assertFalse(result["alive"])
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(result["redirects"], [{"status": 302, "url": "http://intranet.example/"}])

    def test_a_name_that_does_not_resolve_costs_no_request(self):
        c, transport, _ = client({}, addresses={"gone.example": None})
        result, _ = c.follow("https://gone.example/")
        self.assertEqual(result["error"], "dns: name does not resolve")
        self.assertEqual(transport.calls, [])

    def test_only_web_urls(self):
        c, transport, _ = client({})
        result, _ = c.follow("ftp://files.example/a")
        self.assertEqual(result["error"], "not an http or https URL")
        self.assertEqual(transport.calls, [])


class UrlTest(unittest.TestCase):
    def test_iri_to_uri(self):
        self.assertEqual(web.iri_to_uri("https://example.com/café?q=a b#frag"), "https://example.com/caf%C3%A9?q=a%20b")
        self.assertEqual(web.iri_to_uri("https://example.com/a%2Fb?x=%20"), "https://example.com/a%2Fb?x=%20")
        self.assertEqual(web.iri_to_uri("https://bücher.example/"), "https://xn--bcher-kva.example/")
        self.assertEqual(web.iri_to_uri("https://example.com"), "https://example.com/")

    def test_redact_url_keeps_ordinary_queries(self):
        self.assertEqual(web.redact_url("https://e.com/a?id=1&page=2"), "https://e.com/a?id=1&page=2")
        self.assertEqual(web.redact_url("https://e.com/a?token=abc&id=1"), "https://e.com/a?token=REDACTED&id=1")
        self.assertEqual(web.redact_url("https://e.com/a?Session=abc"), "https://e.com/a?Session=REDACTED")

    def test_media_type(self):
        self.assertEqual(web.media_type("Text/HTML; charset=utf-8"), "text/html")
        self.assertIsNone(web.media_type(None))
        self.assertIsNone(web.media_type(""))


if __name__ == "__main__":
    unittest.main()
