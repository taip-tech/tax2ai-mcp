# 업무 계획서 (Work Plan)

기준일: 2026-10-31 · 총 10주 · 범례: ✅ 완료(현 저장소에 구현됨) / ⏳ 예정

## 1. 단계별 계획

### Phase 0 — 준비 (1주차)
| # | 작업 | 담당 | 상태 |
|---|---|---|---|
| 0-1 | 법제처 공동활용 가입, OPEN API 신청, 서버 IP/도메인 등록, OC 발급 | 세무사(PM) | ⏳ |
| 0-2 | 요구사항 확정 (RFP FR/NFR) | PM + 아키텍트 | ✅ |
| 0-3 | 저장소·빌드·테스트 골격 (TypeScript, node:test) | 아키텍트 | ✅ |

### Phase 1 — 코어 (2~4주차) → M1
| # | 작업 | 담당 | 상태 |
|---|---|---|---|
| 1-1 | DRF 클라이언트: 동시성 제한·재시도·TTL 캐시·오류 분류 | lawgo-api-engineer | ✅ |
| 1-2 | 응답 정규화 (단건/배열, 필드 후보, HTML 정리) | lawgo-api-engineer | ✅ |
| 1-3 | 법령 확정·조문 파싱(항·호·목, 삭제 판별)·시점 조회 | lawgo-api-engineer | ✅ |
| 1-4 | 결정례 4개 자료원·행정규칙·별표서식·용어 | lawgo-api-engineer | ✅ |
| 1-5 | 세법 약칭 사전·인용 파서 (같은 법/같은 조/연속 인용) | tax-rule-curator | ✅ |
| 1-6 | 세율표(법인 2018~2026, 종소 2021~2026)·기한 계산 | tax-rule-curator | ✅ (2026 법인세율 원문 대조 필요) |
| 1-7 | MCP 도구 14종 + 프롬프트 3종 | 아키텍트 | ✅ |
| 1-8 | 단위·통합 테스트 25건 | mcp-qa-verifier | ✅ |

### Phase 2 — 실데이터 검증 (5~6주차) → M2
| # | 작업 | 담당 | 상태 |
|---|---|---|---|
| 2-1 | 실제 OC로 target별 원본 응답 수집 → `test/fixtures/` 익명화 저장 | lawgo-api-engineer | ⏳ |
| 2-2 | 필드 매핑 보정 (특히 `ttSpecialDecc`, `thdCmp`, `oldAndNew`, `lstrm`) | lawgo-api-engineer | ⏳ |
| 2-3 | 라이브 스모크 30 시나리오 (아래 4절) | mcp-qa-verifier | ⏳ |
| 2-4 | 2026 법인세율·최근 개정 조문 원문 대조 | tax-rule-curator | ⏳ |

### Phase 3 — 고도화 (7~8주차) → M3
| # | 작업 | 담당 | 상태 |
|---|---|---|---|
| 3-1 | 공휴일 API(특일정보) 연동으로 음력·대체공휴일 자동 반영 | lawgo-api-engineer | ⏳ |
| 3-2 | 조세조약(`trty`)·지방세 해석례 자료원 추가 | lawgo-api-engineer | ⏳ |
| 3-3 | 가산세·기업업무추진비 한도·인정이자 계산, 조세조약 조회 | tax-rule-curator | ✅ (조약 응답 필드 실데이터 확인 필요) |
| 3-4 | HTTP 배포 (컨테이너/사내 서버), 토큰 인증, 접근 로그(본문 제외) | 아키텍트 | ⏳ |
| 3-5 | 디스크 캐시(선택) — 재기동 시 워밍업 | lawgo-api-engineer | ⏳ |
| 3-6 | 부칙 조회, 공용 키 일일 한도, Origin 검사, 접근 로그 | 아키텍트 | ✅ |
| 3-7 | Claude Code 플러그인(`/semu` 스킬, 원격 MCP 자동 등록) | 아키텍트 | ✅ (라이선스·아이콘·개인정보처리방침 URL 필요) |
| 3-8 | 국세청 자료(질의회신·사전답변·집행기준) 연동 검토 — 이용약관·제공 방식 확인 후 결정 | PM | ⏳ |
| 3-9 | Vercel 다중 인스턴스용 공유 저장소(호출 한도·캐시) 검토 | lawgo-api-engineer | ⏳ |

