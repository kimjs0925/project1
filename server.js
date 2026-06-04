import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { request } from 'undici';
import os from 'os';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), 'openaiapi.env') });
const app = express();
const port = process.env.PORT || 3000;
const openaiSecretPath = path.resolve(process.cwd(), 'openaiapi.env');
const dataDir = path.resolve(process.cwd(), '.data');
const statePath = path.join(dataDir, 'conflict-state.json');

function loadOpenAIApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (!fs.existsSync(openaiSecretPath)) return '';

  const raw = fs.readFileSync(openaiSecretPath, 'utf8').trim();
  if (!raw) return '';
  const match = raw.match(/OPENAI_API_KEY\s*=\s*(.+)/);
  return (match ? match[1] : raw).trim();
}

const openaiApiKey = loadOpenAIApiKey();
const openaiModel = process.env.OPENAI_MODEL || 'gpt-5-mini';
const openaiApiUrl = 'https://api.openai.com/v1/responses';
const allowedCorsOrigins = new Set([
  'null',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://192.168.1.19:3000'
]);

app.use((req, res, next) => {
  const requestedPath = path.basename(req.path).toLowerCase();
  if (
    req.path === '/.env' ||
    req.path === '/제미나이.env.txt' ||
    req.path.startsWith('/.data') ||
    requestedPath.endsWith('.env') ||
    requestedPath === 'openaiapi.env' ||
    requestedPath.startsWith('openaiapi')
  ) {
    return res.status(404).end();
  }
  next();
});
app.use((req, res, next) => {
  const origin = req.headers.origin;

  let allowed = false;
  if (origin && allowedCorsOrigins.has(origin)) {
    allowed = true;
  } else if (origin) {
    try {
      const u = new URL(origin);
      const host = u.hostname;
      // Allow localhost and common private LAN ranges
      if (/^localhost$/i.test(host) || host === '127.0.0.1') allowed = true;
      if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) allowed = true;
    } catch (e) {
      // ignore parse errors
    }
  }

  if (allowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    if (origin && !allowed) {
      return res.status(403).end();
    }
    return res.status(204).end();
  }
  next();
});
app.use(express.json({ limit: '5mb' }));

const emptyState = {
  padletUrl: '',
  notebooklmUrl: '',
  situations: [],
  chars: [],
  students: {},
  analysis: { summary: '', frequency: {}, details: '', updatedAt: '' }
};

function readAppState() {
  try {
    if (!fs.existsSync(statePath)) return { ...emptyState, students: {}, situations: [] };
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeAppState(parsed);
  } catch (error) {
    console.error('상태 파일 읽기 오류:', error);
    return { ...emptyState, students: {}, situations: [] };
  }
}

function writeAppState(nextState) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2), 'utf8');
}

function getClassSettings(current) {
  return {
    padletUrl: current.padletUrl,
    notebooklmUrl: current.notebooklmUrl,
    situations: current.situations,
    chars: current.chars,
    analysis: current.analysis
  };
}

function serializeForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function normalizeAppState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    padletUrl: typeof source.padletUrl === 'string' ? source.padletUrl : '',
    notebooklmUrl: typeof source.notebooklmUrl === 'string' ? source.notebooklmUrl : '',
    situations: Array.isArray(source.situations) ? source.situations : [],
    chars: Array.isArray(source.chars) ? source.chars : [],
    students: source.students && typeof source.students === 'object' ? source.students : {},
    analysis: source.analysis && typeof source.analysis === 'object'
      ? source.analysis
      : { summary: '', frequency: {}, details: '', updatedAt: '' }
  };
}

