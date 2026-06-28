# 갈등 해결 활동 앱

학생과 관리자를 위한 갈등 해결 활동 통합 앱입니다.

## 기능

- **학생 페이지**: 갈등 상황 입력, 상황 확인 및 감정 입력, 해결 방법 대화
- **관리자 페이지**: 외부 링크 설정, 문제 상황 및 등장인물 관리

## 사용 방법

1. 터미널에서 이 폴더로 이동합니다.
2. `npm install`을 실행하여 서버 의존성을 설치합니다.
3. OpenAI API 분석이나 AI 맞춤 피드백을 쓰려면 `.env`, `openaiapi.env`, `google.env`, 또는 `..\아침대화\google.env` 파일에 다음 형식으로 추가합니다:
   ```
   OPENAI_API_KEY=여기에_OPENAI_API_KEY
   OPENAI_MODEL=gpt-5-mini
   GEMINI_API_KEY=여기에_GOOGLE_AI_STUDIO_API_KEY
   GEMINI_MODEL=gemini-3.5-flash
   GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
   GEMINI_TTS_VOICE=Leda
   PORT=3000
   ```
4. `run_server.bat`을 실행합니다.
   - 현재 실행 배치파일은 Python 보조 서버로 학생 입력 저장과 수업 설정 동기화를 실행합니다.
   - Windows 방화벽 허용 창이 뜨면 학생 컴퓨터 접속을 위해 허용을 눌러야 합니다.
5. 브라우저에서 `http://localhost:3000`을 열어 앱을 사용합니다.

## 학생용 index 배포

1. 교사 컴퓨터에서 `run_server.bat`으로 서버를 켭니다.
2. 관리자 페이지에서 패들렛 링크, 노트북LM 링크, 문제 상황을 입력한 뒤 저장합니다.
3. 학생에게 나눠 줄 파일은 교사 컴퓨터 IP 주소로 연 `student-index.html`에서 만듭니다.
   - 현재 이 컴퓨터의 Wi-Fi IP 예: `http://192.168.1.19:3000/student-index.html`
   - 교사용 컴퓨터에서만 확인할 때는 `http://localhost:3000/student-index.html`도 열 수 있지만, 이 주소로 만든 파일은 학생 컴퓨터에서 교사 서버를 찾지 못할 수 있습니다.
   - 학생 컴퓨터에 복사할 파일은 반드시 `localhost` 주소가 아니라 교사 컴퓨터 IP 주소로 연 `student-index.html`에서 만들어야 합니다.
   - `run_server.bat`을 켜면 `student-index-copy.html`도 자동으로 생성됩니다. 학생에게 파일을 복사해 나눠줄 때는 원본 `index.html`보다 이 파일을 사용하세요.
4. 학생이 이 파일을 열고 입력한 내용은 교사 컴퓨터 서버의 `/api/state`로 저장됩니다.

## 연결이 안 될 때 먼저 확인할 것

1. 교사 컴퓨터에서 `run_server.bat` 창이 열려 있는지 확인합니다. 창을 닫으면 학생 연결도 끊깁니다.
2. 교사 컴퓨터 브라우저에서 `http://localhost:3000/api/class-settings`가 열리는지 확인합니다.
3. 학생 컴퓨터에서는 `localhost`가 아니라 교사 컴퓨터 IP 주소를 사용해야 합니다.
4. Windows 방화벽 허용 창이 뜨면 허용해야 합니다.
5. 교사가 상황을 저장했을 때 “서버에 저장되었습니다”가 아니라 “이 컴퓨터에만 저장되었습니다”가 보이면 학생 페이지에는 반영되지 않습니다.

## OpenAI 분석 기능

- 관리자 페이지에서 `분석 실행`을 누르면 `Padlet학생글.xlsx` 파일을 읽고 OpenAI API로 갈등 유형별 순위와 빈도수를 분석합니다.
- `OPENAI_API_KEY`가 없거나 OpenAI 분석에 실패하면 수업 중 결과 확인이 가능하도록 키워드 기반 분석으로 대체됩니다.
- API 키는 `.env`, `openaiapi.env`, `google.env`, `..\아침대화\google.env` 파일에서만 읽으며 브라우저로 노출하지 않습니다.

## Google AI Studio 아침대화 피드백

- 아침대화 학생창의 콩이 피드백은 `GEMINI_API_KEY`가 있으면 Google AI Studio/Gemini API를 먼저 사용해 더 자연스러운 말투로 만듭니다.
- 콩이가 말로 읽어주는 음성도 `GEMINI_API_KEY`가 있으면 Gemini TTS로 생성한 자연스러운 WAV 오디오를 먼저 재생합니다.
- Gemini 피드백에 실패하거나 키가 없으면 OpenAI 맞춤 피드백, 그다음 기본 문장으로 이어집니다.
- Gemini 음성 생성에 실패하거나 키가 없으면 기존 브라우저 음성으로 자동 전환됩니다.
- 목소리는 `.env`의 `GEMINI_TTS_VOICE`에서 바꿀 수 있습니다. 기본값은 `Leda`입니다.
- Google AI Studio의 Live Translate는 공식적으로 실시간 음성 번역용 기능이라 텍스트 대화 자연화에는 직접 쓰지 않고, 현재 앱은 Gemini 텍스트 생성 API로 피드백을 다듬습니다.

## Railway 배포

1. Railway에서 GitHub 저장소를 연결해 배포합니다.
2. 서비스의 Public Networking에서 `Generate Domain`을 눌러 HTTPS 주소를 만듭니다.
3. 학생창은 `https://배포주소/student.html`, 관리자창은 `https://배포주소/admin.html`로 엽니다.
4. 기록을 재배포 후에도 보존하려면 Railway Volume을 `/data`에 마운트하고 환경변수 `DATA_DIR=/data`를 추가합니다.
5. AI 맞춤 피드백을 쓰려면 Variables에 `GEMINI_API_KEY`, 필요 시 `GEMINI_MODEL`을 추가합니다. OpenAI 분석/대체 피드백을 함께 쓰려면 `OPENAI_API_KEY`, 필요 시 `OPENAI_MODEL`도 추가합니다.

## 기술 스택

- HTML5
- CSS3 (인라인 스타일)
- JavaScript (바닐라 JS)

## 브라우저 지원

모던 웹 브라우저에서 작동합니다.
