// 강의 교재 읽기 + 반 참여·결과 제출.
// - 교재: tax2.ai 공개 API(/api/lessons/<slug>) — 교재 화면과 같은 공개 규칙(닫힌 교시는 본문 없음)
// - 반·제출: Supabase REST/Storage + 로그인 사용자 토큰 → RLS로 본인 것만 쓴다(AI 학습실 반 모드와 같은 테이블)
// 수강생 대화 원문은 받지 않는다. 수강생이 제출하겠다고 할 때 AI가 정리한 내용만 저장한다.

import { randomBytes } from "node:crypto";
import { currentUser } from "../office/caller.js";

export const DEFAULT_SLUG = "seoul2_261104";
const BUCKET = "learn-captures";

export class ClassroomUnavailable extends Error {}

export interface LessonListItem { key: string; label: string; title: string; open: boolean; url: string }
export interface LessonDoc {
  slug: string; key: string; label: string; title: string; url: string; aiLessonId: string; open: boolean;
  course?: string | null; day?: number; session?: number;
  sections: { id: string; title: string; text: string }[];
}
export interface Membership { classId: string; className: string; name: string; org: string }
export interface ResultFile { name: string; content: string }

/** "1일차 1교시", "day1-session1", "1-1", "보충" → 교시 키 */
export function normalizeLessonKey(input: string): string {
  const s = input.trim().toLowerCase();
  if (/^[a-z0-9-]{1,40}$/.test(s) && !/^\d+-\d+$/.test(s)) return s;
  const m = /(\d)\s*(?:일차|일|-|\.|day)\D*(\d)\s*(?:교시)?/.exec(s) ?? /day\s*(\d)\D+session\s*(\d)/.exec(s);
  if (m) return `day${m[1]}-session${m[2]}`;
  if (/보충|하네스|harness/.test(s)) return "bonus-harness";
  throw new RangeError(`교시를 알아보지 못했습니다: "${input}". 예: "1일차 1교시" 또는 "day1-session1"`);
}

