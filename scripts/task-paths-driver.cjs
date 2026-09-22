#!/usr/bin/env node
/**
 * task-paths-driver — task-paths.cjs 를 한 프로세스에서 반복 호출한다.
 *
 * 왜 — 원장은 과업마다 `node task-paths.cjs {과업번호}` 를 spawn 했다. 그 비용의 90%가
 * **node 기동**이다(실측: 빈 node 370ms · task-paths 실제 일 36ms). 21건 7.3초, 88건 24초로
 * 계획서 추정(1~2초 / 10초)의 3~5배였다. 그룹을 넓히면 못 쓴다.
 *
 * 무엇을 바꾸고 무엇을 안 바꿨나 — **경로 정본은 여전히 task-paths.cjs 다.** 경로를 손으로
 * 조립하지 않고, 하네스 파일도 한 줄 고치지 않았다. 바꾼 것은 "어떻게 부르는가" 하나다.
 * 실측 21건 7,275ms → 26ms.
 *
 * 어떻게 — task-paths.cjs 는 main 가드도 module.exports 도 없는 순수 CLI 다(실측). 최상위에서
 * process.argv 를 읽고 console.log 로 찍고 process.exit 로 끝난다. 그래서 호출마다
 * argv 를 갈아끼우고 console.log 를 가로채고 process.exit 를 던지기로 바꾼 뒤 require 캐시를
 * 지우고 다시 require 한다.
 *
 * ⚠ 이 방식은 **task-paths.cjs 의 구조에 기대고 있다.** 하네스가 거기에 main 가드를 붙이면
 * require 가 아무것도 출력하지 않아 전 과업이 조용히 "경로 해석 실패"가 된다. 그래서
 * selfCheck() 가 spawn 1회와 대조한다 — 어긋나면 느린 길로 되돌아가고 그 사실을 남긴다.
 * 조용히 틀리느니 느린 게 낫다.
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

/** task-paths.cjs 를 이 프로세스 안에서 1회 실행하고 stdout 을 돌려준다. */
function runInProcess(tpFile, taskId) {
  const argv = process.argv;
  const log = console.log;
  const err = console.error;
  const exit = process.exit;
  const marker = { __taskPathsExit: true, code: 0 };
  let out = '';

  process.argv = [argv[0], tpFile, taskId];
  console.log = function () { out += Array.prototype.join.call(arguments, ' ') + '\n'; };
  console.error = function () { /* CLI 안내문은 버린다 — 호출측이 exit 코드로 판단한다 */ };
  process.exit = function (code) { marker.code = code || 0; throw marker; };

  try {
    delete require.cache[require.resolve(tpFile)];
    require(tpFile);
  } catch (e) {
    if (e !== marker) { out = ''; marker.code = 2; }
  } finally {
    process.argv = argv;
    console.log = log;
    console.error = err;
    process.exit = exit;
  }
  return { stdout: out, code: marker.code };
}

/** spawn 1회와 대조한다. 이 한 번이 구조 변경을 잡는 값이다. */
function selfCheck(tpFile, taskId) {
  let spawned;
  try {
    spawned = execFileSync(process.execPath, [tpFile, taskId], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    return { ok: false, why: 'spawn 대조 자체가 실패했다' };
  }
  const got = runInProcess(tpFile, taskId).stdout;
  try {
    const a = JSON.stringify(JSON.parse(spawned));
    const b = JSON.stringify(JSON.parse(got));
    return a === b ? { ok: true } : { ok: false, why: 'spawn 결과와 내용이 다르다' };
  } catch (e) {
    return { ok: false, why: 'spawn 또는 in-process 출력이 JSON 이 아니다' };
  }
}

/**
 * 과업번호 목록을 한 번에 해석한다.
 *
 * @param {string} tpFile  task-paths.cjs 절대경로 (하네스 소유 · 정본)
 * @param {string[]} ids
 * @returns {{ map: Object, warns: string[], mode: 'in-process'|'spawn' }}
 *          map[id] = 파싱된 JSON, 실패한 id 는 키가 없다
 */
function resolveMany(tpFile, ids) {
  const map = {};
  const warns = [];
  if (!ids.length) return { map, warns, mode: 'in-process' };

  // 표본은 **성공하는 과업**이어야 한다. 형식이 깨진 과업을 표본으로 잡으면 spawn 이
  // 비정상 종료해 "구조가 바뀌었다"로 오판하고 느린 길로 되돌아간다(실측으로 걸렸다).
  let check = { ok: false, why: '대조할 표본을 찾지 못했다' };
  for (let i = 0; i < ids.length && i < 5; i++) {
    const c = selfCheck(tpFile, ids[i]);
    if (c.ok) { check = c; break; }
    check = c;
  }
  if (!check.ok) {
    warns.push('task-paths 일괄 해석을 쓰지 않는다 (' + check.why + ') — 과업마다 spawn 한다');
    for (const id of ids) {
      try {
        map[id] = JSON.parse(execFileSync(process.execPath, [tpFile, id], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }));
      } catch (e) { /* 호출측이 없는 키로 판단한다 */ }
    }
    return { map, warns, mode: 'spawn' };
  }

  for (const id of ids) {
    const r = runInProcess(tpFile, id);
    if (r.code !== 0) continue;
    try { map[id] = JSON.parse(r.stdout); } catch (e) { /* 위와 같다 */ }
  }
  return { map, warns, mode: 'in-process' };
}

module.exports = { resolveMany, runInProcess, selfCheck };
