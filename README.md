# WE-ADP Developer — 비플페이 (ADP `BPL`)

WE-ADP 4단위시스템 중 **Developer** 의 비플페이 구현이다. 작업요청서(FRD·SRT)를 받아
**TRD** 로 나누고 개발·리뷰 진행 상태를 한 장의 원장으로 세어 화면에 보인다.

> 용어는 WE-ADP 표준을 따른다. 개발 지시 문서는 **TRD**(Technical Requirements Document)다.
> 컨셉 목업의 `TDD` 표기는 쓰지 않는다.

## 구성

| 경로 | 무엇 |
|---|---|
| `scripts/task-ledger.cjs` | 원장 생성기. JEX 하네스의 `target/tasks/` 를 스캔한다 |
| `scripts/task-ledger.schema.json` | **출력 계약의 정본.** 화면이 의존하는 유일한 명세 |
| `scripts/adapters/` | 작업요청서 수신 어댑터. 파일 하나 = 수신 경로 하나 (**신뢰 경계**) |
| `scripts/task-paths-driver.cjs` | 경로 해석을 한 프로세스에 모은다. 정본은 여전히 하네스의 `task-paths.cjs` |
| `scripts/serve.cjs` | 화면을 로컬에서 띄우는 정적 서버. `file://` 로는 안 열린다 |
| `scripts/selftest.cjs` | 회귀 테스트. `node scripts/selftest.cjs` (CI 에서도 돈다) |
| `web/developer.html` | 화면 1장(의존성 없음). 같은 폴더의 `ledger.json` 을 읽는다 |
| `docs/task-ledger.md` | 사용법·상태 판정 규칙·**한계표** |

## 빠른 시작

```bash
# 이 레포를 JEX 하네스 워킹카피 안에 둔다 (권장: <하네스>/target/developer-repo/)
node scripts/task-ledger.cjs --root ../../ --group BIZ_ZEROPAY   # → web/ledger.json
node scripts/serve.cjs                                           # 브라우저가 열린다
```

`developer.html` 을 **더블클릭(`file://`)으로 열면 화면이 빈다** — 브라우저가 `ledger.json` 의
`fetch` 를 막기 때문이고, 파일이 잘못된 것이 아니다. `serve.cjs` 가 그 한 가지를 해결한다
(의존성 없음 · `--port` · `--no-open`).

`--root` 는 스캔할 하네스 루트다. 생략하면 스크립트 위치와 현재 폴더에서 위로 올라가며 찾고,
`JEX_HARNESS_ROOT` 도 본다. **찾지 못하면 `exit 2`** — 추측해서 엉뚱한 원장을 만들지 않는다.

## 설계에서 물러서지 않는 것

- **사람이 상태를 입력하는 곳이 없다.** 개발자가 평소처럼 `/dev-plan`·`/qa-test`·`/code-review`
  를 돌리면 산출물 파일이 생기고, 그 파일의 실재가 곧 상태다.
- **유도할 수 없으면 추정하지 않는다.** 추정한 값은 `statusInferred:true` 와 `statusVia` 로
  출처를 데이터에 싣는다. 화면도 "그중 추정 N" 으로 드러낸다.
- **한계표(`docs/task-ledger.md`)를 지우지 않는다.** 빼고 "잘 동작함" 만 남기면 다음 사람이
  추정 판정을 사실로 믿는다.

## 지금 상태 (2026-09-22)

- 대상 그룹은 `BIZ_ZEROPAY` 하나다. `--group` 으로 넓힐 수 있으나 표준이 그룹 추가·변경 시
  워킹그룹 공유를 요구한다.
- Builder **전송 방식은 합의됐다**(2026-09-22) — Builder 레포가 저장소 레포
  (`beple-dev-1/we-adp-repository-test`)로 push 하고 Developer 가 clone/pull 로 받는다.
  `scripts/adapters/adp-repository.cjs` 가 그 경로를 읽는다.
- 다만 **요청서 형식은 아직 미정**이라 그 어댑터는 지금 0건을 돌려준다. 저장소 레포 전수에
  `FRD`·`SRT` 문구가 없고, 들어 있는 것은 IA·화면명세·디자인가이드다. 화면명세를 요청서로
  바꿔 세는 것은 지어내는 일이라 하지 않았다 — 형식이 정해지면 파싱부만 채운다.
- Builder 로의 반환(그린존)은 범위 밖이다.
- DB 없이 스캔만으로 돈다. 로컬 실행 전제다.

> `scripts/adapters/` 는 **신뢰 경계**다 — 여기 놓인 `.cjs` 는 `require` 로 실행된다.
