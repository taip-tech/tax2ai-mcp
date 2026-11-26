import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadSettings } from "../src/config.ts";
import { FxDesk, normalizeCurrency, normalizeDate, parseSmbs, type FxFetcher } from "../src/fx/smbs.ts";
import { LawgoClient } from "../src/lawgo/client.ts";
import { buildServer } from "../src/server.ts";
import { openDesks } from "../src/tools/context.ts";

// 실제 응답 형태 (diff 키 뒤 공백, && 연속 포함)
const FRI = "\r\n\r\n?test0=test&updown=0&USD=1,343.90&updown1=0&&diff1 =.3&JPY=844.37&updown2=0&&diff2 =.96&EUR=1,475.06&updown3=0&&diff3 =2.34&AUD=890.80&updown4=1&&diff4 =-.95&VND=5.20&updown5=1&&diff5 =-.01&MNT=0.37&updown6=3&&diff6 =0&loading=ok&";
const EMPTY = "?test0=test&updown=0&loading=ok&";

function fakeFetch(byDate: Record<string, string>, log: string[] = []): FxFetcher {
  return async (url) => {
    const d = new URL(url).searchParams.get("tr_date")!;
    log.push(d);
    return { ok: true, status: 200, text: async () => byDate[d] ?? EMPTY };
  };
}
const NOW = () => new Date("2026-11-26T03:00:00Z"); // KST 12시

test("응답 파싱: 쉼표·부호·100단위", () => {
  const m = parseSmbs(FRI);
  assert.equal(m.get("USD")!.rate, 1343.9);
  assert.equal(m.get("USD")!.change, 0.3);
  assert.equal(m.get("AUD")!.change, -0.95);
  assert.equal(m.get("JPY")!.unit, 100);
  assert.equal(m.get("VND")!.unit, 100);
  assert.equal(m.get("MNT")!.change, 0);
  assert.equal(parseSmbs(EMPTY).size, 0);
});

test("날짜·통화 표기 정규화", () => {
  assert.equal(normalizeDate("2026.11.20"), "2026-11-20");
  assert.equal(normalizeDate("2026년 1월 5일"), "2026-01-05");
  assert.equal(normalizeDate("20261120"), "2026-11-20");
  assert.equal(normalizeDate(46346), "2026-11-20");
  assert.equal(normalizeDate("2026-02-30"), null);
  assert.equal(normalizeCurrency("엔화"), "JPY");
  assert.equal(normalizeCurrency("usd"), "USD");
  assert.equal(normalizeCurrency("CNY"), "CNH");
  assert.equal(normalizeCurrency("JPY(100)"), "JPY");
  assert.equal(normalizeCurrency("XYZ"), null);
});

test("주말은 직전 고시일, 캐시로 중복 조회 없음, 미래 날짜 거부", async () => {
  const log: string[] = [];
  const fx = new FxDesk(fakeFetch({ "2026-11-20": FRI }, log), NOW);
  const sun = await fx.resolve("2026-11-22");
  assert.equal(sun.used, "2026-11-20");
  await fx.resolve("2026-11-21");
  assert.deepEqual(log, ["2026-11-22", "2026-11-21", "2026-11-20"]);
  assert.equal((await fx.resolve("2026-11-22", false)).used, "");
  await assert.rejects(fx.resolve("2026-11-27"), /아직 오지 않은/);
});

async function connect(byDate: Record<string, string>) {
  const cfg = { ...loadSettings({}), oc: "tester" };
  const desks = openDesks(cfg, new LawgoClient(cfg), false, new FxDesk(fakeFetch(byDate), NOW));
  const server = buildServer(desks);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "exchange_rate", arguments: args });
    return { text: (r.content as Array<{ text: string }>).map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  };
}

test("exchange_rate: 엑셀 행 환산 (100단위·휴일 대체·오류 행)", async () => {
  const call = await connect({ "2026-11-20": FRI });
  const r = await call({
    rows: [
      { date: "2026-11-20", currency: "USD", amount: 1000.5, ref: "A2" },
      { date: 46347, currency: "엔화", amount: 150000, ref: "A3" },
      { date: "2026/11/20", currency: "XYZ", amount: 1, ref: "A4" },
    ],
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /\| A2 \| 2026-11-20 \| 2026-11-20 \| USD \| 1,000.50 \| 1,343.90 \| 1,344,571 \|/);
  assert.match(r.text, /\| A3 \| 2026-11-21 \| 2026-11-20\* \| JPY\(100\) \| 150,000.00 \| 844.37 \/100 \| 1,266,555 \|/);
  assert.match(r.text, /A4: 통화 'XYZ'/);
  assert.match(r.text, /합계: \*\*2,611,126원\*\*/);
  assert.match(r.text, /원문 출처: 서울외국환중개\(smbs\.biz\)/);
  assert.doesNotMatch(r.text, /법제처/);
});

test("exchange_rate: 날짜 1개는 전 통화, 입력 없으면 BAD_INPUT", async () => {
  const call = await connect({ "2026-11-20": FRI });
  const r = await call({ dates: ["2026-11-20"] });
  assert.match(r.text, /\| USD \| 미국 달러 \| 1,343.90 \| ▲0.30 \|/);
  assert.match(r.text, /\| AUD \| 호주 달러 \| 890.80 \| ▼0.95 \|/);
  assert.match((await call({})).text, /BAD_INPUT/);
});
