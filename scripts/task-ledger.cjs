#!/usr/bin/env node
/**
 * task-ledger.cjs — 과업 원장 (WE-ADP Developer 가 읽는 단일 데이터 계약)
 *
 *   node scripts/task-ledger.cjs [--root {하네스루트}] [--group BIZ_ZEROPAY]
 *                                [--out web/ledger.json] [--stale-days 14] [--json] [--quiet]
 *   node scripts/task-ledger.cjs export [--root ...] [--file ...] [--dest ...] [--dry-run]
 *
 * --root 는 스캔할 하네스(.claude/scripts/task-paths.cjs 가 있는 폴더)다. 생략하면 스크립트
 * 위치와 cwd 에서 위로 올라가며 찾고, JEX_HARNESS_ROOT 환경변수도 본다. 이 스크립트가
 * 하네스 안에 있든 개발용 레포 클론 안에 있든 같은 방식으로 돈다.
 *
 * 무엇 — target/tasks/ 를 스캔해 한 그룹의 과업 목록과 상태 4택(접수·개발중·리뷰중·완료)을
 * 결정론으로 산출하고 ledger.json 1장을 만든다. 매 실행마다 통째로 새로 만든다(스캔 생성형).
 *
 * 왜 스크립트인가 — 상태를 사람이 입력하면 반드시 빠진다. 개발자가 평소처럼 /dev-plan·/qa-test·
 * /code-review 를 돌리면 산출물 파일이 생기고, 그 파일의 실재가 곧 상태다. 판정을 코드 밖에
 * 두지 않으며, 유도할 수 없으면 추정하지 않고 그 사실(statusVia·statusInferred)을 남긴다.
 *
 * 상태 어휘가 wiki-summary.cjs(5택 계획완료…배포완료)와 다른 것은 의도다 — 저쪽은 발행 상태,
 * 이쪽은 개발 진행 상태로 세는 축이 다르다. 두 도구를 공유 모듈로 묶지 않는다.
 *
 * 경로는 직접 조립하지 않고 task-paths.cjs 에 위임한다(정본 1곳 유지). 그 대신 spawn 비용이
 * 과업당 1회 들므로 **그룹 필터를 먼저** 한다 — 179건 전체에 부르면 10초가 든다.
 *
 * 원장은 외부로 나갈 수 있다(선택 내보내기). 파일 절대경로·개발자 이메일·리뷰 대상 소스 경로는
 * 싣지 않는다 — 통째 복사 금지, 아래 표에 있는 키만 옮긴다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 경로는 두 축으로 갈린다. 섞지 말 것.
//   ① 하네스 축 (ROOT 기준) — 스캔 대상 target/tasks/ 와 하네스 소유 도구 3종
//      (task-paths.cjs · hooks/lib/registry.js · scan-publish.sh). 이 셋의 정본은
//      하네스 레포이며 여기로 복제해 오지 않는다.
//   ② 산출물 축 (__dirname 기준) — 스키마·어댑터. 이 스크립트와 함께 움직인다.
// 이 파일이 하네스 밖(개발용 레포 클론)에 놓여도 ①이 --root 로 해결되면 그대로 돈다.
let ROOT = null;
let TASKS_DIR = null;
const ADAPTERS_DIR = path.join(__dirname, 'adapters');
const SCHEMA_FILE = path.join(__dirname, 'task-ledger.schema.json');

/** 하네스 도구의 표식 — 이 파일이 있는 폴더가 하네스 루트다. */
const ROOT_MARKER = path.join('.claude', 'scripts', 'task-paths.cjs');

function harnessTool(...seg) {
  return path.join(ROOT, '.claude', ...seg);
}

/**
 * 하네스 루트를 정한다. 명시(--root) > 환경변수 > 스크립트 위치에서 위로 > cwd 에서 위로.
 * 명시했으면 거기만 본다 — 틀린 경로를 조용히 다른 곳으로 대체하면 엉뚱한 원장이 나온다.
 */
