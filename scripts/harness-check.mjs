import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const checks = [
  {
    name: 'student class label is 5학년 6반',
    run: () => read('student.html').includes('5학년 6반')
  },
  {
    name: 'morning student route exists',
    run: () => /app\.get\(\[['"]\/morning\/student/.test(read('server.js'))
  },
  {
    name: 'morning admin route exists',
    run: () => /app\.get\(\[['"]\/morning\/admin/.test(read('server.js'))
  },
  {
    name: 'morning feedback endpoint exists',
    run: () => read('server.js').includes("app.post('/api/morning-feedback'")
  },
  {
    name: 'morning feedback keeps local fallback',
    run: () => read('server.js').includes('buildMorningFeedbackFallback')
  },
  {
    name: 'morning records save endpoint exists',
    run: () => read('server.js').includes("app.post('/api/morning-records'")
  },
  {
    name: 'secret env files are not served as static files',
    run: () => {
      const server = read('server.js');
      return server.includes("req.path === '/.env'")
        && server.includes("requestedPath.endsWith('.env')")
        && server.includes("requestedPath === 'openaiapi.env'");
    }
  },
  {
    name: 'privacy checklist exists',
    run: () => fs.existsSync(path.join(root, 'docs', 'security-privacy-checklist.md'))
  },
  {
    name: 'decisions log exists',
    run: () => fs.existsSync(path.join(root, 'docs', 'decisions-log.md'))
  }
];

const failures = checks.filter(check => {
  try {
    return !check.run();
  } catch {
    return true;
  }
});

if (failures.length) {
  console.error('Harness check failed:');
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(`Harness check passed (${checks.length} checks).`);
