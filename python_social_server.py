from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from datetime import datetime
import json
import mimetypes
import os
import re
import socket
import threading


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / ".data"
STATE_PATH = DATA_DIR / "conflict-state.json"
MORNING_RECORDS_PATH = DATA_DIR / "morning-records.json"
PORT = int(os.environ.get("PORT", "3000"))
HOST = os.environ.get("HOST", "0.0.0.0")
MORNING_STORE_LOCK = threading.Lock()

EMPTY_STATE = {
    "padletUrl": "",
    "notebooklmUrl": "",
    "situations": [],
    "chars": [],
    "students": {},
    "analysis": {"summary": "", "frequency": {}, "details": "", "updatedAt": ""},
}

BLOCKED_NAMES = {".env", "openaiapi.env", "제미나이.env.txt"}
STUDENT_COPY_PATH = ROOT / "student-index-copy.html"


def now_iso():
    return datetime.now().astimezone().isoformat()


def local_date_key(value=None):
    if not value:
        return datetime.now().astimezone().strftime("%Y-%m-%d")
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone().strftime("%Y-%m-%d")
    except Exception:
        return ""


def parse_iso_timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def get_morning_record_date_key(record):
    if not isinstance(record, dict):
        return ""
    if isinstance(record.get("recordDate"), str) and record["recordDate"].strip():
        return record["recordDate"].strip()
    return local_date_key(record.get("startedAt") or record.get("updatedAt") or record.get("completedAt"))


def normalize_morning_record(record):
    if not isinstance(record, dict):
        return None
    try:
        student_no = str(int(record.get("studentNo")))
    except Exception:
        return None
    if not student_no:
        return None

    normalized = dict(record)
    normalized["studentNo"] = student_no
    normalized["recordDate"] = get_morning_record_date_key(normalized) or local_date_key()
    normalized["answers"] = normalized.get("answers") if isinstance(normalized.get("answers"), dict) else {}
    normalized["transcript"] = normalized.get("transcript") if isinstance(normalized.get("transcript"), list) else []
    normalized["startedAt"] = normalized.get("startedAt") or now_iso()
    normalized["updatedAt"] = normalized.get("updatedAt") or now_iso()
    normalized["completedAt"] = normalized.get("completedAt") if isinstance(normalized.get("completedAt"), str) else ""
    return normalized


def empty_morning_store():
    return {"records": {}, "history": {}, "deleted": {}}


def read_morning_store():
    if not MORNING_RECORDS_PATH.exists():
        return empty_morning_store()
    try:
        parsed = json.loads(MORNING_RECORDS_PATH.read_text(encoding="utf-8"))
        if not isinstance(parsed, dict):
            return empty_morning_store()

        source_records = parsed.get("records") if isinstance(parsed.get("records"), dict) else parsed
        source_history = parsed.get("history") if isinstance(parsed.get("history"), dict) else {}
        records = {}
        history = {}

        for key, record in source_records.items():
            if not isinstance(record, dict):
                continue
            normalized = normalize_morning_record({**record, "studentNo": record.get("studentNo") or key})
            if not normalized:
                continue
            record_date = get_morning_record_date_key(normalized)
            records[normalized["studentNo"]] = normalized
            history.setdefault(normalized["studentNo"], {})[record_date] = normalized

        for student_no, records_by_date in source_history.items():
            if not isinstance(records_by_date, dict):
                continue
            for date_key, record in records_by_date.items():
                if not isinstance(record, dict):
                    continue
                normalized = normalize_morning_record({
                    **record,
                    "studentNo": student_no,
                    "recordDate": record.get("recordDate") or date_key,
                })
                if not normalized:
                    continue
                history.setdefault(normalized["studentNo"], {})[get_morning_record_date_key(normalized)] = normalized

        deleted = parsed.get("deleted") if isinstance(parsed.get("deleted"), dict) else {}
        return {"records": records, "history": history, "deleted": deleted}
    except Exception:
        return empty_morning_store()


def write_morning_store(store):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    next_store = {
        "records": store.get("records") if isinstance(store.get("records"), dict) else {},
        "history": store.get("history") if isinstance(store.get("history"), dict) else {},
        "deleted": store.get("deleted") if isinstance(store.get("deleted"), dict) else {},
    }
    MORNING_RECORDS_PATH.write_text(json.dumps(next_store, ensure_ascii=False, indent=2), encoding="utf-8")


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


def build_student_index_html(origin):
    index_path = ROOT / "index.html"
    injection = (
        "<script>"
        f"window.CONFLICT_APP_TEACHER_SERVER_URL = {inline_script_value(origin)};"
        f"window.CONFLICT_APP_DEFAULT_SETTINGS = {inline_script_value(get_class_settings(read_state()))};"
        "</script>\n"
    )
    html = index_path.read_text(encoding="utf-8")
    return html.replace("</head>", f"{injection}</head>") if "</head>" in html else injection + html


