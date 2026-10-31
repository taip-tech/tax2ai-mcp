// 사무소 프로필: 문서(자료요청문·채용공고)에 자동으로 들어가는 사무소 정보.
// - 원격(로그인): Supabase REST + 사용자 토큰 → RLS로 본인 행만 읽고 쓴다
// - 로컬(stdio): 파일 하나에 저장
// 고객 정보는 받지도 저장하지도 않는다.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Settings } from "../config.js";
import { currentUser } from "./caller.js";

export type Tone = "formal" | "friendly";

export interface OfficeProfile {
  officeName?: string;
  representative?: string;
  phone?: string;
  email?: string;
  address?: string;
  website?: string;
  /** 고객 자료 받는 방법 (예: "이메일 회신 또는 카카오톡 채널 'OO세무회계'") */
  submitChannel?: string;
  /** 자료 마감일 = 신고기한 n일 전 (기본 10) */
  leadDays?: number;
  tone?: Tone;
  /** 메일·문서 끝에 붙일 맺음 문구 */
  closingNote?: string;
}

export const PROFILE_FIELDS: Record<keyof OfficeProfile, string> = {
  officeName: "사무소명",
  representative: "대표세무사",
  phone: "전화",
  email: "이메일",
  address: "주소",
  website: "홈페이지",
  submitChannel: "자료 제출 방법",
  leadDays: "자료 마감(신고기한 n일 전)",
  tone: "말투(formal=격식체, friendly=친근체)",
  closingNote: "맺음 문구",
};

export class ProfileUnavailable extends Error {}

export interface ProfileStore {
  /** 저장 위치 설명 (사용자 안내용) */
  readonly where: string;
  load(): Promise<OfficeProfile | undefined>;
  save(p: OfficeProfile): Promise<void>;
}

const TABLE = "mcp_office_profiles";

class RemoteProfileStore implements ProfileStore {
  readonly where = "TAX2.AI 계정 (본인만 조회 가능)";
  constructor(
    private readonly baseUrl: string,
    private readonly anonKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private headers(token: string): Record<string, string> {
    return { apikey: this.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  private user() {
    const u = currentUser();
    if (!u) throw new ProfileUnavailable("로그인 정보가 없어 사무소 프로필을 사용할 수 없습니다.");
    return u;
  }

  async load(): Promise<OfficeProfile | undefined> {
    const u = this.user();
    const r = await this.fetcher(`${this.baseUrl}/rest/v1/${TABLE}?select=profile&user_id=eq.${encodeURIComponent(u.userId)}`, {
      headers: this.headers(u.token),
    });
    if (!r.ok) throw new ProfileUnavailable(`프로필 저장소 응답 ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const rows = (await r.json()) as { profile?: OfficeProfile }[];
    return rows[0]?.profile ?? undefined;
  }

  async save(p: OfficeProfile): Promise<void> {
    const u = this.user();
    const r = await this.fetcher(`${this.baseUrl}/rest/v1/${TABLE}?on_conflict=user_id`, {
      method: "POST",
      headers: { ...this.headers(u.token), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: u.userId, profile: p, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new ProfileUnavailable(`프로필 저장 실패 ${r.status}: ${(await r.text()).slice(0, 160)}`);
  }
}

class FileProfileStore implements ProfileStore {
  constructor(private readonly path: string) {}
  get where() {
    return `이 컴퓨터의 ${this.path}`;
  }

  async load(): Promise<OfficeProfile | undefined> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as OfficeProfile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async save(p: OfficeProfile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(p, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

/** 공개(비로그인) 원격 모드처럼 저장할 곳이 없을 때 */
class NoProfileStore implements ProfileStore {
  readonly where = "저장 안 함";
  async load() {
    return undefined;
  }
  async save(): Promise<void> {
    throw new ProfileUnavailable("이 연결 방식에서는 사무소 프로필을 저장할 수 없습니다. 로그인 방식으로 연결하거나 로컬 설치를 사용하세요.");
  }
}

/**
 * 실행 방식에 맞는 저장소 선택.
 * remote=true(HTTP)면 로그인 + Supabase 설정이 있을 때만 원격 저장, 아니면 저장 안 함.
 */
export function openProfileStore(cfg: Settings, remote: boolean, fetcher?: typeof fetch): ProfileStore {
  if (!remote) return new FileProfileStore(cfg.profileFile);
  if (cfg.authMode === "oauth" && cfg.supabaseUrl && cfg.supabaseAnonKey) {
    return new RemoteProfileStore(cfg.supabaseUrl, cfg.supabaseAnonKey, fetcher);
  }
  return new NoProfileStore();
}

/** 입력값 정리: 빈 문자열은 삭제, 길이 제한 */
export function mergeProfile(base: OfficeProfile | undefined, patch: OfficeProfile): OfficeProfile {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in PROFILE_FIELDS) || v === undefined) continue;
    if (v === "" || v === null) delete out[k];
    else out[k] = typeof v === "string" ? v.trim().slice(0, 300) : v;
  }
  return out as OfficeProfile;
}

export function describeProfile(p: OfficeProfile | undefined): string {
  if (!p || !Object.keys(p).length) return "(등록된 정보 없음)";
  return (Object.keys(PROFILE_FIELDS) as (keyof OfficeProfile)[])
    .filter((k) => p[k] !== undefined && p[k] !== "")
    .map((k) => `- ${PROFILE_FIELDS[k]}: ${p[k]}`)
    .join("\n");
}
