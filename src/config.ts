// 환경변수 → 런타임 설정. 모든 값은 기동 시 한 번만 읽는다.

import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface Settings {
  oc: string;
  baseUrl: string;
  timeoutMs: number;
  maxParallel: number;
  ttlSearchSec: number;
  ttlDocumentSec: number;
  charBudget: number;
  httpHost: string;
  httpPort: number;
  accessToken: string;
  /** 토큰 없이 외부 공개 (tax2.ai 공개 서비스용). 대신 IP별 호출 제한 적용 */
  publicMode: boolean;
  ratePerMinute: number;
  /** 리버스 프록시 뒤에서 X-Forwarded-For를 신뢰 */
  trustProxy: boolean;
  publicEndpoint: string;
  brandName: string;
  brandUrl: string;
  /** 사용자 본인 OC 필수 (서버 키를 대신 쓰지 않음) */
  requireUserOc: boolean;
  /** 연결 주소 쿼리(?oc=)로 사용자 OC 받기 허용. URL은 접근 로그에 남을 수 있음 */
  allowQueryOc: boolean;
  /** 사용자 인증 방식: none(공개) | oauth(인증 서버 로그인 필수) */
  authMode: "none" | "oauth";
  /** OAuth 인증 서버 issuer (예: https://<ref>.supabase.co/auth/v1) */
  oauthIssuer: string;
  /** 지정하면 토큰 aud 클레임을 이 값으로 검증 */
  oauthAudience: string;
  /** 법제처 호출 시 보낼 Referer. 신청 정보에 등록한 도메인과 맞춰야 IP가 바뀌는 환경(Vercel)에서도 통과 */
  upstreamReferer: string;
  /** 서버 공용 키의 하루 업스트림 호출 한도 (0=무제한) */
  serverKeyDailyLimit: number;
  /** 브라우저 Origin 허용 목록. 비우면 Origin 헤더가 있는 요청을 막는다. "*"는 전부 허용 */
  allowedOrigins: string[];
  /** 요청 경로·상태·소요시간만 기록 (쿼리·본문 제외) */
  accessLog: boolean;
  /** 도구 응답·최종 답변에 출처(Powered by) 표기 */
  attribution: boolean;
  /** 사무소 프로필 저장소(Supabase REST). 비우면 OAuth issuer의 origin */
  supabaseUrl: string;
  /** Supabase 공개(anon/publishable) 키. 로그인 사용자 토큰과 함께 써서 RLS로 본인 행만 접근 */
  supabaseAnonKey: string;
  /** 로컬(stdio) 실행 시 사무소 프로필 파일 경로 */
  profileFile: string;
}

const flag = (v: string | undefined, fallback: boolean) =>
  v === undefined || v === "" ? fallback : ["1", "true", "on", "yes"].includes(v.toLowerCase());

export function loadSettings(env: Env = process.env): Settings {
  return {
    oc: (env.LAWGO_OC ?? "").trim(),
    baseUrl: (env.LAWGO_BASE_URL ?? "https://www.law.go.kr/DRF").replace(/\/+$/, ""),
    timeoutMs: num(env, "LAWGO_TIMEOUT_MS", 10_000),
    maxParallel: num(env, "LAWGO_MAX_PARALLEL", 4),
    ttlSearchSec: num(env, "CACHE_TTL_SEARCH", 1800),
    ttlDocumentSec: num(env, "CACHE_TTL_DOCUMENT", 43_200),
    charBudget: num(env, "REPLY_CHAR_BUDGET", 14_000),
    httpHost: env.HTTP_HOST ?? "127.0.0.1",
    httpPort: num(env, "HTTP_PORT", 8787),
    accessToken: (env.MCP_ACCESS_TOKEN ?? "").trim(),
    publicMode: flag(env.PUBLIC_MODE, false),
    ratePerMinute: num(env, "RATE_LIMIT_PER_MIN", 30),
    trustProxy: flag(env.TRUST_PROXY, false),
    publicEndpoint: env.PUBLIC_ENDPOINT ?? "https://mcp.tax2.ai/mcp",
    brandName: env.BRAND_NAME ?? "TAX2.AI",
    brandUrl: env.BRAND_URL ?? "https://tax2.ai",
    attribution: flag(env.BRAND_ATTRIBUTION, true),
    requireUserOc: flag(env.REQUIRE_USER_OC, false),
    allowQueryOc: flag(env.ALLOW_QUERY_OC, true),
    authMode: env.AUTH_MODE === "oauth" ? "oauth" : "none",
    oauthIssuer: (env.OAUTH_ISSUER ?? "").replace(/\/+$/, ""),
    oauthAudience: (env.OAUTH_AUDIENCE ?? "").trim(),
    upstreamReferer: env.LAWGO_REFERER ?? new URL(env.PUBLIC_ENDPOINT ?? "https://mcp.tax2.ai/mcp").origin,
    serverKeyDailyLimit: Math.max(0, Math.floor(Number(env.SERVER_KEY_DAILY_LIMIT ?? 0)) || 0),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    accessLog: flag(env.ACCESS_LOG, false),
    supabaseUrl: (env.SUPABASE_URL ?? (env.OAUTH_ISSUER ? new URL(env.OAUTH_ISSUER).origin : "")).replace(/\/+$/, ""),
    supabaseAnonKey: (env.SUPABASE_ANON_KEY ?? "").trim(),
    profileFile: env.PROFILE_FILE ?? join(homedir(), ".tax2ai", "office-profile.json"),
  };
}
