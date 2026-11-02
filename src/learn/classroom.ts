// 강의 교재 읽기 + 반 참여·결과 제출.
// - 교재: tax2.ai 공개 API(/api/lessons/<slug>) — 교재 화면과 같은 공개 규칙(닫힌 교시는 본문 없음)
// - 반·제출: Supabase REST/Storage + 로그인 사용자 토큰 → RLS로 본인 것만 쓴다(AI 학습실 반 모드와 같은 테이블)
// 수강생이 제출하겠다고 할 때만 저장한다. 대화 원문(transcript)은 수강생 AI 앱이 옮겨 적은 것이라 실제 원문과 다를 수 있다.

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
/** ended: 수강 기간이 끝났거나 강사가 차단한 경우 그 사유, 아니면 null */
export interface Membership { classId: string; className: string; name: string; org: string; ended: string | null }
export interface ResultFile { name: string; content: string }
export interface TranscriptTurn { role: "user" | "assistant"; text: string }
export const TRANSCRIPT_MAX_CHARS = 400_000;

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
    const rows = await this.rest<{ class_id: string; name: string; org: string | null; blocked?: boolean }[]>(
      `/rest/v1/learn_members?select=class_id,name,org,blocked&user_id=eq.${encodeURIComponent(u.userId)}&order=joined_at.desc&limit=1`,
      { token: u.token },
    );
    const m = rows[0];
    if (!m) return null;
    const cls = await this.rest<{ name: string; access_until?: string | null }[]>(`/rest/v1/learn_classes?select=name,access_until&id=eq.${m.class_id}`, { token: u.token }).catch(() => []);
    const until = cls[0]?.access_until;
    const ended = m.blocked
      ? "강사가 이 반의 학습 연결을 끊어 두었습니다."
      : until && Date.parse(until) <= Date.now()
        ? `이 반의 수강 기간이 ${new Date(until).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}에 끝났습니다.`
        : null;
    return { classId: m.class_id, className: cls[0]?.name ?? "(이름 없음)", name: m.name, org: m.org ?? "", ended };
  }

  /** 로그인한 수강생의 반 수강이 끝났거나 차단됐으면 그 사유. 로그인 안 함·반 미참여·저장소 없음이면 null(공개 교재는 그대로 읽힌다). */
  async accessEnded(): Promise<string | null> {
    if (!currentUser() || !this.canWrite) return null;
    // 반 정보를 못 읽으면 막지 않는다(공개 교재 읽기만 해당 — 제출·업로드는 DB 정책이 따로 막는다)
    return (await this.membership().catch(() => null))?.ended ?? null;
  }

  attachUrl(submissionId: string): string {
    return `${this.siteUrl}/learn/attach/${encodeURIComponent(submissionId)}`;
  }

  /** 이 교시에 낸 내 최근 제출물 (캡처 추가 링크용) */
  async latestSubmission(aiLessonId: string): Promise<{ id: string; submittedAt: string } | null> {
    const u = this.user();
    const rows = await this.rest<{ id: string; submitted_at: string }[]>(
      `/rest/v1/learn_submissions?select=id,submitted_at&user_id=eq.${encodeURIComponent(u.userId)}&lesson_id=eq.${encodeURIComponent(aiLessonId)}&order=submitted_at.desc&limit=1`,
      { token: u.token },
    );
    return rows[0] ? { id: rows[0].id, submittedAt: rows[0].submitted_at } : null;
  }

  async join(code: string, name: string, org: string): Promise<Membership> {
    const u = this.user();
    const rows = await this.rest<{ class_id: string; class_name: string }[]>(`/rest/v1/rpc/learn_join`, {
      method: "POST",
      token: u.token,
      body: JSON.stringify({ p_code: code.trim().toUpperCase(), p_name: name, p_org: org }),
    }).catch((err: unknown) => {
      if (err instanceof Error && err.message.includes("수강 기간")) throw new AccessEnded("이 반은 수강 기간이 끝나 새로 참여할 수 없습니다.");
      throw err;
    });
    const row = rows?.[0];
    if (!row) throw new ClassroomUnavailable("반에 들어가지 못했습니다. 참여 코드를 확인해 주세요.");
    return { classId: row.class_id, className: row.class_name, name, org, ended: null };
  }

  /** tax2.ai API 주소. tax2.ai → www.tax2.ai 리다이렉트를 거치면 Authorization 헤더가 떨어지므로 처음부터 www로 부른다. */
  private get api(): string {
    return this.siteUrl.replace(/^https:\/\/tax2\.ai\b/, "https://www.tax2.ai");
  }

  /** 결과 파일을 수강생 토큰으로 저장소에 올린다. 대화 기록처럼 보이는 파일은 거절(transcript로 보내야 대화창으로 보인다). */
  private async uploadFiles(files: ResultFile[], u: { userId: string; token: string }, classId: string, stem: string) {
    const out: { path: string; kind: "file"; name: string; mediaType: string; size: number; label: string }[] = [];
    for (const [i, f] of files.entries()) {
      const ext = (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? "txt").toLowerCase();
      const mediaType = MIME[ext];
      if (!mediaType) throw new RangeError(`올릴 수 없는 파일 형식입니다: ${f.name} (가능: ${RESULT_EXTS.join(", ")})`);
      if (TRANSCRIPT_FILE.test(f.name) && /^(md|txt|json)$/.test(ext)) throw new TranscriptAsFile(f.name);
      const bytes = Buffer.from(f.content, "utf8");
      if (bytes.length > MAX_FILE_BYTES) throw new RangeError(`${f.name}이(가) 1MB를 넘습니다.`);
      const path = `${classId}/${u.userId}/${stem}${i + 1}.${ext}`;
      const r = await this.fetcher(`${this.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: this.headers(u.token, { "Content-Type": `${mediaType}; charset=utf-8`, "x-upsert": "true" }),
        body: bytes,
      });
      if (!r.ok) throw new ClassroomUnavailable(`${f.name} 업로드 실패 (${r.status}): ${(await r.text()).slice(0, 160)}`);
      out.push({ path, kind: "file", name: f.name, mediaType, size: bytes.length, label: "claude.ai·ChatGPT에서 제출" });
    }
    return out;
  }

  /**
   * 제출. 같은 교시에 이미 낸 제출물이 있으면 그 제출물을 새 내용으로 갱신한다(newSubmission=true면 새로 추가).
   * 갱신은 tax2.ai PATCH /api/learn/submissions/<id> (수강생 토큰으로 본인 확인 후 서버가 쓴다 — 수강생에게 수정 RLS가 없음).
   */
  async submit(input: {
    lesson: LessonDoc; reflection: string; summary?: string; questions?: string[]; files?: ResultFile[]; transcript?: TranscriptTurn[]; newSubmission?: boolean;
  }): Promise<{ id: string; membership: Membership; files: string[]; turns: number; updated: boolean }> {
    const u = this.user();
    const m = await this.membership();
    if (!m) throw new NotInClass();
    if (m.ended) throw new AccessEnded(m.ended);
    const questions = (input.questions ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 50);
    const transcript = (input.transcript ?? []).map((t) => ({ role: t.role, text: t.text.trim() })).filter((t) => t.text);
    const total = transcript.reduce((n, t) => n + t.text.length, 0);
    if (total > TRANSCRIPT_MAX_CHARS) throw new RangeError(`대화 기록이 너무 깁니다(${total.toLocaleString()}자, 최대 ${TRANSCRIPT_MAX_CHARS.toLocaleString()}자). 앞부분을 summary로 줄이고 최근 대화만 transcript로 보내세요.`);
    for (const f of input.files ?? []) if (TRANSCRIPT_FILE.test(f.name) && /\.(md|txt|json)$/i.test(f.name)) throw new TranscriptAsFile(f.name);
    const worksheet = input.summary ? `■ AI 대화 요약 (수강생의 AI 계정에서 정리)\n\n${input.summary}` : undefined;

    const prev = input.newSubmission ? null : await this.latestSubmission(input.lesson.aiLessonId);
    if (prev) {
      const files = await this.uploadFiles(input.files ?? [], u, m.classId, `${prev.id}-u${Date.now().toString(36)}-`);
      const r = await this.fetcher(`${this.api}/api/learn/submissions/${encodeURIComponent(prev.id)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${u.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reflection: input.reflection, worksheet_text: worksheet, transcript: transcript.length ? transcript : undefined, questions, files }),
      });
      if (r.status === 403) throw new AccessEnded("수강 기간이 끝났거나 학습 연결이 끊겼습니다.");
      if (!r.ok) throw new ClassroomUnavailable(`제출물 갱신 실패 (${r.status}): ${(await r.text()).slice(0, 160)}`);
      return { id: prev.id, membership: m, files: files.map((f) => f.name), turns: transcript.length, updated: true };
    }

    const id = `mcp-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const captures = await this.uploadFiles(input.files ?? [], u, m.classId, `${id}-`);
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
        worksheet_text: worksheet ?? null,
        // 대화 기록이 있으면 대화(질문·답 모두), 없으면 핵심 질문만
        conversation: transcript.length ? transcript : questions.map((text) => ({ role: "user", text })),
        captures,
        stats: {
          questions: transcript.length ? transcript.filter((t) => t.role === "user").length : questions.length,
          captures: 0, files: captures.length, via: "mcp", transcript: transcript.length > 0,
        },
      }),
    });
    return { id, membership: m, files: captures.map((c) => c.name), turns: transcript.length, updated: false };
  }
}

/** 대화 기록을 파일(.md 등)로 만들어 보낸 경우 — transcript로 다시 보내게 한다 */
export const TRANSCRIPT_FILE = /대화|전문|원문|기록|transcript|conversation|chat|채팅/i;
export class TranscriptAsFile extends RangeError {
  constructor(name: string) {
    super(`"${name}"은(는) 대화 기록 파일로 보입니다. 대화 기록은 파일로 만들지 말고 transcript 항목에 메시지별(role·text)로 넣어 다시 호출하세요. 그래야 강사 화면에 대화 형태로 보입니다.`);
  }
}

export class AccessEnded extends Error {}

export class NotInClass extends Error {
  constructor() {
    super("아직 반에 참여하지 않았습니다.");
  }
}
