// 행정규칙(기본통칙·고시·훈령·예규), 별표·서식, 법령용어, 위임 연결, 신구조문

import { LawgoClient, LawgoFault } from "./client.js";
import { field, isObj, locateRows, plain, unwrapRoot, ymd, type Json, type JsonObj } from "./shape.js";
import type { ResolvedStatute } from "./statutes.js";

export interface AdminRuleRow {
  id: string;
  name: string;
  type: string;
  ministry: string;
  issued: string;
  effective: string;
}

export interface AnnexRow {
  name: string;
  lawName: string;
  annexType: string;
  annexNo: string;
  fileLink: string;
  pdfLink: string;
}

export interface TreatyRow {
  id: string;
  name: string;
  treatyNo: string;
  kind: string;
  effective: string;
  signed: string;
}

export class GuidanceDesk {
  constructor(private readonly api: LawgoClient) {}

  async findAdminRules(query: string, opts: { limit?: number; page?: number; inBody?: boolean } = {}) {
    const payload = await this.api.search("admrul", {
      query,
      search: opts.inBody ? 2 : 1,
      display: Math.min(opts.limit ?? 10, 100),
      page: opts.page ?? 1,
    });
    return locateRows(payload, ["admrul", "AdmRul"]).map<AdminRuleRow>((r) => ({
      id: field(r, "행정규칙일련번호", "id"),
      name: field(r, "행정규칙명"),
      type: field(r, "행정규칙종류"),
      ministry: field(r, "소관부처명"),
      issued: ymd(field(r, "발령일자")),
      effective: ymd(field(r, "시행일자")),
    }));
  }

  async readAdminRule(id: string): Promise<{ name: string; meta: string; body: string }> {
    const root = unwrapRoot(await this.api.detail("admrul", { ID: id }));
    const meta = isObj(root["행정규칙기본정보"]) ? (root["행정규칙기본정보"] as JsonObj) : root;
    const name = field(meta, "행정규칙명");
    const body = plain(field(root, "조문내용"));
    if (!name && !body) throw new LawgoFault("NO_MATCH", `행정규칙 ${id} 본문을 찾지 못했습니다.`);
    const info = [
      field(meta, "행정규칙종류"),
      field(meta, "소관부처명"),
      field(meta, "발령번호") && `발령번호 ${field(meta, "발령번호")}`,
      field(meta, "발령일자") && `발령 ${ymd(field(meta, "발령일자"))}`,
      field(meta, "시행일자") && `시행 ${ymd(field(meta, "시행일자"))}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const annex = plain(field(root, "별표내용"));
    return { name, meta: info, body: annex ? `${body}\n\n[별표]\n${annex}` : body };
  }

  async findAnnexes(query: string, opts: { limit?: number; byLawName?: boolean } = {}): Promise<AnnexRow[]> {
    const payload = await this.api.search("licbyl", {
      query,
      search: opts.byLawName ? 2 : 1,
      display: Math.min(opts.limit ?? 15, 100),
    });
    return locateRows(payload, ["licbyl"]).map((r) => ({
      name: field(r, "별표명", "별표서식명"),
      lawName: field(r, "관련법령명", "법령명"),
      annexType: field(r, "별표종류"),
      annexNo: field(r, "별표번호"),
      fileLink: absolutize(field(r, "별표서식파일링크")),
      pdfLink: absolutize(field(r, "별표서식PDF파일링크")),
    }));
  }

  async explainTerm(term: string): Promise<Array<{ term: string; definition: string; source: string }>> {
    const listing = await this.api.search("lstrm", { query: term, display: 10 });
    const rows = locateRows(listing, ["lstrm"]);
    const picked = rows.filter((r) => field(r, "법령용어명") === term).concat(rows).slice(0, 3);
    const out: Array<{ term: string; definition: string; source: string }> = [];
    const seen = new Set<string>();
    for (const r of picked) {
      const name = field(r, "법령용어명");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const detail = unwrapRoot(await this.api.detail("lstrm", { query: name }));
      out.push({
        term: name,
        definition: plain(field(detail, "법령용어정의", "법령용어 정의")) || plain(field(r, "법령용어정의")),
        source: field(detail, "출처", "법령명") || field(r, "출처"),
      });
    }
    return out;
  }

  /** 조약 (조세조약은 '이중과세', '소득에 대한 조세' 등으로 검색) */
  async findTreaties(query: string, limit = 10): Promise<TreatyRow[]> {
    const payload = await this.api.search("trty", { query, display: Math.min(limit, 100) });
    return locateRows(payload, ["Trty", "trty"]).map((r) => ({
      id: field(r, "조약일련번호", "id"),
      name: plain(field(r, "조약명", "조약명한글")),
      treatyNo: field(r, "조약번호"),
      kind: field(r, "조약구분명", "조약구분"),
      effective: ymd(field(r, "발효일자")),
      signed: ymd(field(r, "서명일자")),
    }));
  }

  async readTreaty(id: string): Promise<JsonObj> {
    const root = unwrapRoot(await this.api.detail("trty", { ID: id }));
    if (!Object.keys(root).length) throw new LawgoFault("NO_MATCH", `조약 ${id} 본문을 찾지 못했습니다.`);
    return root;
  }

  /** 법률-시행령-시행규칙 연결 (knd=1 인용조문, knd=2 위임조문) */
  async delegationOutline(law: ResolvedStatute, mode: "delegated" | "cited"): Promise<JsonObj> {
    const payload = await this.api.detail("thdCmp", {
      MST: law.mst || undefined,
      ID: law.mst ? undefined : law.lawId,
      knd: mode === "cited" ? 1 : 2,
    });
    return unwrapRoot(payload);
  }

  async revisionComparison(law: ResolvedStatute): Promise<JsonObj> {
    const payload = await this.api.detail("oldAndNew", { MST: law.mst || undefined, ID: law.mst ? undefined : law.lawId });
    return unwrapRoot(payload);
  }
}

function absolutize(link: string): string {
  if (!link) return "";
  return link.startsWith("http") ? link : `https://www.law.go.kr${link.startsWith("/") ? "" : "/"}${link}`;
}

/**
 * 구조를 모르는 응답을 들여쓰기 개요로 펼친다.
 * keep이 주어지면 해당 문자열을 포함한 블록만 남긴다(조문 단위 필터용).
 */
export function outline(node: Json, keep?: (block: string) => boolean, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") {
    const t = plain(String(node));
    return t ? `${pad}${t}` : "";
  }
  if (Array.isArray(node)) {
    return node
      .map((n) => outline(n, undefined, depth))
      .filter((b) => b && (!keep || keep(b)))
      .join("\n");
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (v === "" || v === null) continue;
    if (typeof v !== "object") {
      const t = plain(String(v));
      if (t) parts.push(`${pad}${k}: ${t}`);
    } else {
      const inner = outline(v as Json, keep, depth + 1);
      if (inner) parts.push(`${pad}[${k}]\n${inner}`);
    }
  }
  return parts.join("\n");
}
