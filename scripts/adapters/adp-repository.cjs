#!/usr/bin/env node
/**
 * adp-repository — Builder 개발요청서 수신 어댑터 2호 (저장소 레포 clone)
 *
 * 합의된 수신 방식 (2026-09-22)
 *   Builder 레포  ──push──▶  저장소 레포  ──clone/pull──▶  여기
 *   저장소 레포: github.com/beple-dev-1/we-adp-repository-test
 *
 * ★ 지금은 요청서를 0건 돌려준다. 골격만 있는 상태다.
 *
 *   전송 방식(clone)은 합의됐지만 **실어 보낼 요청서 형식이 아직 정해지지 않았다.**
 *   2026-09-22 실측 — 저장소 레포 전수에 `FRD`·`SRT`·`요청서` 문구가 하나도 없다.
 *   들어 있는 것은 IA 이름표·화면명세·디자인가이드다:
 *     index.json  화면 454건 (BPY 118 · HIT 123 · BPG 79 · MCH 62 · EXW 55 · MGC 17)
 *     페이지 명세  55건 (전부 EXW) — `과업:` 필드는 55건 전부 비어 있음
 *     화면유형     454건 전부 `미분류`
 *
 *   화면명세를 요청서로 바꿔 세는 것은 **지어내는 일**이라 하지 않는다. Builder 가 형식을
 *   정해 push 하기 시작하면 아래 parseRequests() 안만 채운다 — 경로 해석·레포 판별·
 *   그룹 매핑·경고 처리는 이미 여기 있다.
 *
 * 계약 — 본체가 기대하는 형태 (requests-local 과 같다)
 *   { requestId, group, type: 'FRD'|'SRT', title, status, receivedAt, linkedTaskIds: [] }
 *
 * 규약 — 본체를 require 하지 않는다 · 그룹 필터는 본체가 한다 · 동기 함수다.
 */
'use strict';

const fs = require('fs');
const path = require('path');

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
  // BPY(비플페이 앱) · HIT(힛플러스) · MCH(가맹점관리) · MGC(모바일상품권) 은 미정.
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

/**
 * 요청서 파싱 — **여기만 채우면 된다.**
 *
 * Builder 가 형식을 정하면 그 파일들을 읽어 계약 형태의 배열로 돌려준다. 그룹은
 * systemToGroup() 으로 옮기고, 옮기지 못한 것은 버리지 말고 warns 에 남긴다.
 */
function parseRequests(_dir, _manifest, _warns) {
  return [];
}

/** system 코드를 그룹으로 옮긴다. 모르는 코드는 빈 문자열이다 — 짐작하지 않는다. */
function systemToGroup(system) {
  return SYSTEM_TO_GROUP[String(system || '').toUpperCase()] || '';
}

module.exports = { name: 'adp-repository', load, systemToGroup, SYSTEM_TO_GROUP };
