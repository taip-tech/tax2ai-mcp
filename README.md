# tax2ai-mcp

세무사 실무를 위한 **법령·결정례 MCP 서버**입니다. 법제처 국가법령정보 공동활용 Open API를 원천으로, AI 어시스턴트가 조문 원문·시행 시점·위임 법령·결정례를 직접 조회하고 근거를 붙여 답하도록 돕습니다.

- 줄임말 이해: `법법`, `조특법 시행령`, `상증법` → 정식 법령명
- **시점 조회**: 사업연도 당시 시행 문언을 `asOf`로 확인, 시행 예정 개정 자동 경고
- **인용 점검**: 초안의 "같은 법 제52조제1항" 같은 인용까지 추출해 존재·삭제·항호 범위 판정
- **기한·세액 계산**: 경정청구 5년, 부과제척기간, 휴일 순연 / 연도별 세율표 기반 산출세액
- 결정례 통합 검색: 법원 판례 · 헌재 · 조세심판원 · 법제처 해석례

**공개 엔드포인트:** `https://mcp.tax2.ai/mcp` · 배포 방법(Vercel / Docker)은 [docs/DEPLOY.md](docs/DEPLOY.md)

```bash
claude mcp add --transport http tax2ai https://mcp.tax2.ai/mcp
# 본인 법제처 OC 사용 시
claude mcp add --transport http tax2ai https://mcp.tax2.ai/mcp --header "X-Lawgo-OC: 본인OC"
```

### Claude Code 플러그인 (권장)
MCP 연결, `/semu` 검토 스킬, 실무 서브에이전트 5종을 한 번에 설치합니다. 설치할 때 본인 법제처 OC를 선택 입력합니다(민감 정보로 저장).
```
/plugin marketplace add taip-tech/tax2ai-mcp
/plugin install tax2ai@tax2ai
```
사용: `/semu 2021 사업연도 법인세 경정청구 기한은?` · `/semu deep 대표이사 가지급금 인정이자와 손금불산입 범위`

**수강생이라면** → [docs/STUDENT_GUIDE.md](docs/STUDENT_GUIDE.md)부터 보세요.

> 출력은 참고자료이며 유권해석이 아닙니다. 법적 효과가 있는 판단은 원문 확인과 세무사 검토를 거치세요.

## 빠른 시작

```bash
npm install
npm run build
cp .env.example .env   # LAWGO_OC 입력
```

