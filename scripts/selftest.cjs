#!/usr/bin/env node
/**
 * selftest — 회귀 테스트. 의존성 없이 `node scripts/selftest.cjs` 로 돈다.
 *
 * 왜 — 생성기 844줄 + 화면 1,300줄을 매번 손으로 확인하고 있었다. 한 세션에만 회귀가 3건
 * 났다(브라우저 캐시로 옛 CSS 를 검증 · CSS 특이도로 강조선이 안 보임 · 스크립트가 백슬래시를
 * 먹어 정규식이 깨짐). 사람이 매번 잡을 수 있는 종류가 아니다.
 *
 * 무엇을 보는가 — **하네스가 없어도 되는 것만** 본다. 원장 생성은 하네스 워킹카피가 있어야
 * 하므로 CI 에서 돌지 않는다. 그건 --with-harness 로 따로 돌린다.
 *
 * 무엇을 안 보는가 — 브라우저 렌더. 그건 눈과 playwright 의 몫이다. 여기서는 화면 파일을
 * **문자열로** 검사해 "규격이 지워졌는가"만 잡는다.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'developer.html'), 'utf8');

let pass = 0;
const fails = [];

function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fails.push(name + (why ? ' — ' + why : ''));
}

function has(name, re, why) {
  ok(name, re.test(HTML), why);
}

/* ── 1. 문법 ─────────────────────────────────────── */

const scripts = HTML.match(/<script>([\s\S]*?)<\/script>/g) || [];
ok('화면에 <script> 블록이 있다', scripts.length > 0);
for (let i = 0; i < scripts.length; i++) {
  const body = scripts[i].replace(/^<script>/, '').replace(/<\/script>$/, '');
  try { new Function(body); pass++; } catch (e) { fails.push('인라인 JS #' + (i + 1) + ' 문법 오류 — ' + e.message); }
}
// 모듈은 require 로 (부수효과가 없어야 한다는 것 자체가 검사다).
for (const f of ['task-ledger.cjs', 'task-paths-driver.cjs', 'greenzone.cjs', 'adapters/requests-local.cjs', 'adapters/adp-repository.cjs']) {
  try { require(path.join(ROOT, 'scripts', f)); pass++; } catch (e) { fails.push(f + ' 로드 실패 — ' + e.message); }
}
// CLI 는 require 하면 **실제로 돈다**. serve.cjs 를 require 했다가 서버가 떴다(실측).
// 문법만 본다.
for (const f of ['serve.cjs', 'selftest.cjs']) {
  try {
    // 셔뱅(#!)은 JS 토큰이 아니다 — node 는 벗겨서 읽지만 new Function 은 그대로 받는다.
    const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8').split('\n');
    if (src[0].slice(0, 2) === '#!') src[0] = '';
    new Function(src.join('\n'));
    pass++;
  } catch (e) { fails.push(f + ' 문법 오류 — ' + e.message); }
}
try { JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'task-ledger.schema.json'), 'utf8')); pass++; }
catch (e) { fails.push('schema.json 파싱 실패 — ' + e.message); }

/* ── 2. 출력 이스케이프 ──────────────────────────── */

// esc() 를 지나지 않는 데이터 출력이 생기면 XSS 가 열린다.
has('esc() 가 있다', /function esc\(/);
ok('innerHTML 에 원시 데이터를 바로 넣지 않는다',
  !/innerHTML\s*=\s*[a-zA-Z_$][\w.$]*\.(title|taskId|owner|status)\b/.test(HTML),
  '데이터 필드를 esc() 없이 innerHTML 에 넣는 코드가 있다');

/* ── 3. 알림 규격 (컨셉 목업) ────────────────────── */

has('알림 트리거가 아이콘이다', /class="notification-trigger" aria-label="알림"/, '글자 라벨로 되돌아갔다');
has('알림 트리거에 svg 가 있다', /notification-trigger[\s\S]{0,200}<svg/);
has('점은 기본 투명이다', /\.notice__state\s*\{[^}]*background:\s*transparent/, '점이 항상 켜지면 읽음·안읽음 구분이 사라진다');
has('안읽음일 때만 점이 켜진다', /\.notice--unread \.notice__state\s*\{[^}]*background:/);
has('읽은 알림은 흐려진다', /\.notice--read\s*\{[^}]*color:\s*var\(--color-muted\)/);
// 컨셉이 적대검증으로 잡은 특이도 함정 — `.pop__body a`(0-1-1) 가 `.notice--read`(0-1-0) 를 이긴다.
has('읽음 색 선택자가 특이도를 이긴다', /\.pop__body a\.notice--read/,
  '`.pop__body a` 가 생기면 읽음 표시가 조용히 사라진다');
has('알림 항목이 과업별로 이동한다', /href="#\/progress\?task='/, '전부 같은 곳으로 가던 회귀');
has('간트 줄에 과업 앵커가 있다', /id="task-' \+ esc\(t\.taskId\)/);

/* ── 4. 강조·폭 ──────────────────────────────────── */

// 라벨이 sticky·z-index 3 이라 행에 표식을 달면 가려진다(실측으로 걸린 회귀).
has('딥링크 강조 표식이 라벨에 있다', /\.g-row--target \.g-label\s*\{[^}]*box-shadow/,
  '행에 달면 sticky 라벨이 덮어 안 보인다');
for (const v of ['progress', 'inbox', 'request', 'trd', 'review']) {
  has('폭 상한 해제 — ' + v, new RegExp('\\.view-' + v + ' \\.maxw'), '1320px 상한으로 되돌아갔다');
}

/* ── 5. 신선도 ───────────────────────────────────── */

has('원장 신선도를 표시한다', /id="freshness"/);
has('신선도 임계가 있다', /var STALE_HOURS = \d+/);
has('임계를 넘으면 다시 만들라고 한다', /다시 만드세요/);

/* ── 6. 계약 ─────────────────────────────────────── */

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'task-ledger.schema.json'), 'utf8'));
const led = require(path.join(ROOT, 'scripts', 'task-ledger.cjs'));
ok('화면이 받아들이는 스키마 버전에 현재 계약이 들어 있다',
  new RegExp("ACCEPTED_SCHEMA\\s*=\\s*\\[[^\\]]*'" + schema.properties.meta.properties.schemaVersion.enum[0] + "'").test(HTML),
  '스키마를 올리고 화면 허용 목록을 안 올리면 화면이 데이터를 안 그린다');
