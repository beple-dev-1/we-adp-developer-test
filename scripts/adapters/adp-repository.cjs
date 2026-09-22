#!/usr/bin/env node
/**
 * adp-repository — Builder 개발요청서 수신 어댑터 2호 (저장소 레포 clone)
 *
 * 합의된 수신 방식 (2026-09-22)
 *   Builder 레포  ──push──▶  저장소 레포  ──clone/pull──▶  여기
 *   저장소 레포: github.com/beple-dev-1/we-adp-repository-test
 *
 * 전송 꾸러미는 **브랜치**로 온다 — `dr/{DR-###}` (실측 2026-09-22 DR-009 첫 수신).
 * `main` 만 보면 안 보인다. 어댑터는 `origin/dr/*` 를 훑어 브랜치째로 읽는다.
 *
 *   {DR}/manifest.json   specVersion · request.label · screens[] · expectedBack
 *   {DR}/dev-request.md  FRD 본문 (머리표에 원천 유형 FRD/SRT)
 *   {DR}/screens/{SYS}/{화면ID}/{as-is,to-be,changes}.{html,md}
 *
 * 상태는 **머지 여부로 유도**한다 — 브랜치만 있으면 `요청`, `main` 머지면 `완료`.
 * manifest 에 상태 필드가 없어서다(사용자 확정 · 잠정). 가운데 두 상태(접수·진행)는
 * 유도할 근거가 없어 쓰지 않는다. Builder 가 상태를 실어 보내면 그것으로 바꾼다.
 *
 * 계약 — 본체가 기대하는 형태 (requests-local 과 같다)
 *   { requestId, group, type: 'FRD'|'SRT', title, status, receivedAt, linkedTaskIds: [] }
 *
 * 규약 — 본체를 require 하지 않는다 · 그룹 필터는 본체가 한다 · 동기 함수다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** clone 위치. 환경변수로 덮을 수 있고, 없으면 하네스 루트 아래 관례 경로를 본다. */
const ENV_DIR = 'ADP_REPOSITORY_DIR';
const DEFAULT_DIR = path.join('target', 'adp-repository');

/** 저장소 레포임을 확인하는 표식. 엉뚱한 폴더를 가리켰을 때 조용히 0건을 내지 않기 위함이다. */
const MANIFEST = 'manifest.json';
const TOOLCHAIN_PREFIX = 'we-adk-toolchain/';

/**
 * 저장소 레포의 system 코드 → 내 그룹 축.
 *
 * 두 축은 다르다 — 저쪽은 Builder 의 시스템 구분이고 이쪽은 과업의 프로젝트다.
 * **근거가 있는 것만 적는다.** 없는 것은 비워 두고 미매핑으로 경고한다 — 짐작으로 채우면
 * 남의 그룹 요청이 내 수신함에 섞여 들어온다.
 */
const SYSTEM_TO_GROUP = {
  // EXW 페이지 명세가 brnd_webview_gift_list_view.jsp 를 원본으로 지목한다 (BIZ_ZEROPAY 소스).
  EXW: 'BIZ_ZEROPAY',
  // manifest.json 의 label 이 "비플PG" 다.
  BPG: 'BPPAY_PG',
  // 사용자 확정 (2026-09-22) — 비플페이 앱 · 힛플러스 · 가맹점관리.
  BPY: 'BIZ_ZEROPAY',
  HIT: 'BIZ_ZEROPAY',
  MCH: 'AFLT',
  // MGC(모바일상품권) 은 비워 둔다 — 사용자가 보류로 정했다 (2026-09-22).
};

/**
 * @param {{group: string, root: string}} ctx
 * @returns {{requests: object[], warns: string[]}}
 */
function load(ctx) {
  const warns = [];
  const dir = process.env[ENV_DIR]
    ? path.resolve(process.env[ENV_DIR])
    : path.join(ctx.root, DEFAULT_DIR);

  // 아직 clone 하지 않은 것은 오류가 아니다 — 조용히 0건이다.
  if (!fs.existsSync(dir)) return { requests: [], warns };

  const manifestFile = path.join(dir, MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    warns.push(`adp-repository: ${MANIFEST} 을 읽지 못했다 — 저장소 레포 clone 이 맞는지 확인해라`);
    return { requests: [], warns };
  }
  if (typeof manifest.toolchain !== 'string' || manifest.toolchain.indexOf(TOOLCHAIN_PREFIX) !== 0) {
    warns.push(`adp-repository: toolchain 표식이 없다(${TOOLCHAIN_PREFIX}…) — 다른 폴더를 가리키고 있다`);
    return { requests: [], warns };
  }

  const requests = parseRequests(dir, manifest, warns);

  // 요청서가 0건이면 그 사실을 남긴다. 조용한 0건은 "받은 게 없다" 와 "못 읽었다" 를 못 가른다.
  if (!requests.length) {
    warns.push('adp-repository: 저장소 레포는 있으나 요청서가 0건이다 — Builder 요청서 형식 미합의(전송 방식만 합의됨)');
  }
  return { requests, warns };
}

/** 전송 꾸러미가 올라오는 브랜치 접두. 실측 — `dr/DR-009` (2026-09-22 첫 수신). */
const DR_REF_PREFIX = 'refs/remotes/origin/dr';
const SPEC_VERSION = 2;