function mergeStudentResponses(baseStudents = {}, incomingStudents = {}) {
  const merged = JSON.parse(JSON.stringify(baseStudents || {}));

  Object.entries(incomingStudents || {}).forEach(([studentId, student]) => {
    if (!merged[studentId]) merged[studentId] = { responses: {} };
    if (!merged[studentId].responses) merged[studentId].responses = {};

    Object.entries(student?.responses || {}).forEach(([situationId, entries]) => {
      if (!Array.isArray(entries)) return;
      if (!Array.isArray(merged[studentId].responses[situationId])) {
        merged[studentId].responses[situationId] = [];
      }

      const seen = new Set(
        merged[studentId].responses[situationId].map(entry =>
          `${entry?.who || ''}\n${entry?.text || ''}\n${entry?.time || ''}`
        )
      );

      entries.forEach(entry => {
        if (!entry || typeof entry !== 'object') return;
        const text = typeof entry.text === 'string' ? entry.text.trim() : '';
        const who = typeof entry.who === 'string' ? entry.who.trim() : '';
        if (!text || !who) return;
        const normalized = {
          who,
          text,
          time: typeof entry.time === 'string' ? entry.time : ''
        };
        const key = `${normalized.who}\n${normalized.text}\n${normalized.time}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged[studentId].responses[situationId].push(normalized);
        }
      });
    });
  });

  return merged;
}

function mergeAppState(base, incoming) {
  const normalizedBase = normalizeAppState(base);
  const normalizedIncoming = normalizeAppState(incoming);
  return {
    ...normalizedBase,
    padletUrl: normalizedIncoming.padletUrl || normalizedBase.padletUrl,
    notebooklmUrl: normalizedIncoming.notebooklmUrl || normalizedBase.notebooklmUrl,
    situations: normalizedIncoming.situations.length ? normalizedIncoming.situations : normalizedBase.situations,
    chars: normalizedIncoming.chars.length ? normalizedIncoming.chars : normalizedBase.chars,
    analysis: normalizedIncoming.analysis?.summary || normalizedIncoming.analysis?.details
      ? normalizedIncoming.analysis
      : normalizedBase.analysis,
    students: mergeStudentResponses(normalizedBase.students, normalizedIncoming.students)
  };
}

app.get('/api/state', (req, res) => {
  res.json({ state: readAppState() });
});

app.post('/api/state', (req, res) => {
  const incomingState = req.body?.state;
  if (!incomingState || typeof incomingState !== 'object') {
    return res.status(400).json({ error: '저장할 상태 데이터가 필요합니다.' });
  }

  const nextState = mergeAppState(readAppState(), incomingState);
  writeAppState(nextState);
  return res.json({ state: nextState });
});

app.get('/api/class-settings', (req, res) => {
  const current = readAppState();
  res.json({ settings: getClassSettings(current) });
});

app.post('/api/class-settings', (req, res) => {
  const incomingSettings = req.body?.settings;
  if (!incomingSettings || typeof incomingSettings !== 'object') {
    return res.status(400).json({ error: '저장할 수업 설정 데이터가 필요합니다.' });
  }

  const current = readAppState();
  const normalized = normalizeAppState({
    ...current,
    ...incomingSettings,
    students: current.students
  });
  writeAppState(normalized);
  return res.json({ settings: normalized });
});

app.get('/student-index.html', (req, res) => {
  const indexPath = path.join(process.cwd(), 'index.html');
  const current = readAppState();
  const teacherOrigin = `${req.protocol}://${req.get('host')}`;
  const injection = [
    '<script>',
    `window.CONFLICT_APP_TEACHER_SERVER_URL = ${serializeForInlineScript(teacherOrigin)};`,
    `window.CONFLICT_APP_DEFAULT_SETTINGS = ${serializeForInlineScript(getClassSettings(current))};`,
    '</script>'
  ].join('');

  try {
    const html = fs.readFileSync(indexPath, 'utf8');
    const output = html.includes('</head>')
      ? html.replace('</head>', `${injection}\n</head>`)
      : `${injection}\n${html}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(output);
  } catch (error) {
    console.error('학생 배포용 index 생성 오류:', error);
    return res.status(500).send('학생 배포용 index 파일을 만드는 중 오류가 발생했습니다.');
  }
});

function readZipEntryMap(filePath) {
  const buffer = fs.readFileSync(filePath);
  let eocdOffset = -1;
  const minOffset = Math.max(0, buffer.length - 66000);

  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('XLSX 압축 구조를 읽지 못했습니다.');
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    entries.set(name, data.toString('utf8'));

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function decodeXmlText(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  const result = [];
  const items = xml.match(/<si\b[\s\S]*?<\/si>/g) || [];
  items.forEach(item => {
    const parts = [...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map(match => decodeXmlText(match[1]));
    result.push(parts.join(''));
  });
  return result;
}

function parseWorksheetRows(xml, sharedStrings) {
  const rows = [];
  const rowMatches = xml.match(/<row\b[\s\S]*?<\/row>/g) || [];

  rowMatches.forEach(rowXml => {
    const row = {};
    const cells = rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g);
    for (const cell of cells) {
      const attrs = cell[1];
      const body = cell[2];
      const ref = attrs.match(/\br="([A-Z]+)(\d+)"/);
      if (!ref) continue;

      const col = ref[1];
      const valueMatch = body.match(/<v>([\s\S]*?)<\/v>/);
      const inlineMatch = body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
      let value = valueMatch ? decodeXmlText(valueMatch[1]) : '';
      if (/\bt="s"/.test(attrs)) {
        value = sharedStrings[Number(value)] || '';
      } else if (!value && inlineMatch) {
        value = decodeXmlText(inlineMatch[1]);
      }
      row[col] = value;
    }
    if (Object.keys(row).length) rows.push(row);
  });

  return rows;
}

function extractPadletPostsFromXlsx(filePath) {
  const entries = readZipEntryMap(filePath);
  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml') || '');
  const sheet = entries.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('게시물 시트를 찾지 못했습니다.');

  const rows = parseWorksheetRows(sheet, sharedStrings);
  const header = rows[0] || {};
  const bodyColumn = Object.entries(header).find(([, value]) => value === '본문')?.[0] || 'B';

  return rows.slice(1)
    .map(row => String(row[bodyColumn] || '').replace(/\s+/g, ' ').trim())
    .filter(text => text.length >= 5);
}

const conflictTypeRules = [
  {
    type: '친구 관계의 무시·소외',
    description: '친구가 말을 들어주지 않거나, 소외감·거리감을 느끼는 상황',
    keywords: ['무시', '안 들어', '안들어', '말을 안', '말없', '친해지고', '단답', '대답', '소외', '따돌']
  },
  {
    type: '신체적 괴롭힘·폭력',
    description: '때림, 맞음, 아픔처럼 신체적 접촉이나 위협이 포함된 상황',
    keywords: ['때려', '때리', '맞', '아프', '쎄게', '세게', '폭력', '밀', '차', '괴롭']
  },
  {
    type: '물건·소유 갈등',
    description: '물건을 가져가거나 숨기거나 준비물 때문에 생기는 갈등',
    keywords: ['물건', '숨겨', '숨긴', '가져', '필통', '샤프', '준비물', '잃어', '빼앗']
  },
  {
    type: '말투·언어 갈등',
    description: '짜증, 말투, 비난, 공격적인 말 때문에 감정이 상한 상황',
    keywords: ['말투', '짜증', '화난 목소리', '뭐라', '욕', '신경쓰지마', '비난', '무시까', '왜이렇게']
  },
  {
    type: '약속·기다림 갈등',
    description: '약속을 어기거나 기다리게 해서 생기는 갈등',
    keywords: ['기다리', '약속', '연락', '먼저 집', '놀기로', '학원끝', '알겠다고']
  },
  {
    type: '놀이·게임 갈등',
    description: '게임, 놀이, 같이 노는 과정에서 생기는 갈등',
    keywords: ['게임', '로블록스', '디스코드', '놀', '시작해', '판', '전화']
  },
  {
    type: '학업·규칙 스트레스',
    description: '숙제, 시험, 수업 규칙, 지적 등 학교생활 부담과 관련된 갈등',
    keywords: ['학업', '숙제', '시험', '사인', '수업', '규칙', '지적', '선생', '반이', '책상']
  },
  {
    type: '운동·역할 참여 갈등',
    description: '운동이나 모둠 활동에서 역할·참여 문제로 생기는 갈등',
    keywords: ['운동', '아무것도 안', '못하냐', '너가해라', '네가해라', '역할', '팀']
  },
  {
    type: '가족 갈등',
    description: '부모님이나 가족의 다툼이 학생에게 영향을 주는 상황',
    keywords: ['엄마', '아빠', '부모', '가족', '생일']
  }
];

function classifyConflictPost(text) {
  const normalized = text.toLowerCase();
  const scored = conflictTypeRules.map(rule => ({
    ...rule,
    score: rule.keywords.reduce((sum, keyword) =>
      sum + (normalized.includes(keyword.toLowerCase()) ? 1 : 0), 0)
  })).filter(rule => rule.score > 0);

  return scored.sort((a, b) => b.score - a.score)[0] || {
    type: '기타 갈등',
    description: '정해진 키워드로 뚜렷하게 구분하기 어려운 갈등',
    score: 0
  };
}

function analyzePadletPosts(posts) {
  const groups = new Map();

  posts.forEach((text, index) => {
    const result = classifyConflictPost(text);
    if (!groups.has(result.type)) {
      groups.set(result.type, {
        type: result.type,
        count: 0,
        description: result.description,
        examples: []
      });
    }
    const group = groups.get(result.type);
    group.count += 1;
    if (group.examples.length < 3) {
      group.examples.push(`${index + 1}번: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
    }
  });

  const frequency = Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      percent: posts.length ? Math.round((item.count / posts.length) * 100) : 0
    }));

  const top = frequency[0];
  return {
    summary: top
      ? `Padlet학생글.xlsx의 게시물 ${posts.length}개를 분석했습니다. 가장 많은 갈등 유형은 '${top.type}'이며 ${top.count}건(${top.percent}%)입니다.`
      : '분석할 게시물이 없습니다.',
    frequency,
    details: frequency.map(item =>
      `${item.rank}위. ${item.type}: ${item.count}건 (${item.percent}%)\n- ${item.description}\n- 예시: ${item.examples.join('\n  ')}`
    ).join('\n\n'),
    updatedAt: new Date().toLocaleString('ko-KR', { hour12: false })
  };
}

function extractOpenAIText(body) {
  if (typeof body.output_text === 'string') return body.output_text;
  if (Array.isArray(body.output)) {
    return body.output.flatMap(item =>
      Array.isArray(item.content)
        ? item.content.map(content => content.text || '').filter(Boolean)
        : []
    ).join('\n').trim();
  }
  return '';
}

function parseJsonObject(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw error;
    return JSON.parse(match[0]);
  }
}

