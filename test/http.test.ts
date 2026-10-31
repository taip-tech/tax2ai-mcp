// HTTP 처리기: 사용자 본인 OC 전달, 사용자 키 필수 모드, 공유 캐시

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadSettings } from "../src/config.ts";
import { LawgoClient, type Fetcher } from "../src/lawgo/client.ts";
import { createMcpHandler } from "../src/httpHandler.ts";
import { openDesks } from "../src/tools/context.ts";

const LIST = { LawSearch: { totalCnt: "1", law: [{ 법령일련번호: "1", 법령명한글: "법인세법", 법령구분명: "법률", 시행일자: "20250101" }] } };

async function start(env: Record<string, string>) {
  const cfg = loadSettings(env);
  const seen: string[] = [];
  const f: Fetcher = async (url) => {
    seen.push(new URL(url).searchParams.get("OC") ?? "");
    return { ok: true, status: 200, text: async () => JSON.stringify(LIST) };
  };
  const server: Server = createServer(createMcpHandler(cfg, openDesks(cfg, new LawgoClient(cfg, f))));
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
