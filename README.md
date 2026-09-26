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
| `scripts/intake.cjs` | 요청서 → 채번·연결·원장재생성 한 번에 (기본 미리보기) |
| `scripts/greenzone.cjs` | 계획서·TRD → **기능명세서**(그린존 산출물) 유도 |
| `scripts/greenzone-return.cjs` | 개발요청서(DR) **회신** — 규격대로 깔고 올리기 전에 검사 |
| `scripts/selftest.cjs` | 회귀 테스트. `node scripts/selftest.cjs` (CI 에서도 돈다) |
| `web/developer.html` | 화면 1장(의존성 없음). 같은 폴더의 `ledger.json` 을 읽는다 |
| `web/ledger.json` | 화면이 읽는 데이터. **레포에 담지 않는다 — 각자 자기 하네스로 만든다** |
| `docs/task-ledger.md` | 사용법·상태 판정 규칙·**한계표** |
| `docs/HANDOVER.md` | **인수인계** — 참고 기준·판정 규칙·안 한 것과 이유·남은 일. 처음 받으면 여기부터 |
| `docs/WALKTHROUGH.md` | **동작 시뮬레이션** — 요청 수신부터 그린존 반환까지 실제 실행 기록 |

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
- **그린존 반환** — 표준상 그린존은 Builder 안의 열람 전용 구역이고 Developer 산출물이 거기
  올라간다. `scripts/greenzone.cjs` 가 개발 계획서·TRD 에서 **기능명세서**를 유도한다.

  ```bash
  node scripts/greenzone.cjs build --root ../../ --group BIZ_ZEROPAY   # → greenzone/{과업}/feature-spec.md
  node scripts/greenzone.cjs export --root ../../ --dest {저장소레포경로}
  ```

  **화면설계서는 만들지 않는다(사용자 확정 A안)** — ① 계획서·TRD 전 과업에 화면 서술이 0건이라
  유도할 원본이 없고, ② 저장소 레포의 화면명세 55건을 Builder 가 운영 소스에서 이미 뽑고 있어
  또 만들면 정본이 둘이 된다.
  산출물은 **이 레포에도 담고**(`greenzone/`) 저장소 레포로도 내보낸다(사용자 확정 2026-09-22).
  기능명세서는 계획서 원문이라 소스 경로·줄번호·DB 컬럼·운영 수치가 실린다 — 과업 제목만
  담는 원장보다 노출 규모가 크다는 것을 알고 내린 결정이다.
- **개발요청서(DR) 회신** — 위 기능명세서와 **다른 산출물**이다. 저쪽은 우리가 만든 것을 열람
  구역에 내는 것이고, 이쪽은 Builder 가 보낸 요청마다 **정해진 자리에 정해진 파일을 돌려주는**
  것이다. 규격이 요청마다 달라서 `scripts/greenzone-return.cjs` 가 읽어 깐다.

  ```bash
  node scripts/greenzone-return.cjs plan     --dr BP-D900001 --root ../../   # 규격을 읽어 보여준다
  git -C target/adp-repository switch -c feedback/BP-D900001 {plan 이 찍어 준 base}
  node scripts/greenzone-return.cjs scaffold --dr BP-D900001 --root ../../   # 회신서·시험결과 표
  # ... 화면을 고치고 판정 칸을 채운 뒤
  node scripts/greenzone-return.cjs check    --dr BP-D900001 --root ../../   # 올리기 전 게이트
  ```

  **규격 정본은 `{DR}/manifest.json` 의 `expectedBack` 이다** — `expected-back.md` 가 아니다.
  v3 부터 그 md 는 "Developer 는 이 파일을 받지 않는다(스펙 4-4)" 한 줄짜리로 바뀌었고,
  `expectedBack` 블록은 v2·v3 에 똑같이 실려 온다(실측 2026-09-26).
  **반환 브랜치 이름을 짐작하지 않는다** — v2 는 `feedback/{시스템}/{DR}`, v3 는 `feedback/{DR}` 로
  시스템 마디가 빠졌다. manifest 가 준 문자열을 그대로 쓴다.
  `check` 는 Builder 가 거절하는 사유 9종을 **올리기 전에 로컬에서** 재현한다 — 기준 커밋이
  기본 브랜치 이력에 없음 · 화면 집합 불일치 · 모르는 상태값 · 보낸 적 없는 TC · 9칸 아님 ·
  판정 공란·허용 어휘 위반 · 갈라 온 뒤 기본 브랜치가 그 파일을 고침.
- 회신의 `changed`/`unchanged` 는 **사람이 적지 않는다** — base 대비 실제 파일 차이로 유도한다.
  적은 것과 낸 것이 어긋날 자리를 없앤다. 반대로 **판정 칸은 대신 채우지 않는다** — 하네스 TC
  번호(`TC-{과업번호}-017`)와 Builder TC 번호(`TC-001`)는 번호 공간이 다르고 둘을 잇는 근거가
  없다. 없는 매핑을 지어내는 대신 빈칸으로 내고 `check` 가 막는다.
- 반환 **전송 방향은 아직 미합의**다. `export`·`check` 모두 push 하지 않는다 — 올리기는 사람이 한다.
- DB 없이 스캔만으로 돈다. 로컬 실행 전제다.

> `scripts/adapters/` 는 **신뢰 경계**다 — 여기 놓인 `.cjs` 는 `require` 로 실행된다.
