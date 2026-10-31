// 행정규칙(기본통칙·고시·훈령·예규), 별표·서식, 법령용어, 위임 연결, 신구조문

import { LawgoClient, LawgoFault } from "./client.js";
import { asList, field, flattenText, isObj, locateRows, plain, unwrapRoot, ymd, type Json, type JsonObj } from "./shape.js";
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
      sort: "ddes",
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

  async explainTerm(term: string, lawFilter?: string): Promise<{ term: string; related: string[]; definitions: Array<{ definition: string; source: string }> }> {
    const listing = await this.api.search("lstrm", { query: term, display: 100 });
    const names = locateRows(listing, ["lstrm"]).map((r) => field(r, "법령용어명")).filter(Boolean);
    if (!names.length) throw new LawgoFault("NO_MATCH", `'${term}' 법령용어를 찾지 못했습니다.`);
    // 정확히 같은 용어 → 없으면 가장 짧은(가장 일반적인) 용어
    const picked = names.find((n) => n === term) ?? [...names].sort((x, y) => x.length - y.length)[0];
    const detail = unwrapRoot(await this.api.detail("lstrm", { query: picked }));
    const defs = asList<Json>(detail["법령용어정의"]).map((x) => plain(flattenText(x)));
    const srcs = asList<Json>(detail["출처"]).map((x) => plain(flattenText(x)));
    let definitions = defs.map((definition, i) => ({ definition, source: srcs[i] ?? "" })).filter((x) => x.definition);
    if (lawFilter) {
      const k = lawFilter.replace(/\s/g, "");
      const narrowed = definitions.filter((x) => x.source.replace(/\s/g, "").includes(k));
      if (narrowed.length) definitions = narrowed;
    }
    const related = names.filter((n) => n !== picked).sort((x, y) => x.length - y.length).slice(0, 8);
    return { term: picked, related, definitions };
  }

  /**
   * 조세조약 찾기. 조약 검색은 국가명만으로는 군사·어업 협정 등이 섞이므로
   * '조세'로 조세조약 전체(약 150건)를 받아 국가명(별칭 포함)으로 거른다.
   */
  async findTreaties(query: string, limit = 10): Promise<{ rows: TreatyRow[]; taxOnly: boolean }> {
    const terms = countryTerms(query);
    if (terms.length) {
      const all: TreatyRow[] = [];
      for (let page = 1; page <= 2; page++) {
        const payload = await this.api.search("trty", { query: "조세", display: 100, page });
        const rows = locateRows(payload, ["Trty", "trty"]).map(toTreatyRow);
        all.push(...rows);
        if (rows.length < 100) break;
      }
      const hits = all
        .filter((r) => terms.some((t) => r.name.includes(t)))
        // 본 협약 → 개정의정서 → 기타(정정·교환각서) 순
        .sort((a, b) => treatyRank(a.name) - treatyRank(b.name) || b.effective.localeCompare(a.effective));
      if (hits.length) return { rows: hits.slice(0, limit), taxOnly: true };
    }
    const payload = await this.api.search("trty", { query, display: Math.min(limit, 100) });
    return { rows: locateRows(payload, ["Trty", "trty"]).map(toTreatyRow), taxOnly: false };
  }

  async readTreaty(id: string): Promise<JsonObj> {
    const root = unwrapRoot(await this.api.detail("trty", { ID: id }));
    if (!Object.keys(root).length) throw new LawgoFault("NO_MATCH", `조약 ${id} 본문을 찾지 못했습니다.`);
    return root;
  }

  /** 법률-시행령-시행규칙 연결 (knd=1 인용조문, knd=2 위임조문) */
  async delegationOutline(law: ResolvedStatute, mode: "delegated" | "cited"): Promise<JsonObj> {
    // 3단 비교는 법령ID로 요청해야 조문별 내용이 온다 (MST로는 기본정보만 옴)
    const payload = await this.api.detail("thdCmp", {
      ID: law.lawId || undefined,
      MST: law.lawId ? undefined : law.mst,
      knd: mode === "cited" ? 1 : 2,
    });
    return unwrapRoot(payload);
  }

  async revisionComparison(law: ResolvedStatute): Promise<JsonObj> {
    const payload = await this.api.detail("oldAndNew", { ID: law.lawId || undefined, MST: law.lawId ? undefined : law.mst });
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

// ───────── 3단 비교(위임·인용) 정리 ─────────

export interface ArticleKey {
  no: number;
  branch: number;
  title: string;
}

export interface DelegationEntry {
  article: number;
  branch: number;
  decree: ArticleKey[];
  rule: ArticleKey[];
}

function keyOf(o: JsonObj): ArticleKey | null {
  const no = Number(field(o, "조번호"));
  if (!no) return null;
  return { no, branch: Number(field(o, "조가지번호") || 0), title: plain(field(o, "조제목")) };
}

/** 3단 비교 응답 → 법률 조문별 시행령·시행규칙 연결 목록 */
export function delegationEntries(root: JsonObj): DelegationEntry[] {
  const table = Object.entries(root).find(([k, v]) => k.includes("삼단비교") && isObj(v))?.[1] as JsonObj | undefined;
  if (!table) return [];
  const byArticle = new Map<string, DelegationEntry>();
  const add = (list: ArticleKey[], k: ArticleKey | null) => {
    if (k && !list.some((x) => x.no === k.no && x.branch === k.branch)) list.push(k);
    else if (k && k.title) {
      const hit = list.find((x) => x.no === k.no && x.branch === k.branch);
      if (hit && !hit.title) hit.title = k.title;
    }
  };
  for (const row of asList<Json>(table["법률조문"]).filter(isObj)) {
    const article = Number(field(row, "조번호"));
    if (!article) continue;
    const branch = Number(field(row, "조가지번호") || 0);
    const id = `${article}-${branch}`;
    const entry = byArticle.get(id) ?? { article, branch, decree: [], rule: [] };
    byArticle.set(id, entry);
    for (const d of asList<Json>(row["시행령조문"]).filter(isObj)) add(entry.decree, keyOf(d));
    for (const r of asList<Json>(row["시행규칙조문"]).filter(isObj)) add(entry.rule, keyOf(r));
  }
  const order = (a: { no: number; branch: number }, b: { no: number; branch: number }) => a.no - b.no || a.branch - b.branch;
  return [...byArticle.values()]
    .filter((e) => e.decree.length || e.rule.length)
    .map((e) => ({ ...e, decree: e.decree.sort(order), rule: e.rule.sort(order) }))
    .sort((a, b) => a.article - b.article || a.branch - b.branch);
}

// ───────── 신구조문 대비 정리 ─────────

export interface RevisionPair {
  label: string;
  article: number;
  branch: number;
  before: string;
  after: string;
}

const HEAD_RX = /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/;

/** 바뀐 부분 표시(<P>…</P>)를 【…】로 살려 텍스트로 */
function markChanges(s: string): string {
  return plain(s.replace(/<P>([\s\S]*?)<\/P>/gi, "【$1】"));
}

function groupByArticle(list: Json): Map<string, { article: number; branch: number; label: string; lines: string[] }> {
  const groups = new Map<string, { article: number; branch: number; label: string; lines: string[] }>();
  let current: { article: number; branch: number; label: string; lines: string[] } | undefined;
  const items = isObj(list) ? asList<Json>(list["조문"]) : asList<Json>(list);
  for (const it of items) {
    const text = markChanges(isObj(it) ? field(it, "content") : String(it ?? ""));
    if (!text) continue;
    const m = HEAD_RX.exec(text);
    if (m) {
      const article = Number(m[1]);
      const branch = m[2] ? Number(m[2]) : 0;
      const key = `${article}-${branch}`;
      current = groups.get(key) ?? { article, branch, label: `제${article}조${branch ? `의${branch}` : ""}`, lines: [] };
      groups.set(key, current);
    }
    if (current) current.lines.push(text);
  }
  return groups;
}

export function revisionPairs(root: JsonObj): RevisionPair[] {
  const before = groupByArticle(root["구조문목록"] ?? null);
  const after = groupByArticle(root["신조문목록"] ?? null);
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys]
    .map((k) => {
      const b = before.get(k);
      const a = after.get(k);
      const ref = (a ?? b)!;
      return { label: ref.label, article: ref.article, branch: ref.branch, before: b?.lines.join("\n") ?? "(신설)", after: a?.lines.join("\n") ?? "(삭제)" };
    })
    .sort((x, y) => x.article - y.article || x.branch - y.branch);
}

