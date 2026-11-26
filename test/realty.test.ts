import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadSettings } from "../src/config.ts";
import { FxDesk } from "../src/fx/smbs.ts";
import { LawgoClient } from "../src/lawgo/client.ts";
import { parseJibun, RealtyDesk, sggAliases, sidoAliases, type RealtyFetcher } from "../src/realty/realtyprice.ts";
import { buildServer } from "../src/server.ts";
import { openDesks } from "../src/tools/context.ts";
import { splitUnit } from "../src/tools/realtyTools.ts";

const json = (list: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ view: null, model: { list, ...extra } });

// 실제 응답에서 줄인 형태
const SIDO = [
  { sido: "11", reg: "11000", eub: "00000", name: "서울특별시", code: "11" },
  { sido: "12", reg: "12000", eub: "00000", name: "전남광주통합특별시", code: "12" },
  { sido: "41", reg: "41000", eub: "00000", name: "경기도", code: "41" },
];
const SGG: Record<string, unknown[]> = {
  "11": [{ name: "강남구", code: "11680" }, { name: "중구", code: "11140" }],
  "12": [{ name: "서구", code: "12140" }],
  "41": [{ name: "고양덕양구", code: "41281" }, { name: "가평군", code: "41820" }],
};
const EUB: Record<string, unknown[]> = {
  "11680": [{ name: "역삼동", code: "10100" }, { name: "논현동", code: "10800" }],
  "41820": [{ name: "가평읍 ", code: "25000" }, { name: "가평읍 대곡리", code: "25022" }],
  "41281": [{ name: "행신동", code: "12300" }],
  "12140": [{ name: "치평동", code: "11700" }],
  "11140": [{ name: "을지로", code: "10100" }],
};
const GSI = [
  { notice_ymd: "20260430", base_year: "2026", base_md: "01월01일", jibun: "737번지", addr: "서울특별시 강남구 역삼동 737", gakuka_w: "71,160,000", etc_cntn: " " },
  { notice_ymd: "20250430", base_year: "2025", base_md: "01월01일", jibun: "737번지", addr: "서울특별시 강남구 역삼동 737", gakuka_w: "67,300,000", etc_cntn: " " },
];
const HPI = [
  { base_ymd: "2026/01/01", hprice_w: "2,124,000,000", addr: "서울특별시 강남구 논현동 4-9", tbook_area: "261.4", calc_larea: "172.3", bldg_garea: "770.82", res_area: "520.85", dong_gbn: "99999" },
];
const APT = [
  { code: 20022859, name: "(757) 역삼래미안", notice_date: "20260626" },
  { code: 20055187, name: "(757) 다른단지", notice_date: "20260626" },
];
const DONG = [{ code: 1, name: "101", notice_date: "20260626" }, { code: 2, name: "102", notice_date: "20260626" }];
// 호 이름 '102'와 다른 호의 내부 코드 102가 겹치는 실제 사례
const HO = [{ code: 2, name: "102", notice_date: "20260626" }, { code: 102, name: "2004", notice_date: "20260626" }];
const TOWN = [
  { apt_name: "역삼래미안", dong_name: "101", ho_name: "102", notice_date: "20260626", notice_date_name: "2026.1.1", full_addr_name: "서울특별시 강남구 선릉로69길 19(강남구 역삼동   757)", full_road_name: "서울특별시 강남구 선릉로69길 19", priv_area: "59.4", notice_amt: "   1,638,000,000" },
  { apt_name: "역삼래미안", dong_name: "101", ho_name: "102", notice_date: "20250626", notice_date_name: "2025.1.1", full_addr_name: "", full_road_name: "", priv_area: "59.4", notice_amt: "   1,215,000,000" },
];

function fakeFetch(log: string[] = [], over: Record<string, string> = {}): RealtyFetcher {
  return async (url) => {
    const u = new URL(url);
    const q = u.searchParams;
    log.push(`${u.pathname}?${q.toString()}`);
    const path = u.pathname.replace("/notice", "");
    let body = over[path];
    if (!body) {
      if (path === "/bjd/searchBjdApi.bjd") {
        const g = q.get("gubun");
        body = json(g === "" ? SIDO : g === "sgg" ? SGG[q.get("sido")!] ?? null : EUB[q.get("sgg")!] ?? null);
      } else if (path === "/search/gsiSearchListApi.search") body = json(q.get("bun1") === "0737" ? GSI : null, { totalCnt: 2 });
      else if (path === "/search/hpiSearchListApi.search") body = json(q.get("bun2") === "0009" ? HPI : null);
      else if (path === "/search/searchApt.search") {
        const g = q.get("gbnApt");
        body = json(g === "DONG" ? DONG : g === "HO" ? HO : APT);
      } else if (path === "/search/townPriceListPastYearMap.search") body = json(TOWN);
      else body = "<html>에러</html>";
    }
    return { ok: true, status: 200, text: async () => body };
  };
}

async function connect(fetcher: RealtyFetcher) {
  const cfg = { ...loadSettings({}), oc: "tester" };
  const desks = openDesks(cfg, new LawgoClient(cfg), false, new FxDesk(), new RealtyDesk(fetcher, () => new Date("2026-11-26T03:00:00Z")));
  const server = buildServer(desks);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "public_price", arguments: args });
    return { text: (r.content as Array<{ text: string }>).map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  };
}

