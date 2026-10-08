#!/usr/bin/env python3
"""A local stand-in for the portal, for testing the room (rummet/).

Serves this repo's files and the two file-API routes the room uses, with the
portal's own read_file and write_file (scripts/dashboard/files.py in
generalassistant) behind them, so the mtime check and the atomic write are the
real ones. Every path the room asks for under /home/henric/generalassistant is
moved into --rot first, and the allowlist is that folder alone: nothing
outside it can be read or written.

    python3 scripts/rummet_provserver.py --rot /tmp/rum --port 8765
    python3 scripts/rummet_provserver.py --rot /tmp/rum --utan-api     # the public site, read-only

--uploads DIR serves a built copy (scripts/rummet_deploy.py) at
/uploads/glimt-rummet/, as the portal does.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import mimetypes
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

REPO = Path(__file__).resolve().parents[1]
GA = "/home/henric/generalassistant"
FILES_PY = Path(GA) / "scripts" / "dashboard" / "files.py"


def load_files_api(rot: Path):
    if not FILES_PY.is_file():
        sys.exit(f"Needs the portal's file module: {FILES_PY}")
    spec = importlib.util.spec_from_file_location("portal_files", FILES_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.ALLOWED_ROOTS = [rot.resolve()]
    return mod


def make_handler(files_api, rot: Path, uploads: Path | None, api: bool):
    rot = rot.resolve()

    def moved(raw: str) -> Path | None:
        """The room's absolute path, moved into the sandbox. None if it is not
        one of ours or would leave the sandbox."""
        if not raw.startswith(GA + "/") or ".." in raw:
            return None
        p = rot / raw[len(GA) + 1:]
        return p if files_api.is_path_allowed(p) else None

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args) -> None:  # quiet
            pass

        def _send(self, status: int, body: bytes, ctype: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj: dict, status: int = 200) -> None:
            self._send(status, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

        def _same_origin(self) -> bool:
            host = self.headers.get("Host", "")
            for src in (self.headers.get("Origin", ""), self.headers.get("Referer", "")):
                if src and urlparse(src).netloc == host:
                    return True
            return False

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            if path == "/api/files/read":
                if not api:
                    self._send(404, b"not found", "text/html")
                    return
                target = moved((parse_qs(parsed.query).get("path", [""])[0] or "").strip())
                if target is None:
                    self._json({"error": "outside allowlist"}, 403)
                    return
                try:
                    self._json(files_api.read_file(target))
                except FileNotFoundError:
                    self._json({"error": "not found"}, 404)
                except PermissionError as e:
                    self._json({"error": str(e)}, 403)
                return
            if uploads and path.startswith("/uploads/glimt-rummet/"):
                self._static(uploads, path[len("/uploads/glimt-rummet/"):])
                return
            self._static(REPO, path.lstrip("/"))

        def _static(self, base: Path, rel: str) -> None:
            if rel == "" or rel.endswith("/"):
                rel += "index.html"
            target = (base / rel).resolve()
            try:
                target.relative_to(base.resolve())
            except ValueError:
                self._send(403, b"forbidden", "text/plain")
                return
            if not target.is_file():
                self._send(404, b"not found", "text/html")
                return
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            if target.suffix == ".md":
                ctype = "text/markdown; charset=utf-8"
            if target.suffix in (".js", ".mjs"):
                ctype = "application/javascript; charset=utf-8"
            self._send(200, target.read_bytes(), ctype)

        def do_POST(self) -> None:
            if urlparse(self.path).path != "/api/files/write" or not api:
                self._send(404, b"not found", "text/html")
                return
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if not self._same_origin():
                self._json({"error": "bad origin"}, 403)
                return
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._json({"error": "invalid json"}, 400)
                return
            target = moved(data.get("path", ""))
            if target is None:
                self._json({"error": "outside allowlist"}, 403)
                return
            content = data.get("content", "")
            if not isinstance(content, str):
                self._json({"error": "content must be string"}, 400)
                return
            try:
                result = files_api.write_file(target, content, data.get("expected_mtime"))
            except FileExistsError:
                current = target.stat().st_mtime if target.exists() else None
                self._json({"error": "mtime mismatch", "current_mtime": current}, 409)
                return
            except (PermissionError, FileNotFoundError, ValueError) as e:
                self._json({"error": str(e)}, 400)
                return
            self._json(result)

    return Handler


def serve(rot: Path, port: int = 0, uploads: Path | None = None, api: bool = True) -> ThreadingHTTPServer:
    rot.mkdir(parents=True, exist_ok=True)
    files_api = load_files_api(rot)
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(files_api, rot, uploads, api))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--rot", required=True, type=Path, help="sandbox folder that stands in for generalassistant")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--uploads", type=Path, default=None)
    ap.add_argument("--utan-api", action="store_true", help="no file API: the room falls back to read-only")
    args = ap.parse_args()
    server = serve(args.rot, args.port, args.uploads, api=not args.utan_api)
    print(f"http://127.0.0.1:{server.server_address[1]}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