async function requestOpenAIJson(prompt) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY가 설정되지 않았습니다.');
  }

  const response = await request(openaiApiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: openaiModel,
      input: prompt,
      max_output_tokens: 3000
    })
  });

  const bodyText = await response.body.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`OpenAI 응답을 읽지 못했습니다: ${bodyText.slice(0, 200)}`);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(body.error?.message || 'OpenAI API 요청에 실패했습니다.');
  }

  const outputText = extractOpenAIText(body);
  if (!outputText) {
    throw new Error('OpenAI 응답에 분석 텍스트가 없습니다.');
  }

  return parseJsonObject(outputText);
}

function buildConflictAnalysisPrompt(text) {
  return `초등학생이 작성한 갈등 상황 글을 분석해 주세요.

반드시 아래 JSON 형식 하나만 출력하세요. 마크다운 코드블록은 쓰지 마세요.
{
  "summary": "전체 갈등 요약",
  "frequency": [
    { "type": "갈등 유형", "count": 3, "description": "해당 유형 설명" }
  ],
  "details": "유형별 특징과 지도 시 참고할 점"
}

분류 기준:
- 학생 글의 실제 의미를 기준으로 분류합니다.
- 비슷한 유형은 하나로 묶습니다.
- count는 해당 유형에 속한 글 수입니다.
- frequency는 count가 많은 순서로 정렬합니다.

입력 텍스트:
${text}`;
}

