# 아침대화 앱 작업 하네스

이 문서는 아침대화 앱을 AI나 개발자가 수정할 때 지켜야 할 프로젝트 규약이다. 새 세션을 시작하면 먼저 이 파일을 읽고, 큰 변경은 `docs/verification-loop.md`와 `docs/decisions-log.md`를 함께 확인한다.

## 프로젝트 요약

- 대상: 초등 학급용 갈등 해결 활동과 아침대화 앱.
- 스택: Node.js Express 서버, 바닐라 HTML/CSS/JS, 파일 기반 JSON 저장소.
- 주요 화면:
  - `/morning/student`: 학생 아침대화 화면.
  - `/morning/admin`: 교사용 관리자 화면.
  - `/student-index.html`: 갈등 해결 활동 배포 화면.
- 주요 데이터:
  - `.data/morning-records.json`: 아침대화 기록.
  - `.data/conflict-state.json`: 갈등 해결 활동 상태.
  - `/data` Railway Volume 사용 시 재배포 후 기록 보존.

## 변경 원칙

- 학생 화면, 관리자 화면, 서버 API를 함께 바꾸는 변경은 반드시 하나의 완성 세트로 다룬다.
- 학생 입력, 표정 신호, 음성, AI 피드백은 민감한 교실 데이터로 간주한다.
- 카메라 화면과 원본 음성은 저장하지 않는 현재 설계를 유지한다.
- Gemini/OpenAI 실패 시 수업이 멈추지 않도록 로컬 fallback을 유지한다.
- API 키와 env 파일은 브라우저로 노출하지 않는다.
- 큰 파일을 수정할 때는 변경 범위를 작게 잡고, 주변 함수 이름과 기존 스타일을 따른다.

## 파일 소유 경계

동시에 여러 작업을 나눌 때 아래 경계가 겹치면 병렬 수정하지 않는다.

| 영역 | 파일 |
|---|---|
| 서버/API/저장소 | `server.js`, `.env.example`, `package.json`, `scripts/*` |
| 학생 아침대화 UI | `student.html`, `morning-style.css`, `morning-shared.js`, `assets/*` |
| 관리자 아침대화 UI | `admin.html`, `morning-style.css`, `morning-shared.js` |
| 갈등 해결 활동 | `index.html`, `emotion-buddy.html`, `server.js`의 conflict API |
| 운영/문서/하네스 | `README.md`, `AGENTS.md`, `docs/*` |

공유 파일인 `server.js`, `morning-shared.js`, `morning-style.css`는 한 번에 한 작업만 수정한다.

## 필수 검증

작업 후 가능한 한 아래를 실행한다.

```powershell
npm run check
```

UI나 브라우저 동작을 바꿨다면 로컬 서버를 켜고 최소한 학생/관리자 화면을 직접 확인한다.

```powershell
npm start
```

확인할 기본 주소:

- `http://localhost:3000/morning/student`
- `http://localhost:3000/morning/admin`
- `http://localhost:3000/student-index.html`

## 배포 절차

- 이 프로젝트의 Railway 반영 저장소는 `https://github.com/kimjs0925/project1.git`의 `main` 브랜치다.
- 사용자가 "반영", "푸쉬", "배포", "Railway에 올려"처럼 말하면 로컬 수정과 검증에서 멈추지 말고 GitHub `main`까지 푸시해 Railway 자동 배포가 시작되게 한다.
- 현재 작업 폴더의 `.git`이 비어 있거나 깨져 있으면 `git init`, `git remote add origin https://github.com/kimjs0925/project1.git`, `git fetch origin main`, `git reset --mixed origin/main`, `git branch -M main` 순서로 원격 기준만 복구한다. 작업 파일을 덮어쓰는 `git checkout`, `git reset --hard`는 사용하지 않는다.
- 작업 폴더에는 원격과 무관한 변경/자료 파일이 섞일 수 있으므로 `git add -A`를 쓰지 말고, 이번 작업에 필요한 파일만 명시적으로 stage/commit/push한다.
- 직접 `npx.cmd @railway/cli up`은 폴더 전체 업로드라 민감 파일 전송 위험이 있다. 사용자가 위험을 알고 명시적으로 승인한 경우가 아니면 GitHub `main` 푸시 방식으로 배포한다.

## 완료 조건

- 수정한 기능의 성공 경로와 실패 경로를 모두 설명할 수 있어야 한다.
- 학생 기록 저장, 관리자 조회, AI fallback, 개인정보 약속 중 하나라도 건드렸다면 `docs/decisions-log.md`에 새 결정이 필요한지 확인한다.
- 검증을 못 했다면 이유와 남은 위험을 마지막 응답에 남긴다.
