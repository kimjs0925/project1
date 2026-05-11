import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { request } from 'undici';

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
const envPath = path.resolve(process.cwd(), '.env');
const secretPath = path.resolve(process.cwd(), '제미나이.env.txt');

let geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey && fs.existsSync(secretPath)) {
  const raw = fs.readFileSync(secretPath, 'utf8').trim();
  if (/=/.test(raw)) {
    const match = raw.match(/GEMINI_API_KEY\s*=\s*(.+)/);
    geminiApiKey = match ? match[1].trim() : raw;
  } else {
    geminiApiKey = raw;
  }
}

if (!geminiApiKey) {
  console.error('GEMINI_API_KEY가 설정되지 않았습니다. .env 또는 제미나이.env.txt 파일에 키를 추가하세요.');
  process.exit(1);
}

const model = process.env.GEMINI_MODEL || 'gemini-1.5';
const apiUrl = `https://generativelanguage.googleapis.com/v1beta2/models/${model}:generateText?key=${encodeURIComponent(geminiApiKey)}`;

app.use((req, res, next) => {
  if (req.path === '/.env' || req.path === '/제미나이.env.txt') {
    return res.status(404).end();
  }
  next();
});
app.use(express.static(path.join(process.cwd(), '')));
app.use(express.json({ limit: '1mb' }));

app.post('/api/analyze', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '분석할 텍스트를 요청 본문에 포함해 주세요.' });
  }

  const prompt = `다음 텍스트를 분석하여 갈등 유형별로 분류하고, 각 갈등 유형의 발생 빈도수를 계산해 주세요. 결과는 반드시 JSON 형식으로만 출력해야 합니다. JSON 응답은 반드시 다음과 같은 형태여야 합니다.\n\n{
  "summary": "전체 갈등 요약",
  "frequency": [
    { "type": "갈등 유형", "count": 3, "description": "해당 유형에 해당하는 주요 내용" }
  ],
  "details": "추가 설명"
}\n\n출력에는 JSON 외의 다른 텍스트를 포함하지 마세요.\n\n입력 텍스트:\n${text}`;

  try {
    const response = await request(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: { text: prompt },
        temperature: 0.2,
        maxOutputTokens: 600
      })
    });

    const body = await response.body.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (jsonError) {
      return res.status(502).json({ error: 'Gemini 응답이 JSON으로 파싱되지 않았습니다.', raw: body });
    }

    const candidate = parsed?.candidates?.[0];
    let analysis = '';
    if (candidate) {
      analysis = candidate.content || (Array.isArray(candidate.output) ? candidate.output.map(item => item.content || '').join('') : '');
    }
    if (!analysis) {
      analysis = body;
    }

    return res.json({ analysis });
  } catch (error) {
    console.error('Gemini 분석 오류:', error);
    return res.status(500).json({ error: 'Gemini 분석 중 오류가 발생했습니다.' });
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

app.listen(port, () => {
  console.log(`서버가 실행 중입니다: http://localhost:${port}`);
});
