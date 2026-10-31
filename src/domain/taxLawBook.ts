// 세무 실무에서 쓰는 법령 줄임말 → 정식 법령명 사전.
// 검색어 확장, 인용문 해석, 법령명 정규화에 공통으로 쓴다.

export const TAX_STATUTES: ReadonlyArray<{ official: string; nicknames: string[] }> = [
  { official: "국세기본법", nicknames: ["국기법"] },
  { official: "국세징수법", nicknames: ["국징법", "징수법"] },
  { official: "법인세법", nicknames: ["법법", "법인법"] },
  { official: "소득세법", nicknames: ["소법", "소득법"] },
  { official: "부가가치세법", nicknames: ["부가법", "부가세법", "부법"] },
  { official: "상속세 및 증여세법", nicknames: ["상증법", "상증세법", "상속세및증여세법"] },
  { official: "조세특례제한법", nicknames: ["조특법", "조세특례법"] },
  { official: "국제조세조정에 관한 법률", nicknames: ["국조법", "국제조세조정법", "국조정법"] },
  { official: "종합부동산세법", nicknames: ["종부세법", "종부법"] },
  { official: "개별소비세법", nicknames: ["개소세법", "개소법"] },
  { official: "교통ㆍ에너지ㆍ환경세법", nicknames: ["교통에너지환경세법", "교에환세법"] },
  { official: "주세법", nicknames: [] },
  { official: "인지세법", nicknames: [] },
  { official: "증권거래세법", nicknames: ["증거세법"] },
  { official: "교육세법", nicknames: [] },
  { official: "농어촌특별세법", nicknames: ["농특세법", "농특법"] },
  { official: "지방세기본법", nicknames: ["지기법"] },
  { official: "지방세법", nicknames: ["지세법"] },
  { official: "지방세특례제한법", nicknames: ["지특법"] },
  { official: "지방세징수법", nicknames: ["지징법"] },
  { official: "조세범 처벌법", nicknames: ["조처법", "조세범처벌법"] },
  { official: "조세범 처벌절차법", nicknames: ["조세범처벌절차법"] },
  { official: "세무사법", nicknames: [] },
  { official: "관세법", nicknames: [] },
  { official: "자유무역협정의 이행을 위한 관세법의 특례에 관한 법률", nicknames: ["FTA관세법", "에프티에이관세법"] },
  { official: "부동산 가격공시에 관한 법률", nicknames: ["부동산공시법"] },
  { official: "주식회사 등의 외부감사에 관한 법률", nicknames: ["외감법"] },
  { official: "근로자퇴직급여 보장법", nicknames: ["퇴직급여법", "근퇴법"] },
];

const LEVEL_SUFFIX = /\s*(시행령|시행규칙)$/;

const squash = (s: string) => s.replace(/[\s·ㆍ]/g, "");

const lookup = new Map<string, string>();
for (const { official, nicknames } of TAX_STATUTES) {
  lookup.set(squash(official), official);
  for (const n of nicknames) lookup.set(squash(n), official);
}

/**
 * "법법 시행령" → "법인세법 시행령", "상증법" → "상속세 및 증여세법".
 * 사전에 없으면 입력을 그대로(앞뒤 공백만 정리) 돌려준다.
 */
export function canonicalLawName(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, " ");
  const levelMatch = LEVEL_SUFFIX.exec(trimmed);
  const level = levelMatch ? levelMatch[1] : "";
  const base = level ? trimmed.slice(0, levelMatch!.index).trim() : trimmed;
  // "법인세법시행령"처럼 붙여 쓴 경우
  const glued = /^(.*?)(시행령|시행규칙)$/.exec(squash(base));
  const core = glued ? glued[1] : base;
  const lvl = level || (glued ? glued[2] : "");
  const official = lookup.get(squash(core)) ?? core;
  return lvl ? `${official} ${lvl}` : official;
}

/** 인용문 스캐너용: 사전의 모든 표기(정식명·줄임말)를 길이 내림차순으로 */
export function allStatuteSpellings(): string[] {
  const out = new Set<string>();
  for (const { official, nicknames } of TAX_STATUTES) {
    out.add(official);
    for (const n of nicknames) out.add(n);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** 두 법령명이 표기만 다른 같은 법령인지 (공백·가운뎃점 무시) */
export function sameLawName(a: string, b: string): boolean {
  return squash(canonicalLawName(a)) === squash(canonicalLawName(b));
}

/** 세법(및 그 시행령·시행규칙)인지 — 사전에 등록된 법령 기준 */
export function isTaxStatute(name: string): boolean {
  const base = canonicalLawName(name).replace(/\s*(시행령|시행규칙)$/, "");
  return TAX_STATUTES.some((t) => t.official === base);
}

/** 세무 관련 행정규칙 소관 기관 */
export const TAX_AUTHORITIES = ["국세청", "재정경제부", "기획재정부", "조세심판원", "행정안전부", "관세청"];
