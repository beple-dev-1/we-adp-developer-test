#!/usr/bin/env node
/**
 * greenzone-return — 개발요청서(DR) **회신**을 규격대로 만들고 올리기 전에 검사한다.
 *
 *   node scripts/greenzone-return.cjs plan     --dr {DR}
 *   node scripts/greenzone-return.cjs scaffold --dr {DR}
 *   node scripts/greenzone-return.cjs check    --dr {DR}
 *
 * 기능명세서(`greenzone.cjs`)와는 다른 산출물이다 — 저쪽은 우리가 만든 것을 열람 구역에
 * 내는 것이고, 이쪽은 **Builder 가 보낸 요청마다 정해진 자리에 정해진 파일을 돌려주는**
 * 것이다. 규격이 요청마다 다르므로 손으로 짜지 않는다.
 *
 * ★ 규격 정본은 `{DR}/manifest.json` 의 `expectedBack` 이다 — `expected-back.md` 가 아니다.
 *   v3 부터 그 md 는 "Developer 는 이 파일을 받지 않는다(스펙 4-4)" 한 줄짜리 껍데기로
 *   바뀌었고, `expectedBack` 블록은 v2·v3 에 똑같이 실려 온다(실측 2026-09-26).
 *
 * ★ 브랜치 이름을 짐작하지 않는다. v2 는 `feedback/{시스템}/{DR}`, v3 는 `feedback/{DR}` 로
 *   **시스템 마디가 빠졌다.** manifest 가 준 문자열을 그대로 쓴다.
 *
 * ★ push 하지 않는다 · 브랜치를 갈아타지 않는다 · `core/` 화면 파일을 만들지 않는다.
 *   워킹트리는 사람의 것이고, 화면을 고치는 것은 개발이다. 이 도구는 **회신서와 시험결과
 *   표를 규격대로 깔고, 규격 위반을 올리기 전에 잡는 것**까지만 한다.
 *
 * ★ 판정 칸을 대신 채우지 않는다. 하네스 TC 번호(`TC-{과업번호}-017`)와 Builder TC 번호
 *   (`TC-001`)는 번호 공간이 다르고 둘을 잇는 근거가 없다. 없는 매핑을 지어내는 대신
 *   빈칸으로 내고 `check` 가 공란·허용 어휘 위반을 fail-closed 로 막는다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveRoot, scrub } = require('./greenzone.cjs');

/** 저장소 레포 clone 위치. 어댑터와 같은 규약을 쓴다. */
const ENV_DIR = 'ADP_REPOSITORY_DIR';
const DEFAULT_DIR = path.join('target', 'adp-repository');
/** 명령 예시에 찍는 경로. git 명령에 윈도 구분자를 넣지 않는다. */
const DEFAULT_DIR_POSIX = 'target/adp-repository';

/** 전달 꾸러미 브랜치 접두. `dr/{DR}` · `dr/{시스템}/{DR}` 두 형태를 다 잡는다. */
const DR_REF_PREFIX = 'refs/remotes/origin/dr';
const MAIN_REF = 'origin/main';

/** 아는 꾸러미 규격. 모르는 버전은 조용히 통과시키지 않는다. */
const SPEC_VERSIONS = [2, 3];

/** 회신서에 쓰는 상태값. 이 둘뿐이고, 견본 문구를 그대로 두면 Builder 가 거절한다. */
const STATES = ['changed', 'unchanged'];

/** 판정 허용 어휘. 다른 말은 Builder 가 「모름」으로 센다. */
const VERDICTS = ['통과', 'PASS', 'OK', '실패', 'FAIL', 'NG'];

/** 시험결과 표의 칸. 9칸 고정 — 빼거나 합치면 그 줄을 못 읽는다. */
const TC_COLUMNS = ['TC', '무엇을 보나', '의존', '조건', '행위', '기대 결과', '실제 결과', '판정', '근거'];
const TC_FILLED = 6;   // 앞 6칸은 요청서에서 옮긴다 — 고치지 않는다.
const NONE = '—';

/* ── git ─────────────────────────────────────────── */

function git(dir, args) {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
}

function gitTry(dir, args) {
  try { return { out: git(dir, args) }; } catch (e) { return { error: e }; }
}

/** 브랜치의 파일 하나. 없으면 null — 빈 파일과 구분한다. */
function showFile(dir, ref, file) {
  const r = gitTry(dir, ['show', ref + ':' + file]);
  return r.error ? null : r.out;
}

