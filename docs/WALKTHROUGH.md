# 동작 시뮬레이션 — 요청 수신부터 그린존 반환까지

**실제로 돌린 기록이다.** 아래 출력은 전부 2026-09-22 에 DR-009(Builder 가 보낸 첫 FRD)로
실행한 것을 그대로 옮긴 것이며 꾸며 쓰지 않았다.

- 대상 요청 — `DR-009 · 에이블리 회원가입 웹뷰 회원정보 프리필`
- 결과 과업 — `ZERO-MEMB-260922-01`

---

## 전체 그림

```
① Builder ──push──▶ 저장소 레포 (브랜치 dr/DR-009)
② git fetch                    ← 내가 받는다
③ task-ledger.cjs              ← 수신함에 뜬다
④ intake.cjs                   ← 채번·연결·원장재생성 (자동)
⑤ /dev-interview → /dev-plan   ← TRD 가 생긴다 (사람)
⑥ /develop → /qa-test → /code-review   (사람)
⑦ greenzone.cjs build/export   ← 기능명세서 반환
```

기계가 하는 것은 ②③④⑦, 사람이 하는 것은 ⑤⑥ 이다.

---

## ① Builder 가 보낸다

저장소 레포에 **브랜치로** 올라온다. `main` 만 보면 안 보인다.

```
dr/DR-009
  DR-009/manifest.json      specVersion · request.label · screens[] · expectedBack
  DR-009/dev-request.md     FRD 본문 (요청내용·요구사항·개발범위·완료조건·확인필요…)
  DR-009/screens/EXW/EXW-UWV-70-30-10-C/
     as-is.html / as-is.md      바뀌기 전
     to-be.html / to-be.md      바뀐 뒤 — 이대로 보여야 한다
     changes.md                 변경 목록과 까닭
```

---

## ② 받는다

```bash
cd target/adp-repository
git fetch origin "+refs/heads/*:refs/remotes/origin/*"
```

```
브랜치 origin/dr/DR-009  (2026-09-22)
```

> `git pull` 만 하면 `main` 만 갱신돼 **안 보인다.** 꾸러미는 브랜치로 온다.

---

## ③ 원장을 만든다 — 수신함에 뜬다

```bash
cd target/developer-repo
node scripts/task-ledger.cjs --root ../../ --group BIZ_ZEROPAY
```

```
과업 원장 — BIZ_ZEROPAY (ADP BPL)
  대상 21건 / 전체 스캔 186건
  상태  접수 4 · 개발중 4 · 리뷰중 1 · 완료 12   (추정 5건)
  요청서 3건   ·   과업 연결 1건
```

| 요청서 | 유형 | 상태 | 수신 경로 | 제목 |
|---|---|---|---|---|
| **DR-009** | FRD | 요청 | **adp-repository** | 에이블리 회원가입 웹뷰 회원정보 프리필 |
| REQ-BPL-0001 | FRD | 진행 | requests-local | 바코드 결제토큰 체크디지트 검증 강화 |
| REQ-BPL-0002 | SRT | 요청 | requests-local | 오프라인 결제준비 화면 안내문구 수정 |

어떻게 채워지나 — `requestId`←`manifest.request.label` · `group`←`screens[].systemCode`
(EXW→BIZ_ZEROPAY) · `type`←`dev-request.md` 머리표 · `status`←**머지 여부**(브랜치만=요청,
`main` 머지=완료 · 잠정).

---

## ④ 인테이크 — 채번·연결·원장재생성

화면의 「다음 단계」가 이 명령을 그대로 보여 준다. **기본은 미리보기다.**

```bash
node scripts/intake.cjs --request DR-009 --entry=interview --root ../../
```

```
인테이크 — DR-009  (FRD · BIZ_ZEROPAY)
  에이블리 회원가입 웹뷰 회원정보 프리필

진입 단계  interview
도메인     member   (제목 자동 판정)

만들 과업 1건
  [member] 에이블리 회원가입 웹뷰 회원정보 프리필

미리보기다. 실제로 채번하려면 --yes 를 붙인다.
```

`--yes` 를 붙이면 실행한다.

```
채번  ZERO-MEMB-260922-01  [member]
연결  target/request-links.json  DR-009 ← ZERO-MEMB-260922-01
원장  재생성 완료

다음 — /dev-interview ZERO-MEMB-260922-01
```

**이 단계가 지키는 것 3가지**

- `--entry` 에 **기본값이 없다.** entry 가 TRD 유무를 가르는데(`direct`·`investigate`·`ops`
  는 계획서가 없어 TRD 가 영영 안 생긴다) 기본값을 두면 그 선택이 조용히 일어난다.
- **도메인 후보가 여러 개면 과업을 나눈다.** 하나를 임의로 고르면 지식 로딩과 TC 도메인코드가
  오염된다. DR-009 는 `member` 하나라 1건으로 끝났다.
- 이미 연결된 요청서는 **거부**한다(중복 채번 방지).

