#!/usr/bin/env node
/**
 * requests-local — Builder 개발요청서 수신 어댑터 1호 (로컬 파일)
 *
 * 무엇 — `target/requests/*.json` 을 읽어 어댑터 계약 형태로 돌려준다.
 *
 * 왜 어댑터인가 — Builder 에서 개발요청서를 어떤 경로로 받을지가 아직 정해지지 않았다
 * (API·공유DB·파일 중 미정). 수신부를 본체에서 떼어 두면 경로가 정해질 때 이 폴더에
 * 파일 하나를 더 놓는 것으로 끝난다. 본체·스키마·화면은 바뀌지 않는다.
 *
 * 계약 — load() 는 아래 형태의 배열을 돌려준다. 입력이 무엇이든 이 형태만 지키면 된다.
 *   { requestId, group, type: 'FRD'|'SRT', title, status, receivedAt, linkedTaskIds: [] }
 *
 * 규약 2가지:
 *  - 본체를 require 하지 않는다. 의존 방향은 본체 → 어댑터 단방향이다.
 *  - 그룹 필터는 본체가 한다. 어댑터가 필터까지 하면 경로가 늘 때마다 같은 규칙을 N번 구현한다.
 *  - 동기 함수다. 본체가 동기 스캔이라 async 를 섞으면 호출부가 오염된다.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const INPUT_DIR = path.join('target', 'requests');

/**
 * @param {{group: string, root: string}} ctx
 * @returns {{requests: object[], warns: string[]}}
 */
function load(ctx) {
  const dir = path.join(ctx.root, INPUT_DIR);
  const requests = [];
  const warns = [];

  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'));
  } catch {
    return { requests, warns }; // 폴더가 없는 것은 오류가 아니다 — 아직 아무것도 안 받은 상태다.
  }

  for (const name of names.sort()) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      warns.push(`requests-local: ${name} 파싱 실패 (${e.message})`);
      continue;
    }
    for (const r of Array.isArray(raw) ? raw : [raw]) {
      if (!r || !r.requestId) {
        warns.push(`requests-local: ${name} requestId 없음 — 건너뜀`);
        continue;
      }
      requests.push({
        requestId: String(r.requestId),
        group: String(r.group || ''),
        type: String(r.type || ''),
        title: String(r.title || ''),
        status: String(r.status || ''),
        receivedAt: String(r.receivedAt || ''),
        linkedTaskIds: Array.isArray(r.linkedTaskIds) ? r.linkedTaskIds.map(String) : [],
      });
    }
  }
  return { requests, warns };
}

module.exports = { name: 'requests-local', load };
