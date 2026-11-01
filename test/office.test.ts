// 사무소 업무 도구: 자료요청 기한·목록, 채용공고 점검, 프로필 저장소, 객관식 되묻기

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadSettings } from "../src/config.ts";
import { buildChecklist, requestDeadline, requestSchedule } from "../src/domain/docRequests.ts";
import { checkMinimumWage, scanPosting } from "../src/domain/hiring.ts";
import { runAsUser } from "../src/office/caller.ts";
import { mergeProfile, openProfileStore } from "../src/office/profile.ts";
import { buildServer } from "../src/server.ts";

test("자료요청: 세목별 신고기한과 휴일을 피한 자료 마감일", () => {
  const vat = requestSchedule("vat_final", { year: 2026, half: 2 }, { vatType: "general" });
  assert.ok(!("missing" in vat));
  assert.equal(vat.filingDue, "2027-01-25");
  assert.equal(requestDeadline(vat.filingDue, 10), "2027-01-15");
  // 2026-03-10은 화요일 → 마감 n일 전이 일요일이면 앞당김
  assert.equal(requestDeadline("2026-03-10", 2), "2026-03-06");

  const wh = requestSchedule("withholding", { year: 2026, month: 12 });
  assert.ok(!("missing" in wh) && wh.filingDue === "2027-01-11"); // 1/10 일요일 → 1/11
  const cg = requestSchedule("capital_gains", { eventDate: "2026-09-15" });
  assert.ok(!("missing" in cg) && cg.filingDue === "2026-11-30");
  assert.deepEqual(requestSchedule("vat_final", { year: 2026 }, { vatType: "general" }), { missing: ["half"] });
  const simple = requestSchedule("vat_final", { year: 2026 }, { vatType: "simplified" });
  assert.ok(!("missing" in simple) && simple.filingDue === "2027-01-25");
});

test("자료요청: 고객 유형에 따라 항목이 달라진다", () => {
  const general = buildChecklist("vat_final", "individual", "general").flatMap((s) => s.items);
  const simplified = buildChecklist("vat_final", "individual", "simplified").flatMap((s) => s.items);
  assert.ok(general.some((i) => i.includes("수출")));
  assert.ok(!simplified.some((i) => i.includes("수출")));
  const corp = buildChecklist("vat_final", "corporation", "general");
  assert.ok(corp.find((s) => s.title.includes("매입"))!.items.some((i) => i.includes("법인카드")));
});

test("채용공고 점검: 차별 표현은 잡고 허용 표현은 넘어간다", () => {
  const ids = (t: string) => scanPosting(t).map((f) => f.rule.id);
  assert.deepEqual(ids("만 35세 이하, 여성 우대, 키 160 이상, 미혼"), ["age", "gender", "body_marital"]);
  assert.deepEqual(ids("성별 무관, 나이 무관, 연령 제한 없음, 사진 첨부 불필요"), []);
  assert.deepEqual(ids("출신 지역과 부모님 직업 기재, 사진 부착 필수"), ["personal_info", "photo"]);
  assert.deepEqual(ids("수습 3개월 무급"), ["unpaid_probation"]);
  assert.deepEqual(ids("전산세무 2급 이상 우대, 경력 3년 이상"), []);
});

test("최저임금: 시급·월급·연봉 환산", () => {
  assert.equal(checkMinimumWage("hourly", 10_320, 2026).ok, true);
  assert.equal(checkMinimumWage("hourly", 10_000, 2026).ok, false);
  assert.equal(checkMinimumWage("monthly", 2_156_880, 2026).ok, true);
  assert.equal(checkMinimumWage("annual", 24_000_000, 2026).ok, false);
  assert.equal(checkMinimumWage("monthly", 3_000_000, 2031).ok, null);
});

test("프로필: 빈 문자열은 항목 삭제, 모르는 키는 무시", () => {
  const p = mergeProfile({ officeName: "가", phone: "1" }, { phone: "", email: " a@b.c ", junk: "x" } as never);
  assert.deepEqual(p, { officeName: "가", email: "a@b.c" });
});