function currentBranch(dir) {
  const r = gitTry(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.error ? '' : r.out.trim();
}

/** `dr/*` 브랜치에서 DR 번호가 **마지막 마디**인 것을 찾는다. */
function findDrRef(dir, dr) {
  const r = gitTry(dir, ['for-each-ref', '--format=%(refname:short)', DR_REF_PREFIX]);
  if (r.error) return { error: 'dr/* 브랜치 목록을 읽지 못했다 (' + scrub(r.error.message) + ')' };
  const refs = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  const hit = refs.filter((x) => x.split('/').pop() === dr);
  if (!hit.length) {
    return {
      error: refs.length
        ? dr + ' 전달 브랜치가 없다 — 받은 것: ' + refs.map((x) => x.split('/').pop()).join(' · ') + ' (git fetch 했나)'
        : 'dr/* 브랜치가 하나도 없다 — 얕은 clone 이면 refspec 이 main 하나로 좁혀져 영영 안 온다',
    };
  }
  if (hit.length > 1) return { error: dr + ' 에 전달 브랜치가 여럿이다: ' + hit.join(' · ') };
  return { ref: hit[0] };
}

/* ── 저장소 레포 · 규격 읽기 ─────────────────────── */

function repoDir(harness) {
  return process.env[ENV_DIR] ? path.resolve(process.env[ENV_DIR]) : path.join(harness, DEFAULT_DIR);
}

/** 화면 구성요소 → 회신 자리. 규격이 정한 세 가지뿐이다. */
function slotPath(part, system, screenId) {
  if (part === 'pages') return 'core/' + system + '/pages/' + screenId + '.html';
  if (part === 'screen-md') return 'core/' + system + '/pages/' + screenId + '.md';
  if (part === 'index') return 'index.json';
  return null;
}

/**
 * 회신 규격. `manifest.json` 의 `expectedBack` 이 정본이다.
 * @returns {{contract: object}|{error: string}}
 */
function readContract(dir, ref, dr) {
  const raw = showFile(dir, ref, dr + '/manifest.json');
  if (!raw) return { error: dr + '/manifest.json 이 전달 브랜치에 없다' };
  let m;
  try { m = JSON.parse(raw); } catch (e) { return { error: dr + '/manifest.json 파싱 실패' }; }
  if (SPEC_VERSIONS.indexOf(m.specVersion) < 0) {
    return { error: dr + ' specVersion=' + m.specVersion + ' (아는 것은 ' + SPEC_VERSIONS.join('·') + ')' };
  }
  const eb = m.expectedBack;
  if (!eb || typeof eb !== 'object') return { error: dr + ' manifest 에 expectedBack 블록이 없다 — 회신 규격을 알 수 없다' };
  if (!eb.returnBranch) return { error: dr + ' expectedBack 에 returnBranch 가 없다 — 브랜치 이름을 짐작하지 않는다' };
  if (!eb.base) return { error: dr + ' expectedBack 에 base 가 없다' };

  const screens = (Array.isArray(eb.screens) ? eb.screens : []).map((s) => ({
    screenId: s.screenId,
    system: s.system,
    required: Array.isArray(s.required) ? s.required.slice() : [],
  }));
  const tests = eb.tests || {};
  return {
    contract: {
      dr: dr,
      specVersion: m.specVersion,
      returnBranch: String(eb.returnBranch),
      base: String(eb.base),
      screens: screens,
      unit: Array.isArray(tests.unit) ? tests.unit.slice() : [],
      integration: Array.isArray(tests.integration) ? tests.integration.slice() : [],
    },
  };
}

/* ── 마크다운 표 ─────────────────────────────────── */

/** `\|` 를 칸 구분으로 세지 않고 한 줄을 칸으로 가른다. */
function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  // 줄 양끝의 `|` 가 만든 빈 칸을 버린다.
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((s) => s.trim());
}

const TC_ID = /^`?(TC-\d+)`?$/;

/**
 * 문서에서 TC 로 시작하는 표 줄을 모아 **앞 6칸**을 만든다.
 *
 * 9칸 원본(v2 `expected-back.md`)은 앞 6칸을 그대로 옮긴다.
 * 3칸 원본(v3 `test-cases.md` — TC·무엇·기대)은 아는 두 칸만 옮기고 의존·조건·행위는
 * `—` 로 둔다. **지어내지 않는다** (사용자 확정 2026-09-26).
 */