function resolveRoot(explicit) {
  const has = (d) => fs.existsSync(path.join(d, ROOT_MARKER));
  if (explicit) {
    const abs = path.resolve(explicit);
    return has(abs) ? { root: abs }
      : { error: `--root 에 하네스가 없다: ${scrub(abs)} (${ROOT_MARKER} 를 찾지 못했다)` };
  }
  if (process.env.JEX_HARNESS_ROOT) {
    const abs = path.resolve(process.env.JEX_HARNESS_ROOT);
    return has(abs) ? { root: abs }
      : { error: `JEX_HARNESS_ROOT 에 하네스가 없다: ${scrub(abs)}` };
  }
  for (const start of [__dirname, process.cwd()]) {
    let d = start;
    for (let i = 0; i < 10; i++) {
      if (has(d)) return { root: d };
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return { error: `하네스 루트를 찾지 못했다 — --root 로 지정한다 (${ROOT_MARKER} 가 있는 폴더)` };
}

function setRoot(root) {
  ROOT = root;
  TASKS_DIR = path.join(ROOT, 'target', 'tasks');
}

const DEFAULT_GROUP = 'BIZ_ZEROPAY';
const DEFAULT_OUT = path.join(__dirname, '..', 'web', 'ledger.json');
const SCHEMA_VERSION = '1.0';

// 비플페이 ADP 구분 코드 (WE-ADP 표준 정의서 §1.2 — 3자리 고정)
const ADP_CODE = 'BPL';

// 상태 4택. 배열 순서가 곧 진행 순서이며 역행 방지의 기준이다.
const TASK_STATUSES = ['접수', '개발중', '리뷰중', '완료'];

// 개발요청서 값 (WE-ADP 표준 정의서 §3.2 · §4.2.4). 스키마 enum 과 같은 목록이다.
const REQUEST_TYPES = ['FRD', 'SRT'];
const REQUEST_STATUSES = ['요청', '접수', '진행', '완료'];

// TRD 상태 3택 (컨셉 목업 어휘).
const TRD_STATUSES = ['개발대기', '개발중', '개발완료'];

// TRD 상태는 과업 상태에서 유도한다 — 페이즈 문서 10건 전수에 기계가 읽을 완료 플래그가 없다.
// 본문 산문의 "완료" 를 긁으면 오판이 조용히 섞이므로, 근거 없는 추정을 원장에 넣지 않는다.
// 한계: 한 과업의 TRD 가 전부 같은 상태로 보인다. 화면이 이 출처를 드러내야 한다.
const TRD_STATUS_MAP = {
  접수: '개발대기',
  개발중: '개발중',
  리뷰중: '개발완료',
  완료: '개발완료',
};

// 진입단계별 상태 경로. 단일 규칙을 쓰면 계획서가 생기지 않는 진입단계의 과업이 영원히
// '접수'에 머문다(실측: 178건 중 93건). present 키는 task-paths.cjs 의 paths 키와 같다.
const ENTRY_PATHS = {
  interview: [{ key: 'plan', status: '개발중' }, { key: 'result', status: '리뷰중' }, { key: 'reviewJson', status: '완료' }],
  plan:      [{ key: 'plan', status: '개발중' }, { key: 'result', status: '리뷰중' }, { key: 'reviewJson', status: '완료' }],
  direct:    [{ key: 'result', status: '리뷰중' }, { key: 'reviewJson', status: '완료' }],
  // 아래 3종은 산출물을 남기지 않는 것이 정상 동작이라 파일로 완료를 알 수 없다 → 14일 규칙.
  investigate: 'stale-rule',
  ops:         'stale-rule',
  harness:     'stale-rule',
};

// /pack 의 "14일 무변경 스레드 자동 archive" 와 같은 값. 같은 뜻의 임계값을 둘 두지 않는다.
// [근거:관례·조정가능]
const DEFAULT_STALE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 진단 문자열에서 파일 경로를 벗긴다.
 *
 * 왜 — `diagnostics.warnings[]` 는 예외 메시지를 그대로 싣던 자유문자열 채널이었고, Node 의
 * 예외 메시지는 절대경로(사용자명·머신 구조 포함)를 담는다. 원장은 공개 레포로 나갈 수 있는데
 * scan-publish.sh 의 패턴에는 **경로가 없어** 이 축을 막을 게이트가 없다.
 * [근거:코드리뷰 2026-09-22 W1]
 */
function scrub(msg) {
  let s = String(msg == null ? '' : msg);
  s = s.split(ROOT).join('.');                          // 작업 디렉터리는 상대경로로
  s = s.replace(/[A-Za-z]:[\\/][^\s'"]*/g, '{경로}');     // 남은 드라이브 경로 (C:\… · C:/…)
  s = s.replace(/\/(?:Users|home)\/[^\s'"]*/g, '{경로}'); // POSIX 홈 경로
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ── 인자 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    root: '',
    group: DEFAULT_GROUP,
    out: DEFAULT_OUT,
    staleDays: DEFAULT_STALE_DAYS,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = argv[++i];
    else if (a.startsWith('--root=')) opts.root = a.slice(7);
    else if (a === '--group') opts.group = argv[++i];
    else if (a.startsWith('--group=')) opts.group = a.slice(8);
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else if (a === '--stale-days') opts.staleDays = Number(argv[++i]);
    else if (a.startsWith('--stale-days=')) opts.staleDays = Number(a.slice(13));
    else if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else return { error: `알 수 없는 인자: ${a}` };
  }
  if (opts.root !== '' && !opts.root) return { error: '--root 값이 비었다' };
  if (!opts.group) return { error: '--group 값이 비었다' };
  if (!opts.out) return { error: '--out 값이 비었다' };
  if (!Number.isFinite(opts.staleDays) || opts.staleDays < 0) {
    return { error: '--stale-days 는 0 이상의 숫자다' };
  }
  return opts;
}

// ── 스캔 ────────────────────────────────────────────────────────────────

/** 과업 폴더를 나열하고 _intake.json 을 읽는다. 읽지 못한 것은 건너뛰되 사유를 모은다. */
function scanTasks(tasksDir) {
  const tasks = [];
  const skipped = [];
  let entries;
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch (e) {
    return { tasks, skipped: [{ taskId: '(전체)', reason: `tasks 디렉터리를 읽지 못했다: ${scrub(e.code || e.message)}` }] };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const taskId = ent.name;
    const intakeFile = path.join(tasksDir, taskId, '_intake.json');
    if (!fs.existsSync(intakeFile)) {
      skipped.push({ taskId, reason: '_intake.json 없음' });
      continue;
    }
    try {
      tasks.push({ taskId, dir: path.join(tasksDir, taskId), intake: JSON.parse(fs.readFileSync(intakeFile, 'utf8')) });
    } catch (e) {
      skipped.push({ taskId, reason: `_intake.json 파싱 실패: ${scrub(e.message)}` });
    }
  }
  return { tasks, skipped };
}

/** 그룹(= _intake.json.project) 이 같은 것만 남긴다. spawn 전에 반드시 먼저 거른다. */
function filterGroup(rawTasks, group) {
  return rawTasks.filter((t) => t.intake.project === group);
}

/** 경로 해석은 task-paths.cjs 가 정본이다. 과업당 1회만 spawn 한다. */
function resolvePaths(taskId) {
  try {
    const out = execFileSync(process.execPath, [harnessTool('scripts', 'task-paths.cjs'), taskId], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out);
    return { present: parsed.present || {}, warning: null };
  } catch (e) {
    // 실패해도 예외로 중단하지 않는다 — 한 과업 때문에 원장 전체가 죽지 않게 한다.
    return { present: {}, warning: `${taskId}: 경로 해석 실패 (${scrub(e.code || e.message)})` };
  }
}

/** 과업 폴더 하위 전체 파일의 최대 mtime 과 경과일. */
function lastTouched(taskDir, now) {
  let newest = 0;
  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (it.isDirectory()) walk(p);
      } catch { /* 경합으로 사라진 파일은 무시한다 */ }
    }
  };
  walk(taskDir);
  if (!newest) newest = now;
  return { iso: new Date(newest).toISOString(), days: Math.floor((now - newest) / DAY_MS) };
}

/** _intake.json 외에 남은 산출물이 있는가. 조사 과업의 완료 신호다. */
function hasArtifacts(taskDir) {
  try {
    return fs.readdirSync(taskDir).filter((n) => n !== '_intake.json').length > 0;
  } catch {
    return false;
  }
}

// ── 상태 엔진 ───────────────────────────────────────────────────────────

/**
 * 성립하는 근거 중 **가장 진행된 단계**를 채택한다 — 역행 방지.
 * (한 과업에 여러 근거가 동시에 성립할 때 뒤 단계로 내려가지 않게 한다.)
 */
function resolveStatus(candidates) {
  let best = { value: TASK_STATUSES[0], via: '채번됨', inferred: false };
  let bestIdx = 0;
  for (const c of candidates) {
    const idx = TASK_STATUSES.indexOf(c.value);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = c;
    }
  }
  return { value: best.value, via: best.via, inferred: Boolean(best.inferred) };
}

/**
 * 상태 엔진 본체. 진입단계 표를 보고 근거 파일의 실재를 단계로 바꾼다.
 * 유도할 수 없으면 추정하지 않고, 추정한 경우 inferred=true 로 그 사실을 남긴다.
 */
function deriveStatus(entry, present, touched, staleDays, artifacts) {
  const rule = ENTRY_PATHS[entry];

  if (rule === 'stale-rule') {
    // 리뷰 판정 파일은 확정 근거다 — 사람이 판정한 사실이라 추정이 아니다.
    if (present.reviewJson) {
      return { value: '완료', via: 'reviewJson 존재', inferred: false };
    }
    // 그 밖의 산출물은 '무언가 만들어졌다'일 뿐 완료 표시가 아니다.
    // (실측 반례: 리뷰 중인 harness 과업이 brief·plan·test 를 가져 '완료'로 찍혔다)
    // [근거:코드리뷰 2026-09-22 W2]
    if (artifacts) {
      return { value: '완료', via: '산출물 존재(완료 표시 아님)', inferred: true };
    }
    if (touched.days >= staleDays) {
      return { value: '완료', via: `무변경 ${touched.days}일`, inferred: true };
    }
    return { value: '개발중', via: `최근 활동 ${touched.days}일 전`, inferred: false };
  }

  if (!Array.isArray(rule)) {
    // 표에 없는 진입단계 — 추정하지 않는다.
    return { value: '접수', via: `진입단계 미정의(${entry})`, inferred: false };
  }

  const candidates = [];
  for (const step of rule) {
    if (present[step.key]) candidates.push({ value: step.status, via: `${step.key} 존재`, inferred: false });
  }
  if (!candidates.length) return { value: '접수', via: '채번됨', inferred: false };
  return resolveStatus(candidates);
}

// ── 보강 (페이즈 2) ─────────────────────────────────────────────────────

/**
 * plan/phases/phase_{N}.md 를 모아 TRD 목록을 만든다.
 * 헤더 표는 파싱하지 않는다 — 과업마다 행 구성이 다르다(실측: slug·커버요구 행 유무가 섞임).
 */
function collectTrds(phaseDirRel, taskId) {
  if (!phaseDirRel) return [];
  const dir = path.isAbsolute(phaseDirRel) ? phaseDirRel : path.join(ROOT, phaseDirRel);
  let files;
  try {
    files = fs.readdirSync(dir).filter((n) => /^phase[_-]?\d+\.md$/i.test(n));
  } catch {
    return [];
  }
  const trds = [];
  for (const name of files) {
    let first = '';
    try {
      first = fs.readFileSync(path.join(dir, name), 'utf8').split('\n')[0] || '';
    } catch { /* 읽지 못하면 파일명만으로 만든다 */ }

    const head = first.match(/^#\s*페이즈\s*(\d+)\s*[:：]\s*(.+)$/);
    const fromName = name.match(/(\d+)/);
    const seq = Number((fromName && fromName[1]) || (head && head[1]) || 0);
    const title = (head && head[2].trim()) || name.replace(/\.md$/i, '');
    trds.push({ trdId: `${taskId}#${seq}`, seq, title });
  }
  // phase_10 이 생겨도 순서가 깨지지 않도록 숫자로 정렬한다.
  trds.sort((a, b) => a.seq - b.seq);
  return trds;
}

/** 과업 상태 → TRD 상태. 사상표 밖이면 추정하지 않고 개발대기로 떨어뜨린다. */
function deriveTrdStatus(taskStatus) {
  const mapped = TRD_STATUS_MAP[taskStatus];
  if (mapped) return { value: mapped, via: '과업상태 유도' };
  return { value: TRD_STATUSES[0], via: '폴백 — 완료 플래그 부재' };
}

/**
 * 리뷰 판정 요약. files[] 에는 소스 파일 경로가 들어 있으므로 통째로 담지 않고
 * 건수만 남긴다 (R-18). 필요한 필드만 골라 옮긴다.
 */
function summarizeReview(reviewJsonRel) {
  if (!reviewJsonRel) return null;
  const file = path.isAbsolute(reviewJsonRel) ? reviewJsonRel : path.join(ROOT, reviewJsonRel);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      verdict: j.verdict || '',
      critical: Number(j.critical) || 0,
      warning: Number(j.warning) || 0,
      reviewedAt: j.generated_at || '',
      fileCount: Array.isArray(j.files) ? j.files.length : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 원장을 만든 사람. 과업 수행자가 아니라 **원장 생성자**다.
 * 이름 대신 이메일을 설정한 환경이 있어 형식 검사로 버린다.
 */
let _ownerCache;
function resolveOwner() {
  if (_ownerCache !== undefined) return _ownerCache;
  try {
    const name = execFileSync('git', ['config', 'user.name'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    _ownerCache = name && !name.includes('@') ? name : null;
  } catch {
    _ownerCache = null;
  }
  return _ownerCache;
}

/** 그룹 표시명. 레지스트리가 정본이며 실패하면 그룹명을 그대로 쓴다. */
function resolveGroupLabel(group) {
  try {
    const out = execFileSync(process.execPath, [harnessTool('hooks', 'lib', 'registry.js'), 'get-json', group], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out).role || group;
  } catch {
    return group;
  }
}

/** 페이즈 1 이 만든 과업 레코드에 두 번째 층을 얹는다. 과업 상태는 바꾸지 않는다. */
function enrichTask(task, present) {
  const st = deriveTrdStatus(task.status);
  task.trds = collectTrds(present.phaseDir, task.taskId).map((t) => ({
    ...t, status: st.value, statusVia: st.via,
  }));
  task.review = summarizeReview(present.reviewJson);
  task.owner = resolveOwner();
  return task;
}

// ── 수신 어댑터 (페이즈 3) ──────────────────────────────────────────────

/**
 * adapters/*.cjs 를 나열해 require 한다.
 *
 * 주의 — 이 폴더는 **신뢰 경계**다. 놓인 파일이 그대로 실행된다.
 * 어댑터 추가는 하네스 파일 수정 원칙(사용자 확인)을 따른다.
 */
function loadAdapters(dirRel) {
  const dir = path.isAbsolute(dirRel) ? dirRel : path.join(ROOT, dirRel);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.cjs')).sort();
  } catch {
    return { adapters: [], warns: [] }; // 어댑터가 없는 것은 정상이다.
  }
  const adapters = [];
  const warns = [];
  for (const n of names) {
    try {
      const mod = require(path.join(dir, n));
      if (!mod || typeof mod.load !== 'function' || !mod.name) {
        warns.push(`어댑터 ${n}: {name, load} 계약을 지키지 않아 건너뜀`);
        continue;
      }
      adapters.push(mod);
    } catch (e) {
      warns.push(`어댑터 ${n} 로드 실패: ${scrub(e.message)}`);
    }
  }
  return { adapters, warns };
}

/** 어댑터들의 수신분을 모아 그룹으로 거르고 requestId 중복을 없앤다. */
function collectRequests(adapters, group) {
  const requests = [];
  const warns = [];
  const seen = new Map();
  for (const ad of adapters) {
    let got;
    try {
      got = ad.load({ group, root: ROOT }) || {};
    } catch (e) {
      warns.push(`어댑터 ${ad.name} 실행 실패: ${scrub(e.message)}`);
      continue;
    }
    for (const w of got.warns || []) warns.push(w);
    for (const r of got.requests || []) {
      if (r.group && r.group !== group) continue; // 그룹 필터는 본체가 한다.
      // 계약 밖 레코드는 버리고 경고만 남긴다 — 어댑터 입력은 외부 데이터라
      // 1건 불량이 원장 전체를 막으면 화면이 통째로 '원장 없음'이 된다.
      // 스캔 경로(skipped)와 저하 동작을 맞춘다. [근거:코드리뷰 2026-09-22 W3]
      if (REQUEST_TYPES.indexOf(r.type) < 0 || REQUEST_STATUSES.indexOf(r.status) < 0) {
        warns.push(`${ad.name}: ${r.requestId} 계약 밖 값(type=${r.type || '-'} status=${r.status || '-'}) — 제외`);
        continue;
      }
      if (seen.has(r.requestId)) {
        // 선순위 = 먼저 로드된 어댑터. 나중에 넣으면 그때는 데이터가 이미 섞여 있다.
        warns.push(`requestId 충돌: ${r.requestId} — ${seen.get(r.requestId)} 우선, ${ad.name} 무시`);
        continue;
      }
      seen.set(r.requestId, ad.name);
      requests.push({ ...r, group: r.group || group, source: ad.name });
    }
  }
  return { requests, warns };
}

/** requests[].linkedTaskIds 를 단일 원천으로 tasks[].requestIds 역참조를 만든다. */
function linkRequests(tasks, requests) {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const unlinked = [];
  for (const r of requests) {
    for (const id of r.linkedTaskIds) {
      const t = byId.get(id);
      if (!t) { unlinked.push(id); continue; }
      if (!t.requestIds.includes(r.requestId)) t.requestIds.push(r.requestId);
    }
  }
  return [...new Set(unlinked)];
}

// ── 출력 계약 검증 (무의존 최소 검증기) ─────────────────────────────────

// 이 검증기가 해석하는 키워드. 스키마에 그 밖의 키워드를 쓰면 조용히 통과하므로 경고한다.
const SUPPORTED_KEYWORDS = new Set([
  '$comment', 'type', 'required', 'properties', 'items', 'enum', 'pattern',
  'minimum', 'additionalProperties',
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function validateNode(value, schema, at, errors, unsupported) {
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(k)) unsupported.add(k);
  }

  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = allowed.some((t) => (t === 'number' ? actual === 'number' : t === actual));
    if (!ok) {
      errors.push(`${at}: type ${allowed.join('|')} 기대, ${actual} 임`);
      return; // 타입이 틀리면 하위 검사는 의미가 없다.
    }
  }
  if (value === null) return;

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: enum [${schema.enum.join(', ')}] 밖의 값 '${value}'`);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: pattern ${schema.pattern} 불일치 ('${String(value).slice(0, 30)}')`);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${at}: minimum ${schema.minimum} 미만 (${value})`);
  }

  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${at}.${key}: 필수 필드 없음`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${at}.${key}: 계약에 없는 필드`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) validateNode(value[key], sub, `${at}.${key}`, errors, unsupported);
    }
  }

  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((v, i) => validateNode(v, schema.items, `${at}[${i}]`, errors, unsupported));
  }
}

/** 원장이 계약을 지키는지 본다. 어기면 파일을 쓰지 않는다. */
function validate(ledger, schemaFile) {
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`스키마 파일을 읽지 못했다: ${e.message}`], unsupported: [] };
  }
  const errors = [];
  const unsupported = new Set();
  validateNode(ledger, schema, '$', errors, unsupported);
  return { ok: errors.length === 0, errors, unsupported: [...unsupported] };
}

// ── 조립 ────────────────────────────────────────────────────────────────

/**
 * meta + tasks[] 조립. 과업 1건을 만드는 지점을 이 함수 한 곳에 모아 둔다 —
 * 페이즈 2·3 이 여기에 보강 단계를 끼워 넣는다.
 */
function buildLedger(opts) {
  const now = Date.now();
  const { tasks: all, skipped } = scanTasks(TASKS_DIR);
  const mine = filterGroup(all, opts.group);
  const warnings = [];

  const tasks = mine.map((t) => {
    const { present, warning } = resolvePaths(t.taskId);
    if (warning) warnings.push(warning);
    const touched = lastTouched(t.dir, now);
    const st = deriveStatus(t.intake.entry, present, touched, opts.staleDays, hasArtifacts(t.dir));

    // 통째 복사하지 않는다 — 아래 키만 옮긴다.
    const rec = {
      taskId: t.taskId,
      group: opts.group,
      domain: t.intake.domain || '',
      domainCode: t.intake.domainCode || '',
      entry: t.intake.entry || '',
      title: t.intake.title || '',
      createdAt: t.intake.mintedAt || '',
      updatedAt: touched.iso,
      status: st.value,
      statusVia: st.via,
      statusInferred: st.inferred,
      // 아래 4개는 보강 단계가 채운다. 화면이 undefined 를 만나지 않도록 키는 반드시 둔다.
      owner: null,
      trds: [],
      review: null,
      requestIds: [], // 페이즈 3
    };
    return enrichTask(rec, present);
  });

  tasks.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));

  // 수신 어댑터 — 0개여도 원장은 정상 생성된다.
  const ad = loadAdapters(ADAPTERS_DIR);
  warnings.push(...ad.warns);
  const req = collectRequests(ad.adapters, opts.group);
  warnings.push(...req.warns);
  const unlinkedTaskIds = linkRequests(tasks, req.requests);

  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      adpCode: ADP_CODE,
      group: opts.group,
      groupLabel: resolveGroupLabel(opts.group),
      generatedBy: resolveOwner(),
      generatedAt: new Date(now).toISOString(),
      staleDays: opts.staleDays,
      taskCount: tasks.length,
      scannedCount: all.length,
      skippedCount: skipped.length,
      requestCount: req.requests.length,
    },
    tasks,
    requests: req.requests,
    diagnostics: { skipped, warnings, unlinkedTaskIds },
  };
}

// ── 출력 ────────────────────────────────────────────────────────────────

function printSummary(ledger) {
  const m = ledger.meta;
  const counts = {};
  for (const s of TASK_STATUSES) counts[s] = 0;
  let inferred = 0;
  for (const t of ledger.tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1;
    if (t.statusInferred) inferred++;
  }
  const line = TASK_STATUSES.map((s) => `${s} ${counts[s]}`).join(' · ');

  console.log(`\n과업 원장 — ${m.group} (ADP ${m.adpCode})`);
  console.log(`  생성 ${m.generatedAt}  ·  무변경 기준 ${m.staleDays}일`);
  console.log(`  대상 ${m.taskCount}건 / 전체 스캔 ${m.scannedCount}건`);
  console.log(`  상태  ${line}${inferred ? `   (추정 ${inferred}건)` : ''}`);

  const withTrd = ledger.tasks.filter((t) => t.trds.length).length;
  const trdTotal = ledger.tasks.reduce((n, t) => n + t.trds.length, 0);
  const reviewed = ledger.tasks.filter((t) => t.review).length;
  if (withTrd || reviewed) {
    console.log(`  TRD   과업 ${withTrd}건 · ${trdTotal}개   ·   리뷰 판정 ${reviewed}건`);
  }
  if (m.requestCount) {
    const linked = ledger.tasks.filter((t) => t.requestIds.length).length;
    console.log(`  요청서 ${m.requestCount}건   ·   과업 연결 ${linked}건`);
  }
  if (m.generatedBy) console.log(`  생성자 ${m.generatedBy}`);
  const un = ledger.diagnostics.unlinkedTaskIds || [];
  if (un.length) console.log(`  ! 요청서가 가리키는 미등재 과업 ${un.length}건: ${un.join(', ')}`);

  if (m.skippedCount) console.log(`  건너뜀 ${m.skippedCount}건 (_intake.json 없음·파싱 실패)`);
  for (const w of ledger.diagnostics.warnings) console.log(`  ! ${w}`);
  console.log('');
}

// ── 내보내기 (선택 단계) ────────────────────────────────────────────────

const scanSh = () => harnessTool('scripts', 'scan-publish.sh');

/**
 * 발행 게이트. fail-closed 이며 우회 인자를 두지 않는다 — 예외가 없다는 것이 이 게이트의 값이다.
 * 히트는 파일·패턴·줄번호만 옮긴다. 매칭 값을 재출력하면 스캔 로그가 시크릿 사본이 된다.
 */
function runScanGate(fileRel) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('bash', [scanSh(), '--file', fileRel], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 2;
    out = (e.stdout || '').toString();
  }
  let json = null;
  try { json = JSON.parse(out); } catch { /* 게이트가 JSON 을 못 낸 경우도 실패로 다룬다 */ }
  const hits = (json && Array.isArray(json.hits) ? json.hits : []).map((h) => ({
    file: h.file || '', pattern: h.pattern || h.rule || '', line: h.line || h.lineNo || '',
  }));
  return { pass: code === 0 && json && json.pass === true, code, hits, raw: json };
}

function exportLedger(argv) {
  const o = { root: '', file: DEFAULT_OUT, dest: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a.startsWith('--root=')) o.root = a.slice(7);
    else if (a === '--file') o.file = argv[++i];
    else if (a.startsWith('--file=')) o.file = a.slice(7);
    else if (a === '--dest') o.dest = argv[++i];
    else if (a.startsWith('--dest=')) o.dest = a.slice(7);
    else if (a === '--dry-run') o.dryRun = true;
    else { console.error(`ERROR: 알 수 없는 인자: ${a}`); process.exit(2); }
  }
  // 값 없이 온 인자를 여기서 닫는다 — 안 그러면 스캔을 다 하고 나서 스택트레이스로 죽는다.
  for (const [k, v] of [['--root', o.root], ['--file', o.file], ['--dest', o.dest]]) {
    if (v !== '' && !v) { console.error(`ERROR: ${k} 값이 비었다`); process.exit(2); }
  }

  const r = resolveRoot(o.root);
  if (r.error) { console.error(`ERROR: ${r.error}`); process.exit(2); }
  setRoot(r.root);

  // 1단계 — 대상이 계약을 지키는가. 어긴 것을 내보내지 않는다.
  const abs = path.resolve(o.file);
  if (!fs.existsSync(abs)) {
    console.error(`ERROR: 원장이 없다: ${o.file} — 먼저 생성해라.`);
    process.exit(2);
  }
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    console.error(`ERROR: 원장을 읽지 못했다: ${e.message}`);
    process.exit(2);
  }
  const v = validate(ledger, SCHEMA_FILE);
  for (const k of v.unsupported) {
    console.error(`경고: 스키마에 검증기가 모르는 키워드 '${k}' 가 있다 — 그 규칙은 검사되지 않았다`);
  }
  if (!v.ok) {
    console.error(`ERROR: 계약 위반 ${v.errors.length}건 — 내보내지 않는다.`);
    for (const e of v.errors.slice(0, 10)) console.error(`  ${e}`);
    process.exit(2);
  }

  // 2단계 — 발행 게이트. 통과하지 못하면 여기서 끝난다.
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const gate = runScanGate(rel);
  if (!gate.pass) {
    console.error(`ERROR: 발행 스캔에 막혔다 (exit ${gate.code}) — 내보내지 않는다.`);
    for (const h of gate.hits.slice(0, 20)) {
      console.error(`  ${h.file}:${h.line}  패턴=${h.pattern}`);
    }
    if (!gate.hits.length) console.error('  (게이트가 사유를 내지 않았다 — scan-publish.sh 를 직접 실행해 확인해라)');
    process.exit(1);
  }

  console.log(`발행 스캔 통과 — ${rel}`);
  console.log(`  과업 ${ledger.meta.taskCount}건 · 요청서 ${ledger.meta.requestCount}건 · 그룹 ${ledger.meta.group}`);
  console.log('  주의: 이 스캔은 시크릿·PII·내부IP 를 잡는다. 과업 제목의 고객사명 같은 사업 정보는 잡지 못한다.');

  if (o.dryRun) { console.log('\n--dry-run — 복사하지 않고 끝낸다.'); return; }
  if (!o.dest) {
    console.log('\n--dest 가 없다. 통과만 확인하고 끝낸다 (복사하려면 --dest {경로}).');
    return;
  }

  // 4단계 — 복사까지만 한다(3단계는 위 --dry-run 반환). 커밋·push 는 사람이 한다(권한 실패를 스크립트가 삼키지 않게).
  const destAbs = path.resolve(o.dest);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(abs, destAbs);
  console.log(`\n복사 완료 → ${o.dest}`);
  console.log('  커밋·push 는 하지 않았다. 대상 레포에서 직접 커밋해라.');
}

// ── 실행 ────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'export') return exportLedger(argv.slice(1));

  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`ERROR: ${opts.error}`);
    console.error('사용: node task-ledger.cjs [--root {하네스루트}] [--group {그룹}] [--out {경로}] [--stale-days N] [--json] [--quiet]');
    process.exit(2);
  }

  const r = resolveRoot(opts.root);
  if (r.error) {
    console.error(`ERROR: ${r.error}`);
    process.exit(2);
  }
  setRoot(r.root);

  const ledger = buildLedger(opts);

  if (!ledger.tasks.length) {
    console.error(`ERROR: 그룹 '${opts.group}' 에 해당하는 과업이 없다 (전체 ${ledger.meta.scannedCount}건 스캔).`);
    process.exit(1);
  }

  // 계약 검증 — 어기면 파일을 쓰지 않는다. 반쪽 원장이 화면에 실리면 실패가 감춰진다.
  const v = validate(ledger, SCHEMA_FILE);
  for (const k of v.unsupported) {
    console.error(`경고: 스키마에 검증기가 모르는 키워드 '${k}' 가 있다 — 그 규칙은 검사되지 않았다`);
  }
  if (!v.ok) {
    console.error(`ERROR: 출력이 계약(task-ledger.schema.json)을 어겼다 — 파일을 쓰지 않는다. 위반 ${v.errors.length}건`);
    for (const e of v.errors.slice(0, 20)) console.error(`  ${e}`);
    if (v.errors.length > 20) console.error(`  … 외 ${v.errors.length - 20}건`);
    process.exit(2);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(ledger, null, 2) + '\n');
    return;
  }

  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');

  if (!opts.quiet) {
    printSummary(ledger);
    console.log(`  → ${path.relative(ROOT, outPath).split(path.sep).join('/')}`);
  }
}

if (require.main === module) main();

module.exports = {
  deriveStatus, resolveStatus, buildLedger,
  collectTrds, deriveTrdStatus, summarizeReview, enrichTask,
  loadAdapters, collectRequests, linkRequests, validate, scrub,
  TASK_STATUSES, TRD_STATUSES, ENTRY_PATHS, TRD_STATUS_MAP, SCHEMA_FILE,
};
