"""Local HTTP server: JSON API + static front end. Binds to 127.0.0.1 only."""
import json
import mimetypes
import os
import re
import threading
import time
import traceback
from datetime import date, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from . import __version__, logic, service
from .db import TABLES

STATIC_DIR = Path(__file__).parent / "static"
APP_ID = "revision-tracker"


def today():
    """Local date. REVISION_TRACKER_TODAY (YYYY-MM-DD) overrides it for testing."""
    fixed = os.environ.get("REVISION_TRACKER_TODAY")
    return date.fromisoformat(fixed) if fixed else date.today()


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


ROUTES = []


def route(method, pattern):
    def deco(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn))
        return fn
    return deco


# ---------------------------------------------------------------- routes

@route("GET", "/api/health")
def health(app, req):
    return {"app": APP_ID, "version": __version__}


@route("GET", "/api/bootstrap")
def bootstrap(app, req):
    s = app.store.settings()
    return {"today": today().isoformat(), "settings": s, "version": __version__,
            "data_dir": str(app.store.data_dir), "db_path": str(app.store.path),
            "statuses": logic.STATUSES, "error_types": logic.ERROR_TYPES, "grades": logic.GRADES,
            "tables": TABLES}


@route("GET", "/api/chapters")
def chapters(app, req):
    return service.list_chapters(app.store, today())


@route("PATCH", r"/api/chapters/(\d+)")
def chapter_patch(app, req, cid):
    return service.update_chapter(app.store, int(cid), req.json(), today())


@route("POST", r"/api/chapters/(\d+)/review")
def chapter_review(app, req, cid):
    body = req.json()
    return service.review_chapter(app.store, int(cid), body.get("confidence"), body.get("note", ""), today())


@route("GET", r"/api/chapters/(\d+)/history")
def chapter_history(app, req, cid):
    return service.chapter_history(app.store, int(cid), today())


@route("DELETE", r"/api/reviews/(\d+)")
def review_delete(app, req, rid):
    return service.delete_review(app.store, int(rid), today())


@route("GET", "/api/due")
def due(app, req):
    return service.due_list(app.store, today())


@route("GET", "/api/papers")
def papers(app, req):
    return service.list_papers(app.store, today())


@route("POST", "/api/papers")
def paper_create(app, req):
    return service.create_paper(app.store, req.json(), today())


@route("PATCH", r"/api/papers/(\d+)")
def paper_patch(app, req, pid):
    return service.update_paper(app.store, int(pid), req.json(), today())


@route("DELETE", r"/api/papers/(\d+)")
def paper_delete(app, req, pid):
    service.delete_row(app.store, "papers", int(pid))
    return {"ok": True}


@route("POST", r"/api/papers/(\d+)/questions")
def question_add(app, req, pid):
    return service.add_question(app.store, int(pid), req.json())


@route("PATCH", r"/api/questions/(\d+)")
def question_patch(app, req, qid):
    return service.update_question(app.store, int(qid), req.json())


@route("DELETE", r"/api/questions/(\d+)")
def question_delete(app, req, qid):
    service.delete_row(app.store, "paper_questions", int(qid))
    return {"ok": True}


@route("GET", "/api/papers/chart")
def paper_chart(app, req):
    return service.paper_chart(app.store, today())


@route("GET", "/api/boundaries")
def boundaries(app, req):
    return service.list_boundaries(app.store)


@route("PUT", "/api/boundaries")
def boundary_put(app, req):
    return service.upsert_boundary(app.store, req.json())


@route("DELETE", r"/api/boundaries/(\d+)")
def boundary_delete(app, req, bid):
    service.delete_row(app.store, "boundaries", int(bid))
    return {"ok": True}


@route("GET", "/api/mistakes")
def mistakes(app, req):
    return service.list_mistakes(app.store, today())


@route("POST", "/api/mistakes")
def mistake_create(app, req):
    return service.create_mistake(app.store, req.json(), today())


@route("PATCH", r"/api/mistakes/(\d+)")
def mistake_patch(app, req, mid):
    return service.update_mistake(app.store, int(mid), req.json(), today())


@route("POST", r"/api/mistakes/(\d+)/retest")
def mistake_retest(app, req, mid):
    return service.retest_mistake(app.store, int(mid), bool(req.json().get("passed")), today())


@route("DELETE", r"/api/mistakes/(\d+)")
def mistake_delete(app, req, mid):
    service.delete_row(app.store, "mistakes", int(mid))
    return {"ok": True}


@route("GET", "/api/dashboard")
def dashboard(app, req):
    return service.dashboard(app.store, today())


@route("GET", "/api/settings")
def settings_get(app, req):
    return app.store.settings()


@route("PUT", "/api/settings")
def settings_put(app, req):
    return app.store.save_settings(req.json())


@route("POST", "/api/settings/reset")
def settings_reset(app, req):
    keys = req.json().get("keys") or []
    return app.store.save_settings({k: logic.DEFAULT_SETTINGS[k] for k in keys
                                    if k in logic.DEFAULT_SETTINGS})


@route("GET", "/api/export/json")
def export_json(app, req):
    stamp = datetime.now().strftime("%Y-%m-%d")
    body = json.dumps(app.store.export_json(), indent=1, ensure_ascii=False).encode("utf-8")
    return RawResponse(body, "application/json", f"revision-tracker-{stamp}.json")


@route("GET", "/api/export/csv")
def export_csv(app, req):
    stamp = datetime.now().strftime("%Y-%m-%d")
    return RawResponse(app.store.export_csv_zip(), "application/zip", f"revision-tracker-csv-{stamp}.zip")


@route("POST", "/api/import/json")
def import_json(app, req):
    app.store.import_json(req.json())
    return {"ok": True}