function parseTcRows(md) {
  const rows = {};
  if (!md) return rows;
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (t[0] !== '|') continue;
    const cells = splitRow(t);
    if (!cells.length) continue;
    const m = TC_ID.exec(cells[0]);
    if (!m) continue;
    const id = m[1];
    if (rows[id]) continue;                       // 먼저 나온 것이 이긴다
    if (cells.length >= TC_FILLED) {
      rows[id] = [id, cells[1], cells[2], cells[3], cells[4], cells[5]];
    } else if (cells.length === 3) {
      rows[id] = [id, cells[1], NONE, NONE, NONE, cells[2]];
    } else {
      rows[id] = [id, cells[1] || NONE, NONE, NONE, NONE, NONE];
    }
  }
  return rows;
}

/**
 * TC 원본. `expected-back.md` 에 표가 있으면 그것이 정본이고, 없으면 `test-cases.md` 를
 * 본다. 버전 번호가 아니라 **실제로 읽힌 것**으로 고른다.
 */
function readTcSource(dir, ref, dr) {
  const eb = parseTcRows(showFile(dir, ref, dr + '/expected-back.md'));
  if (Object.keys(eb).length) return { rows: eb, via: dr + '/expected-back.md' };
  const tc = parseTcRows(showFile(dir, ref, dr + '/test-cases.md'));
  if (Object.keys(tc).length) return { rows: tc, via: dr + '/test-cases.md (3칸 — 의존·조건·행위는 ' + NONE + ')' };
  return { rows: {}, via: '' };
}

/** 9칸 표를 만든다. 뒤 3칸은 비운다 — 사람이 채운다. */
function tcTable(title, ids, src, warns) {
  const L = [];
  L.push('# ' + title);
  L.push('');
  L.push('| ' + TC_COLUMNS.join(' | ') + ' |');
  L.push('|' + TC_COLUMNS.map(() => '---').join('|') + '|');
  for (const id of ids) {
    let cols = src.rows[id];
    if (!cols) {
      warns.push(id + ' 은 요청서에 표 줄이 없다 — 앞 칸을 ' + NONE + ' 로 뒀다 (지어내지 않는다)');
      cols = [id, NONE, NONE, NONE, NONE, NONE];
    }
    L.push('| ' + cols.join(' | ') + ' |  |  |  |');
  }
  L.push('');
  L.push('**실제 결과·판정·근거만 채운다.** 앞 6칸은 고치지 않는다 — 고치면 어느 것을 검증했는지 짝이 어긋난다.');
  L.push('판정은 ' + VERDICTS.join(' · ') + ' 중 하나다. 다른 말은 Builder 가 「모름」으로 센다.');
  L.push('');
  return L.join('\n');
}

/* ── 회신서 ──────────────────────────────────────── */

/** 워킹트리의 파일이 base 와 다른가. 양쪽 다 없으면 같다고 본다. */
function differsFromBase(dir, base, rel) {
  const atBase = showFile(dir, base, rel);
  const abs = path.join(dir, rel);
  const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (atBase === null && now === null) return false;
  if (atBase === null || now === null) return true;
  return atBase !== now;
}

/**
 * 회신서를 만든다. `changed`/`unchanged` 를 사람이 적지 않는다 —
 * **base 대비 실제 파일 차이로 유도**한다. 적은 것과 낸 것이 어긋날 자리를 없앤다.
 */
function buildReturnJson(dir, contract) {
  const screens = contract.screens.map((s) => {
    const row = { screenId: s.screenId };
    for (const part of s.required) {
      const rel = slotPath(part, s.system, s.screenId);
      row[part] = rel && differsFromBase(dir, contract.base, rel) ? 'changed' : 'unchanged';
    }
    return row;
  });
  return { dr: contract.dr, base: contract.base, screens: screens };
}

/* ── 공통 준비 ───────────────────────────────────── */

function prepare(o) {
  const r = resolveRoot(o.root);
  if (r.error) return { error: r.error };
  const dir = o.repo ? path.resolve(o.repo) : repoDir(r.root);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return { error: '저장소 레포 clone 이 없다: ' + scrub(dir) + ' (' + ENV_DIR + ' 로 지정할 수 있다)' };
  }
  const f = findDrRef(dir, o.dr);
  if (f.error) return { error: f.error };
  const c = readContract(dir, f.ref, o.dr);
  if (c.error) return { error: c.error };
  return { dir: dir, ref: f.ref, contract: c.contract };
}

function die(msg) { console.error('ERROR: ' + msg); process.exit(2); }