def write_student_copy(origin):
    try:
        STUDENT_COPY_PATH.write_text(build_student_index_html(origin), encoding="utf-8")
        print(f"학생 배포용 복사 파일 생성: {STUDENT_COPY_PATH.name}", flush=True)
    except Exception as error:
        print(f"학생 배포용 복사 파일 생성 실패: {error}", flush=True)


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
        if route == "/api/morning-records":
            with MORNING_STORE_LOCK:
                store = read_morning_store()
            return self.send_json(200, {"records": store["records"], "updatedAt": now_iso()})
        history_match = re.match(r"^/api/morning-records/(\d+)/history$", route)
        if history_match:
            student_no = str(int(history_match.group(1)))
            with MORNING_STORE_LOCK:
                store = read_morning_store()
            records_by_date = store["history"].get(student_no, {})
            records = [
                normalize_morning_record(record)
                for record in records_by_date.values()
            ]
            records = [
                record
                for record in records
                if record
            ]
            records.sort(key=get_morning_record_date_key, reverse=True)
            return self.send_json(200, {"studentNo": student_no, "records": records})
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

        if parsed.path == "/api/morning-records":
            record = normalize_morning_record(body.get("record"))
            if not record:
                return self.send_json(400, {"error": "저장할 학생 기록이 올바르지 않습니다."})

            with MORNING_STORE_LOCK:
                store = read_morning_store()
                deleted = store["deleted"].get(record["studentNo"])
                record_date = get_morning_record_date_key(record)
                record_started_at = parse_iso_timestamp(record.get("startedAt") or record.get("updatedAt"))
                deleted_at = parse_iso_timestamp(deleted.get("deletedAt")) if isinstance(deleted, dict) else None

                if (
                    isinstance(deleted, dict)
                    and deleted.get("recordDate") == record_date
                    and deleted_at
                    and record_started_at
                    and record_started_at < deleted_at
                ):
                    return self.send_json(409, {
                        "error": "이미 삭제된 이전 기록입니다.",
                        "reason": "deleted-record",
                        "recordDate": record_date,
                    })

                store["records"][record["studentNo"]] = record
                store["history"].setdefault(record["studentNo"], {})[record_date] = record
                if isinstance(deleted, dict) and deleted.get("recordDate") == record_date:
                    store["deleted"].pop(record["studentNo"], None)
                write_morning_store(store)
            return self.send_json(200, {"ok": True, "record": record})

        if parsed.path == "/api/morning-feedback":
            return self.send_json(503, {"error": "맞춤 피드백 서버를 사용할 수 없어 기본 피드백을 사용합니다."})

        return self.send_json(404, {"error": "찾을 수 없는 API입니다."})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        route = parsed.path
        delete_match = re.match(r"^/api/morning-records/(\d+)$", route)
        if not delete_match:
            return self.send_json(404, {"error": "찾을 수 없는 API입니다."})

        student_no = str(int(delete_match.group(1)))
        date_key = (parse_qs(parsed.query).get("date") or [""])[0]
        with MORNING_STORE_LOCK:
            store = read_morning_store()
            record = store["records"].get(student_no)
            history_record = store["history"].get(student_no, {}).get(date_key) if date_key else None
            target_record = (history_record or record) if date_key else record

            if not target_record:
                return self.send_json(404, {"ok": False, "reason": "not-found"})

            record_date = get_morning_record_date_key(target_record)
            if date_key and record_date != date_key:
                return self.send_json(409, {"ok": False, "reason": "date-mismatch", "recordDate": record_date})

            if not date_key or get_morning_record_date_key(record) == record_date:
                store["records"].pop(student_no, None)
            if student_no in store["history"]:
                store["history"][student_no].pop(record_date, None)
                if not store["history"][student_no]:
                    store["history"].pop(student_no, None)
            store["deleted"][student_no] = {"recordDate": record_date, "deletedAt": now_iso()}
            write_morning_store(store)

        return self.send_json(200, {"ok": True, "recordDate": record_date})

    def send_student_index(self):
        if not (ROOT / "index.html").exists():
            self.send_error(404)
            return
        origin = f"http://{self.headers.get('Host', f'localhost:{PORT}')}"
        html = build_student_index_html(origin)
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
    student_origin = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        lan_ip = probe.getsockname()[0]
        probe.close()
        student_origin = f"http://{lan_ip}:{PORT}"
        print(f"학생용 파일 주소: {student_origin}/student-index.html", flush=True)
    except Exception:
        print(f"학생용 파일 주소 예: http://<교사컴퓨터IP>:{PORT}/student-index.html", flush=True)
    if student_origin:
        write_student_copy(student_origin)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