// ───────── 조세조약 보조 ─────────

const COUNTRY_ALIASES: Record<string, string[]> = {
  미국: ["미합중국"],
  영국: ["대영제국", "그레이트브리튼", "영국"],
  중국: ["중화인민공화국"],
  일본: ["일본국"],
  독일: ["독일연방공화국", "독일"],
  프랑스: ["프랑스공화국", "프랑스"],
  호주: ["오스트레일리아"],
  러시아: ["러시아연방"],
  캐나다: ["캐나다"],
  인도: ["인도공화국"],
  싱가포르: ["싱가포르공화국", "싱가포르"],
  네덜란드: ["네덜란드왕국", "네덜란드"],
  스위스: ["스위스연방", "스위스"],
  인도네시아: ["인도네시아공화국"],
  필리핀: ["필리핀공화국"],
  태국: ["타이왕국", "태국"],
  말레이시아: ["말레이시아"],
  베트남: ["베트남사회주의공화국", "베트남"],
  홍콩: ["홍콩"],
  아랍에미리트: ["아랍에미리트"],
  사우디: ["사우디아라비아"],
};

const TAX_WORDS = /조세|이중과세|소득|탈세/;

function countryTerms(query: string): string[] {
  const q = query.replace(/조세조약|조세|이중과세|협약|조약|소득/g, "").trim();
  if (!q || TAX_WORDS.test(q)) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    for (const alias of COUNTRY_ALIASES[w] ?? []) out.add(alias);
  }
  return [...out];
}

function treatyRank(name: string): number {
  if (/정정|교환각서|부속약정|양해각서/.test(name)) return 2;
  if (/의정서|개정/.test(name)) return 1;
  return 0;
}

function toTreatyRow(r: JsonObj): TreatyRow {
  return {
    id: field(r, "조약일련번호", "id"),
    name: plain(field(r, "조약명", "조약명한글")),
    treatyNo: field(r, "조약번호"),
    kind: field(r, "조약구분명", "조약구분"),
    effective: ymd(field(r, "발효일자")),
    signed: ymd(field(r, "서명일자")),
  };
}

/** 조약 본문 문자열을 조문 단위로 나눈다 ("제10조 배당" 형태의 머리말 기준) */
export function treatyArticles(root: JsonObj): Array<{ heading: string; text: string }> {
  const raw = flattenText(root["조약내용"] ?? root);
  const body = raw
    .replace(/\[\/?(조약번호|전문|본문|부칙|서명)\]/g, "\n")
    .replace(/\t/g, " ");
  const parts = body.split(/(?=제\s*\d+\s*조\s)/);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^제\s*(\d+)\s*조\s*([가-힣ㆍ·]+(?:\s[가-힣ㆍ·]+)?)?/.exec(p);
      const title = m?.[2] ? ` ${m[2].slice(0, 12)}` : "";
      return { heading: m ? `제${m[1]}조${title}` : "전문·서두", text: plain(p) };
    });
}