function buildPadletFileAnalysisPrompt(posts) {
  const numberedPosts = posts.map((text, index) => `${index + 1}. ${text}`).join('\n\n');
  return `Padlet학생글.xlsx에서 추출한 초등학생 갈등 상황 글 ${posts.length}개를 유형별로 분류해 주세요.

반드시 아래 JSON 형식 하나만 출력하세요. 마크다운 코드블록은 쓰지 마세요.
{
  "summary": "전체 요약과 가장 많은 갈등 유형",
  "frequency": [
    {
      "rank": 1,
      "type": "갈등 유형",
      "count": 5,
      "percent": 17,
      "description": "이 유형의 특징",
      "examples": ["대표 예시 1", "대표 예시 2"]
    }
  ],
  "details": "순위별 해석과 수업 지도에 참고할 점"
}

분류 기준:
- 학생 글의 실제 의미를 읽고 분류합니다.
- 너무 세분화하지 말고 교사가 수업에서 볼 수 있는 5~9개 유형으로 묶습니다.
- count 총합은 반드시 ${posts.length}가 되게 합니다.
- percent는 전체 ${posts.length}개 중 비율을 반올림한 정수입니다.
- frequency는 count가 많은 순서로 정렬합니다.
- examples에는 학생 개인정보를 늘리지 말고 핵심 상황만 짧게 넣습니다.

학생 글:
${numberedPosts}`;
}

