from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from datetime import datetime
import base64
import json
import mimetypes
import os
import re
import socket
import struct
import threading
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent


def load_env_file(path):
    if not path.exists():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        print(f"환경 파일을 읽지 못했습니다: {path.name}")
        return
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


ENV_PATHS = [
    ROOT / ".env",
    ROOT / "openaiapi.env",
    ROOT / "google.env",
    ROOT.parent / "아침대화" / "google.env",
]
if os.environ.get("GOOGLE_ENV_PATH"):
    ENV_PATHS.append(Path(os.environ["GOOGLE_ENV_PATH"]))

for env_path in ENV_PATHS:
    load_env_file(env_path)


DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / ".data")).resolve()
STATE_PATH = DATA_DIR / "conflict-state.json"
MORNING_RECORDS_PATH = DATA_DIR / "morning-records.json"
PORT = int(os.environ.get("PORT", "3000"))
HOST = os.environ.get("HOST", "0.0.0.0")
MORNING_STORE_LOCK = threading.Lock()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
GEMINI_MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.5-flash"
GEMINI_TTS_MODEL = os.environ.get("GEMINI_TTS_MODEL") or "gemini-3.1-flash-tts-preview"
GEMINI_TTS_VOICE = os.environ.get("GEMINI_TTS_VOICE") or "Leda"

EMPTY_STATE = {
    "padletUrl": "",
    "notebooklmUrl": "",
    "situations": [],
    "chars": [],
    "students": {},
    "analysis": {"summary": "", "frequency": {}, "details": "", "updatedAt": ""},
}

BLOCKED_NAMES = {".env", "openaiapi.env", "google.env", "제미나이.env.txt"}
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


def compact_text(value, max_length=600):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:max_length]


def parse_json_object(text):
    raw = str(text or "").strip()
    try:
        return json.loads(raw)
    except Exception:
        match = re.search(r"\{[\s\S]*\}", raw)
        if not match:
            raise
        return json.loads(match.group(0))


def extract_gemini_text(body):
    if isinstance(body.get("text"), str):
        return body["text"]
    chunks = []
    for candidate in body.get("candidates") or []:
        content = candidate.get("content") if isinstance(candidate, dict) else {}
        for part in content.get("parts") or []:
            text = part.get("text") if isinstance(part, dict) else ""
            if text:
                chunks.append(text)
    return "\n".join(chunks).strip()


def extract_gemini_inline_audio(body):
    for candidate in body.get("candidates") or []:
        content = candidate.get("content") if isinstance(candidate, dict) else {}
        for part in content.get("parts") or []:
            if not isinstance(part, dict):
                continue
            inline_data = part.get("inlineData") or part.get("inline_data") or {}
            if inline_data.get("data"):
                return {
                    "data": inline_data["data"],
                    "mimeType": inline_data.get("mimeType") or inline_data.get("mime_type") or "audio/pcm;rate=24000",
                }
    return None


def create_wav_bytes(pcm_bytes, sample_rate=24000, channels=1, bits_per_sample=16):
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    header = b"".join([
        b"RIFF",
        struct.pack("<I", 36 + len(pcm_bytes)),
        b"WAVE",
        b"fmt ",
        struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, bits_per_sample),
        b"data",
        struct.pack("<I", len(pcm_bytes)),
    ])
    return header + pcm_bytes


def request_gemini_generate(model, payload):
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY가 설정되지 않았습니다.")
    model_name = re.sub(r"^models/", "", model)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=raw,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:200]
        raise RuntimeError(f"Gemini API 요청에 실패했습니다: {detail}") from error


def build_morning_feedback_prompt(payload):
    previous = payload.get("previousAnswers") if isinstance(payload.get("previousAnswers"), list) else []
    previous_text = "\n".join(
        f"{compact_text(item.get('label'), 30)}: {compact_text(item.get('summary') or item.get('raw'), 120)}"
        for item in previous[:5]
        if isinstance(item, dict)
    ).strip()
    return f"""너는 초등학생 아침대화 앱의 따뜻한 대화 친구 '콩이'입니다.
학생의 방금 답변을 읽고, 실제 교실 아침 대화처럼 자연스러운 한국어 피드백을 작성해 주세요.

반드시 아래 JSON 하나만 출력하세요. 마크다운 코드블록은 쓰지 마세요.
{{
  "feedback": "학생 답변 내용에 맞춘 1~2문장 피드백",
  "tone": "supportive | calm | encouraging | concerned",
  "needsTeacherAttention": false
}}

규칙:
- 학생이 실제로 말한 구체적인 내용을 한 가지 반영합니다.
- 초등학생에게 말하듯 쉽고 부드럽게 말하되, 매번 "기록해둘게" 같은 표현을 반복하지 않습니다.
- 길이는 45~90자 정도의 자연스러운 말투로 유지합니다.
- 질문을 다시 설명하지 말고, 학생 답변에 바로 반응합니다.
- 필요할 때만 선생님 확인을 말하고, 평범한 답변에는 편안한 인정으로 마무리합니다.
- 의학적 진단, 심리 진단, 단정, 훈계, 해결책 강요는 하지 않습니다.
- 학생이 "없어", "괜찮아", "보통"처럼 말하면 억지로 문제를 만들지 말고 짧게 인정합니다.
- 자해, 폭력, 학대, 심한 두려움, 안전 위험이 보이면 needsTeacherAttention을 true로 둡니다.
- 개인정보를 늘리거나 새 사실을 만들어내지 않습니다.

현재 질문:
- key: {compact_text(payload.get("questionKey"), 24)}
- label: {compact_text(payload.get("questionLabel"), 40)}

학생 답변:
{compact_text(payload.get("answer"), 700)}

규칙 기반 요약:
{compact_text(payload.get("summary"), 160) or "없음"}

이전 답변 요약:
{previous_text or "없음"}

카메라 표정 참고:
{compact_text(payload.get("expression"), 80) or "없음"}"""


