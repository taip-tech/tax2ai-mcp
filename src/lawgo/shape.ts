// 법제처 DRF 응답은 같은 API라도 건수(1건이면 객체, 여러 건이면 배열)나
// 필드명 표기가 들쭉날쭉하다. 여기서 형태를 정리해 상위 코드가 신경 쓰지 않게 한다.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObj = { [k: string]: Json };

export function isObj(v: unknown): v is JsonObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asList<T = Json>(v: unknown): T[] {
  if (v === undefined || v === null || v === "") return [];
  return (Array.isArray(v) ? v : [v]) as T[];
}

/** 후보 키를 순서대로 살펴 처음 발견된 값을 문자열로 돌려준다. */
export function field(obj: unknown, ...keys: string[]): string {
  if (!isObj(obj)) return "";
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const s = flattenText(v).trim();
    if (s) return s;
  }
  return "";
}

/** 중첩 배열/객체 안의 문자열을 줄바꿈으로 이어 붙인다. */
export function flattenText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(flattenText).filter(Boolean).join("\n");
  if (isObj(v)) return Object.values(v).map(flattenText).filter(Boolean).join("\n");
  return "";
}

/** HTML 태그·엔티티를 제거하고 공백을 정돈한다. */
export function plain(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 루트 래퍼 객체(예: { LawSearch: {...} })를 한 겹 벗긴다. */
export function unwrapRoot(payload: unknown): JsonObj {
  if (!isObj(payload)) return {};
  const keys = Object.keys(payload);
  if (keys.length === 1 && isObj(payload[keys[0]])) return payload[keys[0]] as JsonObj;
  return payload;
}

/**
 * 검색 응답에서 결과 목록을 찾는다. preferred 키를 먼저 보고,
 * 없으면 '일련번호' 류 필드를 가진 첫 번째 배열/객체를 결과로 간주한다.
 */
export function locateRows(payload: unknown, preferred: string[]): JsonObj[] {
  const root = unwrapRoot(payload);
  for (const k of preferred) {
    if (k in root) return asList<Json>(root[k]).filter(isObj);
  }
  for (const v of Object.values(root)) {
    const rows = asList<Json>(v).filter(isObj);
    if (rows.length && rows.some((r) => Object.keys(r).some((key) => key.includes("일련번호") || key.endsWith("ID")))) {
      return rows;
    }
  }
  return [];
}

export function totalCount(payload: unknown): number {
  const root = unwrapRoot(payload);
  const n = Number(field(root, "totalCnt", "totalcnt", "검색결과개수"));
  return Number.isFinite(n) ? n : 0;
}

/** YYYYMMDD → YYYY-MM-DD (형식이 다르면 원문 유지) */
export function ymd(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}