@route("POST", r"/api/import/csv/(\w+)")
def import_csv(app, req, table):
    n = app.store.import_csv(table, req.body().decode("utf-8-sig"))
    return {"ok": True, "rows": n}


@route("GET", "/api/backups")
def backups(app, req):
    return {"dir": str(app.store.backup_dir), "backups": app.store.list_backups()}


@route("POST", "/api/backups")
def backup_now(app, req):
    p = app.store.backup(label="manual-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    return {"ok": True, "name": p.name}


@route("POST", "/api/backups/restore")
def backup_restore(app, req):
    app.store.restore_backup(str(req.json().get("name", "")))
    return {"ok": True}


@route("POST", "/api/heartbeat")
def heartbeat(app, req):
    app.touch()
    return {"ok": True, "today": today().isoformat()}


@route("POST", "/api/bye")
def bye(app, req):
    app.page_closed()
    return {"ok": True}


@route("POST", "/api/quit")
def quit_app(app, req):
    threading.Thread(target=app.shutdown_soon, args=(0.3,), daemon=True).start()
    return {"ok": True}


# ---------------------------------------------------------------- plumbing

class RawResponse:
    def __init__(self, body, content_type, filename=None):
        self.body, self.content_type, self.filename = body, content_type, filename


class Handler(BaseHTTPRequestHandler):
    server_version = "RevisionTracker"
    app = None  # set by App

    def log_message(self, fmt, *args):  # keep the log quiet; errors are logged separately
        pass

    def body(self):
        if not hasattr(self, "_body"):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 50 * 1024 * 1024:
                raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Upload too large")
            self._body = self.rfile.read(n) if n else b""
        return self._body

    def json(self):
        raw = self.body()
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8-sig"))
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Request body is not valid JSON")
        if not isinstance(data, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Expected a JSON object")
        return data

    def _dispatch(self, method):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            if method != "GET":
                return self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return self._static(path)
        if method != "GET" and not self._same_origin():
            return self._send_json({"error": "Cross-origin request refused"}, HTTPStatus.FORBIDDEN)
        for m, rx, fn in ROUTES:
            if m != method:
                continue
            match = rx.match(path)
            if match:
                try:
                    self.app.store.daily_backup(today())
                    result = fn(self.app, self, *match.groups())
                except ApiError as e:
                    return self._send_json({"error": str(e)}, e.status)
                except service.NotFound as e:
                    return self._send_json({"error": f"{e} not found"}, HTTPStatus.NOT_FOUND)
                except ValueError as e:
                    return self._send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
                except Exception:
                    self.app.log(traceback.format_exc())
                    return self._send_json({"error": "Internal error (see log)"},
                                           HTTPStatus.INTERNAL_SERVER_ERROR)
                if isinstance(result, RawResponse):
                    return self._send(result.body, result.content_type, filename=result.filename)
                return self._send_json(result)
        return self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def _same_origin(self):
        """Refuse state-changing requests from other websites (the server is local-only, but a
        page in another tab could still try to POST to localhost)."""
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        host = self.headers.get("Host", "")
        return urlparse(origin).netloc == host

    def _static(self, path):
        rel = unquote(path).lstrip("/") or "index.html"
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR.resolve() not in target.parents or not target.is_file():
            target = STATIC_DIR / "index.html"
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._send(target.read_bytes(), ctype)

    def _send_json(self, data, status=HTTPStatus.OK):
        self._send(json.dumps(data, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8", status)

    def _send(self, body, ctype, status=HTTPStatus.OK, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")


class App:
    """Owns the store and HTTP server, and shuts down once the window has gone away."""

    IDLE_TIMEOUT = 180       # seconds without a heartbeat before quitting
    FIRST_CONTACT = 300      # seconds to wait for the window to connect at all
    CLOSE_GRACE = 45         # after a page says goodbye (allows reloads and other open windows)
    WATCH_INTERVAL = 5       # seconds between watchdog checks
    SLEEP_GAP = 30           # a longer gap between checks means the computer slept

    def __init__(self, store, port, log_fn=print, auto_exit=True):
        self.store = store
        self.log = log_fn
        handler = type("BoundHandler", (Handler,), {"app": self})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.started = time.monotonic()
        self.last_seen = None
        self.closed_at = None
        self.auto_exit = auto_exit
        self._stopping = threading.Event()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}/"

    def touch(self):
        self.last_seen = time.monotonic()
        self.closed_at = None

    def page_closed(self):
        self.closed_at = time.monotonic()

    def _watchdog(self):
        last_tick = time.monotonic()
        while not self._stopping.wait(self.WATCH_INTERVAL):
            now = time.monotonic()
            if now - last_tick > self.SLEEP_GAP:
                # The computer was asleep: give the window a chance to reconnect.
                if self.last_seen is not None:
                    self.last_seen = now
                self.closed_at = None
            last_tick = now
            if self.closed_at and now - self.closed_at > self.CLOSE_GRACE:
                self.log("Window closed; shutting down.")
                break
            if self.last_seen is None and now - self.started > self.FIRST_CONTACT:
                self.log("No window connected; shutting down.")
                break
            if self.last_seen is not None and now - self.last_seen > self.IDLE_TIMEOUT:
                self.log("No heartbeat; shutting down.")
                break
        else:
            return
        self.shutdown_soon(0)

    def shutdown_soon(self, delay):
        time.sleep(delay)
        self._stopping.set()
        self.httpd.shutdown()

    def serve(self):
        if self.auto_exit:
            threading.Thread(target=self._watchdog, daemon=True).start()
        try:
            self.httpd.serve_forever(poll_interval=0.5)
        finally:
            self._stopping.set()
            self.httpd.server_close()
