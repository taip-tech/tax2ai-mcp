// HTTP 처리기: 사용자 본인 OC 전달, 사용자 키 필수 모드, 공유 캐시

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadSettings } from "../src/config.ts";
import { LawgoClient, type Fetcher } from "../src/lawgo/client.ts";
import { createMcpHandler } from "../src/httpHandler.ts";
import { openDesks } from "../src/tools/context.ts";
import type { TokenVerifier } from "../src/oauth.ts";
import { openSavedKeys, type SavedKeyLookup } from "../src/office/savedKey.ts";

const LIST = { LawSearch: { totalCnt: "1", law: [{ 법령일련번호: "1", 법령명한글: "법인세법", 법령구분명: "법률", 시행일자: "20250101" }] } };

async function start(env: Record<string, string>, opts: { verifier?: TokenVerifier; savedKey?: SavedKeyLookup } = {}) {
  const cfg = loadSettings(env);
  const seen: string[] = [];
  const f: Fetcher = async (url) => {
    seen.push(new URL(url).searchParams.get("OC") ?? "");
    return { ok: true, status: 200, text: async () => JSON.stringify(LIST) };
  };
  const server: Server = createServer(createMcpHandler(cfg, openDesks(cfg, new LawgoClient(cfg, f)), opts.verifier, opts.savedKey));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, query: string, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_statute", arguments: { query } } }),
    });
    return { status: res.status, body: await res.text() };
  };
  return { call, seen, close: () => server.close() };
}

test("사용자 OC(헤더·쿼리)가 서버 키보다 우선하고 캐시는 공유", async () => {
  const s = await start({ LAWGO_OC: "serverkey" });
  await s.call("/mcp", "법인세법", { "x-lawgo-oc": "alice" });
  await s.call("/mcp?oc=bob", "소득세법");
  await s.call("/mcp", "부가가치세법");
  assert.deepEqual(s.seen, ["alice", "bob", "serverkey"]);
  const again = await s.call("/mcp?oc=carol", "법인세법"); // 같은 검색 → 캐시 적중
  assert.match(again.body, /법인세법/);
  assert.equal(s.seen.length, 3);
  s.close();
});

test("REQUIRE_USER_OC=1이면 서버 키로 대신 호출하지 않음", async () => {
  const s = await start({ LAWGO_OC: "serverkey", REQUIRE_USER_OC: "1" });
  const r = await s.call("/mcp", "법인세법");
  assert.match(r.body, /KEY_MISSING/);
  assert.match(r.body, /본인의 법제처 OC가 필요합니다/);
  assert.equal(s.seen.length, 0);
  const ok = await s.call("/mcp", "법인세법", { "x-lawgo-oc": "alice" });
  assert.doesNotMatch(ok.body, /KEY_MISSING/);
  assert.deepEqual(s.seen, ["alice"]);
  s.close();
});

test("ALLOW_QUERY_OC=0이면 쿼리 키 무시, 잘못된 형식은 400", async () => {
  const s = await start({ LAWGO_OC: "serverkey", ALLOW_QUERY_OC: "0" });
  await s.call("/mcp?oc=bob", "법인세법");
  assert.deepEqual(s.seen, ["serverkey"]);
  const bad = await s.call("/mcp", "소득세법", { "x-lawgo-oc": "bad key!" });
  assert.equal(bad.status, 400);
  s.close();
});

test("SERVER_KEY_DAILY_LIMIT: 공용 키만 한도 적용, 사용자 키는 통과", async () => {
  const s = await start({ LAWGO_OC: "serverkey", SERVER_KEY_DAILY_LIMIT: "2" });
  await s.call("/mcp", "가");
  await s.call("/mcp", "나");
  const third = await s.call("/mcp", "다");
  assert.match(third.body, /QUOTA_EXCEEDED/);
  assert.match(third.body, /본인 법제처 OC/);
  const cached = await s.call("/mcp", "가"); // 캐시 적중은 한도와 무관
  assert.doesNotMatch(cached.body, /QUOTA_EXCEEDED/);
  const own = await s.call("/mcp", "라", { "x-lawgo-oc": "alice" });
  assert.doesNotMatch(own.body, /QUOTA_EXCEEDED/);
  assert.deepEqual(s.seen, ["serverkey", "serverkey", "alice"]);
  s.close();
});

test("Origin: 공개 모드는 허용(커넥터), 그 밖엔 허용 목록", async () => {
  const pub = await start({ LAWGO_OC: "k", PUBLIC_MODE: "1" });
  assert.equal((await pub.call("/mcp", "가", { origin: "https://claude.ai" })).status, 200);
  pub.close();
  const blocked = await start({ LAWGO_OC: "k" });
  assert.equal((await blocked.call("/mcp", "가", { origin: "https://evil.example" })).status, 403);
  assert.equal((await blocked.call("/mcp", "가")).status, 200); // 서버 간 호출(Origin 없음)은 통과
  blocked.close();
  const allowed = await start({ LAWGO_OC: "k", ALLOWED_ORIGINS: "https://tax2.ai/" });
  assert.equal((await allowed.call("/mcp", "가", { origin: "https://tax2.ai" })).status, 200);
  allowed.close();
});

const OAUTH = { LAWGO_OC: "serverkey", AUTH_MODE: "oauth", OAUTH_ISSUER: "https://x.supabase.co/auth/v1" };
const loggedIn: TokenVerifier = async (t) => ({ userId: t, clientId: "c" });