---

## ⑤ 화면에서 확인 — 다음에 뭘 할지 알려 준다

`작업 수신함 → DR-009` 로 들어가면 지금 단계에 맞는 명령만 보인다.

```
다음 단계 — 계획 수립(TRD 생성)
  과업은 있으나 TRD 가 없습니다. TRD 는 계획서의 페이즈 문서이며 /dev-plan 이 만듭니다.

  ① 인터뷰 (entry=interview 인 경우)   /dev-interview ZERO-MEMB-260922-01
  ② 계획 수립 — 여기서 TRD 가 생깁니다  /dev-plan ZERO-MEMB-260922-01
  ③ 원장 재생성                        node scripts/task-ledger.cjs --root {하네스} --group BIZ_ZEROPAY
```

화면은 **명령을 실행하지 않는다.** 정적 파일이라 실행할 방법이 없고, 실행하는 척하면 안 된
일을 됐다고 믿게 된다.

이 시점의 상태 — `연결 과업 0/1 완료` · `TRD 없음` · `진척 0%` · 담당 `비플개발센터`.

---

## ⑥ 사람이 하는 구간

```bash
/dev-interview ZERO-MEMB-260922-01     # 요구 확정 → 개발 브리프
/dev-plan      ZERO-MEMB-260922-01     # ★ 여기서 TRD(페이즈 문서)가 생긴다
/develop {스코프} ZERO-MEMB-260922-01   # 구현
/qa-test       ZERO-MEMB-260922-01     # 테스트
/code-review                           # 커밋 전 필수
```

각 단계가 끝날 때마다 **원장을 다시 만들면** 화면이 따라온다. 상태는 사람이 입력하지 않고
산출물 파일의 실재에서 유도된다.

DR-009 는 `dev-request.md` §6 에 **확인 필요 4건**이 있다 — 전달 방식·암호화 규격,
프리필 값 부재 시 처리, 잠금 해제 수단, 주민등록번호 반쪽 상태 표시. `/dev-interview` 가
이것들을 닫는 자리다.

---

## ⑦ 그린존 반환

개발 계획서와 TRD 에서 **기능명세서**를 유도해 저장소 레포로 돌려보낸다.

```bash
node scripts/greenzone.cjs build  --root ../../ --group BIZ_ZEROPAY
node scripts/greenzone.cjs export --root ../../ --dest ../adp-repository/greenzone
```

```
그린존 산출물 — A1 기능명세서
  기능명세서 4건 · 기능 25개 · 담당 TRD 연결 25개

발행 스캔 통과 — 9개 파일
복사 완료 → ../adp-repository/greenzone
커밋·push 는 하지 않았다. 대상 레포에서 직접 커밋해라.
```

- **모델을 쓰지 않는다.** 계획서 원문을 옮길 뿐 요약하지 않고, 없는 항목은
  "해당 없음 — 왜 없는지"로 닫는다.
- **화면설계서는 만들지 않는다.** 계획서·TRD 에 화면 서술이 0건이라 유도할 원본이 없고,
  저장소 레포의 화면명세를 Builder 가 운영 소스에서 이미 뽑고 있어 정본이 둘이 된다.
- `export` 는 **복사까지만** 한다. push 를 스크립트가 하면 권한 실패를 삼켜 안 나간 것을
  나갔다고 믿게 된다.

---

## 이 시뮬레이션이 찾아낸 것

문서를 쓰려고 실제로 돌리다 **구멍 하나를 찾았다.**

`intake.cjs` 가 `target/requests/*.json`(로컬 수신 형식)만 읽고 있어 **브랜치로 온 DR-009 를
찾지 못했다.** 두 수신 경로를 만든 뒤 인테이크를 그중 하나에만 맞춰 둔 것이다.

고친 방향 — 인테이크는 **원장에서** 요청서를 찾는다(원장이 이미 어댑터를 합쳐 놓았다).
연결은 수신원에 되쓰지 않고 `target/request-links.json` 한 곳에 쓴다. 저장소 레포는 남의
레포라 되쓸 수 없기 때문이다.

---

## 한눈에

| 단계 | 명령 | 누가 |
|---|---|---|
| 받기 | `git fetch origin "+refs/heads/*:refs/remotes/origin/*"` | 기계 |
| 수신함 반영 | `node scripts/task-ledger.cjs --root … --group …` | 기계 |
| 채번·연결 | `node scripts/intake.cjs --request … --entry=… --yes` | 기계(단계는 사람이 고름) |
| TRD 생성 | `/dev-interview` → `/dev-plan` | **사람** |
| 구현·검증 | `/develop` → `/qa-test` → `/code-review` | **사람** |
| 반환 | `node scripts/greenzone.cjs build` → `export` | 기계 |

**아직 안 되는 것** — `docs/HANDOVER.md` §8. 특히 TRD 진행률이 과업 상태에서 유도한
값이라 한 과업의 TRD 가 전부 같은 상태로 보인다.
