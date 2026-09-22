# 기능명세서 — ZERO-PAY-260916-03

| 항목 | 내용 |
|---|---|
| 구역 | 그린존 (A1 기능명세서) |
| 과업번호 | ZERO-PAY-260916-03 |
| 제목 | 네이버(기아) 복지포인트 오프라인 잔액조회 지원 |
| 작성일 | 2026-09-16 |
| 대상 범위 | bzp (`BIZ_ZEROPAY/src/bppaypg/**`) |

> 이 문서는 개발 계획서와 TRD(페이즈 문서)에서 **기계로 유도**했다. 문장을 요약하지 않고
> 원문을 옮긴다. 원본에 없는 항목은 "해당 없음"으로 닫는다 — 지어내지 않는다.

## 1. 목적

통합PG v2 오프라인 잔액조회(`POST /api/v2/payment/offlineBalance`)에서 **네이버(기아) 복지포인트 바코드만 `PA06`(결제 수단 정보가 없습니다)** 로 응답한다.
같은 바코드로 결제준비·승인·취소는 전부 `0000` 이므로 **결제는 되는데 잔액조회만 안 되는 비대칭**이다.

원인은 코드에 명시돼 있다 — `InquiryOfflineBalance.loadWelfareBalance()` 첫 줄의 조기 반환이다.

- `InquiryOfflineBalance.java:390-396` — `"NV".equals(qrData.getString("WLFE_AGNC_DV"))` 면 로그만 남기고 `return`.
- 스킵 → `balanceList` 빈 목록 → `InquiryOfflineBalance.java:133-135` 에서 `PA06`.
- 개발 WAS 로그에 해당 INFO 가 호출 시각마다 기록됨(2026-09-16 19:53~19:55, 7건) — 가설이 아니라 실증된 원인이다.

스킵 근거로 적힌 *"오프라인 잔액조회 요청에는 가맹점 식별 정보(AFLT_CTGRY_CD)가 없다"* 는 **사실과 다르다**.

- 잔액조회 요청 봉투에 `MID` 가 이미 있다 — `offlinebalance/data/ev/EvRequest.java:14`, `InquiryOfflineBalance.java:76`.
- 업종코드는 `TB_BP_AFLT_MNG_R002`(키 `PG_AFLT_ID` = MID)로 구한다 — 출력에 `CTGR_CD` 포함(IDO XML 확인).
- **결제준비가 이미 그렇게 하고 있다** — `ReserveOffline.java:877-884`(`loadMchtInfo`, 0건 → `PA15`) → `ReserveOffline.java:340-343`(`ENT_WLFE_MEST_LMT_R001` 의 `AFLT_CTGRY_CD` 로 소비).

따라서 이 과업의 골자는 **결제준비의 업종코드·사번 확보 경로를 잔액조회에 그대로 이식**해 두 경로의 한도 산출 입력을 일치시키는 것이다.

## 2. 기능 목록

| 기능 ID | 내용 | 담당 TRD |
|---|---|---|
| `R-ZERO-PAY-260916-03-01` | 네이버(기아) 복지포인트 바코드의 오프라인 잔액조회가 `PA06` 대신 `RES_CD=0000` + `PAY_MEASURE_TP=17` 잔액 1건을 응답한다. | #2 |
| `R-ZERO-PAY-260916-03-02` | 요청 봉투의 `MID` 로 가맹점 업종코드(`CTGR_CD`)를 확보한다 — `TB_BP_AFLT_MNG_R002`(`PG_AFLT_ID`=MID), 0건이면 `PA15`. | #1 |
| `R-ZERO-PAY-260916-03-03` | 네이버(기아) 회원의 사번/이메일 식별정보를 `TB_MEMBER_CORP_APRV_R001`(`DYNAMIC_0`)로 확보한다 — 결제준비와 동일한 조회 조건. | #1 |
| `R-ZERO-PAY-260916-03-04` | 네이버(기아) 한도조회를 결제준비와 **같은 BCS·같은 파라미터**로 호출한다 — `ENT_WLFE_MEST_LMT_R001`, `AFLT_CTGRY_CD`=`CTGR_CD`, `OLNE_YN`="N". | #2 |
| `R-ZERO-PAY-260916-03-05` | `ENT_WLFE_MEST_LMT_R001` 의 **평면(REC 없음) 출력**을 `BALANCE_LIST` 로 매핑하고, 바코드에 묶인 한도만 담는 `qrBoundLimitId` 일치 검사를 유지한다. | #2 |
| `R-ZERO-PAY-260916-03-06` | 비(非)네이버 복지·비플식권·비플머니 경로는 동작·응답값이 바뀌지 않는다(회귀 0). | #1 #2 |
| `R-ZERO-PAY-260916-03-07` | 사실과 다른 주석을 정정한다 — 클래스 javadoc(42-48행) · `loadWelfareBalance` 주석(390-393행) · `loadEmplNo` javadoc(440-443행) · `process()` 인라인 주석(131행). | #2 |