test("계정에 저장한 OC: 서버 키보다 우선, 연결에 실은 키보다는 뒤", async () => {
  const asked: string[] = [];
  const s = await start(OAUTH, {
    verifier: loggedIn,
    savedKey: async (u) => {
      asked.push(u.userId);
      return u.userId === "alice" ? "alice-oc" : undefined;
    },
  });
  await s.call("/mcp", "가", { authorization: "Bearer alice" });
  await s.call("/mcp", "나", { authorization: "Bearer bob" });
  await s.call("/mcp?oc=url-oc", "다", { authorization: "Bearer alice" });
  assert.deepEqual(s.seen, ["alice-oc", "serverkey", "url-oc"]);
  assert.deepEqual(asked, ["alice", "bob"]); // 연결에 실은 키가 있으면 저장소를 부르지 않음
  s.close();
});

test("도구 호출이 아니면 저장된 키를 조회하지 않음", async () => {
  let asked = 0;
  const cfg = loadSettings(OAUTH);
  const server: Server = createServer(
    createMcpHandler(cfg, openDesks(cfg, new LawgoClient(cfg)), loggedIn, async () => {
      asked++;
      return undefined;
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer alice" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);
  assert.equal(asked, 0);
  server.close();
});

test("REQUIRE_USER_OC=1이어도 계정에 저장한 OC로 호출", async () => {
  const s = await start({ ...OAUTH, REQUIRE_USER_OC: "1" }, { verifier: loggedIn, savedKey: async () => "alice-oc" });
  const r = await s.call("/mcp", "법인세법", { authorization: "Bearer alice" });
  assert.doesNotMatch(r.body, /KEY_MISSING/);
  assert.deepEqual(s.seen, ["alice-oc"]);
  s.close();
});

test("openSavedKeys: 본인 토큰으로 조회·60초 캐시, 저장소 장애는 공용 키 경로로", async () => {
  const cfg = loadSettings({ ...OAUTH, SUPABASE_ANON_KEY: "anon" });
  const calls: { url: string; auth: string }[] = [];
  let mode: "ok" | "down" | "bad" = "ok";
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (mode === "down") return new Response("x", { status: 500 });
    return Response.json(mode === "bad" ? [{ oc: "bad key!" }] : url.includes("alice") ? [{ oc: "alice-oc" }] : []);
  }) as unknown as typeof fetch;
  const look = openSavedKeys(cfg, f);
  assert.equal(await look({ userId: "alice", token: "t1" }), "alice-oc");
  assert.equal(await look({ userId: "alice", token: "t1" }), "alice-oc");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /mcp_user_keys\?select=oc&user_id=eq\.alice/);
  assert.equal(calls[0].auth, "Bearer t1");
  assert.equal(await look({ userId: "bob", token: "t2" }), undefined); // 없음도 캐시
  assert.equal(await look({ userId: "bob", token: "t2" }), undefined);
  assert.equal(calls.length, 2);
  mode = "down";
  assert.equal(await look({ userId: "carol", token: "t3" }), undefined);
  mode = "bad";
  assert.equal(await look({ userId: "dave", token: "t4" }), undefined);
});

test("로그인 방식이 아니면 저장된 키를 조회하지 않음", async () => {
  let called = 0;
  const f = (async () => (called++, Response.json([]))) as unknown as typeof fetch;
  const look = openSavedKeys(loadSettings({ LAWGO_OC: "k", SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "a" }), f);
  assert.equal(await look({ userId: "a", token: "t" }), undefined);
  assert.equal(called, 0);
});

test("비회원: 본인 OC가 있으면 로그인 없이 그 키로만, 없으면 401", async () => {
  const s = await start(OAUTH, { verifier: loggedIn, savedKey: async () => "must-not-use" });
  assert.equal((await s.call("/mcp", "가")).status, 401);
  assert.equal(s.seen.length, 0);
  const viaUrl = await s.call("/mcp?oc=guest", "나");
  assert.equal(viaUrl.status, 200);
  const viaHeader = await s.call("/mcp", "다", { "x-lawgo-oc": "guest2" });
  assert.equal(viaHeader.status, 200);
  assert.deepEqual(s.seen, ["guest", "guest2"]); // 공용 키 미사용
  assert.equal((await s.call("/mcp?oc=bad%20key", "라")).status, 400);
  s.close();
});

test("비회원: 잘못된 토큰은 OC가 있어도 401, ALLOW_QUERY_OC=0이면 쿼리로 우회 불가", async () => {
  const reject: TokenVerifier = async () => {
    throw new Error("no");
  };
  const s = await start(OAUTH, { verifier: reject });
  assert.equal((await s.call("/mcp?oc=guest", "가", { authorization: "Bearer bad" })).status, 401);
  s.close();
  const off = await start({ ...OAUTH, ALLOW_QUERY_OC: "0" }, { verifier: loggedIn });
  assert.equal((await off.call("/mcp?oc=guest", "가")).status, 401);
  off.close();
});

test("비회원: IP별 호출 제한 적용", async () => {
  const s = await start({ ...OAUTH, RATE_LIMIT_PER_MIN: "2" }, { verifier: loggedIn });
  assert.equal((await s.call("/mcp?oc=guest", "가")).status, 200);
  assert.equal((await s.call("/mcp?oc=guest", "나")).status, 200);
  assert.equal((await s.call("/mcp?oc=other", "다")).status, 429);
  s.close();
});

test("비회원: 로그인 전용 도구는 사용자 데이터 없이 막힘", async () => {
  const cfg = loadSettings({ ...OAUTH, SUPABASE_ANON_KEY: "anon" });
  const server: Server = createServer(createMcpHandler(cfg, openDesks(cfg, undefined, true), loggedIn));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`${base}/mcp?oc=guest`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return res.text();
  };
  assert.match(await tool("office_profile", {}), /PROFILE_UNAVAILABLE/);
  assert.match(await tool("join_class", { code: "ABC123" }), /로그인 정보가 없습니다/);
  server.close();
});
