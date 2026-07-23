import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const requiredRelease = '20260723-ai-smile-lock';

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const indexHtml = read('index.html');
const serverJs = read('server.js');
const railwayIgnorePath = path.join(root, '.railwayignore');
const railwayIgnore = fs.existsSync(railwayIgnorePath)
  ? fs.readFileSync(railwayIgnorePath, 'utf8')
  : '';

const checks = [
  {
    name: `student release meta is ${requiredRelease}`,
    ok: indexHtml.includes(`<meta name="ai-smile-release" content="${requiredRelease}" />`)
      || indexHtml.includes(`<meta name="ai-smile-release" content="${requiredRelease}">`)
  },
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
    name: 'local run_server starts the Node AI-SMILE server',
    ok: read('run_server.bat').includes('server.js')
      && !read('run_server.bat').includes('python_social_server.py')
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
    name: 'stale student copy cannot be served directly',
    ok: /app\.get\(\[['"]\/student-index-copy\.html['"], ['"]\/student-index-copy['"]\][\s\S]*?res\.redirect\(302, ['"]\/student-index\.html['"]\)/.test(serverJs)
  },
  {
    name: 'html responses disable browser caching',
    ok: serverJs.includes('function setNoStoreHeaders')
      && serverJs.includes('Surrogate-Control')
      && serverJs.includes('setHeaders: (res, filePath)')
  },
  {
    name: `deploy version is locked to ${requiredRelease}`,
    ok: serverJs.includes(`const deployVersion = '${requiredRelease}';`)
      || serverJs.includes(`const deployVersion = "${requiredRelease}";`)
  },
  {
    name: 'Railway config runs the release guard during build',
    ok: read('railway.json').includes('"buildCommand": "npm run railway:build"')
      && read('package.json').includes('"railway:build": "npm run release:guard"')
      && read('package.json').includes('"release:guard": "node scripts/railway-release-guard.mjs"')
  },
  {
    name: 'Railway upload includes the guard, config, and allowlist',
    ok: !railwayIgnore || (
      railwayIgnore.includes('!.railwayignore')
      && railwayIgnore.includes('!railway.json')
      && railwayIgnore.includes('!scripts/')
      && railwayIgnore.includes('!scripts/**')
    )
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