### Phase 4 — 인수 (9~10주차) → M4
| # | 작업 | 담당 | 상태 |
|---|---|---|---|
| 4-1 | 실무 사례 20건 수용 테스트 (경정청구 5, 고객질의 10, 의견서 점검 5) | PM + refund-claim-examiner 등 | ⏳ |
| 4-2 | 운영 매뉴얼, 개정 반영 체크리스트 | 아키텍트 | ⏳ |

## 2. 서브에이전트 운용 설계

### 2.1 개발용
```
            ┌──────────────── 메인 세션 (아키텍트) ────────────────┐
            │  작업 분해 · 리뷰 · 머지 판단                        │
            └──────┬──────────────────┬──────────────────┬────────┘
                   ▼                  ▼                  ▼
        lawgo-api-engineer    tax-rule-curator     mcp-qa-verifier
        (src/lawgo/*)         (src/domain/*)       (test/*, 스모크)
                   └──────── 결과 보고 ─┴─── 실패 시 재할당 ┘
```
- 병렬 가능: `lawgo-api-engineer`와 `tax-rule-curator`는 수정 디렉터리가 겹치지 않으므로 동시 진행.
- `mcp-qa-verifier`는 항상 마지막 게이트. 실패 보고 → 해당 담당에게 재할당.

### 2.2 실무 운영용 (세무사 사무소)
| 시나리오 | 호출 순서 |
|---|---|
| 경정청구 검토 | `refund-claim-examiner` (내부에서 기한 → 쟁점 묶음 → 조문·결정례 → 인용 점검) |
| 고객 질의 답변 | `statute-navigator` ∥ `precedent-analyst` (병렬) → `memo-drafter` → `citation-auditor` |
| 의견서/AI 답변 검수 | `citation-auditor` 단독 |
| 매년 세법 개정 반영 | `tax-rule-curator` → `mcp-qa-verifier` |

## 3. 연간 유지보수 캘린더
| 시기 | 작업 |
|---|---|
| 12월 말 | 세법 개정 법률 공포 → `trace_amendments`로 확인, 세율표 새 구간 추가(caution 표기) |
| 2~3월 | 시행령·시행규칙 개정 반영, caution 해제 |
| 상시 | 라이브 스모크 실패 시 필드 매핑 보정 |

## 4. 라이브 스모크 시나리오 (발췌)
1. `find_statute` "법법" → 법인세법 확장
2. `read_provision` 법인세법 52 → 부당행위계산의 부인
3. `read_provision` 법인세법 55 asOf=2022-06-30 → 10/20/22/25% 문언
4. `read_provision` 조특법 시행령 (목차)
5. `trace_amendments` 소득세법 55, depth 4
6. `trace_delegation` 법인세법 52 → 시행령 제88조·제89조 연결
7. `find_rulings` "업무무관 가지급금" (court, tribunal, moleg)
8. `read_ruling` 상기 결과 상위 1건 (각 자료원)
9. `find_admin_rule` "법인세법 기본통칙"
10. `find_form` "법인세 과세표준 및 세액신고서"
11. `check_references` 샘플 의견서 (의도적 오인용 3건 포함 → 3건 ⚠)
12. `build_issue_brief` "임원 퇴직금 한도초과"
13. `tax_deadline` corporate 2021-12-31 → 경정청구 2027-03-31
…(총 30건, QA 에이전트가 관리)

## 5. 완료 정의 (DoD)
- `npm run typecheck && npm test` 통과
- 새 도구·자료원은 가짜 업스트림 통합 테스트 1건 이상
- 세율·기한 변경은 근거 조문 발췌와 경계값 테스트 동반
- README 도구 표 갱신
