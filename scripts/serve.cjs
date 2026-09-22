#!/usr/bin/env node
/**
 * serve.cjs — 화면을 로컬에서 띄운다.
 *
 *   node scripts/serve.cjs [--port 8080] [--no-open]
 *
 * 왜 필요한가 — developer.html 을 file:// 로 직접 열면 브라우저가 ledger.json 의 fetch 를
 * 막아(CORS) 화면이 비어 보인다. 파일이 잘못된 것이 아니라 그냥 열 수 없는 것이다.
 * 정적 서버 하나면 해결되므로 의존성 없이 여기에 둔다.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WEB = path.join(__dirname, '..', 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let port = 8080;
let open = true;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--port') port = Number(process.argv[++i]);
  else if (a.startsWith('--port=')) port = Number(a.slice(7));
  else if (a === '--no-open') open = false;
  else { console.error(`ERROR: 알 수 없는 인자: ${a}`); process.exit(2); }
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('ERROR: --port 는 1~65535 의 정수다');
  process.exit(2);
}

if (!fs.existsSync(path.join(WEB, 'ledger.json'))) {
  console.error('ERROR: web/ledger.json 이 없다 — 먼저 원장을 만든다:');
  console.error('  node scripts/task-ledger.cjs --root {하네스루트} --group BIZ_ZEROPAY');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (rel === '/') rel = '/developer.html';
  // web/ 밖으로 나가지 못하게 한다.
  const abs = path.join(WEB, path.normalize(rel).replace(/^[/\\]+/, ''));
  if (!abs.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`ERROR: 포트 ${port} 가 이미 쓰이고 있다 — --port 로 다른 번호를 준다`);
    process.exit(1);
  }
  console.error(`ERROR: ${e.code || e.message}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/developer.html`;
  console.log(`\n  WE-ADP Developer — ${url}`);
  console.log('  Ctrl+C 로 종료\n');
  if (!open) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  execFile(cmd[0], cmd[1], () => {});
});
