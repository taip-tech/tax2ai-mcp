# tax2.ai 배포 가이드

공개 엔드포인트: **`https://mcp.tax2.ai/mcp`** (Streamable HTTP, 무상태)
상태 확인: `https://mcp.tax2.ai/healthz`

## 0. 배포 방식 선택

| | Vercel | 자체 서버 (Docker + Caddy) |
|---|---|---|
| 준비 | `vercel deploy` 한 번, TLS·도메인 자동 | VM, Docker, DNS 직접 관리 |
| 법제처 IP 등록 | 나가는 IP가 고정되지 않음 → **Static IPs(유료 플랜) 필요** 또는 도메인 등록만으로 통과하는지 실측 필요 | 서버 공인 IP 하나 등록 |
| 캐시·호출 제한 | 인스턴스별 메모리 (인스턴스가 여러 개면 나뉨) | 프로세스 하나에 모임 |
| 권장 | 빠른 공개, 트래픽 적을 때 | 법제처 등록 문제를 확실히 피하고 싶을 때 |

### Vercel 배포
```bash
vercel link
vercel env add LAWGO_OC production
vercel env add PUBLIC_MODE production      # 1
vercel deploy --prod
vercel domains add mcp.tax2.ai             # tax2.ai DNS에 안내된 CNAME 추가
```
- 진입점: `api/mcp.js` (빌드된 `dist/`를 사용), 경로: `/mcp`, `/healthz` (vercel.json rewrite)
- 배포 직후 `https://mcp.tax2.ai/healthz`와 법령 도구 한 번(`find_statute`)을 호출해 `KEY_REJECTED`가 나는지 확인합니다. 나면 법제처 등록 정보와 Vercel 아웃바운드 IP 문제입니다.

### 공개 운영 권장값 (수강생 대상 무료 공개)
| 변수 | 권장 | 이유 |
|---|---|---|
| `PUBLIC_MODE` | `1` | 토큰 없이 누구나 연결 |
| `LAWGO_OC` | 운영자 키 | 키 없는 수강생도 바로 사용 |
| `SERVER_KEY_DAILY_LIMIT` | 운영 첫 주 사용량을 보고 설정 | 공용 키 한도 소진 방지, 초과 시 본인 키 안내 |
| `RATE_LIMIT_PER_MIN` | `30` | 한 사람의 과도한 호출 방지 |
| `ALLOW_QUERY_OC` | `1` | Claude 웹 커넥터 사용자가 `?oc=`로 본인 키 사용 |
| `ACCESS_LOG` | `1` | 장애 확인용 (쿼리·본문은 기록 안 함) |
| `BRAND_ATTRIBUTION` | `1` | 출처·AI 작성 고지 |

개인정보처리방침은 `/privacy`(public/privacy.html)로 제공됩니다. 문의 이메일 자리를 채운 뒤 배포하세요.

## 1. 서버 준비 (자체 서버)
- **고정 공인 IP가 있는 서버**(클라우드 VM 등)를 권장합니다. 법제처 OPEN API는 호출 서버의 IP 또는 도메인을 등록해야 해서, 나가는 IP가 계속 바뀌는 서버리스 환경에서는 `KEY_REJECTED`가 날 수 있습니다.
- Docker, Docker Compose 설치

## 2. DNS
| 레코드 | 이름 | 값 |
|---|---|---|
| A | `mcp` | 서버 공인 IP |

## 3. 법제처 등록
open.law.go.kr → OPEN API 신청 정보에 **서버 공인 IP**와 도메인 `mcp.tax2.ai`를 등록합니다.

## 4. 실행
```bash
cp .env.example .env      # LAWGO_OC 입력
cd deploy
docker compose up -d --build
curl https://mcp.tax2.ai/healthz
```
Caddy가 TLS 인증서를 자동으로 발급합니다.

## 5. 공개 방식
| 방식 | 설정 | 용도 |
|---|---|---|
| 공개 (기본 compose) | `PUBLIC_MODE=1`, `TRUST_PROXY=1`, `RATE_LIMIT_PER_MIN=30` | 누구나 연결, IP당 분당 호출 제한 |
| 회원 전용 | `MCP_ACCESS_TOKEN=<긴 임의값>` | `Authorization: Bearer` 헤더 필요 |

