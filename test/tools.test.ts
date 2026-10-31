// 법제처 응답을 흉내 낸 가짜 fetch로 MCP 도구를 끝까지 호출해 본다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadSettings } from "../src/config.ts";
import { LawgoClient, type Fetcher } from "../src/lawgo/client.ts";
import { buildServer } from "../src/server.ts";
import { openDesks } from "../src/tools/context.ts";

const LAW_LIST = {
  LawSearch: {
    totalCnt: "2",
    law: [
      { 법령일련번호: "900001", 법령명한글: "법인세법", 법령ID: "001563", 법령구분명: "법률", 시행일자: "20250101", 공포일자: "20241231", 소관부처명: "기획재정부", 현행연혁코드: "현행" },
      { 법령일련번호: "900002", 법령명한글: "법인세법 시행령", 법령ID: "002000", 법령구분명: "대통령령", 시행일자: "20250221", 공포일자: "20250221", 소관부처명: "기획재정부", 현행연혁코드: "현행" },
    ],
  },
};

const ARTICLE_52 = {
  법령: {
    기본정보: { 법령명_한글: "법인세법", 시행일자: "20250101" },
    조문: {
      조문단위: [
        { 조문번호: "52", 조문여부: "전문", 조문내용: "제2절 부당행위계산" },
        {
          조문번호: "52",
          조문여부: "조문",
          조문제목: "부당행위계산의 부인",
          조문내용: "제52조(부당행위계산의 부인)",
          조문시행일자: "20250101",
          항: [
            { 항번호: "①", 항내용: "① 납세지 관할 세무서장 또는 관할지방국세청장은 ... 계산할 수 있다." },
            { 항번호: "②", 항내용: "② 제1항을 적용할 때에는 ... 시가를 기준으로 한다." },
          ],
        },
        { 조문번호: "53", 조문여부: "조문", 조문제목: "", 조문내용: "제53조 삭제 <2018.12.24>" },
        {
          조문번호: "60",
          조문여부: "조문",
          조문제목: "과세표준 등의 신고",
          조문내용: "제60조(과세표준 등의 신고)",
          항: { 항번호: "①", 항내용: "① 납세의무가 있는 내국법인은 ...", 호: [{ 호번호: "1.", 호내용: "1. 재무상태표" }] },
        },
      ],
    },
    부칙: {
      부칙단위: [
        { 부칙공포일자: "20221231", 부칙공포번호: "19193", 부칙내용: [["부칙 <제19193호, 2022. 12. 31.>"], ["제2조(법인세율에 관한 적용례) 제55조제1항의 개정규정은 이 법 시행 이후 개시하는 사업연도분부터 적용한다."]] },
        { 부칙공포일자: "20241231", 부칙공포번호: "20613", 부칙내용: "제1조(시행일) 이 법은 2025년 1월 1일부터 시행한다." },
      ],
    },
  },
};

const PREC_LIST = {
  PrecSearch: { totalCnt: "1", prec: { 판례일련번호: "228541", 사건명: "법인세부과처분취소", 사건번호: "2019두12345", 선고일자: "20210311", 법원명: "대법원" } },
};

const PREC_BODY = {
  PrecService: { 사건명: "법인세부과처분취소", 사건번호: "2019두12345", 선고일자: "20210311", 판시사항: "[1] 부당행위계산 부인의 요건", 판결요지: "경제적 합리성이 없는 거래 ...", 참조조문: "법인세법 제52조" },
};

function fakeFetch(log: string[]): Fetcher {
  return async (url) => {
    const u = new URL(url);
    const target = u.searchParams.get("target");
    const endpoint = u.pathname.split("/").pop();
    log.push(`${endpoint}:${target}:${u.searchParams.get("JO") ?? ""}`);
    let body: unknown = { result: "no data" };
    if (endpoint === "lawSearch.do" && (target === "law" || target === "eflaw")) {
      body = target === "eflaw" && u.searchParams.get("nw") === "2" ? { LawSearch: { totalCnt: "0" } } : LAW_LIST;
    } else if (endpoint === "lawService.do" && target === "law") body = ARTICLE_52;
    else if (endpoint === "lawSearch.do" && target === "prec") body = PREC_LIST;
    else if (endpoint === "lawService.do" && target === "prec") body = PREC_BODY;
    else if (endpoint === "lawSearch.do") body = { Search: { totalCnt: "0" } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

async function connect(oc = "tester", env: Record<string, string> = {}) {
  const cfg = { ...loadSettings(env), oc };
  const log: string[] = [];
  const desks = openDesks(cfg, new LawgoClient(cfg, fakeFetch(log)));
  const server = buildServer(desks);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const t = (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
    return { text: t, isError: Boolean(r.isError) };
  };
  return { client, call, log, instructions: client.getInstructions() ?? "" };
}

test("도구 목록과 프롬프트 노출", async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "build_issue_brief",
    "check_references",
    "compare_revision",
    "deemed_interest",
    "entertainment_limit",
    "estimate_penalty",
    "estimate_tax",
    "explain_term",
    "find_admin_rule",
    "find_form",
    "find_rulings",
    "find_statute",
    "find_treaty",
    "read_provision",
    "read_ruling",
    "read_transition_rules",
    "tax_deadline",
    "trace_amendments",
    "trace_delegation",
  ]);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  assert.ok(prompts.includes("refund_claim_review"));
});

