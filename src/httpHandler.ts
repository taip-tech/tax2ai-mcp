// Streamable HTTP(무상태) 요청 처리기. 자체 서버(cli.ts --http)와 Vercel 함수(api/mcp.js)가 함께 쓴다.

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Settings } from "./config.js";
import { OC_PATTERN, runWithUserKey } from "./lawgo/client.js";
import {
  authServerMetadataUrl,
  bearerChallenge,
  createTokenVerifier,
  protectedResourceMetadata,
  TokenRejected,
  type Caller,
  type TokenVerifier,
} from "./oauth.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { openDesks, type Desks } from "./tools/context.js";

const MAX_BODY = 1_000_000;
const MCP_PATHS = new Set(["/mcp", "/api/mcp"]);
const HEALTH_PATHS = new Set(["/healthz", "/api/healthz"]);

type IncomingWithBody = IncomingMessage & { body?: unknown };

async function readJson(req: IncomingWithBody): Promise<unknown> {
  // Vercel Node 런타임은 본문을 미리 파싱해 req.body에 넣어 준다
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body || "null") ?? undefined : req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("요청 본문이 너무 큽니다.");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function tokenOk(req: IncomingMessage, expected: string): boolean {
  if (!expected) return true;
  const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** IP별 1분 고정 창 호출 제한 (공개 모드용). 인스턴스 메모리 기준이다. */
class MinuteQuota {
  private window = 0;
  private readonly counts = new Map<string, number>();
  constructor(private readonly limit: number) {}

  take(key: string): boolean {
    const now = Math.floor(Date.now() / 60_000);
    if (now !== this.window) {
      this.window = now;
      this.counts.clear();
    }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= this.limit;
  }
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** 사용자 본인 OC: X-Lawgo-OC 헤더 우선, 허용 시 ?oc= 쿼리 */
function userKey(req: IncomingMessage, url: URL, allowQuery: boolean): string | undefined | null {
  const header = req.headers["x-lawgo-oc"];
  const raw = (Array.isArray(header) ? header[0] : header) ?? (allowQuery ? url.searchParams.get("oc") ?? undefined : undefined);
  if (raw === undefined || raw === "") return undefined;
  return OC_PATTERN.test(raw) ? raw : null; // null = 형식 오류
}

/**
 * 브라우저 출처(Origin) 허용 여부.
 * - ALLOWED_ORIGINS를 지정했으면 그 목록만 (`*`는 전부)
 * - 지정하지 않았을 때: 공개 모드(토큰 없음)는 지킬 인증 정보가 없으므로 전부 허용
 *   (Claude 웹·데스크톱 커넥터가 Origin을 붙여 호출함), 그 밖(로컬·토큰 운영)은 DNS 리바인딩 방지를 위해 차단
 */
function originAllowed(origin: string, cfg: Settings): boolean {
  const allowed = cfg.allowedOrigins;
  if (allowed.length) return allowed.includes("*") || allowed.includes(origin.replace(/\/+$/, ""));
  return cfg.publicMode && !cfg.accessToken;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Lawgo-OC",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

export type McpHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createMcpHandler(cfg: Settings, desks: Desks = openDesks(cfg), verifier?: TokenVerifier): McpHttpHandler {
  // desks(캐시 포함)는 요청 간 공유
  const quota = new MinuteQuota(cfg.ratePerMinute);
  const oauth = cfg.authMode === "oauth";
  if (oauth && !cfg.oauthIssuer) throw new Error("AUTH_MODE=oauth 에는 OAUTH_ISSUER가 필요합니다.");
  const verify = oauth ? (verifier ?? createTokenVerifier(cfg)) : undefined;
  let asMetadata: { body: unknown; at: number } | undefined;

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (cfg.accessLog) {
      const t0 = Date.now();
      // 쿼리(?oc=)와 본문은 남기지 않는다
      res.on("finish", () => console.error(`[access] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`));
    }
    const origin = req.headers.origin;
    if (origin) {
      if (!originAllowed(origin, cfg)) return reply(res, 403, { error: "이 출처(Origin)에서의 요청은 허용되지 않습니다." });
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (HEALTH_PATHS.has(path) || (path === "/api/mcp" && url.searchParams.has("health"))) {
      return reply(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION, endpoint: cfg.publicEndpoint, keyConfigured: desks.api.hasKey });
    }
    // OAuth 탐색 문서: Vercel에서는 /.well-known/* 를 ?wk= 로 넘겨받는다
    const wk = path.startsWith("/.well-known/") ? path.slice("/.well-known/".length) : url.searchParams.get("wk");
    if (wk !== null && (path.startsWith("/.well-known/") || path === "/api/mcp")) {
      if (!oauth) return reply(res, 404, { error: "not found" });
      if (wk.startsWith("oauth-protected-resource")) return reply(res, 200, protectedResourceMetadata(cfg));
      if (wk.startsWith("oauth-authorization-server") || wk.startsWith("openid-configuration")) {
        // 인증 서버 메타데이터를 MCP 서버 주소에서 찾는 이전 방식 클라이언트를 위한 중계 (10분 캐시)
        try {
          if (!asMetadata || Date.now() - asMetadata.at > 600_000) {
            const r = await fetch(authServerMetadataUrl(cfg.oauthIssuer));
            if (!r.ok) throw new Error(`인증 서버 응답 ${r.status}`);
            asMetadata = { body: await r.json(), at: Date.now() };
          }
          return reply(res, 200, asMetadata.body);
        } catch (err) {
          return reply(res, 502, { error: err instanceof Error ? err.message : "인증 서버 메타데이터를 가져오지 못했습니다" });
        }
      }
      return reply(res, 404, { error: "not found" });
    }
    if (!MCP_PATHS.has(path)) return reply(res, 404, { error: "not found" });
    let caller: Caller | undefined;
    if (verify) {
      const auth = String(req.headers.authorization ?? "");
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (!m) {
        res.setHeader("WWW-Authenticate", bearerChallenge(cfg));
        return reply(res, 401, { error: "login_required", message: `${cfg.brandName} 로그인이 필요합니다.` });
      }
      try {
        caller = await verify(m[1].trim());
      } catch (err) {
        const rejected = err instanceof TokenRejected ? err : undefined;
        res.setHeader("WWW-Authenticate", bearerChallenge(cfg, { code: "invalid_token", description: rejected?.headerHint ?? "invalid token" }));
        return reply(res, 401, { error: "invalid_token", message: rejected?.message ?? "토큰을 확인할 수 없습니다. 다시 로그인하세요." });
      }
    } else if (!tokenOk(req, cfg.accessToken)) {
      return reply(res, 401, { error: "unauthorized" });
    }
    // 로그인 사용자는 계정 단위, 공개 모드는 IP 단위로 분당 호출 제한
    const quotaKey = caller ? `user:${caller.userId}` : cfg.publicMode && !cfg.accessToken ? `ip:${clientIp(req, cfg.trustProxy)}` : "";
    if (quotaKey && !quota.take(quotaKey)) {
      res.setHeader("Retry-After", "60");
      return reply(res, 429, { jsonrpc: "2.0", error: { code: -32000, message: `분당 ${cfg.ratePerMinute}회 호출 한도를 넘었습니다. 1분 뒤 다시 시도하세요.` }, id: null });
    }
    if (req.method !== "POST") {
      return reply(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "무상태 모드: POST만 지원합니다." }, id: null });
    }
    const oc = userKey(req, url, cfg.allowQueryOc);
    if (oc === null) return reply(res, 400, { jsonrpc: "2.0", error: { code: -32602, message: "OC 형식이 올바르지 않습니다." }, id: null });
    try {
      const body = await readJson(req as IncomingWithBody);
      const server = buildServer(desks);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await runWithUserKey(oc, () => transport.handleRequest(req, res, body));
    } catch (err) {
      if (!res.headersSent) {
        reply(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: err instanceof Error ? err.message : "bad request" }, id: null });
      }
    }
  };
}