/* ── plan ────────────────────────────────────────── */

function cmdPlan(o) {
  const p = prepare(o);
  if (p.error) die(p.error);
  const c = p.contract;
  const src = readTcSource(p.dir, p.ref, c.dr);

  console.log('');
  console.log('  ' + c.dr + ' 회신 규격 (specVersion ' + c.specVersion + ' · 정본 ' + c.dr + '/manifest.json expectedBack)');
  console.log('');
  console.log('    돌려보낼 브랜치   ' + c.returnBranch);
  console.log('    갈라 올 기준      ' + c.base);
  console.log('    TC 원본           ' + (src.via || '없음'));
  console.log('');
  if (c.screens.length) {
    for (const s of c.screens) {
      console.log('    화면 ' + s.screenId + ' (' + s.system + ')');
      for (const part of s.required) console.log('      ' + part + ' → ' + slotPath(part, s.system, s.screenId));
    }
  } else {
    console.log('    화면 없음 — 시험결과만 돌려주는 요청이다.');
  }
  console.log('');
  console.log('    통합테스트 ' + (c.integration.join(' ') || '없음'));
  console.log('    단위테스트 ' + (c.unit.join(' ') || '없음'));
  console.log('');
  console.log('  다음 (저장소 레포에서 직접 실행한다 — 이 도구는 브랜치를 갈아타지 않는다)');
  console.log('');
  console.log('    git -C ' + DEFAULT_DIR_POSIX + ' fetch origin');
  console.log('    git -C ' + DEFAULT_DIR_POSIX + ' switch -c ' + c.returnBranch + ' ' + c.base);
  console.log('    node scripts/greenzone-return.cjs scaffold --dr ' + c.dr);
  console.log('');
  console.log('  ⛔ 전달 브랜치(dr/…) 위에서 따지 않는다 — 기획이 그린 to-be 가 사실인 척 섞여 들어간다.');
  console.log('');
}

/* ── scaffold ────────────────────────────────────── */

function cmdScaffold(o) {
  const p = prepare(o);
  if (p.error) die(p.error);
  const c = p.contract;

  const on = currentBranch(p.dir);
  if (on !== c.returnBranch) {
    die('저장소 레포가 ' + c.returnBranch + ' 가 아니라 ' + (on || '(알 수 없음)') + ' 에 있다\n'
      + '       git -C ' + DEFAULT_DIR_POSIX + ' switch -c ' + c.returnBranch + ' ' + c.base);
  }

  const warns = [];
  const src = readTcSource(p.dir, p.ref, c.dr);
  if (!src.via && (c.integration.length || c.unit.length)) {
    warns.push('요청서에서 TC 표를 찾지 못했다 — 앞 칸이 전부 ' + NONE + ' 이 된다');
  }

  const made = [];
  const kept = [];
  const drDir = path.join(p.dir, c.dr);
  fs.mkdirSync(path.join(drDir, 'return'), { recursive: true });

  // 회신서는 전부 유도값이다 — 사람이 적는 칸이 없으므로 늘 새로 쓴다.
  fs.writeFileSync(path.join(drDir, 'return.json'), JSON.stringify(buildReturnJson(p.dir, c), null, 2) + '\n', 'utf8');
  made.push(c.dr + '/return.json');

  // 시험결과 표에는 사람이 채운 칸이 있다 — 있으면 건드리지 않는다.
  for (const t of [
    { ids: c.integration, file: 'integration-tests.md', title: c.dr + ' 통합테스트 결과' },
    { ids: c.unit, file: 'unit-tests.md', title: c.dr + ' 단위테스트 결과' },
  ]) {
    if (!t.ids.length) continue;
    const abs = path.join(drDir, 'return', t.file);
    const rel = c.dr + '/return/' + t.file;
    if (fs.existsSync(abs)) { kept.push(rel); continue; }
    fs.writeFileSync(abs, tcTable(t.title, t.ids, src, warns), 'utf8');
    made.push(rel);
  }

  console.log('');
  console.log('  ' + c.dr + ' 회신 뼈대를 깔았다 — ' + c.returnBranch);
  for (const f of made) console.log('    만듦  ' + f);
  for (const f of kept) console.log('    보존  ' + f + ' (이미 있다 — 다시 만들려면 지운다)');
  if (src.via) console.log('    TC 원본 ' + src.via);
  for (const w of warns) console.log('    ⚠ ' + w);
  console.log('');
  console.log('  화면 파일은 만들지 않았다 — `core/…` 를 고치는 것은 개발이다.');
  console.log('  회신서의 changed/unchanged 는 base 대비 실제 차이로 유도한다. 화면을 고친 뒤 scaffold 를 다시 돌리면 갱신된다.');
  console.log('');
  console.log('  다음  판정 칸을 채우고 → node scripts/greenzone-return.cjs check --dr ' + c.dr);
  console.log('');
}

