// OAuth 자원 서버 모드: 보호 자원 메타데이터, 401 안내, 토큰 검증

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { loadSettings } from "../src/config.ts";
import { LawgoClient, type Fetcher } from "../src/lawgo/client.ts";
import { createMcpHandler } from "../src/httpHandler.ts";
import { createTokenVerifier } from "../src/oauth.ts";
import { openDesks } from "../src/tools/context.ts";

const ISSUER = "https://demo.supabase.co/auth/v1";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const cfg = loadSettings({ LAWGO_OC: "k", PUBLIC_MODE: "1", AUTH_MODE: "oauth", OAUTH_ISSUER: ISSUER, PUBLIC_ENDPOINT: "https://mcp.tax2.ai/mcp" });
  const f: Fetcher = async () => ({ ok: true, status: 200, text: async () => '{"LawSearch":{"totalCnt":"0"}}' });
  const handler = createMcpHandler(cfg, openDesks(cfg, new LawgoClient(cfg, f)), createTokenVerifier(cfg, jwks));
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sign = (claims: Record<string, unknown>, opts: { iss?: string; exp?: string } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(opts.iss ?? ISSUER).setIssuedAt().setExpirationTime(opts.exp ?? "1h").sign(privateKey);
  const mcp = (token?: string) =>
    fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tax_deadline", arguments: { kind: "vat", periodEnd: "2025-06-30" } } }),
    });
  return { base, sign, mcp, close: () => server.close() };
}

test("보호 자원 메타데이터(RFC 9728)", async () => {
  const s = await setup();
  const r = await fetch(s.base + "/.well-known/oauth-protected-resource");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.resource, "https://mcp.tax2.ai/mcp");
  assert.deepEqual(body.authorization_servers, [ISSUER]);
  // Vercel 경유 형태(?wk=)도 같은 응답
  const viaRewrite = await fetch(s.base + "/api/mcp?wk=oauth-protected-resource/mcp");
  assert.equal((await viaRewrite.json()).resource, "https://mcp.tax2.ai/mcp");
  s.close();
});

test("토큰 없으면 401 + WWW-Authenticate로 메타데이터 위치 안내", async () => {
  const s = await setup();
  const r = await s.mcp();
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer resource_metadata="https:\/\/mcp\.tax2\.ai\/\.well-known\/oauth-protected-resource"/);
  s.close();
});

test("OAuth로 발급된 유효 토큰이면 도구 실행", async () => {
  const s = await setup();
  const token = await s.sign({ sub: "user-1", client_id: "claude-client", role: "authenticated" });
  const r = await s.mcp(token);
  assert.equal(r.status, 200);
  assert.match(JSON.stringify(await r.json()), /2025-07-25/);
  s.close();
});

test("웹 로그인 세션 토큰(client_id 없음)·다른 발급자·만료 토큰은 거부", async () => {
  const s = await setup();
  for (const token of [
    await s.sign({ sub: "user-1", role: "authenticated" }),
    await s.sign({ sub: "user-1", client_id: "c" }, { iss: "https://evil.example/auth/v1" }),
    await s.sign({ sub: "user-1", client_id: "c" }, { exp: "-1m" }),
    "not-a-jwt",
  ]) {
    const r = await s.mcp(token);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  }
  s.close();
});

test("AUTH_MODE=none이면 탐색 문서 없음(404)·토큰 없이 동작", async () => {
  const cfg = loadSettings({ LAWGO_OC: "k", PUBLIC_MODE: "1" });
  const server = createServer(createMcpHandler(cfg));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(base + "/.well-known/oauth-protected-resource")).status, 404);
  server.close();
});