async function analyzePadletPostsWithOpenAI(posts) {
  const analysis = await requestOpenAIJson(buildPadletFileAnalysisPrompt(posts));
  const frequency = Array.isArray(analysis.frequency) ? analysis.frequency : [];
  return {
    summary: analysis.summary || `Padlet학생글.xlsx의 게시물 ${posts.length}개를 OpenAI API로 분석했습니다.`,
    frequency: frequency.map((item, index) => ({
      rank: Number(item.rank) || index + 1,
      type: item.type || '기타 갈등',
      count: Number(item.count) || 0,
      percent: Number(item.percent) || 0,
      description: item.description || '',
      examples: Array.isArray(item.examples) ? item.examples.slice(0, 3) : []
    })).sort((a, b) => b.count - a.count),
    details: analysis.details || '',
    updatedAt: new Date().toLocaleString('ko-KR', { hour12: false }),
    source: 'openai'
  };
}

app.get('/api/padlet-file-analysis', async (req, res) => {
  const filePath = path.resolve(process.cwd(), 'Padlet학생글.xlsx');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Padlet학생글.xlsx 파일을 프로젝트 폴더에서 찾지 못했습니다.' });
  }

  try {
    const posts = extractPadletPostsFromXlsx(filePath);
    if (openaiApiKey) {
      return res.json({ analysis: await analyzePadletPostsWithOpenAI(posts), postCount: posts.length });
    }
    const analysis = analyzePadletPosts(posts);
    analysis.summary = `${analysis.summary}\n\nOPENAI_API_KEY가 없어 키워드 기반 분석으로 표시했습니다.`;
    analysis.source = 'keyword';
    return res.json({ analysis, postCount: posts.length });
  } catch (error) {
    console.error('Padlet학생글 파일 OpenAI 분석 오류:', error);
    try {
      const posts = extractPadletPostsFromXlsx(filePath);
      const analysis = analyzePadletPosts(posts);
      analysis.summary = `${analysis.summary}\n\nOpenAI 분석에 실패해 키워드 기반 분석으로 표시했습니다: ${error.message}`;
      analysis.source = 'keyword';
      return res.json({ analysis, postCount: posts.length });
    } catch (fallbackError) {
      return res.status(500).json({ error: 'Padlet학생글 파일을 분석하는 중 오류가 발생했습니다.' });
    }
  }
});

app.use(express.static(path.join(process.cwd(), '')));

app.post('/api/analyze', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '분석할 텍스트를 요청 본문에 포함해 주세요.' });
  }

  try {
    const analysis = await requestOpenAIJson(buildConflictAnalysisPrompt(text));
    return res.json({ analysis: JSON.stringify(analysis) });
  } catch (error) {
    console.error('OpenAI 분석 오류:', error);
    return res.status(500).json({ error: `OpenAI 분석 중 오류가 발생했습니다: ${error.message}` });
  }
});