`TRUST_PROXY=1`은 Caddy 같은 리버스 프록시 뒤에서만 켜세요. 직접 노출된 서버에서 켜면 X-Forwarded-For 위조로 호출 제한을 우회할 수 있습니다.

## 6. OC 키 운영 방식

| 방식 | 설정 | 사용자가 할 일 |
|---|---|---|
| 서버 키만 | `LAWGO_OC=운영자키` | 없음 (주소만 연결) |
| **혼합 (기본)** | `LAWGO_OC=운영자키` | 원하면 본인 키 사용, 없으면 서버 키로 동작 |
| 사용자 키 필수 | `REQUIRE_USER_OC=1` | 본인 키 발급 + 등록 필수 |

사용자 키는 `X-Lawgo-OC` 헤더 또는 연결 주소의 `?oc=본인OC`로 받습니다. 사용자 키가 오면 서버 키보다 우선합니다. 법령 데이터는 공개 자료라 캐시는 키와 관계없이 공유합니다.

**사용자 키의 등록 요건 (2026-10-31 확인).** 서버는 법제처 호출에 `Referer: https://mcp.tax2.ai`(실제 서비스 도메인)를 보냅니다. 법제처는 키의 신청 정보에 등록된 도메인과 이를 대조하므로, 본인 키를 쓰는 사용자는 자기 신청 정보의 서버 도메인에 `mcp.tax2.ai`를 등록해야 합니다. 운영자 키도 도메인 등록 후에 Vercel에서 통과했습니다. 인증이 실패하면 서버가 등록할 도메인을 함께 안내합니다.

Referer를 법제처 자신의 도메인(law.go.kr)으로 꾸며 등록 확인을 건너뛰는 방식은 법제처의 접근 통제를 우회하는 것이라 쓰지 않습니다.

`?oc=` 방식은 URL이 접근 로그에 남을 수 있습니다. 헤더만 받으려면 `ALLOW_QUERY_OC=0`으로 설정하세요. 다만 Claude 웹·데스크톱의 사용자 지정 커넥터는 주소만 입력받으므로, 그 사용자들에게는 쿼리 방식이 필요합니다.

### 공용 키 보호와 브라우저 요청
| 설정 | 기본 | 설명 |
|---|---|---|
| `SERVER_KEY_DAILY_LIMIT` | 0 (무제한) | 공용 키로 법제처를 부른 횟수의 하루 상한 (한국 시간 0시 초기화, 캐시 적중 제외). 넘으면 `QUOTA_EXCEEDED`와 함께 본인 OC 사용을 안내 |
| `ALLOWED_ORIGINS` | 비어 있음 | 브라우저 Origin 허용 목록. 비워 두면 공개 모드(토큰 없음)에서는 모두 허용하고(Claude 커넥터가 `Origin: https://claude.ai`를 붙여 호출), 로컬·토큰 운영에서는 Origin 헤더가 있는 요청을 막습니다(DNS 리바인딩 방지) |
| `ACCESS_LOG` | 0 | 1이면 방법·경로·상태·소요시간만 기록. `?oc=` 쿼리와 본문은 남기지 않음 |

인스턴스가 여러 개인 환경(Vercel)에서는 일일 한도와 분당 제한이 인스턴스마다 따로 셉니다.