ok('생성기가 scrub 을 내보낸다', typeof led.scrub === 'function');
ok('scrub 이 윈도 경로를 지운다', !/[A-Za-z]:[\\/]/.test(led.scrub('open C:\\Users\\x\\y.json')));
ok('scrub 이 POSIX 홈을 지운다', !/\/Users\//.test(led.scrub('at /Users/foo/bar')));

// 진단 문자열에 경로가 실리지 못하게 스키마가 막고 있는가 (생성기가 뚫린 날의 그물)
const warnPat = new RegExp(schema.properties.diagnostics.properties.warnings.items.pattern);
ok('스키마가 경로 섞인 경고를 거부한다',
  !warnPat.test('open C:\\Users\\x') && warnPat.test('ZERO-X: 경로 해석 실패'));

/* ── 6-1. 그린존 기능명세서 ──────────────────────── */

const gz = require(path.join(ROOT, 'scripts', 'greenzone.cjs'));

// section() 은 `m` 플래그의 `$` 때문에 본문이 통째로 비는 회귀가 있었다(실측).
const sampleMd = [
  '# 개발 계획서', '',
  '| 항목 | 내용 |', '|---|---|', '| 제목 | 표본 과업 |', '',
  '## 1. 과업 개요', '', '첫 문단이다.', '',
  '### 1-1. 하위절', '', '여기는 목적에 들어가면 안 된다.', '',
  '## 2. 기능 요구사항', '',
  '- [ ] **R-X-01** 첫 기능이다.',
  '- [ ] **R-X-02** 둘째 기능이다.', '',
  '## 3. 다음', '', '끝.',
].join(String.fromCharCode(10));

ok('section() 이 §1 본문을 읽는다', /첫 문단이다/.test(gz.section(sampleMd, 1) || ''),
  'm 플래그의 $ 로 본문이 비던 회귀');
ok('목적에서 하위절을 뺀다', !/하위절에 들어가면/.test(gz.section(sampleMd, 1) || ''));
ok('section() 이 다음 헤더에서 끊는다', !/끝\./.test(gz.section(sampleMd, 2) || ''));
ok('section() 이 없는 절에 null 을 준다', gz.section(sampleMd, 9) === null);

const rq = gz.requirements(sampleMd);
ok('R-번호 요구사항을 2건 읽는다', rq.items.length === 2);
ok('요구사항 본문을 요약하지 않고 옮긴다', rq.items[0].text === '첫 기능이다.');
ok('메타 표에서 제목을 읽는다', gz.metaTable(sampleMd)['제목'] === '표본 과업');

// 원본에 없으면 "해당 없음" 으로 닫는가 — 지어내지 않는 것이 이 도구의 계약이다.
const bare = gz.specMarkdown(gz.buildSpec('T-000', (function () {
  const f = path.join(require('os').tmpdir(), 'gz-selftest-' + process.pid + '.md');
  fs.writeFileSync(f, '# 개발 계획서' + String.fromCharCode(10), 'utf8');
  return f;
})(), null));
ok('빈 계획서는 전부 "해당 없음" 으로 닫는다', (bare.match(/해당 없음/g) || []).length >= 5);
ok('빈 계획서에 화면설계서를 만들지 않는다', !/화면설계서는 여기 없다[\s\S]*?버튼/.test(bare) || /화면설계서는 여기 없다/.test(bare));

const gzSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'greenzone.cjs'), 'utf8');
ok('그린존 export 에 우회 인자가 없다', !/--force|skip-scan|no-scan/.test(gzSrc));
ok('그린존 export 는 push 하지 않는다', !/git\s+push|push\(/.test(gzSrc));

/* ── 7. 발행 게이트 우회 없음 ────────────────────── */

const gen = fs.readFileSync(path.join(ROOT, 'scripts', 'task-ledger.cjs'), 'utf8');
ok('발행 게이트에 우회 인자가 없다',
  !/--force|skip-scan|no-scan|SKIP_SCAN/.test(gen),
  '예외가 없다는 것이 이 게이트의 값이다');

/* ── 결과 ────────────────────────────────────────── */

console.log('\n  selftest — 통과 ' + pass + ' · 실패 ' + fails.length);
if (fails.length) {
  fails.forEach(function (f) { console.log('    FAIL  ' + f); });
  console.log('');
  process.exit(1);
}
console.log('  전부 통과\n');
