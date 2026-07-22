import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const indexHtml = read('index.html');
const serverJs = read('server.js');
const railwayIgnore = read('.railwayignore');

const checks = [
  {
    name: 'student release title is Daehanminguk AI-SMILE',
    ok: indexHtml.includes('<title>대한민국 AI-SMILE</title>')
  },
  {
    name: 'student page exposes the AI-SMILE brand lockup',
    ok: indexHtml.includes('aria-label="대한민국 AI-SMILE"')
      && indexHtml.includes('AI-SMILE 메뉴 설정 저장하기')
  },
  {
    name: 'old conflict app title is not present',
    ok: !indexHtml.includes('<title>갈등 해결 활동 앱</title>')
  },
  {
    name: 'conflict route serves the student AI-SMILE page',
    ok: /app\.get\(\[['"]\/conflict['"], ['"]\/conflict\/['"]\][\s\S]*?res\.redirect\(302, ['"]\/student-index\.html['"]\)/.test(serverJs)
  },
  {
    name: 'deploy version marks an AI-SMILE release',
    ok: /const deployVersion = ['"][^'"]*ai-smile[^'"]*['"]/.test(serverJs)
  },
  {
    name: 'Railway upload includes release guard scripts',
    ok: railwayIgnore.includes('!scripts/') && railwayIgnore.includes('!scripts/**')
  }
];

const failures = checks.filter(check => !check.ok);

if (failures.length) {
  console.error('Railway release guard failed. Refusing to deploy a stale conflict app build.');
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(`Railway release guard passed (${checks.length} checks).`);