## 7. 사용자 연결 안내 (서비스 페이지용 문구)
- **Claude (웹/데스크톱)**: 설정 → 커넥터 → 사용자 지정 커넥터 추가 → URL `https://mcp.tax2.ai/mcp` → 연결 → TAX2 로그인 → 허용 (`AUTH_MODE=none`으로 운영할 때는 인증 "로그인 없음" 선택) (본인 키: 신청 정보에 `mcp.tax2.ai` 등록 후 `https://mcp.tax2.ai/mcp?oc=본인OC`)
- **Claude Code 플러그인 (권장)**: `/plugin marketplace add taip-tech/tax2ai-mcp` → `/plugin install tax2ai@tax2ai` (설치 시 OC 입력)
- **Claude Code 수동 등록**: `claude mcp add --transport http tax2ai https://mcp.tax2.ai/mcp --header "X-Lawgo-OC: 본인OC"`
- **원격 HTTP 미지원 클라이언트**: `npx mcp-remote https://mcp.tax2.ai/mcp --header "X-Lawgo-OC: 본인OC"`
- **로컬 설치(stdio)**: 본인 키를 `LAWGO_OC` 환경변수에 넣습니다. 이 경우 본인 PC(또는 서버)의 IP를 법제처에 등록합니다.

## 8. 사용자 로그인 (OAuth 2.1)

`AUTH_MODE=oauth`이면 Claude 커넥터 연결 시 TAX2 계정(카카오) 로그인을 거칩니다.

| 구성 | 위치 |
|---|---|
| 인증 서버 | TAX2 플랫폼 Supabase (`OAUTH_ISSUER=https://pseexjrsrgmmjdadoyjk.supabase.co/auth/v1`) |
| 동의 화면 | `https://www.tax2.ai/oauth/consent` (TAX2_AI 저장소 `src/app/oauth/consent`) |
| MCP 서버 역할 | 보호 자원 메타데이터 제공, 401 안내, JWKS로 토큰 검증 |

Supabase 설정: Authentication → OAuth Server 켜기, Authorization path `/oauth/consent`, Dynamic client registration 켜기, Site URL `https://www.tax2.ai`.

검증 규칙: 발급자(issuer)·서명(ES256/RS256)·만료, OAuth로 발급된 토큰(`client_id` 클레임)만 허용. Supabase 토큰의 `aud`는 기본 `authenticated`이므로, 대상까지 묶으려면 액세스 토큰 훅으로 `aud`를 `https://mcp.tax2.ai/mcp`로 지정하고 `OAUTH_AUDIENCE`를 설정합니다.

### 사무소 프로필 저장소
`office_profile` 도구는 로그인 사용자별로 사무소 정보를 저장합니다. 서비스 키 없이 **사용자 토큰 + 공개(anon) 키**로 Supabase REST에 접근하고, RLS가 본인 행만 허용합니다.

1. Supabase SQL Editor에서 `deploy/supabase/mcp_office_profiles.sql` 실행
2. Vercel 환경변수 `SUPABASE_ANON_KEY` (플랫폼의 `NEXT_PUBLIC_SUPABASE_ANON_KEY`와 같은 값) 설정 후 재배포

로그인 없는 공개 모드(`AUTH_MODE=none`)에서는 저장하지 않고, 로컬 stdio 실행은 `PROFILE_FILE`에 저장합니다. 고객 정보는 저장하지 않습니다.

## 9. 출처 표기 (Powered by)
| 위치 | 내용 | 끄는 법 |
|---|---|---|
| 도구 응답 끝 | `Powered by TAX2.AI 세무 법령 MCP · 원문 출처: 법제처 국가법령정보센터` | `BRAND_ATTRIBUTION=0` |
| 서버 지침 → AI 최종 답변 맨 아래 | `— 이 답변은 TAX2.AI 세무 법령 MCP(https://tax2.ai)를 활용하여 AI가 작성했습니다.` | 같음 |
| 워크플로 프롬프트 결과물 | 위 문구 | 같음 |

서버 지침은 AI 클라이언트에 대한 **요청**입니다. 대부분 따르지만 클라이언트나 사용자 설정에 따라 생략될 수 있습니다. 도구 응답 끝의 표기는 항상 붙습니다.

## 10. 운영 점검
- `/healthz`의 `keyConfigured: true` 확인
- 법제처 일일 호출량은 서버 OC 하나로 합산되므로, 사용량이 늘면 `RATE_LIMIT_PER_MIN`과 캐시 TTL을 조정하세요.
- 로그에는 요청 본문(사용자 원고)을 남기지 않습니다.
