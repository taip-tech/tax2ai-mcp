// OAuth 2.1 자원 서버(Resource Server) 역할.
// 로그인·토큰 발급은 인증 서버(TAX2 플랫폼의 Supabase Auth)가 하고,
// 이 서버는 보호 자원 메타데이터(RFC 9728)를 알리고 받은 액세스 토큰을 검증만 한다.

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Settings } from "./config.js";

export interface Caller {
  userId: string;
  clientId: string;
}

export type TokenVerifier = (token: string) => Promise<Caller>;

/** message는 사용자 안내(한글), headerHint는 WWW-Authenticate에 넣을 영문(ASCII) 설명 */
export class TokenRejected extends Error {
  constructor(message: string, public readonly headerHint: string) {
    super(message);
  }
}

/** https://x.supabase.co/auth/v1 → https://x.supabase.co/.well-known/oauth-authorization-server/auth/v1 (RFC 8414 경로 규칙) */
export function authServerMetadataUrl(issuer: string): string {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}/.well-known/oauth-authorization-server${path}`;
}

export function protectedResourceMetadataUrl(cfg: Settings): string {
  return `${new URL(cfg.publicEndpoint).origin}/.well-known/oauth-protected-resource`;
}

/** RFC 9728 보호 자원 메타데이터 */
export function protectedResourceMetadata(cfg: Settings) {
  return {
    resource: cfg.publicEndpoint,
    authorization_servers: [cfg.oauthIssuer],
    bearer_methods_supported: ["header"],
    resource_name: `${cfg.brandName} 세무 법령 MCP`,
    resource_documentation: cfg.brandUrl,
  };
}

/** 401 응답에 붙는 WWW-Authenticate 값 */
export function bearerChallenge(cfg: Settings, error?: { code: string; description: string }): string {
  let v = `Bearer resource_metadata="${protectedResourceMetadataUrl(cfg)}"`;
  if (error) {
    // HTTP 헤더에는 ASCII만 허용된다
    const ascii = error.description.replace(/[^\x20-\x7E]/g, "").replace(/"/g, "'").trim() || "invalid token";
    v += `, error="${error.code}", error_description="${ascii}"`;
  }
  return v;
}

export function createTokenVerifier(cfg: Settings, keys?: JWTVerifyGetKey): TokenVerifier {
  const issuer = cfg.oauthIssuer.replace(/\/+$/, "");
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 60_000 });
  return async (token: string): Promise<Caller> => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer,
        algorithms: ["ES256", "RS256"],
        ...(cfg.oauthAudience ? { audience: cfg.oauthAudience } : {}),
      }));
    } catch (err) {
      const detail = err instanceof Error ? err.message : "verification failed";
      throw new TokenRejected(`토큰을 확인할 수 없습니다. 다시 로그인하세요. (${detail})`, detail);
    }
    // 인증 서버의 OAuth 흐름으로 발급된 토큰만 받는다 (플랫폼 웹 로그인 세션 토큰에는 client_id가 없음)
    const clientId = typeof payload.client_id === "string" ? payload.client_id : "";
    if (!clientId) throw new TokenRejected("OAuth 연결로 발급된 토큰이 아닙니다.", "token was not issued through OAuth (missing client_id)");
    if (!payload.sub) throw new TokenRejected("사용자 정보가 없는 토큰입니다.", "token has no subject");
    return { userId: payload.sub, clientId };
  };
}