test("프로필 원격 저장소: 사용자 토큰과 공개 키로 본인 행만 읽고 쓴다", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "POST") return new Response(null, { status: 201 });
    return Response.json([{ profile: { officeName: "한빛세무회계" } }]);
  }) as typeof fetch;
  const cfg = loadSettings({ AUTH_MODE: "oauth", OAUTH_ISSUER: "https://ref.supabase.co/auth/v1", SUPABASE_ANON_KEY: "anon" });
  const store = openProfileStore(cfg, true, fake);
  await assert.rejects(store.load(), /로그인/);
  const loaded = await runAsUser({ userId: "u-1", token: "tok" }, () => store.load());
  assert.equal(loaded?.officeName, "한빛세무회계");
  await runAsUser({ userId: "u-1", token: "tok" }, () => store.save({ officeName: "새이름" }));
  assert.match(calls[0].url, /^https:\/\/ref\.supabase\.co\/rest\/v1\/mcp_office_profiles\?select=profile&user_id=eq\.u-1$/);
  const h = calls[0].init!.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer tok");
  assert.equal(h.apikey, "anon");
  assert.equal(JSON.parse(String(calls[1].init!.body)).user_id, "u-1");
  // 로그인 없는 공개 원격 모드는 저장하지 않는다
  await assert.rejects(openProfileStore(loadSettings({}), true).save({}), /저장할 수 없습니다/);
});

test("도구: 정보가 없으면 객관식 질문, 프로필이 있으면 문안에 반영", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tax2ai-office-"));
  const server = buildServer(loadSettings({ PROFILE_FILE: join(dir, "p.json") }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })).content as { text: string }[]).map((c) => c.text).join("\n");

  const ask = await call("draft_document_request", { kind: "corporate" });
  assert.match(ask, /\[NEEDS_INPUT\]/);
  assert.match(ask, /인자 `channel`/);
  assert.doesNotMatch(ask, /clientType/); // 법인세는 법인으로 정해짐

  await call("office_profile", { action: "save", officeName: "한빛세무회계", phone: "02-1", leadDays: 7 });
  const draft = await call("draft_document_request", { kind: "corporate", year: 2026, channel: "kakao", formats: ["pdf"] });
  assert.match(draft, /\[한빛세무회계\] 2026 사업연도/);
  assert.match(draft, /자료 마감 2027-03-24 \(신고기한 7일 전\)/);
  assert.match(draft, /\[문안 시작\][\s\S]*\[문안 끝\]/);

  const job = await call("draft_job_posting", { role: "junior_staff" });
  assert.match(job, /\[NEEDS_INPUT\]/);
  const posting = await call("draft_job_posting", { role: "junior_staff", employmentType: "permanent", payNegotiable: true, style: "short" });
  assert.match(posting, /\[한빛세무회계\] 신입 직원 채용/);
  assert.match(posting, /문제 표현이 발견되지 않았습니다/);
});

test("사무소 구성: 허용되지 않은 선택값은 버리고, 고객층·규모가 도구 결과에 반영된다", async () => {
  const p = mergeProfile({}, { officeSize: "huge", clientSegments: ["restaurant", "nope", "restaurant"], myRole: "owner" } as never);
  assert.deepEqual(p, { clientSegments: ["restaurant"], myRole: "owner" });

  const dir = await mkdtemp(join(tmpdir(), "tax2ai-office-"));
  const server = buildServer(loadSettings({ PROFILE_FILE: join(dir, "p.json") }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })).content as { text: string }[]).map((c) => c.text).join("\n");

  await call("office_profile", { action: "save", officeSize: "large", clientSegments: ["restaurant", "rental"] });
  const view = await call("office_profile", {});
  assert.match(view, /사무소 규모: 30명 이상/);
  assert.match(view, /주요 고객층: 음식점, 부동산임대/);
  assert.match(view, /mypage\/office/);

  const ask = await call("draft_document_request", { kind: "vat_final", clientType: "individual", vatType: "general", year: 2026, half: 1, channel: "kakao", formats: ["pdf"] });
  assert.match(ask, /인자 `industry`[\s\S]*음식점[\s\S]*부동산임대[\s\S]*general/);
  const draft = await call("draft_document_request", { kind: "vat_final", clientType: "individual", vatType: "general", year: 2026, half: 1, channel: "kakao", formats: ["pdf"], industry: "restaurant" });
  assert.match(draft, /음식점 업종 추가 자료[\s\S]*의제매입/);

  const check = await call("check_job_posting", { posting: "이력서에 사진 부착 필수" });
  assert.match(check, /30명 이상이므로 적용 대상/);
});
