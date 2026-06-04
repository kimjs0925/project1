from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import json
import mimetypes
import os
import re
import socket


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / ".data"
STATE_PATH = DATA_DIR / "conflict-state.json"
PORT = int(os.environ.get("PORT", "3000"))
HOST = os.environ.get("HOST", "0.0.0.0")

EMPTY_STATE = {
    "padletUrl": "",
    "notebooklmUrl": "",
    "situations": [],
    "chars": [],
    "students": {},
    "analysis": {"summary": "", "frequency": {}, "details": "", "updatedAt": ""},
}

BLOCKED_NAMES = {".env", "openaiapi.env", "제미나이.env.txt"}


def normalize_state(value):
    source = value if isinstance(value, dict) else {}
    analysis = source.get("analysis") if isinstance(source.get("analysis"), dict) else {}
    return {
        "padletUrl": source.get("padletUrl") if isinstance(source.get("padletUrl"), str) else "",
        "notebooklmUrl": source.get("notebooklmUrl") if isinstance(source.get("notebooklmUrl"), str) else "",
        "situations": source.get("situations") if isinstance(source.get("situations"), list) else [],
        "chars": source.get("chars") if isinstance(source.get("chars"), list) else [],
        "students": source.get("students") if isinstance(source.get("students"), dict) else {},
        "analysis": {
            "summary": analysis.get("summary") if isinstance(analysis.get("summary"), str) else "",
            "frequency": analysis.get("frequency") if isinstance(analysis.get("frequency"), dict) else {},
            "details": analysis.get("details") if isinstance(analysis.get("details"), str) else "",
            "updatedAt": analysis.get("updatedAt") if isinstance(analysis.get("updatedAt"), str) else "",
        },
    }


def read_state():
    if not STATE_PATH.exists():
        return dict(EMPTY_STATE)
    try:
        return normalize_state(json.loads(STATE_PATH.read_text(encoding="utf-8")))
    except Exception:
        return dict(EMPTY_STATE)


def write_state(state):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(normalize_state(state), ensure_ascii=False, indent=2), encoding="utf-8")


def get_class_settings(state):
    return {
        "padletUrl": state.get("padletUrl", ""),
        "notebooklmUrl": state.get("notebooklmUrl", ""),
        "situations": state.get("situations", []),
        "chars": state.get("chars", []),
        "analysis": state.get("analysis", EMPTY_STATE["analysis"]),
    }


def merge_students(base_students, incoming_students):
    merged = json.loads(json.dumps(base_students or {}, ensure_ascii=False))
    for student_id, student in (incoming_students or {}).items():
        merged.setdefault(student_id, {"responses": {}})
        merged[student_id].setdefault("responses", {})
        responses = student.get("responses") if isinstance(student, dict) else {}
        if not isinstance(responses, dict):
            continue
        for situation_id, entries in responses.items():
            if not isinstance(entries, list):
                continue
            merged[student_id]["responses"].setdefault(situation_id, [])
            seen = {
                f"{entry.get('who', '')}\n{entry.get('text', '')}\n{entry.get('time', '')}"
                for entry in merged[student_id]["responses"][situation_id]
                if isinstance(entry, dict)
            }
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                who = entry.get("who", "").strip() if isinstance(entry.get("who"), str) else ""
                text = entry.get("text", "").strip() if isinstance(entry.get("text"), str) else ""
                if not who or not text:
                    continue
                normalized = {
                    "who": who,
                    "text": text,
                    "time": entry.get("time", "") if isinstance(entry.get("time"), str) else "",
                }
                key = f"{normalized['who']}\n{normalized['text']}\n{normalized['time']}"
                if key not in seen:
                    seen.add(key)
                    merged[student_id]["responses"][situation_id].append(normalized)
    return merged


