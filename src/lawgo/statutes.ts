// 법령(법률·시행령·시행규칙) 조회: 법령명 확정 → 본문 수신 → 조문 단위로 정리

import { LawgoClient, LawgoFault } from "./client.js";
import { asList, field, flattenText, isObj, locateRows, plain, ymd, type Json, type JsonObj } from "./shape.js";
import { canonicalLawName, sameLawName } from "../domain/taxLawBook.js";
import { joCode } from "../domain/citation.js";

export interface StatuteRow {
  name: string;
  nickname: string;
  lawId: string;
  mst: string; // 법령일련번호
  kind: string; // 법률/대통령령/총리령·부령
  ministry: string;
  promulgated: string;
  effective: string;
  revision: string; // 제정/일부개정/타법개정…
  status: string; // 현행/연혁/시행예정
}

export interface ResolvedStatute extends StatuteRow {
  asOf?: string; // 시점 조회일 (YYYYMMDD)
}

export interface Clause {
  no: number;
  text: string;
  items: Array<{ no: number; text: string }>;
}

export interface Addendum {
  promulgated: string; // YYYYMMDD
  number: string;
  text: string;
}

export interface Provision {
  article: number;
  branch: number;
  title: string;
  text: string;
  clauses: Clause[];
  effective: string;
  repealed: boolean;
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚";

export function clauseNumber(label: string): number {
  const t = label.trim();
  const idx = CIRCLED.indexOf(t.charAt(0));
  if (idx >= 0) return idx + 1;
  const m = /(\d+)/.exec(t);
  return m ? Number(m[1]) : 0;
}

export function toStatuteRow(r: JsonObj): StatuteRow {
  return {
    name: field(r, "법령명한글", "법령명", "법령명_한글"),
    nickname: field(r, "법령약칭명"),
    lawId: field(r, "법령ID"),
    mst: field(r, "법령일련번호", "MST"),
    kind: field(r, "법령구분명"),
    ministry: field(r, "소관부처명"),
    promulgated: field(r, "공포일자"),
    effective: field(r, "시행일자"),
    revision: field(r, "제개정구분명"),
    status: field(r, "현행연혁코드"),
  };
}

export class StatuteDesk {
  constructor(private readonly api: LawgoClient) {}

  /** 법령명 검색 (search=1) 또는 본문 검색 (search=2) */
  async find(query: string, opts: { inBody?: boolean; limit?: number; page?: number } = {}) {
    const q = opts.inBody ? query : canonicalLawName(query);
    const payload = await this.api.search("law", {
      query: q,
      search: opts.inBody ? 2 : 1,
      display: Math.min(opts.limit ?? 20, 100),
      page: opts.page ?? 1,
    });
    return { query: q, rows: locateRows(payload, ["law"]).map(toStatuteRow), payload };
  }

  /** 시행일 기준 버전 목록 (최근 시행일 순) */
  /**
   * 시행일 기준 버전 목록 (최근 시행일 순).
   * DRF는 nw를 생략하거나 sort를 주면 현행만 돌려주므로 nw=1,2,3(연혁·시행예정·현행)을 명시한다.
   * 결과는 시행일 내림차순으로 오며, reachBack 날짜 이하 버전이 나올 때까지 최대 3쪽을 읽는다.
   */
  async versions(name: string, opts: { upcomingOnly?: boolean; reachBack?: string } = {}): Promise<StatuteRow[]> {
    const official = canonicalLawName(name);
    const out: StatuteRow[] = [];
    for (let page = 1; page <= 3; page++) {
      const payload = await this.api.search("eflaw", {
        query: official,
        display: 100,
        page,
        nw: opts.upcomingOnly ? 2 : "1,2,3",
      });
      const rows = locateRows(payload, ["law"]).map(toStatuteRow);
      out.push(...rows.filter((r) => sameLawName(r.name, official)));
      const reached = !opts.reachBack || out.some((r) => r.effective && r.effective <= opts.reachBack!);
      if (rows.length < 100 || reached || opts.upcomingOnly) break;
    }
    return out.sort((a, b) => b.effective.localeCompare(a.effective));
  }