test("주소 표기 변형: 시도 줄임말·시 없는 구·지번·단지 동호", () => {
  assert.ok(sidoAliases("서울특별시").includes("서울"));
  assert.ok(sidoAliases("경상남도").includes("경남"));
  assert.ok(sidoAliases("전남광주통합특별시").includes("광주"));
  assert.ok(sidoAliases("강원특별자치도").includes("강원"));
  assert.ok(sggAliases("고양덕양구").includes("고양시덕양구"));
  assert.deepEqual(parseJibun("산 12-3번지 뒤"), { san: true, bun1: 12, bun2: 3, rest: "뒤" });
  assert.deepEqual(parseJibun("757"), { san: false, bun1: 757, bun2: undefined, rest: "" });
  assert.deepEqual(splitUnit("역삼래미안아파트 101동 1502호"), { complex: "역삼래미안", dong: "101", ho: "1502" });
  assert.deepEqual(splitUnit("101동 102호"), { dong: "101", ho: "102" });
  assert.deepEqual(splitUnit("한빛 가동 3호"), { complex: "한빛", dong: "가", ho: "3" });
});

test("주소 해석: 시도 생략·읍 아래 리·광주 통합특별시", async () => {
  const desk = new RealtyDesk(fakeFetch());
  const a = await desk.resolveAddress("강남구 역삼동 737");
  assert.equal(a.sgg.code, "11680");
  assert.equal(a.eub.code, "10100");
  assert.equal(a.bun1, 737);
  const b = await desk.resolveAddress("경기 가평군 가평읍 대곡리 산 12-3");
  assert.equal(b.eub.code, "25022");
  assert.deepEqual([b.san, b.bun1, b.bun2], [true, 12, 3]);
  const c = await desk.resolveAddress("경기도 고양시 덕양구 행신동 1");
  assert.equal(c.sgg.code, "41281");
  const d = await desk.resolveAddress("광주 서구 치평동 1200");
  assert.equal(d.sgg.code, "12140");
  await assert.rejects(desk.resolveAddress("서울 강남구 없는동 1"), /읍면동/);
});

test("public_price land: 면적 주면 토지 기준시가, 지번은 4자리로 채워 보냄", async () => {
  const log: string[] = [];
  const call = await connect(fakeFetch(log));
  const r = await call({ kind: "land", address: "서울 강남구 역삼동 737", area: 100, year: 2025 });
  assert.equal(r.isError, false);
  assert.match(r.text, /\*\*2025년\(기준일 2025\.01\.01\) 67,300,000원\/㎡\*\* · 공시일 2025\.04\.30/);
  assert.match(r.text, /= \*\*6,730,000,000원\*\*/);
  assert.match(r.text, /\| 2026 \| 2026\.01\.01 \| 71,160,000 \| 7,116,000,000 \| 2026\.04\.30 \|/);
  assert.match(r.text, /원문 출처: 부동산 공시가격 알리미/);
  assert.ok(log.some((l) => l.includes("gsiSearchListApi") && l.includes("bun1=0737") && l.includes("san=1")));
});

test("public_price house: 연도별 개별주택가격, 없으면 NOT_FOUND 안내", async () => {
  const call = await connect(fakeFetch());
  const r = await call({ kind: "house", address: "서울 강남구 논현동 4-9" });
  assert.match(r.text, /\*\*2026\.01\.01 기준 2,124,000,000원\*\*/);
  const none = await call({ kind: "house", address: "서울 강남구 논현동 1" });
  assert.match(none.text, /\[NOT_FOUND\].*kind=apartment/);
});

test("public_price apartment: 단지 여러 개면 NEEDS_INPUT, 호 이름이 다른 호 코드와 겹쳐도 이름 우선", async () => {
  const call = await connect(fakeFetch());
  const many = await call({ kind: "apartment", address: "서울 강남구 역삼동 757" });
  assert.match(many.text, /\[NEEDS_INPUT\] .*단지가 2개/);
  assert.match(many.text, /- \(757\) 다른단지/);

  const noHo = await call({ kind: "apartment", address: "서울 강남구 역삼동 757 역삼래미안 101동" });
  assert.match(noHo.text, /\[NEEDS_INPUT\] .*101동의 호를 골라/);

  const r = await call({ kind: "apartment", address: "서울 강남구 역삼동 757 역삼래미안 101동 102호" });
  assert.equal(r.isError, false);
  assert.match(r.text, /역삼래미안 101동 102호 \(전용 59\.4㎡\)/);
  assert.match(r.text, /\*\*2026\.1\.1 기준 1,638,000,000원\*\* · 공시일 2026\.06\.26/);
  assert.match(r.text, /소재지: 서울특별시 강남구 선릉로69길 19\(강남구 역삼동 757\)/);
});

test("public_price apartment: 사이트 열람 제한·오류 화면은 오류로 전달", async () => {
  const limited = await connect(fakeFetch([], { "/search/townPriceListPastYearMap.search": json(null, { message: "보안문자를 입력하세요.", error_gbn: "ERROR_STOP" }) }));
  const r = await limited({ kind: "apartment", address: "서울 강남구 역삼동 757", complex: "역삼래미안", dong: "101", ho: "102" });
  assert.equal(r.isError, true);
  assert.match(r.text, /\[UPSTREAM\] 보안문자를 입력하세요\. \(사이트가 보안문자 입력을 요구합니다\)/);

  const broken = await connect(fakeFetch([], { "/search/gsiSearchListApi.search": "<html>에러</html>" }));
  const b = await broken({ kind: "land", address: "서울 강남구 역삼동 737" });
  assert.equal(b.isError, true);
  assert.match(b.text, /\[UPSTREAM\] .*오류 화면/);
});