def merge_state(base, incoming):
    current = normalize_state(base)
    next_state = normalize_state(incoming)
    return {
        **current,
        "padletUrl": next_state["padletUrl"] or current["padletUrl"],
        "notebooklmUrl": next_state["notebooklmUrl"] or current["notebooklmUrl"],
        "situations": next_state["situations"] or current["situations"],
        "chars": next_state["chars"] or current["chars"],
        "analysis": next_state["analysis"] if (next_state["analysis"]["summary"] or next_state["analysis"]["details"]) else current["analysis"],
        "students": merge_students(current["students"], next_state["students"]),
    }


def is_allowed_origin(origin):
    if not origin:
        return False
    if origin == "null":
        return True
    try:
        host = urlparse(origin).hostname or ""
    except Exception:
        return False
    return bool(
        host in {"localhost", "127.0.0.1"}
        or re.match(r"^192\.168\.", host)
        or re.match(r"^10\.", host)
        or re.match(r"^172\.(1[6-9]|2\d|3[0-1])\.", host)
    )


def inline_script_value(value):
    return json.dumps(value, ensure_ascii=False).replace("</", "<\\/")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"{self.address_string()} - {format % args}")

    def add_cors_headers(self):
        origin = self.headers.get("Origin")
        if is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.add_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return None
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.add_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path
        if route == "/api/state":
            return self.send_json(200, {"state": read_state()})
        if route == "/api/class-settings":
            return self.send_json(200, {"settings": get_class_settings(read_state())})
        if route == "/student-index.html":
            return self.send_student_index()
        if route == "/":
            route = "/index.html"
        return self.send_static(route)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            body = self.read_json_body() or {}
        except Exception:
            return self.send_json(400, {"error": "요청 데이터를 읽지 못했습니다."})

        if parsed.path == "/api/state":
            incoming = body.get("state")
            if not isinstance(incoming, dict):
                return self.send_json(400, {"error": "저장할 상태 데이터가 필요합니다."})
            next_state = merge_state(read_state(), incoming)
            write_state(next_state)
            return self.send_json(200, {"state": next_state})

        if parsed.path == "/api/class-settings":
            settings = body.get("settings")
            if not isinstance(settings, dict):
                return self.send_json(400, {"error": "저장할 수업 설정 데이터가 필요합니다."})
            current = read_state()
            next_state = normalize_state({**current, **settings, "students": current.get("students", {})})
            write_state(next_state)
            return self.send_json(200, {"settings": next_state})

        return self.send_json(404, {"error": "찾을 수 없는 API입니다."})

    def send_student_index(self):
        index_path = ROOT / "index.html"
        if not index_path.exists():
            self.send_error(404)
            return
        origin = f"http://{self.headers.get('Host', f'localhost:{PORT}')}"
        injection = (
            "<script>"
            f"window.CONFLICT_APP_TEACHER_SERVER_URL = {inline_script_value(origin)};"
            f"window.CONFLICT_APP_DEFAULT_SETTINGS = {inline_script_value(get_class_settings(read_state()))};"
            "</script>\n"
        )
        html = index_path.read_text(encoding="utf-8")
        html = html.replace("</head>", f"{injection}</head>") if "</head>" in html else injection + html
        raw = html.encode("utf-8")
        self.send_response(200)
        self.add_cors_headers()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def send_static(self, route):
        requested = (ROOT / route.lstrip("/")).resolve()
        if ROOT not in requested.parents and requested != ROOT:
            self.send_error(404)
            return
        if requested.name.lower() in BLOCKED_NAMES or requested.suffix.lower() == ".env" or ".data" in requested.parts:
            self.send_error(404)
            return
        if not requested.exists() or not requested.is_file():
            self.send_error(404)
            return
        raw = requested.read_bytes()
        content_type = mimetypes.guess_type(str(requested))[0] or "application/octet-stream"
        self.send_response(200)
        self.add_cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


if __name__ == "__main__":
    print(f"사회정서앱 서버 실행 중: http://localhost:{PORT}", flush=True)
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        lan_ip = probe.getsockname()[0]
        probe.close()
        print(f"학생용 파일 주소: http://{lan_ip}:{PORT}/student-index.html", flush=True)
    except Exception:
        print(f"학생용 파일 주소 예: http://<교사컴퓨터IP>:{PORT}/student-index.html", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
