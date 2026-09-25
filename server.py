#!/usr/bin/env python3
"""Local server for the ENGR101 office hours dashboard."""

import json
import os
import shutil
import ssl
import subprocess
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

QUEUE_API = "https://eecsoh.eecs.umich.edu/api/queues/1xHcWfn2KW5HHly5Y3rLA2g5kW2"
QUEUE_ID = "1xHcWfn2KW5HHly5Y3rLA2g5kW2"
PORT = 8080
ROOT = Path(__file__).resolve().parent
SESSION_FILE = ROOT / ".eecsoh_session"
STAFF_OVERRIDES_FILE = ROOT / "staff-overrides.json"
stored_session = None


def normalize_cookie(cookie):
    if not cookie:
        return None
    cookie = cookie.strip()
    if not cookie:
        return None

    # Prefer an explicit session= pair from document.cookie / pasted headers.
    pairs = [part.strip() for part in cookie.split(";") if part.strip()]
    for part in pairs:
        if part.lower().startswith("session="):
            value = part.split("=", 1)[1].strip()
            return f"session={value}" if value else None

    # Bare token with no key=value — treat as the session value.
    if len(pairs) == 1 and "=" not in pairs[0]:
        return f"session={pairs[0]}"

    # Malformed input (e.g. my_session=value) — do not forward as a Cookie header.
    return None


def identity_fields(entry):
    if not isinstance(entry, dict):
        return {}

    found = {}
    keys = (
        "email",
        "uniqname",
        "username",
        "student_email",
        "name",
        "first_name",
        "last_name",
        "full_name",
        "display_name",
        "firstName",
        "lastName",
        "displayName",
    )
    for key in keys:
        value = entry.get(key)
        if value:
            found[key] = value

    for nest_key in ("user", "student", "owner", "account", "profile", "creator", "member"):
        nested = entry.get(nest_key)
        if isinstance(nested, dict):
            found.update(identity_fields(nested))
    return found


def entry_has_identity(entry):
    return bool(identity_fields(entry))


def load_session():
    global stored_session
    if SESSION_FILE.is_file():
        stored_session = normalize_cookie(SESSION_FILE.read_text().strip()) or None
    return stored_session


def save_session(cookie):
    global stored_session
    stored_session = normalize_cookie(cookie)
    if stored_session:
        SESSION_FILE.write_text(stored_session)
    elif SESSION_FILE.is_file():
        SESSION_FILE.unlink()


def clear_session():
    save_session(None)


def get_active_cookie(handler=None):
    if handler:
        header_cookie = handler.headers.get("X-Queue-Cookie")
        if header_cookie:
            return normalize_cookie(header_cookie)
    env_cookie = os.environ.get("EECSOH_COOKIE")
    if env_cookie:
        return normalize_cookie(env_cookie)
    return stored_session


try:
    import certifi
    DEFAULT_CAFILE = certifi.where()
except ImportError:
    DEFAULT_CAFILE = None


def session_status(cookie=None):
    cookie = normalize_cookie(cookie)
    if not cookie:
        return {"connected": False, "names_visible": False, "uniqnames_visible": False}

    # Verify session against authenticated user endpoint
    try:
        user_info, user_status = fetch_json("https://eecsoh.eecs.umich.edu/api/users/@me", cookie=cookie)
        if user_status == 200 and isinstance(user_info, dict):
            return {
                "connected": True,
                "names_visible": True,
                "uniqnames_visible": True,
                "user": user_info.get("email") or user_info.get("name") or True,
            }
        return {
            "connected": False,
            "invalid": True,
            "expired": True,
            "names_visible": False,
            "uniqnames_visible": False,
        }
    except Exception:
        pass

    try:
        data, status = fetch_json(QUEUE_API, cookie=cookie)
        if status in (401, 403) or status != 200:
            return {"connected": False, "names_visible": False, "uniqnames_visible": False, "invalid": True}

        queue = data.get("queue") or []
        if any(entry_has_identity(entry) for entry in queue):
            return {"connected": True, "names_visible": True, "uniqnames_visible": True}

        if queue:
            entry_id = queue[0].get("id")
            if entry_id:
                detail, detail_status = fetch_json(
                    f"https://eecsoh.eecs.umich.edu/api/queues/{QUEUE_ID}/entries/{entry_id}",
                    cookie=cookie,
                )
                if detail_status == 200 and entry_has_identity(detail):
                    return {"connected": True, "names_visible": True, "uniqnames_visible": True}
                if detail_status in (401, 403):
                    return {
                        "connected": False,
                        "names_visible": False,
                        "uniqnames_visible": False,
                        "staff_required": True,
                    }

        return {"connected": False, "names_visible": False, "uniqnames_visible": False}
    except Exception:
        return {"connected": False, "names_visible": False, "uniqnames_visible": False, "invalid": True}


