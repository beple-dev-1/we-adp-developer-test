#!/usr/bin/env node
/**
 * greenzone — 개발 계획서·TRD 에서 **기능명세서**를 유도한다 (그린존 산출물).
 *
 *   node scripts/greenzone.cjs build  [--root {하네스}] [--group BIZ_ZEROPAY] [--task {과업번호}]
 *   node scripts/greenzone.cjs export --dest {경로} [--dry-run]
 *
 * 그린존이란 — 표준상 Builder 안의 **열람 전용** 구역이고, Developer 가 만든 산출물이 거기에
 * 올라가 기획자가 읽는다. 여기서 만드는 것은 그 구역에 낼 문서다.
 *
 * ★ 기능명세서만 만든다. 화면설계서는 만들지 않는다.
 *   ① 계획서·TRD 전 과업에 화면 서술(버튼·클릭·화면이동·레이아웃)이 **0건**이다 —
 *      유도할 원본이 없으므로 만들면 지어내는 것이 된다.
 *   ② 저장소 레포의 화면명세 55건은 Builder 가 `page2md.py` 로 **운영 소스에서 이미 뽑고
 *      있다**("정본은 운영 소스다"라고 그 파일들이 스스로 밝힌다). 여기서 또 만들면
 *      같은 화면에 정본이 둘이 된다.
 *   이 결정은 사용자 확정이다(2026-09-22, A안).
 *
 * ★ 모델을 쓰지 않는다. 계획서 원문을 **옮길 뿐 요약하지 않는다.** 없는 섹션은 "해당 없음"
 *   으로 닫고 무엇이 없는지 적는다. 요약은 사람이 안 읽은 문장을 사실로 만든다.
 *
 * ★ push 하지 않는다. export 는 발행 게이트를 지나 **복사까지만** 한다 — 원장 내보내기와
 *   같은 경계다. 권한 실패를 스크립트가 삼키면 안 나간 것을 나갔다고 믿게 된다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_MARKER = path.join('.claude', 'scripts', 'task-paths.cjs');
const DEFAULT_OUT = path.join(__dirname, '..', 'greenzone');
const ZONE = '그린존';
const ARTIFACT = 'A1 기능명세서';

let HARNESS = null;

/* ── 공통 ────────────────────────────────────────── */