const MIME: Record<string, string> = { html: "text/html", htm: "text/html", md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json" };
export const RESULT_EXTS = Object.keys(MIME);
const MAX_FILE_BYTES = 1_000_000;

export class Classroom {
  constructor(
    private readonly siteUrl: string,
    private readonly supabaseUrl: string,
    private readonly anonKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get canWrite(): boolean {
    return Boolean(this.supabaseUrl && this.anonKey);
  }

  async listLessons(slug = DEFAULT_SLUG): Promise<LessonListItem[]> {
    const r = await this.fetcher(`${this.siteUrl}/api/lessons/${encodeURIComponent(slug)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new ClassroomUnavailable(`교재 목록을 불러오지 못했습니다 (${r.status}).`);
    return ((await r.json()) as { lessons: LessonListItem[] }).lessons;
  }

  async readLesson(key: string, slug = DEFAULT_SLUG): Promise<LessonDoc> {
    const r = await this.fetcher(`${this.siteUrl}/api/lessons/${encodeURIComponent(slug)}?lesson=${encodeURIComponent(key)}`, { headers: { Accept: "application/json" } });
    if (r.status === 404) throw new RangeError(`없는 교시입니다: ${key}. read_lesson을 교시 없이 호출하면 목록을 볼 수 있습니다.`);
    if (!r.ok) throw new ClassroomUnavailable(`교재를 불러오지 못했습니다 (${r.status}).`);
    return (await r.json()) as LessonDoc;
  }

  // ── 로그인 사용자 전용 ──
  private user() {
    const u = currentUser();
    if (!u) throw new ClassroomUnavailable("로그인 정보가 없습니다. TAX2.AI 커넥터를 로그인(OAuth) 방식으로 연결해 주세요.");
    if (!this.canWrite) throw new ClassroomUnavailable("이 서버에는 반 저장소 설정이 없습니다.");
    return u;
  }

  private headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.anonKey, Authorization: `Bearer ${token}`, ...extra };
  }

  private async rest<T>(path: string, init: RequestInit & { token: string }): Promise<T> {
    const { token, headers, ...rest } = init;
    const r = await this.fetcher(`${this.supabaseUrl}${path}`, { ...rest, headers: { ...this.headers(token, { "Content-Type": "application/json" }), ...(headers as Record<string, string> | undefined) } });
    const body = await r.text();
    if (!r.ok) {
      let msg = body.slice(0, 200);
      try { msg = (JSON.parse(body) as { message?: string }).message ?? msg; } catch { /* 원문 사용 */ }
      throw new ClassroomUnavailable(`저장소 응답 ${r.status}: ${msg}`);
    }
    return (body ? JSON.parse(body) : null) as T;
  }

  async membership(): Promise<Membership | null> {
    const u = this.user();
    const rows = await this.rest<{ class_id: string; name: string; org: string | null }[]>(
      `/rest/v1/learn_members?select=class_id,name,org&user_id=eq.${encodeURIComponent(u.userId)}&order=joined_at.desc&limit=1`,
      { token: u.token },
    );
    const m = rows[0];
    if (!m) return null;
    const cls = await this.rest<{ name: string }[]>(`/rest/v1/learn_classes?select=name&id=eq.${m.class_id}`, { token: u.token }).catch(() => []);
    return { classId: m.class_id, className: cls[0]?.name ?? "(이름 없음)", name: m.name, org: m.org ?? "" };
  }

  async join(code: string, name: string, org: string): Promise<Membership> {
    const u = this.user();
    const rows = await this.rest<{ class_id: string; class_name: string }[]>(`/rest/v1/rpc/learn_join`, {
      method: "POST",
      token: u.token,
      body: JSON.stringify({ p_code: code.trim().toUpperCase(), p_name: name, p_org: org }),
    });
    const row = rows?.[0];
    if (!row) throw new ClassroomUnavailable("반에 들어가지 못했습니다. 참여 코드를 확인해 주세요.");
    return { classId: row.class_id, className: row.class_name, name, org };
  }

  async submit(input: {
    lesson: LessonDoc; reflection: string; summary?: string; questions?: string[]; files?: ResultFile[];
  }): Promise<{ id: string; membership: Membership; files: string[] }> {
    const u = this.user();
    const m = await this.membership();
    if (!m) throw new NotInClass();
    const id = `mcp-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const captures: Record<string, unknown>[] = [];
    for (const [i, f] of (input.files ?? []).entries()) {
      const ext = (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? "txt").toLowerCase();
      const mediaType = MIME[ext];
      if (!mediaType) throw new RangeError(`올릴 수 없는 파일 형식입니다: ${f.name} (가능: ${RESULT_EXTS.join(", ")})`);
      const bytes = Buffer.from(f.content, "utf8");
      if (bytes.length > MAX_FILE_BYTES) throw new RangeError(`${f.name}이(가) 1MB를 넘습니다.`);
      const path = `${m.classId}/${u.userId}/${id}-${i + 1}.${ext}`;
      const r = await this.fetcher(`${this.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: this.headers(u.token, { "Content-Type": `${mediaType}; charset=utf-8`, "x-upsert": "true" }),
        body: bytes,
      });
      if (!r.ok) throw new ClassroomUnavailable(`${f.name} 업로드 실패 (${r.status}): ${(await r.text()).slice(0, 160)}`);
      captures.push({ path, kind: "file", name: f.name, mediaType, size: bytes.length, label: "claude.ai·ChatGPT에서 제출" });
    }
    const questions = (input.questions ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 50);
    await this.rest(`/rest/v1/learn_submissions`, {
      method: "POST",
      token: u.token,
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        id,
        class_id: m.classId,
        user_id: u.userId,
        session_id: null,
        lesson_id: input.lesson.aiLessonId,
        lesson_title: input.lesson.title,
        learner: { name: m.name, org: m.org },
        reflection: input.reflection,
        worksheet_text: input.summary ? `■ AI 대화 요약 (수강생의 AI 계정에서 정리)\n\n${input.summary}` : null,
        conversation: questions.map((text) => ({ role: "user", text })),
        captures,
        stats: { questions: questions.length, captures: 0, files: captures.length, via: "mcp" },
      }),
    });
    return { id, membership: m, files: captures.map((c) => String(c.name)) };
  }
}

export class NotInClass extends Error {
  constructor() {
    super("아직 반에 참여하지 않았습니다.");
  }
}