/* ── check (fail-closed) ─────────────────────────── */

function cmdCheck(o) {
  const p = prepare(o);
  if (p.error) die(p.error);
  const c = p.contract;
  const fails = [];
  const notes = [];

  // ① 브랜치 — 이름을 짐작하지 않는다.
  const on = currentBranch(p.dir);
  if (on !== c.returnBranch) fails.push('브랜치가 ' + c.returnBranch + ' 가 아니라 ' + (on || '(알 수 없음)') + ' 다');

  // ② 회신서
  const rjPath = path.join(p.dir, c.dr, 'return.json');
  let rj = null;
  if (!fs.existsSync(rjPath)) fails.push(c.dr + '/return.json 이 없다 — 없으면 통째로 거절된다');
  else {
    try { rj = JSON.parse(fs.readFileSync(rjPath, 'utf8')); }
    catch (e) { fails.push(c.dr + '/return.json 을 읽지 못했다 (JSON 문법)'); }
  }

  if (rj) {
    if (!rj.base) fails.push('회신서에 base 가 없다');
    else if (gitTry(p.dir, ['merge-base', '--is-ancestor', rj.base, MAIN_REF]).error) {
      // ③ 기준 커밋이 기본 브랜치 이력에 있는가
      fails.push('회신서의 base 가 ' + MAIN_REF + ' 이력에 없다 — 전달 브랜치에서 딴 것은 거절된다');
    }
    if (rj.dr !== c.dr) fails.push('회신서의 dr 이 ' + rj.dr + ' 다 (요청은 ' + c.dr + ')');

    // ④ 화면 집합이 규격과 정확히 같은가
    const got = {};
    for (const s of (Array.isArray(rj.screens) ? rj.screens : [])) if (s && s.screenId) got[s.screenId] = s;
    for (const s of c.screens) {
      const row = got[s.screenId];
      if (!row) { fails.push('돌려받아야 할 화면이 회신서에 없다: ' + s.screenId); continue; }
      for (const part of s.required) {
        const v = row[part];
        if (v === undefined) { fails.push(s.screenId + ' 의 필수 구성요소 ' + part + ' 가 회신서에 없다'); continue; }
        if (STATES.indexOf(v) < 0) { fails.push(s.screenId + '.' + part + ' 가 모르는 상태값이다: ' + JSON.stringify(v)); continue; }

        // ⑤ 적은 것과 낸 것이 맞는가
        const rel = slotPath(part, s.system, s.screenId);
        const diff = differsFromBase(p.dir, rj.base || c.base, rel);
        if (v === 'changed' && !diff) fails.push(s.screenId + '.' + part + ' 를 changed 로 적었으나 ' + rel + ' 가 base 와 같다');
        if (v === 'unchanged' && diff) fails.push(s.screenId + '.' + part + ' 를 unchanged 로 적었으나 ' + rel + ' 가 바뀌어 있다');
      }
      delete got[s.screenId];
    }
    for (const extra of Object.keys(got)) fails.push('돌려받을 목록에 없는 화면이다: ' + extra);
  }

  // ⑥ 갈라 온 뒤 기본 브랜치에서 이 요청의 화면 파일이 바뀌었는가
  const slots = [];
  for (const s of c.screens) {
    for (const part of s.required) {
      const rel = slotPath(part, s.system, s.screenId);
      if (rel && slots.indexOf(rel) < 0) slots.push(rel);
    }
  }
  if (slots.length && rj && rj.base) {
    const d = gitTry(p.dir, ['diff', '--name-only', rj.base, MAIN_REF, '--'].concat(slots));
    if (!d.error) {
      for (const f of d.out.split('\n').map((x) => x.trim()).filter(Boolean)) {
        fails.push('갈라 온 뒤 ' + MAIN_REF + ' 에서 ' + f + ' 가 바뀌었다 — 합치고 base 를 지금 머리로 고친다');
      }
    }
  }

  // ⑦ 시험결과 표
  for (const t of [
    { ids: c.integration, file: 'integration-tests.md' },
    { ids: c.unit, file: 'unit-tests.md' },
  ]) {
    const rel = c.dr + '/return/' + t.file;
    const abs = path.join(p.dir, c.dr, 'return', t.file);
    if (!t.ids.length) {
      if (fs.existsSync(abs)) notes.push(rel + ' 이 있으나 규격에 그 종류 TC 가 없다 — Builder 가 읽지 않는다');
      continue;
    }
    if (!fs.existsSync(abs)) { fails.push(rel + ' 이 없다 — scaffold 를 먼저 돌린다'); continue; }

    const seen = [];
    for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
      const s = line.trim();
      if (s[0] !== '|') continue;
      const cells = splitRow(s);
      const m = cells.length ? TC_ID.exec(cells[0]) : null;
      if (!m) continue;
      const id = m[1];
      seen.push(id);
      if (t.ids.indexOf(id) < 0) { fails.push(rel + ' 에 보낸 적 없는 ' + id + ' 이 있다 — 통째로 거절된다'); continue; }
      if (cells.length !== TC_COLUMNS.length) {
        fails.push(rel + ' ' + id + ' 이 ' + cells.length + '칸이다 (9칸이어야 한다)');
        continue;
      }
      if (!cells[6]) fails.push(rel + ' ' + id + ' 실제 결과 칸이 비었다');
      if (!cells[7]) fails.push(rel + ' ' + id + ' 판정 칸이 비었다');
      else if (VERDICTS.indexOf(cells[7]) < 0) fails.push(rel + ' ' + id + ' 판정 [' + cells[7] + '] 는 허용 어휘가 아니다 (' + VERDICTS.join('·') + ')');
      if (!cells[8]) fails.push(rel + ' ' + id + ' 근거 칸이 비었다');
    }
    for (const id of t.ids) if (seen.indexOf(id) < 0) fails.push(rel + ' 에 ' + id + ' 줄이 없다');
  }

  console.log('');
  console.log('  ' + c.dr + ' 회신 점검 — ' + c.returnBranch);
  for (const n of notes) console.log('    참고  ' + n);
  if (fails.length) {
    for (const f of fails) console.log('    FAIL  ' + f);
    console.log('');
    console.log('  올리지 않는다. 위를 고치고 다시 돌린다.');
    console.log('');
    process.exit(1);
  }
  console.log('    통과 — 규격 위반 없음');
  console.log('');
  console.log('  올리기 (사람이 한다 — 이 도구는 push 하지 않는다)');
  console.log('');
  console.log('    git -C ' + DEFAULT_DIR_POSIX + ' add ' + (slots.length ? slots.join(' ') + ' ' : '') + c.dr + '/return.json ' + c.dr + '/return/');
  console.log('    git -C ' + DEFAULT_DIR_POSIX + ' commit -m "' + c.dr + ' 개발 결과"');
  console.log('    git -C ' + DEFAULT_DIR_POSIX + ' push origin ' + c.returnBranch);
  console.log('');
  console.log('  그다음 기획에 「개발 결과 받기」를 눌러 달라고 알린다.');
  console.log('');
}

