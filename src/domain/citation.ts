// 서면(의견서·검토메모 초안 등)에 등장하는 조문 인용을 구조화한다.
// 예) "법인세법 시행령 제89조제3항", "조특법 제10조의2 제1항 제2호", "같은 법 제52조"

import { allStatuteSpellings, canonicalLawName } from "./taxLawBook.js";

export interface ArticleRef {
  raw: string;
  law: string; // 정식명 + (시행령|시행규칙). 판별 불가 시 ""
  article: number;
  branch: number; // 제N조의M 의 M (없으면 0)
  paragraph?: number;
  item?: number;
  subitem?: string; // 목(가·나·다…)
  offset: number;
}

// 그룹: 1=조, 2=가지, 3="같은 조" 표기, 4=항, 5=호, 6=목
const ARTICLE_RX =
  /(?:제\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,3}))?|(같은\s*조|동조))(?:\s*제\s*(\d{1,3})\s*항)?(?:\s*제\s*(\d{1,3})\s*호)?(?:\s*([가-하])\s*목)?/g;

const LEVEL = "(?:\\s*(시행령|시행규칙))?";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KNOWN_RX = new RegExp(`(${allStatuteSpellings().map(escape).join("|")})${LEVEL}\\s*$`);
const SAME_LAW_RX = new RegExp(`(?:같은\\s*법|동법|동\\s*법)${LEVEL}\\s*$`);
const RELATED_LAW_RX = new RegExp(`((?:[가-힣ㆍ·]+\\s){0,4}[가-힣ㆍ·]+\\s?에\\s?관한\\s?법률)${LEVEL}\\s*$`);
const SINGLE_LAW_RX = new RegExp(`([가-힣ㆍ·]{1,30}법)${LEVEL}\\s*$`);
const CONNECTOR_ONLY = /^[\s,·ㆍ및또는와과、]*$/;

/** 제N조의M → 법제처 JO 파라미터 (조 4자리 + 가지 2자리) */
export function joCode(article: number, branch = 0): string {
  return String(article).padStart(4, "0") + String(branch).padStart(2, "0");
}

export function articleLabel(ref: Pick<ArticleRef, "article" | "branch" | "paragraph" | "item" | "subitem">): string {
  let s = `제${ref.article}조`;
  if (ref.branch) s += `의${ref.branch}`;
  if (ref.paragraph) s += ` 제${ref.paragraph}항`;
  if (ref.item) s += ` 제${ref.item}호`;
  if (ref.subitem) s += ` ${ref.subitem}목`;
  return s;
}

/** "제52조의2" / "52의2" / "52-2" / "52" 같은 사용자 입력을 해석 */
export function parseArticleInput(input: string): { article: number; branch: number } | null {
  const m = /^\s*(?:제\s*)?(\d{1,4})\s*(?:조)?\s*(?:(?:의|-|_)\s*(\d{1,3}))?\s*$/.exec(input);
  if (!m) return null;
  return { article: Number(m[1]), branch: m[2] ? Number(m[2]) : 0 };
}

function lawBefore(prefix: string): { law: string; kind: "known" | "same" | "generic" } | null {
  const tail = prefix.slice(-60);
  let m = KNOWN_RX.exec(tail);
  if (m) {
    // 앞 글자가 한글이면 다른 단어의 일부("국소법" 등)로 보고 무시
    const before = tail.slice(0, m.index).slice(-1);
    if (!/[가-힣]/.test(before)) return { law: canonicalLawName(m[1] + (m[2] ? ` ${m[2]}` : "")), kind: "known" };
  }
  m = SAME_LAW_RX.exec(tail);
  if (m) return { law: m[1] ?? "", kind: "same" };
  m = RELATED_LAW_RX.exec(tail) ?? SINGLE_LAW_RX.exec(tail);
  if (m) return { law: canonicalLawName(m[1].trim() + (m[2] ? ` ${m[2]}` : "")), kind: "generic" };
  return null;
}

const baseOf = (law: string) => law.replace(/\s*(시행령|시행규칙)$/, "");

export function extractArticleRefs(text: string): ArticleRef[] {
  const refs: ArticleRef[] = [];
  let prevLaw = "";
  let prevEnd = -1;
  let prev: ArticleRef | undefined;

  for (const m of text.matchAll(ARTICLE_RX)) {
    const offset = m.index ?? 0;
    const sameArticle = Boolean(m[3]);
    if (sameArticle && (!prev || !m[4])) continue; // "같은 조" 단독 표기는 건너뜀
    const prefix = text.slice(0, offset);
    const found = lawBefore(prefix);
    let law = "";
    let inherited: ArticleRef | undefined;

    if (sameArticle) {
      law = prev!.law;
      inherited = prev;
    } else if (found?.kind === "same") {
      law = found.law ? `${baseOf(prevLaw)} ${found.law}` : baseOf(prevLaw);
    } else if (found) {
      law = found.law;
    } else if (prevEnd >= 0 && CONNECTOR_ONLY.test(text.slice(prevEnd, offset))) {
      law = prevLaw;
    }

    const ref: ArticleRef = {
      raw: m[0],
      law: law.trim(),
      article: inherited ? inherited.article : Number(m[1]),
      branch: inherited ? inherited.branch : m[2] ? Number(m[2]) : 0,
      paragraph: m[4] ? Number(m[4]) : undefined,
      item: m[5] ? Number(m[5]) : undefined,
      subitem: m[6] || undefined,
      offset,
    };
    refs.push(ref);
    if (ref.law) prevLaw = ref.law;
    prevEnd = offset + m[0].length;
    prev = ref;
  }
  return refs;
}