def normalize_morning_feedback_result(result):
    feedback = compact_text((result or {}).get("feedback"), 180)
    return {
        "feedback": feedback or "말해줘서 고마워. 네 이야기를 잘 들었어.",
        "tone": compact_text((result or {}).get("tone"), 24) or "supportive",
        "needsTeacherAttention": bool((result or {}).get("needsTeacherAttention")),
    }


def request_gemini_feedback(payload):
    body = request_gemini_generate(GEMINI_MODEL, {
        "contents": [{"parts": [{"text": build_morning_feedback_prompt(payload)}]}],
        "generationConfig": {
            "maxOutputTokens": 512,
            "responseFormat": {
                "text": {
                    "mimeType": "application/json",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "feedback": {"type": "string"},
                            "tone": {"type": "string"},
                            "needsTeacherAttention": {"type": "boolean"},
                        },
                        "required": ["feedback", "tone", "needsTeacherAttention"],
                    },
                },
            },
        },
    })
    text = extract_gemini_text(body)
    if not text:
        raise RuntimeError("Gemini 응답에 피드백 텍스트가 없습니다.")
    return normalize_morning_feedback_result(parse_json_object(text))


def request_gemini_speech_audio(text):
    speech_text = compact_text(text, 500)
    if not speech_text:
        raise RuntimeError("읽어줄 문장이 없습니다.")
    body = request_gemini_generate(GEMINI_TTS_MODEL, {
        "contents": [{
            "parts": [{
                "text": f"Say in Korean with a warm, friendly, unhurried elementary classroom buddy voice. Do not add extra words: {speech_text}"
            }]
        }],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {
                        "voiceName": GEMINI_TTS_VOICE,
                    },
                },
            },
        },
    })
    audio = extract_gemini_inline_audio(body)
    if not audio:
        raise RuntimeError("Gemini TTS 응답에 오디오가 없습니다.")
    if re.search(r"audio/wav", audio["mimeType"], re.I):
        return {"audioContent": audio["data"], "mimeType": "audio/wav"}
    wav_bytes = create_wav_bytes(base64.b64decode(audio["data"]))
    return {"audioContent": base64.b64encode(wav_bytes).decode("ascii"), "mimeType": "audio/wav"}


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
            answer = body.get("answer")
            if not body.get("questionKey") or not body.get("questionLabel") or not isinstance(answer, str) or not answer.strip():
                return self.send_json(400, {"error": "피드백을 만들 질문과 학생 답변을 포함해 주세요."})
            if not GEMINI_API_KEY:
                return self.send_json(503, {"error": "GEMINI_API_KEY가 설정되지 않았습니다."})
            try:
                feedback = request_gemini_feedback(body)
                return self.send_json(200, {"feedback": feedback, "source": "gemini"})
            except Exception as error:
                print("Gemini 아침대화 맞춤 피드백 오류:", str(error))
                return self.send_json(500, {"error": "맞춤 피드백을 만드는 중 오류가 발생했습니다."})

        if parsed.path == "/api/morning-speech":
            text = compact_text(body.get("text"), 500)
            if not text:
                return self.send_json(400, {"error": "읽어줄 문장을 포함해 주세요."})
            if not GEMINI_API_KEY:
                return self.send_json(503, {"error": "GEMINI_API_KEY가 설정되지 않았습니다."})
            try:
                audio = request_gemini_speech_audio(text)
                audio["source"] = "gemini-tts"
                return self.send_json(200, audio)
            except Exception as error:
                print("Gemini 아침대화 음성 생성 오류:", str(error))
                return self.send_json(500, {"error": "아침대화 음성을 만드는 중 오류가 발생했습니다."})

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