function git(dir, args) {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * `origin/dr/*` 브랜치 목록.
 *
 * ⚠ 실패를 조용히 빈 배열로 만들지 않는다 — 브랜치가 없는 것과 git 이 죽은 것은 다르다.
 * 실제로 `execFileSync` import 를 빠뜨렸는데 catch 가 그것을 삼켜 "요청서 0건"으로만
 * 보였다(실측 2026-09-22). 이 어댑터가 막으려던 바로 그 조용한 0건이다.
 */
function drRefs(dir, warns) {
  try {
    return git(dir, ['for-each-ref', '--format=%(refname:short)', DR_REF_PREFIX])
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    warns.push('adp-repository: 브랜치 목록을 읽지 못했다 (' +
      String(e && e.message || e).split('\n')[0].slice(0, 120) + ')');
    return [];
  }
}

/** 브랜치의 파일 하나를 읽는다. 없으면 null. */
function showFile(dir, ref, file) {
  try { return git(dir, ['show', ref + ':' + file]); } catch (e) { return null; }
}

/**
 * 요청 상태.
 *
 * 브랜치만 있으면 `요청`, `main` 에 머지됐으면 `완료` (사용자 확정 2026-09-22 · 잠정).
 * manifest 에 상태 필드가 없어 머지 여부로 **유도**한 값이다 — Builder 가 상태를 실어
 * 보내기 시작하면 그것을 쓴다. 가운데 두 상태(접수·진행)는 유도할 근거가 없어 쓰지 않는다.
 */
function statusOf(dir, ref) {
  try {
    git(dir, ['merge-base', '--is-ancestor', ref, 'origin/main']);
    return '완료';
  } catch (e) {
    return '요청';
  }
}

/** `dev-request.md` 머리표의 `| FRD | FRD-002 |` 행에서 원천 유형을 읽는다. */
function typeOf(md) {
  if (!md) return '';
  if (/^\|\s*FRD\s*\|/m.test(md)) return 'FRD';
  if (/^\|\s*SRT\s*\|/m.test(md)) return 'SRT';
  return '';
}

/** 제목 — `# DR-009 · 에이블리 …` 의 `·` 뒤. 없으면 화면 표시명으로 떨어진다. */
function titleOf(md, manifest) {
  const h1 = md && (md.match(/^#\s+(.+)$/m) || [])[1];
  if (h1) {
    const i = h1.indexOf('·');
    return (i >= 0 ? h1.slice(i + 1) : h1).trim();
  }
  const s = manifest.screens && manifest.screens[0];
  return s ? (s.displayName || s.screenId || '') : '';
}

/**
 * 요청서 파싱 — 저장소 레포의 `dr/*` 브랜치 전송 꾸러미를 읽는다.
 *
 * 꾸러미 구조(실측 DR-009)
 *   {DR}/manifest.json   specVersion · request.label · screens[] · expectedBack
 *   {DR}/dev-request.md  FRD 본문 (머리표에 원천 유형)
 *   {DR}/screens/{SYS}/{화면ID}/{as-is,to-be,changes}.{html,md}
 *
 * 그룹은 `screens[].systemCode` 를 systemToGroup() 으로 옮긴다. 옮기지 못한 것은
 * **버리지 않고** 경고로 남긴다 — 조용히 사라지면 "안 온 것"과 구별되지 않는다.
 */
function parseRequests(dir, _manifest, warns) {
  const refs = drRefs(dir, warns);
  if (!refs.length) return [];

  const out = [];
  for (const ref of refs) {
    const label = ref.split('/').pop();            // origin/dr/DR-009 → DR-009
    const mf = showFile(dir, ref, label + '/manifest.json');
    if (!mf) { warns.push(`adp-repository: ${label} 에 manifest.json 이 없다 — 건너뜀`); continue; }

    let m;
    try { m = JSON.parse(mf); } catch (e) {
      warns.push(`adp-repository: ${label} manifest.json 파싱 실패 — 건너뜀`);
      continue;
    }
    if (m.specVersion !== SPEC_VERSION) {
      warns.push(`adp-repository: ${label} specVersion=${m.specVersion} (아는 것은 ${SPEC_VERSION}) — 건너뜀`);
      continue;
    }

    const requestId = (m.request && m.request.label) || label;
    const screens = Array.isArray(m.screens) ? m.screens : [];
    const md = showFile(dir, ref, label + '/dev-request.md');

    // 시스템이 여러 그룹에 걸치면 그룹마다 한 건으로 낸다 — 본체가 그룹으로 거르기 때문이다.
    const byGroup = {};
    for (const s of screens) {
      const g = systemToGroup(s.systemCode);
      if (!g) {
        warns.push(`adp-repository: ${label} system=${s.systemCode} 은 그룹 매핑이 없다 — 이 화면은 어느 그룹에도 안 보인다`);
        continue;
      }
      (byGroup[g] = byGroup[g] || []).push(s);
    }
    if (!Object.keys(byGroup).length) continue;

    const type = typeOf(md);
    if (!type) warns.push(`adp-repository: ${label} 의 원천 유형(FRD/SRT)을 읽지 못했다`);

    let receivedAt = '';
    try {
      receivedAt = git(dir, ['log', '-1', '--format=%cI', ref]).trim();
    } catch (e) { /* 비면 화면이 '-' 로 낸다 */ }

    const status = statusOf(dir, ref);
    const title = titleOf(md, m);

    for (const g of Object.keys(byGroup)) {
      out.push({
        requestId: requestId,
        group: g,
        type: type,
        title: title,
        status: status,
        receivedAt: receivedAt,
        // Builder 가 과업번호를 모르므로 연결은 intake.cjs 가 채운다.
        linkedTaskIds: [],
      });
    }
  }
  return out;
}

/** system 코드를 그룹으로 옮긴다. 모르는 코드는 빈 문자열이다 — 짐작하지 않는다. */
function systemToGroup(system) {
  return SYSTEM_TO_GROUP[String(system || '').toUpperCase()] || '';
}

module.exports = { name: 'adp-repository', load, systemToGroup, SYSTEM_TO_GROUP };