- 기능 7건 · 담당 TRD 가 이어진 것 7건.

## 3. TRD (개발 지시 문서)

| # | 제목 | 영역 | 목표 |
|---|---|---|---|
| 1 | 식별정보 확보 (가맹점 업종코드 + 에이전시별 사번) | BE | 네이버(기아) 복지 한도조회에 필요한 두 입력(가맹점 업종코드 `CTGR_CD` · 회원 사번/이메일)을 `InquiryOfflineBalance` 안에서 확보할 수 있게 만든다. **외부 동작은 바꾸지 않는다.** |
| 2 | 복지 한도조회 에이전시 분기 + 평면 응답 매핑 + 주석 정정 | BE | `loadWelfareBalance()` 의 NV 조기 반환을 제거하고 가맹점별 한도조회(`ENT_WLFE_MEST_LMT_R001`)로 분기해 **`PA06` 증상을 해소**한다. 사실과 다른 주석 4곳을 정정한다. |

## 4. 인터페이스·데이터 계약

### 6-1. DB 변경사항

- **없음.** IDO 신규 등록 없음, DDL(CREATE/ALTER/INDEX) 없음.

### 6-2. 공통 모듈 변경사항

- **없음.**

### 6-3. DTO 필드 명세

> 외부 연동 규격(Request/Response)은 **변경하지 않는다**. 아래 표는 페이즈 2 가 채우는 응답 항목의 계약을 고정하기 위한 것이다.

#### (a) Request — `offlinebalance/data/ev/EvRequest` (**변경 없음**)

| 필드명 | 타입 | 필수 | 검증 | 의미 |
|-------|------|:---:|------|------|
| `MID` | String | Y | 봉투 공통부. 빈 값이면 `TB_BP_AFLT_MNG_R002` 0건 → `PA15` | 가맹점코드. **이번 과업에서 업종코드 조회 키로 새로 소비된다** |
| `QR_BAR_CODE` | String | Y | 바코드 21자리 이상(`substring(11,21)` 토큰 추출) | QR/바코드 원문 |
| `QR_BAR_TP` | String | Y | `1`:바코드 / `2`:QR | 코드 구분 |
| `PAY_MEASURE_TP` | String | Y | `06` / `10` (EvChecker 제한) | PG 가 바코드 12번째 자리로 판별한 결제수단 |
| `STORE_CORP_CD` | String | N | — | 점포회사코드(조회이력 적재용) |
| `STORE_CD` | String | N | — | 점포코드(조회이력 적재용) |

#### (b) Response — `offlinebalance/data/ev/EvDataResponse` (**구조 변경 없음**)

| 필드명 | 타입 | 필수 | 검증 | 의미 |
|-------|------|:---:|------|------|
| `RES_CD` | String | Y | 성공 `0000` / 실패 `PA06`·`PA15` 등 | 응답코드 |
| `RES_MSG` | String | Y | — | 응답메시지 |
| `BALANCE_LIST` | JSONArray | Y | 성공 시 size ≥ 1. size == 0 이면 `PA06` | 잔액 목록 |

#### (c) Response 항목 — `BALANCE_LIST[]` (네이버(기아) 복지포인트 신규 충족 케이스)

| 필드명 | 타입 | 필수 | 검증 | 의미 |
|-------|------|:---:|------|------|
| `PAY_MEASURE_TP` | String | Y | 고정 `"17"` (`PaymentMethodType.WLFE_POINT`) | 결제수단 코드 |
| `PAY_MEASURE_NM` | String | Y | 고정 `"복지포인트"` — §4-1 "응답 `PAY_MEASURE_NM`" 결정 | 결제수단명 |
| `PAY_MEASURE_ID` | String | Y | `{APP_CD}\|{CARD_NO}-{LMT_SEQ}` — 기존 조립식 동일 | 결제수단 식별자 |
| `BALANCE` | String | Y | `ENT_WLFE_MEST_LMT_R001.LMT_AMT` **원값**(`null` → `"0"`). **클램프 미적용** — §4-1 "한도 클램프 누락" 결정 | 잔액 |