function stripHtml(text) {
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJsonFromHtml(html, regex) {
  const match = html.match(regex);
  if (!match || !match[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    return null;
  }
}

function normalizeTextValue(value) {
  if (typeof value !== 'string') return '';
  const stripped = stripHtml(value);
  return stripped.length > 10 ? stripped : '';
}

function collectTextFromObject(obj, result = []) {
  if (typeof obj === 'string') {
    const normalized = normalizeTextValue(obj);
    if (normalized) result.push(normalized);
    return result;
  }
  if (Array.isArray(obj)) {
    obj.forEach(item => collectTextFromObject(item, result));
    return result;
  }
  if (obj && typeof obj === 'object') {
    Object.entries(obj).forEach(([key, value]) => {
      if (typeof value === 'string') {
        const normalized = normalizeTextValue(value);
        if (normalized) {
          if (/(text|content|body|description|title|message|post|note|headline|subtitle)/i.test(key)) {
            result.push(normalized);
          } else {
            collectTextFromObject(value, result);
          }
        }
      } else {
        collectTextFromObject(value, result);
      }
    });
  }
  return result;
}

function extractPadletContent(html) {
  const scriptPatterns = [
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]+type=["']application\/json["'][^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]+>window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;<\/script>/i,
    /<script[^>]+>window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?})\s*;<\/script>/i,
    /<script[^>]+>window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?})\s*;<\/script>/i,
    /<script[^>]+>window\.__PADLET_DATA__\s*=\s*({[\s\S]*?})\s*;<\/script>/i,
    /<script[^>]+>window\.__INITIAL_PROPS__\s*=\s*({[\s\S]*?})\s*;<\/script>/i
  ];

  const candidates = scriptPatterns
    .map(pattern => extractJsonFromHtml(html, pattern))
    .filter(Boolean);

  for (const json of candidates) {
    const texts = collectTextFromObject(json).map(t => t.replace(/\s+/g, ' ').trim());
    const uniqueTexts = [...new Set(texts)].filter(Boolean);
    if (uniqueTexts.length >= 5) {
      return uniqueTexts.join('\n\n');
    }
  }

  const cleaned = stripHtml(html);
  if (cleaned.length > 50) {
    return cleaned;
  }

  const fallbackMatches = [];
  const contentPatterns = [
    /<div[^>]+class=["'][^"']*(?:content|post|note|text|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    /<div[^>]+data-qa=["'][^"']*post[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    /<article[^>]*>([\s\S]*?)<\/article>/gi
  ];
  for (const pattern of contentPatterns) {
    let match;
    while ((match = pattern.exec(html))) {
      const item = stripHtml(match[1]);
      if (item.length > 50) {
        fallbackMatches.push(item);
      }
    }
  }

  if (fallbackMatches.length) {
    return [...new Set(fallbackMatches)].join('\n\n');
  }

  return cleaned || '';
}

app.post('/api/padlet', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: '패들렛 URL을 요청 본문에 포함해 주세요.' });
  }

  const normalizedUrl = url.trim();
  if (!/^https?:\/\/(?:www\.)?padlet\.(?:com|co)\//i.test(normalizedUrl)) {
    return res.status(400).json({ error: '유효한 패들렛 URL을 입력해 주세요.' });
  }

  try {
    const response = await request(normalizedUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    const body = await response.body.text();
    const content = extractPadletContent(body);
    if (!content) {
      return res.status(500).json({ error: '패들렛 내용을 추출하지 못했습니다.' });
    }
    return res.json({ content });
  } catch (error) {
    console.error('패들렛 자동 수집 오류:', error);
    return res.status(500).json({ error: '패들렛 내용을 가져오는 중 오류가 발생했습니다.' });
  }
});

const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  const ifaces = os.networkInterfaces();
  const addresses = [];
  Object.values(ifaces).forEach(list => {
    if (!list) return;
    list.forEach(addr => {
      if (addr.family === 'IPv4' && !addr.internal) addresses.push(addr.address);
    });
  });

  console.log(`서버가 실행 중입니다. 바인드: ${host}:${port}`);
  if (addresses.length) {
    addresses.forEach(a => {
      console.log(`학생 접속 URL: http://${a}:${port}/student-index.html`);
    });
  } else {
    console.log(`로컬 접속 URL: http://localhost:${port}/student-index.html`);
  }
});