  /** 법령명을 하나의 법령(현행 또는 지정 시점 버전)으로 확정 */
  async resolve(name: string, asOf?: string): Promise<ResolvedStatute> {
    const official = canonicalLawName(name);
    if (asOf) {
      const day = asOf.replace(/-/g, "");
      if (!/^\d{8}$/.test(day)) throw new LawgoFault("BAD_INPUT", "asOf는 YYYY-MM-DD 형식이어야 합니다.");
      const hit = (await this.versions(official, { reachBack: day })).find((v) => v.effective && v.effective <= day);
      if (!hit) throw new LawgoFault("NO_MATCH", `${official}의 ${ymd(day)} 시점 시행 버전을 찾지 못했습니다.`);
      return { ...hit, asOf: day };
    }
    const { rows } = await this.find(official, { limit: 50 });
    const exact = rows.find((r) => sameLawName(r.name, official) || (r.nickname && sameLawName(r.nickname, official)));
    if (exact) return exact;
    const hint = rows.slice(0, 5).map((r) => r.name).join(", ");
    throw new LawgoFault("NO_MATCH", `'${official}'와 정확히 일치하는 법령이 없습니다.${hint ? ` 유사 법령: ${hint}` : ""}`);
  }

  /** 법령 본문(JSON). article을 주면 JO로 해당 조만 요청 */
  async body(law: ResolvedStatute, article?: { article: number; branch: number }): Promise<JsonObj> {
    const jo = article ? joCode(article.article, article.branch) : undefined;
    const payload = law.asOf
      ? await this.api.detail("eflaw", { MST: law.mst, efYd: law.effective, JO: jo })
      : await this.api.detail("law", { MST: law.mst || undefined, ID: law.mst ? undefined : law.lawId, JO: jo });
    if (!isObj(payload)) throw new LawgoFault("BAD_PAYLOAD", "법령 본문 응답 형식이 올바르지 않습니다.");
    const root = (isObj(payload["법령"]) ? payload["법령"] : payload) as JsonObj;
    return root;
  }

  async addenda(law: ResolvedStatute): Promise<Addendum[]> {
    return extractAddenda(await this.body(law));
  }

  async provisions(law: ResolvedStatute, article?: { article: number; branch: number }): Promise<Provision[]> {
    const root = await this.body(law, article);
    const all = extractProvisions(root);
    if (!article) return all;
    return all.filter((p) => p.article === article.article && p.branch === article.branch);
  }
}

/** 부칙(시행일·적용례·경과조치) 목록, 최근 공포 순 */
export function extractAddenda(root: JsonObj): Addendum[] {
  const container = root["부칙"];
  const units = isObj(container) ? asList<Json>(container["부칙단위"]) : asList<Json>(container);
  return units
    .filter(isObj)
    .map((u) => ({
      promulgated: field(u, "부칙공포일자"),
      number: field(u, "부칙공포번호"),
      text: plain(flattenText(u["부칙내용"])),
    }))
    .filter((a) => a.text)
    .sort((a, b) => b.promulgated.localeCompare(a.promulgated));
}

export function extractProvisions(root: JsonObj): Provision[] {
  const container = root["조문"];
  const units = isObj(container) ? asList<Json>(container["조문단위"]) : asList<Json>(container);
  const out: Provision[] = [];
  for (const u of units) {
    if (!isObj(u)) continue;
    if (field(u, "조문여부") === "전문") continue; // 편·장·절 제목
    const article = Number(field(u, "조문번호"));
    if (!Number.isFinite(article) || article <= 0) continue;
    const branch = Number(field(u, "조문가지번호") || 0);
    const head = plain(field(u, "조문내용"));
    const clauses: Clause[] = [];
    const lines: string[] = [head];
    for (const c of asList<Json>(u["항"])) {
      if (!isObj(c)) continue;
      const ctext = plain(field(c, "항내용"));
      const clause: Clause = { no: clauseNumber(field(c, "항번호") || ctext), text: ctext, items: [] };
      if (ctext) lines.push(ctext);
      for (const it of asList<Json>(c["호"])) {
        if (!isObj(it)) continue;
        const itext = plain(field(it, "호내용"));
        clause.items.push({ no: clauseNumber(field(it, "호번호") || itext), text: itext });
        if (itext) lines.push("  " + itext);
        for (const sub of asList<Json>(it["목"])) {
          const stext = plain(isObj(sub) ? field(sub, "목내용") : String(sub ?? ""));
          if (stext) lines.push("    " + stext);
        }
      }
      clauses.push(clause);
    }
    out.push({
      article,
      branch,
      title: field(u, "조문제목"),
      text: lines.filter(Boolean).join("\n"),
      clauses,
      effective: field(u, "조문시행일자"),
      repealed: /^제\s*\d+\s*조(?:의\s*\d+)?\s*(?:\([^)]*\))?\s*삭제/.test(head),
    });
  }
  return out;
}

export function lawTitle(root: JsonObj): string {
  const meta = isObj(root["기본정보"]) ? root["기본정보"] : root;
  return field(meta, "법령명_한글", "법령명한글", "법령명");
}