### OC 발급
1. [open.law.go.kr](https://open.law.go.kr) 가입 → OPEN API 사용 신청
2. 호출할 서버의 IP 또는 도메인 등록 (미등록 시 `KEY_REJECTED`)
3. 승인 후 OC 값(가입 이메일 ID)을 `LAWGO_OC`에 설정

### Claude Code 연결
저장소의 `.mcp.json`이 `tax2ai` 서버를 등록합니다. 셸에 `export LAWGO_OC=...` 후 이 폴더에서 Claude Code를 실행하세요.

또는 전역 등록:
```bash
claude mcp add tax2ai --env LAWGO_OC=발급값 -- node /절대경로/tax2ai_MCP/dist/cli.js
```

### Claude Desktop 연결
```json
{
  "mcpServers": {
    "tax2ai": {
      "command": "node",
      "args": ["/절대경로/tax2ai_MCP/dist/cli.js"],
      "env": { "LAWGO_OC": "발급값" }
    }
  }
}
```

### HTTP 모드 (자체 서버)
```bash
HTTP_HOST=0.0.0.0 MCP_ACCESS_TOKEN=긴임의값 LAWGO_OC=발급값 npm run start:http
# POST http://서버:8787/mcp  (Authorization: Bearer 긴임의값)
# GET  http://서버:8787/healthz
```

## 출처 표기 (Powered by TAX2.AI)
- 모든 도구 응답 끝: `Powered by TAX2.AI 세무 법령 MCP · 원문 출처: 법제처 국가법령정보센터`
- AI 최종 답변 맨 아래(서버 지침으로 요청): `— 이 답변은 TAX2.AI 세무 법령 MCP(https://tax2.ai)를 활용하여 AI가 작성했습니다.` (인공지능기본법상 생성형 AI 결과물 고지를 겸함)
- `BRAND_ATTRIBUTION=0`으로 끌 수 있고, `BRAND_NAME`·`BRAND_URL`로 문구를 바꿀 수 있습니다.

## 도구 (19)

| 도구 | 용도 | 네트워크 |
|---|---|---|
| `find_statute` | 법령명(줄임말)·본문 키워드 검색 | ● |
| `read_provision` | 조문·항 원문, `asOf` 시점 조회, 시행 예정 경고, 목차 | ● |
| `read_transition_rules` | 부칙의 시행일·적용례·경과조치 (어느 사업연도부터 적용되는지) | ● |
| `trace_amendments` | 시행일별 버전, 조문 문언 변경 시점 | ● |
| `trace_delegation` | 법률↔시행령↔시행규칙 위임·인용 연결 | ● |
| `compare_revision` | 신구조문 대비 | ● |
| `find_rulings` | 판례·헌재·조세심판원·법제처 해석례 통합 검색 | ● |
| `read_ruling` | 결정례 본문 (섹션 선택) | ● |
| `find_admin_rule` | 기본통칙·고시·훈령 검색/본문 | ● |
| `find_form` | 별표·서식 + HWP/PDF 링크 | ● |
| `explain_term` | 법령용어 정의 | ● |
| `check_references` | 초안 인용 조문 점검 | ● |
| `build_issue_brief` | 쟁점별 법령·행정규칙·결정례 후보 일괄 수집 | ● |
| `estimate_tax` | 법인세(2018~2026 개시)·종합소득세(2021~2026) 산출세액 | – |
| `tax_deadline` | 법정신고기한·경정청구·제척기간·후발적 경정청구 | – |
| `estimate_penalty` | 무신고·과소신고·납부지연 가산세, 수정·기한후신고 시점별 감면 | – |
| `entertainment_limit` | 기업업무추진비 한도·한도초과액 (2020~2026 개시) | – |
| `deemed_interest` | 가지급금 적수·인정이자, 5%·3억원 기준 판정 | – |
| `find_treaty` | 조세조약 검색·본문 (키워드 필터) | ● |

긴 응답은 `[MORE] … cursor=N` 안내가 붙으며, 같은 인자에 `cursor`를 넣어 이어받습니다.

## 프롬프트 (3)
`refund_claim_review`(경정청구 검토) · `opinion_citation_audit`(의견서 인용 점검) · `client_question_memo`(고객 질의 답변 메모)

## 서브에이전트 (`.claude/agents/`)

| 구분 | 에이전트 | 역할 |
|---|---|---|
| 개발 | `lawgo-api-engineer` | 법제처 연동·필드 매핑 |
| 개발 | `tax-rule-curator` | 세율표·기한·약칭 개정 반영 |
| 개발 | `mcp-qa-verifier` | 회귀·프로토콜·라이브 스모크 |
| 실무 | `statute-navigator` | 조문·위임·개정 조사 |
| 실무 | `precedent-analyst` | 결정례 수집·유불리 분류 |
| 실무 | `refund-claim-examiner` | 경정청구 검토 전 과정 |
| 실무 | `citation-auditor` | 인용 검수 |
| 실무 | `memo-drafter` | 검토메모·답변서 작성 |

## 개발

```bash
npm run dev         # tsx로 stdio 실행
npm run typecheck
npm test            # 단위 + 가짜 업스트림 통합 테스트
```

문서: [RFP](docs/RFP.md) · [업무 계획](docs/WORKPLAN.md) · [아키텍처](docs/ARCHITECTURE.md) · [배포](docs/DEPLOY.md)

## 라이선스 · 개인정보
- 코드: [MIT](LICENSE) © 2026 TAIP Technologies (TAX2.AI)
- 데이터 출처: [NOTICE.md](NOTICE.md) (법제처 국가법령정보센터)
- 개인정보처리방침: https://mcp.tax2.ai/privacy ([public/privacy.html](public/privacy.html))

## 알려진 제약
- 법제처 응답 필드명은 실데이터로 검증 전 후보 매핑 상태입니다 (특히 조세심판원·3단비교·신구조문·법령용어). `WORKPLAN.md` Phase 2 참조.
- 휴일 순연은 주말·양력 고정 공휴일만 자동 반영합니다. 설·추석·대체공휴일은 `extraHolidays`로 넣으세요.
- 2026.1.1. 이후 개시 사업연도 법인세율(10/20/22/25%)은 원문 대조 전 `caution` 상태입니다.
