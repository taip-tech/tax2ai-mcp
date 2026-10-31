import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "../src/config.ts";
import { LawgoClient, LawgoFault, type Fetcher } from "../src/lawgo/client.ts";
import { locateRows, plain } from "../src/lawgo/shape.ts";
import { TtlStore } from "../src/lawgo/ttlStore.ts";
import { paged } from "../src/tools/reply.ts";

const cfg = { ...loadSettings({}), oc: "tester", timeoutMs: 500 };

test("단건 응답(객체)도 목록으로 정규화", () => {
  const rows = locateRows({ X: { totalCnt: "1", prec: { 판례일련번호: "1" } } }, ["prec"]);
  assert.equal(rows.length, 1);
  const guessed = locateRows({ X: { totalCnt: "1", unknown: [{ 무슨일련번호: "7" }] } }, ["prec"]);
  assert.equal(guessed.length, 1);
});

test("HTML 태그·엔티티 정리", () => {
  assert.equal(plain("가<br/>나 &amp; <b>다</b>"), "가\n나 & 다");
});

test("캐시: 같은 URL은 한 번만 호출", async () => {
  let hits = 0;
  const f: Fetcher = async () => {
    hits++;
    return { ok: true, status: 200, text: async () => '{"LawSearch":{"totalCnt":"0"}}' };
  };
  const api = new LawgoClient(cfg, f);
  await api.search("law", { query: "법인세법" });
  await api.search("law", { query: "법인세법" });
  assert.equal(hits, 1);
});

test("5xx는 재시도 후 성공, 4xx는 즉시 실패", async () => {
  let n = 0;
  const flaky: Fetcher = async () => {
    n++;
    return n < 2 ? { ok: false, status: 503, text: async () => "" } : { ok: true, status: 200, text: async () => "{}" };
  };
  await new LawgoClient(cfg, flaky).search("law", { query: "a" });
  assert.equal(n, 2);

  let m = 0;
  const notFound: Fetcher = async () => {
    m++;
    return { ok: false, status: 404, text: async () => "" };
  };
  await assert.rejects(new LawgoClient(cfg, notFound).search("law", { query: "b" }), LawgoFault);
  assert.equal(m, 1);
});

test("OC 검증 실패 문구는 KEY_REJECTED", async () => {
  const f: Fetcher = async () => ({ ok: true, status: 200, text: async () => "<html>사용자 정보 검증에 실패하였습니다.</html>" });
  await assert.rejects(new LawgoClient(cfg, f).search("law", { query: "c" }), (e: unknown) => e instanceof LawgoFault && e.code === "KEY_REJECTED");
});

test("TTL 만료와 용량 제한", () => {
  let now = 0;
  const s = new TtlStore<number>(2, () => now);
  s.put("a", 1, 10);
  s.put("b", 2, 10);
  s.put("c", 3, 10);
  assert.equal(s.get("a"), undefined);
  now = 11_000;
  assert.equal(s.get("b"), undefined);
});

test("긴 응답은 cursor로 이어받기", () => {
  const body = Array.from({ length: 50 }, (_, i) => `줄 ${i}`).join("\n");
  const first = paged(body, undefined, 100);
  const t = (first.content[0] as { text: string }).text;
  const m = /cursor=(\d+)/.exec(t);
  assert.ok(m);
  const second = (paged(body, Number(m[1]), 10_000).content[0] as { text: string }).text;
  assert.match(second, /줄 49/);
});
