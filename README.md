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
| `scripts/adapters/` | 작업요청서 수신 어댑터. 파일 하나 = 수신 경로 하나 |
| `web/developer.html` | 화면 1장(의존성 없음). 같은 폴더의 `ledger.json` 을 읽는다 |
| `docs/task-ledger.md` | 사용법·상태 판정 규칙·**한계표** |

## 빠른 시작

```bash
# 이 레포를 JEX 하네스 워킹카피 안에 둔다 (권장: <하네스>/target/developer-repo/)
node scripts/task-ledger.cjs --root ../../ --group BIZ_ZEROPAY   # → web/ledger.json
cd web && python -m http.server 8080                             # → localhost:8080/developer.html
```

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
- Builder 수신 인터페이스는 **미합의**다. `scripts/adapters/requests-local.cjs` 는 로컬 파일을
  읽는 임시 경로이며, 합의되면 어댑터를 하나 더 놓는 것으로 끝난다(본체·스키마·화면 무변경).
- Builder 로의 반환(그린존)은 범위 밖이다.
- DB 없이 스캔만으로 돈다. 로컬 실행 전제다.

> `scripts/adapters/` 는 **신뢰 경계**다 — 여기 놓인 `.cjs` 는 `require` 로 실행된다.