def fetch_json(url, cookie=None):
    headers = {}
    if cookie:
        headers["Cookie"] = cookie

    try:
        context = ssl.create_default_context(cafile=DEFAULT_CAFILE) if DEFAULT_CAFILE else ssl.create_default_context()
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=10, context=context) as resp:
            return json.loads(resp.read().decode()), resp.status
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        try:
            return json.loads(body), exc.code
        except json.JSONDecodeError:
            raise urllib.error.URLError(body or exc.reason) from exc
    except (urllib.error.URLError, ssl.SSLError):
        if shutil.which("curl"):
            cmd = ["curl", "-s", "-w", "\n__HTTP__:%{http_code}", url]
            if cookie:
                cmd.extend(["-H", f"Cookie: {cookie}"])
            result = subprocess.run(cmd, capture_output=True, text=True)
            if not result.stdout:
                raise urllib.error.URLError(result.stderr or "curl failed")
            output, _, code_part = result.stdout.rpartition("\n__HTTP__:")
            code = int(code_part)
            if output:
                try:
                    return json.loads(output), code
                except json.JSONDecodeError:
                    pass
            if code >= 400:
                raise urllib.error.URLError(output or f"HTTP {code}")
            raise urllib.error.URLError("Empty response from API")
        raise


def enrich_queue_entries(data, cookie):
    queue = data.get("queue") or []
    if not queue or not cookie:
        return data, False

    if any(entry_has_identity(entry) for entry in queue):
        for i, entry in enumerate(queue):
            queue[i] = {**entry, **identity_fields(entry)}
        data["queue"] = queue
        return data, True

    enriched = []
    visible = False
    staff_blocked = False
    for entry in queue:
        entry_id = entry.get("id")
        if not entry_id:
            enriched.append(entry)
            continue

        try:
            detail, status = fetch_json(
                f"https://eecsoh.eecs.umich.edu/api/queues/{QUEUE_ID}/entries/{entry_id}",
                cookie=cookie,
            )
        except (urllib.error.URLError, ssl.SSLError, subprocess.CalledProcessError, json.JSONDecodeError):
            enriched.append(entry)
            continue

        if status in (401, 403):
            staff_blocked = True
            enriched.append(entry)
            continue

        if status == 200 and isinstance(detail, dict):
            merged = {**entry, **detail, **identity_fields(detail)}
            enriched.append(merged)
            visible = visible or entry_has_identity(merged)
        else:
            enriched.append(entry)

    data["queue"] = enriched
    data["_dashboard_meta"] = {"staff_required": staff_blocked and not visible}
    return data, visible


def fetch_queue_data(cookie=None):
    cookie = normalize_cookie(cookie)
    data, _ = fetch_json(QUEUE_API, cookie=cookie)

    authenticated = False
    names_visible = False
    staff_required = False
    session_expired = False

    if cookie:
        try:
            user_info, user_status = fetch_json("https://eecsoh.eecs.umich.edu/api/users/@me", cookie=cookie)
            if user_status == 200:
                authenticated = True
                data, names_visible = enrich_queue_entries(data, cookie)
                meta = data.pop("_dashboard_meta", {}) or {}
                staff_required = bool(meta.get("staff_required"))
                names_visible = not staff_required
            elif user_status in (401, 403):
                session_expired = True
            else:
                data, names_visible = enrich_queue_entries(data, cookie)
        except Exception:
            data, names_visible = enrich_queue_entries(data, cookie)

    data["_dashboard"] = {
        "authenticated": authenticated,
        "session_expired": session_expired,
        "names_visible": names_visible,
        "uniqnames_visible": names_visible,
        "staff_required": staff_required,
    }
    return data


