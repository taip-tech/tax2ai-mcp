# 아키텍처

## 1. 계층

| 계층 | 경로 | 역할 | 외부 의존 |
|---|---|---|---|
| 진입점 | `src/cli.ts` | stdio / Streamable HTTP(무상태) 선택, 토큰 인증, `/healthz` | MCP SDK |
| 서버 조립 | `src/server.ts` | 도구·프롬프트 등록, 서버 지침 | – |
| 도구 | `src/tools/*` | 입력 스키마(zod), 응답 포맷, 오류→MCP 변환, 분할 응답 | – |
| 도메인 | `src/domain/*` | 약칭 사전, 인용 파서, 세율표, 기한 계산 | 없음 (순수 함수) |
| 업스트림 | `src/lawgo/*` | DRF 호출, 캐시, 응답 정규화, 자료별 조회 | 법제처 DRF |

도메인 계층은 네트워크 없이 테스트할 수 있고, 업스트림 계층은 `Fetcher`를 주입받아 가짜 응답으로 테스트한다.

## 2. 요청 흐름 (read_provision 예)

```
read_provision(law="법법", article="52의2", asOf="2023-06-30")
 ├─ canonicalLawName("법법") → "법인세법"
 ├─ parseArticleInput("52의2") → {article:52, branch:2}
 ├─ StatuteDesk.resolve(name, asOf)
 │    └─ lawSearch.do target=eflaw sort=efdes → 시행일 ≤ 20230630 중 최신 버전(MST)
 ├─ StatuteDesk.provisions(law, {52,2})
 │    └─ lawService.do target=eflaw MST efYd JO=005202
 │         └─ extractProvisions: 조문단위 → 항/호/목 평탄화, 삭제 판별
 └─ paged(): 14,000자 단위 분할 + 면책 문구
```

## 3. 업스트림 클라이언트 정책

| 항목 | 값 | 설정 |
|---|---|---|
| 동시 호출 | 4 | `LAWGO_MAX_PARALLEL` |
| 타임아웃 | 10초 | `LAWGO_TIMEOUT_MS` |
| 재시도 | 5xx·네트워크 오류 3회, 300ms×2ⁿ | 고정 |
| 캐시 키 | 전체 요청 URL | – |
| 캐시 TTL | 검색 30분 / 본문 12시간 | `CACHE_TTL_SEARCH`, `CACHE_TTL_DOCUMENT` |
| 캐시 용량 | 800건 LRU | 고정 |

OC 검증 실패는 법제처가 HTTP 200 + `{"result":"사용자 정보 검증에 실패하였습니다."}`로 응답하므로 본문 문구로 `KEY_REJECTED`를 판별한다.

## 4. 오류 코드

| 코드 | 의미 | 사용자 조치 |
|---|---|---|
| `KEY_MISSING` | OC 미설정 | `.env`에 `LAWGO_OC` |
| `KEY_REJECTED` | OC 미승인 또는 서버 IP/도메인 미등록 | 공동활용 사이트에서 신청 상태·IP 확인 |
| `UPSTREAM_DOWN` | 법제처 장애·타임아웃 | 잠시 후 재시도 |
| `BAD_PAYLOAD` | 해석 불가 응답 | 이슈 등록 (필드 매핑 보정) |
| `NO_MATCH` | 조건에 맞는 자료 없음 | 검색어·조문번호 확인 |
| `BAD_INPUT` | 인자 오류, 세율표 범위 밖 연도 | 입력 수정 |

## 5. 확장 방법

### 새 결정례 자료원
1. `src/lawgo/sources.ts`의 `RULING_SOURCES`에 target·필드 후보·섹션 추가
2. `RulingKind` 유니온에 키 추가 → `find_rulings`/`read_ruling`에 자동 노출
3. 통합 테스트에 가짜 응답 추가

### 세율 개정
`src/domain/rateTables.ts`에 `{from, until, legalBasis, brackets}` 구간 추가 (기존 구간은 `until`만 닫음). `tax-rule-curator` 에이전트 절차 참조.

### 약칭 추가
`src/domain/taxLawBook.ts`의 `TAX_STATUTES`에 추가. 인용 파서·검색어 확장에 자동 반영.

## 6. 보안
- OC는 환경변수로만 받고 응답·로그에 노출하지 않는다 (캐시 키에는 포함되나 메모리 내부).
- HTTP 모드: 기본 `127.0.0.1` 바인딩, 외부 바인딩은 `MCP_ACCESS_TOKEN` 없으면 기동 거부, 상수 시간 비교, 요청 본문 1MB 제한.
- 원고(`check_references` 입력)는 저장하지 않는다.