/* ── 실행 ────────────────────────────────────────── */

function parseArgs(argv) {
  const o = { root: '', repo: '', dr: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (a.slice(0, 2) !== '--' || ['root', 'repo', 'dr'].indexOf(key) < 0) die('알 수 없는 인자: ' + a);
    if (!val) die('--' + key + ' 값이 비었다');
    o[key] = val;
  }
  if (!o.dr) die('--dr {DR번호} 가 필요하다');
  return o;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'plan') return cmdPlan(parseArgs(argv.slice(1)));
  if (cmd === 'scaffold') return cmdScaffold(parseArgs(argv.slice(1)));
  if (cmd === 'check') return cmdCheck(parseArgs(argv.slice(1)));
  console.error('사용: node scripts/greenzone-return.cjs plan     --dr {DR} [--root {하네스}] [--repo {저장소레포}]');
  console.error('      node scripts/greenzone-return.cjs scaffold --dr {DR} [--root {하네스}] [--repo {저장소레포}]');
  console.error('      node scripts/greenzone-return.cjs check    --dr {DR} [--root {하네스}] [--repo {저장소레포}]');
  process.exit(2);
}

if (require.main === module) main();

module.exports = { readContract, readTcSource, parseTcRows, splitRow, tcTable, slotPath, buildReturnJson, STATES, VERDICTS, TC_COLUMNS };