function scrub(msg) {
  let s = String(msg == null ? '' : msg);
  if (HARNESS) s = s.split(HARNESS).join('.');
  s = s.replace(/[A-Za-z]:[\\/][^\s'"]*/g, '{경로}');
  s = s.replace(/\/(?:Users|home)\/[^\s'"]*/g, '{경로}');
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function resolveRoot(explicit) {
  const has = (d) => fs.existsSync(path.join(d, ROOT_MARKER));
  if (explicit) {
    const abs = path.resolve(explicit);
    return has(abs) ? { root: abs } : { error: `--root 에 하네스가 없다: ${scrub(abs)}` };
  }
  if (process.env.JEX_HARNESS_ROOT) {
    const abs = path.resolve(process.env.JEX_HARNESS_ROOT);
    return has(abs) ? { root: abs } : { error: 'JEX_HARNESS_ROOT 에 하네스가 없다' };
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

/* ── 계획서 파싱 (결정론 · 원문 보존) ────────────── */

/**
 * `## N.` 헤더로 끊어 그 섹션 본문을 돌려준다. 못 찾으면 null — 빈 문자열과 구분한다.
 *
 * ⚠ 정규식 `(?=\n## \d+\.|$)` 에 `m` 을 붙이면 `$` 가 **줄 끝마다** 맞아 본문이 통째로 빈다
 * (실측으로 §1·§2·§6·§7 이 전부 "해당 없음"으로 나왔다). 그래서 줄 단위로 가른다.
 */
function section(md, n) {
  const lines = md.split('\n');
  const head = new RegExp('^## ' + n + '\\.');
  const anyHead = /^## \d+\./;
  let i = lines.findIndex((l) => head.test(l));
  if (i < 0) return null;
  const body = [];
  for (i += 1; i < lines.length; i++) {
    if (anyHead.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

/** `### N-M.` 하위 절을 뺀 본문만. 개요는 앞 문단이 요지이고 하위 절은 부록이다. */
function withoutSubsections(body) {
  if (body == null) return null;
  const i = body.search(/^### /m);
  return (i < 0 ? body : body.slice(0, i)).trim();
}

/** 머리말 메타 표 `| 항목 | 값 |` 를 읽는다. */
function metaTable(md) {
  const out = {};
  const re = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$/gm;
  let m;
  while ((m = re.exec(md))) {
    const k = m[1].trim();
    if (!k || /^-+$/.test(k) || k === '항목') continue;
    if (out[k] === undefined) out[k] = m[2].trim();
  }
  return out;
}

/** §2 의 `**R-...**` 요구사항을 번호와 본문으로 가른다. 원문을 그대로 둔다. */
function requirements(md) {
  const body = section(md, 2);
  if (body == null) return { items: [], note: '계획서에 §2 기능 요구사항이 없다' };
  const items = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*[-*]\s*\[[ xX]\]\s*\*\*(R-[A-Z0-9-]+)\*\*\s*(.*)$/);
    if (m) { items.push({ id: m[1], text: m[2].trim() }); continue; }
    const m2 = line.match(/^\s*[-*]\s*\*\*(R-[A-Z0-9-]+)\*\*\s*(.*)$/);
    if (m2) items.push({ id: m2[1], text: m2[2].trim() });
  }
  return {
    items,
    note: items.length ? '' : '§2 는 있으나 R-번호 요구사항이 없다 — 이 계획서는 서술형이다',
  };
}

/** 페이즈 문서 = TRD. 메타 표에서 번호·영역·목표·커버 요구를 읽는다. */
function readTrds(phaseDir) {
  if (!phaseDir || !fs.existsSync(phaseDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(phaseDir).filter((x) => /^phase_\d+\.md$/.test(x))) {
    const md = fs.readFileSync(path.join(phaseDir, f), 'utf8');
    const meta = metaTable(md);
    const title = (md.match(/^#\s*페이즈\s*\d+\s*[::]\s*(.+)$/m) || [])[1] || '';
    const seq = Number((f.match(/phase_(\d+)/) || [])[1] || 0);
    out.push({
      trdId: path.basename(path.dirname(phaseDir)) + '#' + seq,
      seq,
      title: title.trim(),
      area: meta['영역'] || '',
      goal: meta['목표'] || '',
      covers: (meta['커버 요구'] || '').split(/[,·]/).map((s) => s.trim()).filter((s) => /^R-/.test(s)),
      overview: withoutSubsections(section(md, 1)) || '',
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/* ── 기능명세서 조립 ─────────────────────────────── */

function buildSpec(taskId, planFile, phaseDir) {
  const md = fs.readFileSync(planFile, 'utf8');
  const meta = metaTable(md);
  const req = requirements(md);
  const trds = readTrds(phaseDir);

  // 요구사항 ↔ TRD 역매핑. 커버 요구가 적힌 TRD 만 이어진다.
  const byReq = {};
  trds.forEach((d) => d.covers.forEach((r) => { (byReq[r] = byReq[r] || []).push('#' + d.seq); }));

  return {
    zone: ZONE,
    artifact: ARTIFACT,
    taskId,
    title: meta['제목'] || '',
    writtenAt: meta['작성일'] || '',
    scope: meta['대상 스코프'] || '',
    purpose: withoutSubsections(section(md, 1)) || '',
    requirements: req.items.map((r) => ({ id: r.id, text: r.text, trds: byReq[r.id] || [] })),
    requirementNote: req.note,
    trds: trds.map((d) => ({ seq: d.seq, title: d.title, area: d.area, goal: d.goal, covers: d.covers })),
    contract: section(md, 6),
    security: section(md, 7),
    source: { plan: 'plan/dev_plan.md', phases: trds.length },
  };
}

function specMarkdown(s) {
  const L = [];
  const na = (v, why) => (v && String(v).trim() ? v : '해당 없음 — ' + why);

  L.push('# 기능명세서 — ' + s.taskId);
  L.push('');
  L.push('| 항목 | 내용 |');
  L.push('|---|---|');
  L.push('| 구역 | ' + s.zone + ' (' + s.artifact + ') |');
  L.push('| 과업번호 | ' + s.taskId + ' |');
  L.push('| 제목 | ' + na(s.title, '계획서 머리말에 제목이 없다') + ' |');
  L.push('| 작성일 | ' + na(s.writtenAt, '계획서에 작성일이 없다') + ' |');
  L.push('| 대상 범위 | ' + na(s.scope, '계획서에 대상 스코프가 없다') + ' |');
  L.push('');
  L.push('> 이 문서는 개발 계획서와 TRD(페이즈 문서)에서 **기계로 유도**했다. 문장을 요약하지 않고');
  L.push('> 원문을 옮긴다. 원본에 없는 항목은 "해당 없음"으로 닫는다 — 지어내지 않는다.');
  L.push('');
  L.push('## 1. 목적');
  L.push('');
  L.push(na(s.purpose, '계획서에 §1 과업 개요가 없다'));
  L.push('');
  L.push('## 2. 기능 목록');
  L.push('');
  if (s.requirements.length) {
    L.push('| 기능 ID | 내용 | 담당 TRD |');
    L.push('|---|---|---|');
    for (const r of s.requirements) {
      L.push('| `' + r.id + '` | ' + r.text.replace(/\|/g, '\\|') + ' | ' + (r.trds.join(' ') || '미지정') + ' |');
    }
    const un = s.requirements.filter((r) => !r.trds.length).length;
    L.push('');
    L.push('- 기능 ' + s.requirements.length + '건 · 담당 TRD 가 이어진 것 ' + (s.requirements.length - un) + '건.');
    if (un) L.push('- **담당 TRD 미지정 ' + un + '건** — 페이즈 문서의 `커버 요구` 가 비어 있어서다. 누락이 아니라 미기재다.');
  } else {
    L.push(na('', s.requirementNote));
  }
  L.push('');
  L.push('## 3. TRD (개발 지시 문서)');
  L.push('');
  if (s.trds.length) {
    L.push('| # | 제목 | 영역 | 목표 |');
    L.push('|---|---|---|---|');
    for (const d of s.trds) {
      L.push('| ' + d.seq + ' | ' + (d.title || '—') + ' | ' + (d.area || '—') + ' | ' + (d.goal || '—').replace(/\|/g, '\\|') + ' |');
    }
  } else {
    L.push('해당 없음 — 페이즈 문서가 없다(단일 작업 과업이다).');
  }
  L.push('');
  L.push('## 4. 인터페이스·데이터 계약');
  L.push('');
  L.push(na(s.contract, '계획서에 §6 데이터·인터페이스 계약이 없다'));
  L.push('');
  L.push('## 5. 보안 고려사항');
  L.push('');
  L.push(na(s.security, '계획서에 §7 보안 고려사항이 없다'));
  L.push('');
  L.push('## 6. 이 문서의 한계');
  L.push('');
  L.push('- **화면설계서는 여기 없다.** 계획서·TRD 에 화면 서술(버튼·클릭·화면이동·레이아웃)이');
  L.push('  전 과업 0건이라 유도할 원본이 없다. 화면명세는 Builder 가 운영 소스에서 뽑는 것이 정본이다.');
  L.push('- 담당 TRD 연결은 페이즈 문서의 `커버 요구` 기재에만 의존한다 — 안 적힌 것은 "미지정"이다.');
  L.push('- 출처: `' + s.source.plan + '` + 페이즈 문서 ' + s.source.phases + '건.');
  L.push('');
  return L.join('\n');
}

/* ── build ───────────────────────────────────────── */

function cmdBuild(argv) {
  const o = { root: '', group: '', task: '', out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a.startsWith('--root=')) o.root = a.slice(7);
    else if (a === '--group') o.group = argv[++i];
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a === '--task') o.task = argv[++i];
    else if (a.startsWith('--task=')) o.task = a.slice(7);
    else if (a === '--out') o.out = argv[++i];
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else { console.error(`ERROR: 알 수 없는 인자: ${a}`); process.exit(2); }
  }
  for (const [k, v] of [['--root', o.root], ['--group', o.group], ['--task', o.task], ['--out', o.out]]) {
    if (v !== '' && !v) { console.error(`ERROR: ${k} 값이 비었다`); process.exit(2); }
  }

  const r = resolveRoot(o.root);
  if (r.error) { console.error(`ERROR: ${r.error}`); process.exit(2); }
  HARNESS = r.root;

  const tasksDir = path.join(HARNESS, 'target', 'tasks');
  let ids;
  try {
    ids = fs.readdirSync(tasksDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    console.error(`ERROR: 과업 폴더를 읽지 못했다 (${scrub(e.code || e.message)})`);
    process.exit(2);
  }
  if (o.task) ids = ids.filter((x) => x === o.task);

  const made = [];
  const skipped = [];
  for (const id of ids.sort()) {
    const dir = path.join(tasksDir, id);
    // 그룹은 _intake.json 의 project 로 거른다 — 원장과 같은 축을 쓴다.
    if (o.group) {
      let intake = null;
      try { intake = JSON.parse(fs.readFileSync(path.join(dir, '_intake.json'), 'utf8')); } catch (e) { /* 아래에서 건너뛴다 */ }
      if (!intake || intake.project !== o.group) continue;
    }
    const planFile = path.join(dir, 'plan', 'dev_plan.md');
    if (!fs.existsSync(planFile)) { skipped.push({ id, why: '개발 계획서 없음' }); continue; }

    const spec = buildSpec(id, planFile, path.join(dir, 'plan', 'phases'));
    const outDir = path.join(path.resolve(o.out), id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'feature-spec.md'), specMarkdown(spec), 'utf8');
    fs.writeFileSync(path.join(outDir, 'feature-spec.json'), JSON.stringify(spec, null, 2), 'utf8');
    made.push(spec);
  }

  const index = {
    zone: ZONE,
    artifact: ARTIFACT,
    generatedAt: new Date().toISOString(),
    group: o.group || '(전체)',
    specs: made.map((s) => ({
      taskId: s.taskId,
      title: s.title,
      writtenAt: s.writtenAt,
      requirementCount: s.requirements.length,
      linkedCount: s.requirements.filter((x) => x.trds.length).length,
      trdCount: s.trds.length,
    })),
    skipped,
  };
  fs.mkdirSync(path.resolve(o.out), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(o.out), 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  const reqTotal = made.reduce((n, s) => n + s.requirements.length, 0);
  const linked = made.reduce((n, s) => n + s.requirements.filter((x) => x.trds.length).length, 0);
  console.log('');
  console.log(`  ${ZONE} 산출물 — ${ARTIFACT}`);
  console.log(`    대상 그룹 ${index.group}`);
  console.log(`    기능명세서 ${made.length}건 · 계획서 없어 건너뜀 ${skipped.length}건`);
  console.log(`    기능 ${reqTotal}개 · 담당 TRD 연결 ${linked}개`);
  console.log(`    → ${path.relative(process.cwd(), path.resolve(o.out)) || '.'}`);
  console.log('');
  console.log('  push 하지 않았다. 내보내기는 export 로 한다.');
  console.log('');
}

/* ── export (발행 게이트 · 복사까지만) ───────────── */

function cmdExport(argv) {
  const o = { root: '', src: DEFAULT_OUT, dest: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a.startsWith('--root=')) o.root = a.slice(7);
    else if (a === '--src') o.src = argv[++i];
    else if (a.startsWith('--src=')) o.src = a.slice(6);
    else if (a === '--dest') o.dest = argv[++i];
    else if (a.startsWith('--dest=')) o.dest = a.slice(7);
    else if (a === '--dry-run') o.dryRun = true;
    else { console.error(`ERROR: 알 수 없는 인자: ${a}`); process.exit(2); }
  }
  for (const [k, v] of [['--root', o.root], ['--src', o.src], ['--dest', o.dest]]) {
    if (v !== '' && !v) { console.error(`ERROR: ${k} 값이 비었다`); process.exit(2); }
  }
  const r = resolveRoot(o.root);
  if (r.error) { console.error(`ERROR: ${r.error}`); process.exit(2); }
  HARNESS = r.root;

  const srcAbs = path.resolve(o.src);
  if (!fs.existsSync(srcAbs)) {
    console.error('ERROR: 산출물이 없다 — 먼저 build 한다.');
    process.exit(2);
  }

  // 발행 게이트. 산출물 전건이 지나야 한다 — 하나라도 막히면 아무것도 안 나간다.
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|json)$/.test(e.name)) files.push(p);
    }
  };
  walk(srcAbs);

  // 파일마다 bash 를 띄우면 72개에 1분이 넘는다(실측). `--file` 은 반복 인자라 **한 번에** 넘긴다.
  const scan = path.join(HARNESS, '.claude', 'scripts', 'scan-publish.sh');
  const args = [scan];
  for (const f of files) {
    args.push('--file', path.relative(HARNESS, f).split(path.sep).join('/'));
  }
  let out = '';
  let code = 0;
  try {
    out = execFileSync('bash', args, { cwd: HARNESS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 2;
    out = (e.stdout || '').toString();
  }
  let res = null;
  try { res = JSON.parse(out); } catch (e) { /* 아래에서 막는다 */ }
  // 판정을 못 읽으면 통과로 치지 않는다 — fail-closed.
  if (!res || res.pass !== true || code !== 0) {
    console.error('ERROR: 발행 스캔에 막혔다 — 내보내지 않는다.');
    // 매칭 값은 옮기지 않는다. 스캔 로그가 시크릿 사본이 되면 안 된다.
    for (const h of (res && res.hits ? res.hits : []).slice(0, 20)) {
      console.error(`  ${h.file}:${h.line}  패턴=${h.pattern}`);
    }
    if (!res) console.error('  (스캐너 판정을 읽지 못했다)');
    process.exit(1);
  }
  console.log(`\n  발행 스캔 통과 — ${files.length}개 파일`);
  console.log('    주의: 이 스캔은 시크릿·PII·내부IP 를 잡는다. 계획서에서 옮겨온 고객사명 같은');
  console.log('          사업 정보는 잡지 못한다.');

  if (o.dryRun) { console.log('\n  --dry-run — 복사하지 않고 끝낸다.\n'); return; }
  if (!o.dest) { console.error('\nERROR: --dest 가 필요하다 (또는 --dry-run).'); process.exit(2); }

  const destAbs = path.resolve(o.dest);
  fs.mkdirSync(destAbs, { recursive: true });
  fs.cpSync(srcAbs, destAbs, { recursive: true });
  console.log(`\n  복사 완료 → ${o.dest}`);
  console.log('  커밋·push 는 하지 않았다. 대상 레포에서 직접 커밋해라.\n');
}

/* ── 실행 ────────────────────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'build') return cmdBuild(argv.slice(1));
  if (cmd === 'export') return cmdExport(argv.slice(1));
  console.error('사용: node scripts/greenzone.cjs build [--root {하네스}] [--group {그룹}] [--task {과업번호}] [--out {경로}]');
  console.error('      node scripts/greenzone.cjs export [--root {하네스}] [--src {경로}] --dest {경로} | --dry-run');
  process.exit(2);
}

if (require.main === module) main();

module.exports = { buildSpec, specMarkdown, requirements, readTrds, section, metaTable, scrub };
