#!/usr/bin/env node
/**
 * intake — 작업요청서 하나를 받아 과업 채번 → 요청서 연결 → 원장 재생성까지 한 번에.
 *
 *   node scripts/intake.cjs --request REQ-BPL-0001 --entry=plan [--root {하네스}]
 *                           [--domain a,b] [--yes]
 *
 * 왜 — 이 셋은 손으로 하면 순서가 있고, 특히 ②(요청서 JSON 에 과업번호 쓰기)는 오타·누락이
 * 조용히 난다. 기계적인 부분은 기계가 한다.
 *
 * ★ 기본은 **미리보기**다. 실제 채번은 `--yes` 를 줘야 한다.
 *   채번은 과업 폴더·세션 상태를 만들어 되돌리기가 번거롭다. 되돌리기 어려운 일은
 *   한 번 더 묻는다.
 *
 * ★ `--entry` 에 기본값을 두지 않는다.
 *   entry 가 TRD 유무를 가른다 — `direct`·`investigate`·`ops` 를 고르면 계획서가 없어
 *   **그 과업은 TRD 가 영영 안 생긴다.** 기본값을 두면 그 선택이 조용히 일어난다.
 *
 * ★ 도메인 후보가 여러 개면 **과업을 나눈다**(사용자 확정 2026-09-22).
 *   실측 — "바코드 결제토큰 체크디지트 검증 강화" 는 code_master·payment·money 3개가
 *   같은 점수로 나온다. 하나를 임의로 고르면 지식 로딩과 TC 도메인코드가 오염된다.
 *   대신 도메인마다 하위 과업을 만들고 요청서에 전부 잇는다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_MARKER = path.join('.claude', 'scripts', 'task-paths.cjs');
let HARNESS = null;

function die(code, msg) { console.error('ERROR: ' + msg); process.exit(code); }

function resolveRoot(explicit) {
  const has = (d) => fs.existsSync(path.join(d, ROOT_MARKER));
  if (explicit) {
    const abs = path.resolve(explicit);
    return has(abs) ? abs : null;
  }
  if (process.env.JEX_HARNESS_ROOT && has(path.resolve(process.env.JEX_HARNESS_ROOT))) {
    return path.resolve(process.env.JEX_HARNESS_ROOT);
  }
  for (const start of [__dirname, process.cwd()]) {
    let d = start;
    for (let i = 0; i < 10; i++) {
      if (has(d)) return d;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return null;
}

/* ── 인자 ────────────────────────────────────────── */

const o = { root: '', request: '', entry: '', domain: '', yes: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const eq = a.indexOf('=');
  const key = eq > 0 ? a.slice(0, eq) : a;
  const val = eq > 0 ? a.slice(eq + 1) : null;
  const take = () => (val !== null ? val : argv[++i]);
  if (key === '--root') o.root = take();
  else if (key === '--request') o.request = take();
  else if (key === '--entry') o.entry = take();
  else if (key === '--domain') o.domain = take();
  else if (key === '--yes') o.yes = true;
  else die(2, '알 수 없는 인자: ' + a);
}
for (const [k, v] of [['--root', o.root], ['--request', o.request], ['--entry', o.entry], ['--domain', o.domain]]) {
  if (v !== '' && !v) die(2, k + ' 값이 비었다');
}
if (!o.request) die(2, '--request 가 필요하다 (예: --request REQ-BPL-0001)');
if (!o.entry) {
  die(2, '--entry 가 필요하다. 기본값을 두지 않는다 — entry 가 TRD 유무를 가른다.\n' +
        '  interview | plan  → 계획서가 생기고 TRD 도 생긴다\n' +
        '  direct | investigate | ops  → 계획서가 없어 TRD 가 생기지 않는다');
}

HARNESS = resolveRoot(o.root);
if (!HARNESS) die(2, '하네스 루트를 찾지 못했다 — --root 로 지정한다 (' + ROOT_MARKER + ' 가 있는 폴더)');

/* ── 요청서 읽기 ─────────────────────────────────── */

const reqFile = path.join(HARNESS, 'target', 'requests', o.request + '.json');
let req;
try {
  req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
} catch (e) {
  die(2, '요청서를 읽지 못했다: target/requests/' + o.request + '.json');
}
if (Array.isArray(req.linkedTaskIds) && req.linkedTaskIds.length) {
  die(1, '이미 과업이 연결된 요청서다: ' + req.linkedTaskIds.join(', ') + '\n' +
        '  다시 채번하려면 요청서의 linkedTaskIds 를 먼저 비운다.');
}
if (!req.group) die(2, '요청서에 group 이 없다 — 어느 프로젝트로 채번할지 알 수 없다');

/* ── 도메인 판정 ─────────────────────────────────── */