def load_staff_overrides():
    if not STAFF_OVERRIDES_FILE.is_file():
        return {"overrides": {}, "updatedAt": None}
    return json.loads(STAFF_OVERRIDES_FILE.read_text())


def save_staff_overrides(payload):
    STAFF_OVERRIDES_FILE.write_text(json.dumps(payload, indent=2) + "\n")


def staff_request_authorized(handler):
    return handler.headers.get("X-Staff-Auth") == "ok"


class DashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")

    def request_path(self):
        return urlparse(self.path).path

    def _send_json(self, status, payload, cors=False, send_body=True):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        if cors:
            origin = self.headers.get("Origin", "")
            if "eecsoh.eecs.umich.edu" in origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _send_file(self, path, content_type, send_body=True):
        if not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode())

    def do_HEAD(self):
        self.do_GET(send_body=False)

    def do_OPTIONS(self):
        if self.request_path() == "/api/session":
            self.send_response(204)
            origin = self.headers.get("Origin", "")
            if "eecsoh.eecs.umich.edu" in origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            return
        self.send_error(404)

    def do_POST(self):
        if self.request_path() == "/api/staff-overrides":
            if not staff_request_authorized(self):
                self._send_json(401, {"ok": False, "error": "Staff login required"})
                return
            try:
                payload = self._read_json_body()
                if "overrides" not in payload:
                    self._send_json(400, {"ok": False, "error": "Missing overrides"})
                    return
                save_staff_overrides(payload)
                self._send_json(200, payload)
            except json.JSONDecodeError:
                self._send_json(400, {"ok": False, "error": "Invalid JSON"})
            return

        if self.request_path() == "/api/session":
            try:
                body = self._read_json_body()
                cookie = body.get("cookie", "")
                if not cookie:
                    self._send_json(400, {"ok": False, "error": "Missing cookie"}, cors=True)
                    return
                save_session(cookie)
                status = session_status(stored_session)
                self._send_json(200, {"ok": True, **status}, cors=True)
            except json.JSONDecodeError:
                self._send_json(400, {"ok": False, "error": "Invalid JSON"}, cors=True)
            return
        self.send_error(404)

    def do_DELETE(self):
        if self.request_path() == "/api/session":
            clear_session()
            self._send_json(200, {"ok": True, "connected": False})
            return
        self.send_error(404)

    def do_GET(self, send_body=True):
        path = self.request_path()

        if path == "/api/session":
            self._send_json(200, session_status(get_active_cookie(self)), send_body=send_body)
            return

        if path == "/api/queue":
            cookie = get_active_cookie(self)
            try:
                self._send_json(200, fetch_queue_data(cookie=cookie), send_body=send_body)
            except (urllib.error.URLError, ssl.SSLError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
                self._send_json(502, {"error": f"Failed to fetch queue data: {exc}"}, send_body=send_body)
            return

        if path == "/api/schedule":
            schedule_path = ROOT / "schedule.json"
            if not schedule_path.is_file():
                self._send_json(404, {"error": "schedule.json not found. Run parse_schedule.py first."}, send_body=send_body)
                return
            self._send_file(schedule_path, "application/json; charset=utf-8", send_body=send_body)
            return

        if path == "/api/staff-overrides":
            self._send_json(200, load_staff_overrides(), send_body=send_body)
            return

        routes = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/index.html": ("index.html", "text/html; charset=utf-8"),
            "/styles.css": ("styles.css", "text/css; charset=utf-8"),
            "/app.js": ("app.js", "application/javascript; charset=utf-8"),
            "/staff-config.js": ("staff-config.js", "application/javascript; charset=utf-8"),
            "/queue-proxy-config.js": ("queue-proxy-config.js", "application/javascript; charset=utf-8"),
            "/schedule.json": ("schedule.json", "application/json; charset=utf-8"),
            "/queue-snapshot.json": ("queue-snapshot.json", "application/json; charset=utf-8"),
        }
        if path in routes:
            filename, content_type = routes[path]
            self._send_file(ROOT / filename, content_type, send_body=send_body)
            return

        self.send_error(404)


def main():
    load_session()
    server = HTTPServer(("127.0.0.1", PORT), DashboardHandler)
    print(f"ENGR101 dashboard running at http://127.0.0.1:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
