// 강의 도구: 교시 이름 해석, 교재 읽기, 반 참여·제출이 사용자 토큰으로 RLS 경로를 타는지

import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessEnded, Classroom, NotInClass, normalizeLessonKey } from "../src/learn/classroom.ts";
import { runAsUser } from "../src/office/caller.ts";

const UID = "11111111-1111-4111-8111-111111111111";
const CLS = "22222222-2222-4222-8222-222222222222";

test("교시 이름 해석", () => {
  assert.equal(normalizeLessonKey("1일차 1교시"), "day1-session1");
  assert.equal(normalizeLessonKey("2일차 8교시"), "day2-session8");
  assert.equal(normalizeLessonKey("day1-session3"), "day1-session3");
  assert.equal(normalizeLessonKey("1-2"), "day1-session2");
  assert.equal(normalizeLessonKey("보충"), "bonus-harness");
  assert.throws(() => normalizeLessonKey("오늘 수업"), RangeError);
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function fakeFetch(member: boolean, opts: { blocked?: boolean; until?: string | null; joinError?: string } = {}) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: typeof init.body === "string" ? init.body : undefined });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/api/lessons/") && url.includes("lesson=")) {
      return json({ slug: "seoul2_261104", key: "day1-session1", label: "1일차 1교시", title: "AI 기본", url: "https://www.tax2.ai/x", aiLessonId: "seoul2-day1-session1", open: true, sections: [{ id: "a", title: "섹션", text: "본문" }] });
    }
    if (url.includes("/rest/v1/learn_members")) return json(member ? [{ class_id: CLS, name: "홍길동", org: "OO세무", blocked: opts.blocked ?? false }] : []);
    if (url.includes("/rest/v1/learn_classes")) return json([{ name: "서울2기", access_until: opts.until ?? null }]);
    if (url.includes("/rest/v1/rpc/learn_join") && opts.joinError) return new Response(JSON.stringify({ message: opts.joinError }), { status: 400 });
    if (url.includes("/rest/v1/rpc/learn_join")) return json([{ class_id: CLS, class_name: "서울2기" }]);
    if (url.includes("/storage/v1/object/")) return json({ Key: "ok" });
    if (url.includes("/rest/v1/learn_submissions")) return new Response(null, { status: 201 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

test("반 미참여면 제출하지 않고 NotInClass", async () => {
  const f = fakeFetch(false);
  const room = new Classroom("https://tax2.ai", "https://db.example", "anon", f.fn);
  const lesson = await room.readLesson("day1-session1");
  await assert.rejects(runAsUser({ userId: UID, token: "tok" }, () => room.submit({ lesson, reflection: "배웠다" })), NotInClass);
  assert.ok(!f.calls.some((c) => c.url.includes("learn_submissions")));
});

test("제출: 사용자 토큰으로 파일 업로드 후 제출물 저장", async () => {
  const f = fakeFetch(true);
  const room = new Classroom("https://tax2.ai", "https://db.example", "anon", f.fn);
  const lesson = await room.readLesson("day1-session1");
  const r = await runAsUser({ userId: UID, token: "tok" }, () =>
    room.submit({ lesson, reflection: "배웠다", summary: "요약", questions: ["질문1"], files: [{ name: "도구.html", content: "<p>hi</p>" }] }),
  );
  assert.equal(r.membership.className, "서울2기");
  const up = f.calls.find((c) => c.url.includes("/storage/v1/object/learn-captures/"))!;
  assert.ok(up.url.includes(`${CLS}/${UID}/${r.id}-1.html`));
  assert.equal(up.headers.Authorization, "Bearer tok");
  const ins = f.calls.find((c) => c.url.endsWith("/rest/v1/learn_submissions"))!;
  const row = JSON.parse(ins.body!);
  assert.equal(row.lesson_id, "seoul2-day1-session1");
  assert.equal(row.user_id, UID);
  assert.equal(row.class_id, CLS);
  assert.equal(row.captures[0].kind, "file");
  assert.deepEqual(row.conversation, [{ role: "user", text: "질문1" }]);
  assert.match(r.id, /^[A-Za-z0-9_-]{6,40}$/);
  assert.equal(room.attachUrl(r.id), `https://tax2.ai/learn/attach/${r.id}`);
});

test("허용되지 않은 파일 형식은 거절", async () => {
  const f = fakeFetch(true);
  const room = new Classroom("https://tax2.ai", "https://db.example", "anon", f.fn);
  const lesson = await room.readLesson("day1-session1");
  await assert.rejects(runAsUser({ userId: UID, token: "tok" }, () => room.submit({ lesson, reflection: "x", files: [{ name: "a.exe", content: "x" }] })), RangeError);
});

test("로그인 없이 반 기능을 쓰면 안내", async () => {
  const f = fakeFetch(true);
  const room = new Classroom("https://tax2.ai", "https://db.example", "anon", f.fn);
  await assert.rejects(room.membership(), /로그인/);
});

test("수강 기간이 끝난 반: 제출 거절, 교재 읽기도 막힘", async () => {
  const f = fakeFetch(true, { until: "2020-01-01T00:00:00Z" });
  const room = new Classroom("https://tax2.ai", "https://db.example", "anon", f.fn);
  const lesson = await room.readLesson("day1-session1");
  await assert.rejects(runAsUser({ userId: UID, token: "tok" }, () => room.submit({ lesson, reflection: "x" })), AccessEnded);
  assert.ok(!f.calls.some((c) => c.url.endsWith("/rest/v1/learn_submissions")));
  assert.match((await runAsUser({ userId: UID, token: "tok" }, () => room.accessEnded())) ?? "", /수강 기간/);
});

test("차단된 학생은 막히고, 기간 안·로그인 안 함은 그대로", async () => {
  const blocked = new Classroom("https://tax2.ai", "https://db.example", "anon", fakeFetch(true, { blocked: true }).fn);
  assert.match((await runAsUser({ userId: UID, token: "tok" }, () => blocked.accessEnded())) ?? "", /막아/);
  const open = new Classroom("https://tax2.ai", "https://db.example", "anon", fakeFetch(true, { until: "2999-01-01T00:00:00Z" }).fn);
  assert.equal(await runAsUser({ userId: UID, token: "tok" }, () => open.accessEnded()), null);
  assert.equal(await open.accessEnded(), null);
});

test("수강 끝난 반 참여 코드는 AccessEnded", async () => {
  const room = new Classroom("https://tax2.ai", "https://db.example", "anon", fakeFetch(false, { joinError: "수강 기간이 끝난 반이에요" }).fn);
  await assert.rejects(runAsUser({ userId: UID, token: "tok" }, () => room.join("ABC123", "홍길동", "")), AccessEnded);
});