let domains;
let domainVia;
if (o.domain) {
  domains = o.domain.split(',').map((s) => s.trim()).filter(Boolean);
  domainVia = '--domain 지정';
} else {
  let out = '';
  try {
    out = execFileSync(process.execPath,
      [path.join(HARNESS, '.claude', 'scripts', 'domain-graph', 'resolve-domain.cjs'), req.title, '--json'],
      { cwd: HARNESS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { out = ''; }
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (e) { /* 아래에서 막는다 */ }
  if (!parsed || !parsed.matched || !parsed.domains || !parsed.domains.length) {
    die(3, '요청서 제목으로 도메인을 판정하지 못했다.\n' +
          '  추정하지 않는다 — 테이블명·소스경로로 다시 조회한 뒤 --domain={id} 로 지정한다.');
  }
  domains = parsed.domains.map((d) => d.domain);
  domainVia = '제목 자동 판정';
}

const multi = domains.length > 1;

/* ── 계획 ────────────────────────────────────────── */

const plan = domains.map(function (d) {
  return {
    domain: d,
    // 하위 과업의 제목에 도메인을 붙여 무엇을 나눈 것인지 과업 목록에서 보이게 한다.
    summary: multi ? req.title + ' — ' + d : req.title,
  };
});

console.log('');
console.log('  인테이크 — ' + o.request + '  (' + req.type + ' · ' + req.group + ')');
console.log('    ' + req.title);
console.log('');
console.log('  진입 단계  ' + o.entry + (['interview', 'plan'].indexOf(o.entry) < 0
  ? '   ⚠ 계획서가 생기지 않아 TRD 도 생기지 않는다' : ''));
console.log('  도메인     ' + domains.join(' · ') + '   (' + domainVia + ')');
if (multi) {
  console.log('');
  console.log('  도메인이 ' + domains.length + '개다 — 하나를 임의로 고르지 않고 **하위 과업으로 나눈다**.');
  console.log('  한 도메인으로 묶으려면 --domain={id} 로 지정한다.');
}
console.log('');
console.log('  만들 과업 ' + plan.length + '건');
plan.forEach(function (p) { console.log('    [' + p.domain + '] ' + p.summary); });
console.log('');

if (!o.yes) {
  console.log('  미리보기다. 실제로 채번하려면 --yes 를 붙인다.');
  console.log('');
  process.exit(0);
}

/* ── 실행 ────────────────────────────────────────── */

const minted = [];
for (const p of plan) {
  let out = '';
  try {
    out = execFileSync(process.execPath, [
      path.join(HARNESS, '.claude', 'scripts', 'mint-task-id.cjs'),
      p.summary, '--entry=' + o.entry, '--project=' + req.group, '--domain=' + p.domain, '--json',
    ], { cwd: HARNESS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // 앞의 것이 이미 채번됐을 수 있다 — 무엇이 남았는지 밝히고 멈춘다.
    console.error('');
    console.error('ERROR: 채번 실패 [' + p.domain + '] — 여기서 멈춘다.');
    console.error((e.stderr || '').toString().trim().split('\n').map(function (l) { return '  ' + l; }).join('\n'));
    if (minted.length) {
      console.error('');
      console.error('  이미 채번된 것: ' + minted.map(function (m) { return m.taskId; }).join(', '));
      console.error('  요청서에는 아직 잇지 않았다 — 고친 뒤 다시 실행하거나 손으로 잇는다.');
    }
    process.exit(4);
  }
  let intake = null;
  try { intake = JSON.parse(out); } catch (e) { die(4, '채번 결과를 읽지 못했다 [' + p.domain + ']'); }
  minted.push({ taskId: intake.taskId, domain: p.domain });
  console.log('  채번  ' + intake.taskId + '  [' + p.domain + ']');
}

// 요청서에 잇는다. 손으로 고치던 자리다 — 오타·누락이 조용히 나던 곳이다.
req.linkedTaskIds = minted.map(function (m) { return m.taskId; });
fs.writeFileSync(reqFile, JSON.stringify(req, null, 2) + '\n', 'utf8');
console.log('  연결  ' + o.request + '.json  ← ' + req.linkedTaskIds.join(', '));

// 원장 재생성 — 안 하면 화면이 그대로라 "안 된 줄" 안다.
try {
  execFileSync(process.execPath, [
    path.join(__dirname, 'task-ledger.cjs'), '--root', HARNESS, '--group', req.group, '--quiet',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('  원장  재생성 완료');
} catch (e) {
  console.error('  경고: 원장 재생성에 실패했다 — 직접 실행해라');
  console.error('    node scripts/task-ledger.cjs --root {하네스} --group ' + req.group);
}

console.log('');
console.log('  다음 — ' + (['interview'].indexOf(o.entry) >= 0 ? '/dev-interview ' : '/dev-plan ') + minted[0].taskId +
  (minted.length > 1 ? '  (외 ' + (minted.length - 1) + '건)' : ''));
console.log('');