#### (d) 내부 계약 — `ENT_WLFE_MEST_LMT_R001` 호출 (페이즈 2)

> **결제준비(`ReserveOffline.getWelfareLmtInfo()` `:336-359`)와 완전히 동일한 입력 집합**이어야 한다. 값이 갈리면 "조회한 잔액과 실제 결제 가능액이 다르다" 문의로 이어진다.

| 필드명 | 타입 | 필수 | 검증 | 의미 |
|-------|------|:---:|------|------|
| `AFLT_CTGRY_CD` | String | Y | `loadMchtInfo()` 결과의 `CTGR_CD` | 가맹점 업종코드 |
| `OLNE_YN` | String | Y | 고정 `"N"` (오프라인) | 온라인 여부 |
| `CI` | String | Y | 회원 `CI` | 회원 CI |
| `MOB_NO` | String | Y | 회원 `MOB_NO` | 휴대폰번호 |
| `USER_NM` | String | Y | 회원 `MEMB_NM` | 고객명 |
| `EMPL_NO` | String | N | `EMPL_TP=="N"` 일 때만 값, 아니면 `null` | 사번 |
| `EMAIL` | String | N | `EMPL_TP=="E"` 일 때만 값, 아니면 `null` | 이메일 |
| `MEMB_CD` | String | Y | 회원코드 | 회원코드 |
| `APP_CD` | String | Y | `qrData.APP_CD` | 앱코드 |
| `WLFE_NTRY_DT` | String | Y | `TB_MEMBER_CORP_APRV_R001.REG_DTTM` 앞 8자리 | 복지 가입일자 |
| `REQ_CNT` / `REQ_PAGE` | — | **보내지 않음** | NV 분기에서 제외 | 전제 3 — 예약 경로와 동일 |
| `HUB_APP_CD` / `HUB_API_CRTS_KEY` | — | **보내지 않음** | — | 전제 3 — 오프라인 경로는 미설정 |

#### (e) 내부 계약 — `TB_MEMBER_CORP_APRV_R001` `DYNAMIC_0` (페이즈 1)

`ReserveOffline.getEmplNo()` `:396-401` 과 동일한 4개 조건을 `DYNAMIC_0` 으로 붙인다.

| 조건 컬럼 | 값 |
|---------|----|
| `MEMB_CD` | 회원코드 |
| `APP_CD` | 앱코드 |
| `ORG_TP` | `'1'` (현대/기아) |
| `PROD_DV` | `'W'` (복지포인트) |

> ⚠ `TB_MEMBER_CORP_APRV_R001` 은 SQL 말미가 `??` 인 DYNAMIC IDO 다. **`DYNAMIC_0` 를 지정하지 않으면 주석 기본값으로 살아남아 엉뚱한 결과가 나온다** — 반드시 4개 조건을 모두 담아 넘긴다.

---

## 5. 보안 고려사항

- **시크릿 없음.** 이번 변경은 인증키·DB 접속정보·암호화 키를 다루지 않는다. `HUB_API_CRTS_KEY` 는 **보내지 않는 쪽**으로 결정됐다(전제 3).
- **PII** — `CI`·`MOB_NO`·`MEMB_NM`·`EMPL_NO` 를 BCS 입력으로 다루나 **기존 비NV 경로와 동일한 취급**이며 신규 로그 출력 대상이 아니다. 신규 `LOG` 에 `EMPL_NO`·`CI` 원문을 찍지 않는다.
- **인가 경계 변경 없음** — 봉투 `MID` + `Authorization` 인증키 검증은 상위 공통부가 이미 수행한다. 이번 변경은 그 `MID` 를 **조회 키로 추가 소비**할 뿐이다.
- 검증용 계정(`BZ20220500001667`)·한도ID·MID 는 **개발계 테스트 데이터**다. 인증키 실값은 어떤 산출물에도 기재하지 않는다.

---

## 6. 이 문서의 한계

- **화면설계서는 여기 없다.** 계획서·TRD 에 화면 서술(버튼·클릭·화면이동·레이아웃)이
  전 과업 0건이라 유도할 원본이 없다. 화면명세는 Builder 가 운영 소스에서 뽑는 것이 정본이다.
- 담당 TRD 연결은 페이즈 문서의 `커버 요구` 기재에만 의존한다 — 안 적힌 것은 "미지정"이다.
- 출처: `plan/dev_plan.md` + 페이즈 문서 2건.