test("find_statute: 줄임말 확장", async () => {
  const { call } = await connect();
  const r = await call("find_statute", { query: "법법" });
  assert.match(r.text, /'법법' → '법인세법'/);
  assert.match(r.text, /법인세법 시행령/);
});

test("read_provision: 조문·항 조회와 JO 파라미터", async () => {
  const { call, log } = await connect();
  const r = await call("read_provision", { law: "법인세법", article: "52", paragraph: 2 });
  assert.equal(r.isError, false);
  assert.match(r.text, /제52조\(부당행위계산의 부인\)/);
  assert.match(r.text, /② 제1항을 적용할 때/);
  assert.doesNotMatch(r.text, /① 납세지/);
  assert.ok(log.includes("lawService.do:law:005200"));
});

test("read_provision: 없는 조문은 NO_MATCH", async () => {
  const { call } = await connect();
  const r = await call("read_provision", { law: "법인세법", article: "999" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^\[NO_MATCH\]/);
});

test("check_references: 존재·삭제·항 범위 판정", async () => {
  const { call } = await connect();
  const r = await call("check_references", {
    draft: "법인세법 제52조제2항에 따라 부인하고, 같은 법 제53조 및 제52조제5항, 제60조제1항제1호를 참고한다.",
  });
  assert.match(r.text, /총 4건/);
  assert.match(r.text, /제52조 제2항 \| ✅ 확인/);
  assert.match(r.text, /제53조 \| ⚠ 삭제된 조문/);
  assert.match(r.text, /제52조 제5항 \| ⚠ 항 없음/);
  assert.match(r.text, /제60조 제1항 제1호 \| ✅ 확인/);
});

test("find_rulings → read_ruling", async () => {
  const { call } = await connect();
  const list = await call("find_rulings", { query: "부당행위계산", sources: ["court", "tribunal"] });
  assert.match(list.text, /2019두12345/);
  assert.match(list.text, /source=court, id=228541/);
  assert.match(list.text, /조세심판원 심판례: 결과 없음/);
  const doc = await call("read_ruling", { source: "court", id: "228541", sectionsOnly: ["판결요지"] });
  assert.match(doc.text, /【판결요지】/);
  assert.doesNotMatch(doc.text, /【판시사항】/);
});

test("OC 미설정 시 KEY_MISSING, 계산 도구는 동작", async () => {
  const { call } = await connect("");
  const r = await call("find_statute", { query: "법인세법" });
  assert.equal(r.isError, true);
  assert.match(r.text, /KEY_MISSING/);
  const t = await call("estimate_tax", { taxType: "corporate", taxBase: 500_000_000, fiscalStart: "2025-01-01" });
  assert.match(t.text, /75,000,000원/);
  const dl = await call("tax_deadline", { kind: "corporate", periodEnd: "2021-12-31", today: "2026-10-31" });
  assert.match(dl.text, /경정청구 기한: 2027-03-31 \(D-151\)/);
});

test("출처 표기: 도구 응답·서버 지침·프롬프트", async () => {
  const { call, instructions, client } = await connect();
  const ok = await call("estimate_tax", { taxType: "personal", taxBase: 10_000_000, year: 2024 });
  assert.match(ok.text, /Powered by TAX2\.AI 세무 법령 MCP/);
  const bad = await call("estimate_tax", { taxType: "personal", taxBase: 1, year: 2010 });
  assert.equal(bad.isError, true);
  assert.doesNotMatch(bad.text, /Powered by/);
  assert.match(instructions, /이 답변은 TAX2\.AI 세무 법령 MCP\(https:\/\/tax2\.ai\)를 활용하여 AI가 작성했습니다/);
  const p = await client.getPrompt({ name: "opinion_citation_audit", arguments: { draft: "초안" } });
  assert.match(JSON.stringify(p.messages), /TAX2\.AI 세무 법령 MCP/);
});

test("출처 표기 끄기 (BRAND_ATTRIBUTION=0)", async () => {
  const { call, instructions } = await connect("tester", { BRAND_ATTRIBUTION: "0" });
  const r = await call("tax_deadline", { kind: "vat", periodEnd: "2025-06-30" });
  assert.doesNotMatch(r.text, /Powered by/);
  assert.doesNotMatch(instructions, /AI가 작성했습니다/);
});

test("read_transition_rules: 최근 순 정렬과 keyword 필터", async () => {
  const { call } = await connect();
  const all = await call("read_transition_rules", { law: "법인세법" });
  assert.ok(all.text.indexOf("2024-12-31") < all.text.indexOf("2022-12-31"));
  const hit = await call("read_transition_rules", { law: "법법", keyword: "제55조" });
  assert.match(hit.text, /법인세율에 관한 적용례/);
  assert.doesNotMatch(hit.text, /2025년 1월 1일부터 시행/);
  const none = await call("read_transition_rules", { law: "법인세법", keyword: "제999조" });
  assert.match(none.text, /^\[NO_MATCH\]/);
});
