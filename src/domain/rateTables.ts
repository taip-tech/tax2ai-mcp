// 산출세액 계산용 세율표. 표에 없는 연도는 추정하지 않고 오류로 돌려준다.
// 개정 시 이 파일만 고치면 되도록 '적용 시작일' 기준 구간 배열로 관리한다.

export interface Bracket {
  upTo: number; // 이 금액 이하 구간 (원). 마지막 구간은 Infinity
  pct: number;
}

interface RateEdition {
  from: string; // YYYY-MM-DD (포함)
  until: string; // YYYY-MM-DD (미포함)
  legalBasis: string;
  brackets: Bracket[];
  caution?: string;
}

const EOK = 100_000_000;
const MAN = 10_000;

/** 법인세: 사업연도 '개시일' 기준 */
const CORPORATE: RateEdition[] = [
  {
    from: "2018-01-01",
    until: "2023-01-01",
    legalBasis: "법인세법 제55조제1항 (2017.12.19. 개정)",
    brackets: [
      { upTo: 2 * EOK, pct: 10 },
      { upTo: 200 * EOK, pct: 20 },
      { upTo: 3000 * EOK, pct: 22 },
      { upTo: Infinity, pct: 25 },
    ],
  },
  {
    from: "2023-01-01",
    until: "2026-01-01",
    legalBasis: "법인세법 제55조제1항 (2022.12.31. 개정)",
    brackets: [
      { upTo: 2 * EOK, pct: 9 },
      { upTo: 200 * EOK, pct: 19 },
      { upTo: 3000 * EOK, pct: 21 },
      { upTo: Infinity, pct: 24 },
    ],
  },
  {
    from: "2026-01-01",
    until: "2027-01-01",
    legalBasis: "법인세법 제55조제1항 (2025.12.23. 개정, 2026.1.1. 이후 개시 사업연도 · 부칙 제5조)",
    brackets: [
      { upTo: 2 * EOK, pct: 10 },
      { upTo: 200 * EOK, pct: 20 },
      { upTo: 3000 * EOK, pct: 22 },
      { upTo: Infinity, pct: 25 },
    ],
  },
];

/** 종합소득세 기본세율: 귀속연도 1.1. 기준 */
const PERSONAL: RateEdition[] = [
  {
    from: "2021-01-01",
    until: "2023-01-01",
    legalBasis: "소득세법 제55조제1항 (2020.12.29. 개정)",
    brackets: [
      { upTo: 1200 * MAN, pct: 6 },
      { upTo: 4600 * MAN, pct: 15 },
      { upTo: 8800 * MAN, pct: 24 },
      { upTo: 1.5 * EOK, pct: 35 },
      { upTo: 3 * EOK, pct: 38 },
      { upTo: 5 * EOK, pct: 40 },
      { upTo: 10 * EOK, pct: 42 },
      { upTo: Infinity, pct: 45 },
    ],
  },
  {
    from: "2023-01-01",
    until: "2027-01-01",
    legalBasis: "소득세법 제55조제1항 (2022.12.31. 개정)",
    brackets: [
      { upTo: 1400 * MAN, pct: 6 },
      { upTo: 5000 * MAN, pct: 15 },
      { upTo: 8800 * MAN, pct: 24 },
      { upTo: 1.5 * EOK, pct: 35 },
      { upTo: 3 * EOK, pct: 38 },
      { upTo: 5 * EOK, pct: 40 },
      { upTo: 10 * EOK, pct: 42 },
      { upTo: Infinity, pct: 45 },
    ],
  },
];

export interface BracketLine {
  range: string;
  pct: number;
  slice: number;
  tax: number;
}

export interface TaxComputation {
  legalBasis: string;
  taxBase: number;
  computedTax: number;
  localIncomeTax: number;
  effectivePct: number;
  marginalPct: number;
  lines: BracketLine[];
  notes: string[];
}

function pickEdition(table: RateEdition[], date: string, what: string): RateEdition {
  const hit = table.find((e) => date >= e.from && date < e.until);
  if (!hit) {
    const span = `${table[0].from.slice(0, 4)}~${Number(table[table.length - 1].until.slice(0, 4)) - 1}`;
    throw new RangeError(`${what} 세율표가 등록되지 않은 기준일(${date})입니다. 지원 범위: ${span}`);
  }
  return hit;
}

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

function progressive(base: number, brackets: Bracket[]): { tax: number; lines: BracketLine[]; marginal: number } {
  let lower = 0;
  let tax = 0;
  let marginal = brackets[0].pct;
  const lines: BracketLine[] = [];
  for (const b of brackets) {
    if (base <= lower) break;
    const slice = Math.min(base, b.upTo) - lower;
    const part = Math.floor((slice * b.pct) / 100);
    tax += part;
    marginal = b.pct;
    lines.push({
      range: `${won(lower)} 초과 ~ ${b.upTo === Infinity ? "" : won(b.upTo) + " 이하"}`.trim(),
      pct: b.pct,
      slice,
      tax: part,
    });
    lower = b.upTo;
  }
  return { tax, lines, marginal };
}

/**
 * 법인세 산출세액 (각 사업연도 소득, 일반법인 기준).
 * months < 12 이면 법인세법 제55조제2항의 환산 방식 적용.
 */
export function corporateTax(taxBase: number, fiscalStart: string, months = 12): TaxComputation {
  if (!(taxBase >= 0)) throw new RangeError("과세표준은 0 이상이어야 합니다.");
  if (!Number.isInteger(months) || months < 1 || months > 12) throw new RangeError("사업연도 월수는 1~12 정수여야 합니다.");
  const ed = pickEdition(CORPORATE, fiscalStart, "법인세");
  const notes: string[] = [];
  let computed: number;
  let lines: BracketLine[];
  let marginal: number;
  if (months < 12) {
    const annualized = Math.floor((taxBase * 12) / months);
    const r = progressive(annualized, ed.brackets);
    computed = Math.floor((r.tax * months) / 12);
    lines = r.lines;
    marginal = r.marginal;
    notes.push(`사업연도 ${months}개월: 과세표준을 ${won(annualized)}으로 연환산 후 세액에 ${months}/12를 곱했습니다.`);
  } else {
    const r = progressive(taxBase, ed.brackets);
    computed = r.tax;
    lines = r.lines;
    marginal = r.marginal;
  }
  notes.push("성실신고확인대상 소규모 법인(부동산임대업 주업 등)·조합법인 등 특례 세율은 반영하지 않았습니다.");
  notes.push("지방소득세는 지방세법상 법인 세율(국세의 1/10 구조)로 단순 추정한 값입니다.");
  if (ed.caution) notes.push(ed.caution);
  return {
    legalBasis: ed.legalBasis,
    taxBase,
    computedTax: computed,
    localIncomeTax: Math.floor(computed / 10),
    effectivePct: taxBase ? Math.round((computed / taxBase) * 10000) / 100 : 0,
    marginalPct: marginal,
    lines,
    notes,
  };
}

/** 종합소득세 산출세액 (기본세율, 분리과세·비교과세 미반영) */
export function personalIncomeTax(taxBase: number, year: number): TaxComputation {
  if (!(taxBase >= 0)) throw new RangeError("과세표준은 0 이상이어야 합니다.");
  const ed = pickEdition(PERSONAL, `${year}-01-01`, "종합소득세");
  const r = progressive(taxBase, ed.brackets);
  const notes = [
    "금융소득 종합과세 비교과세, 분리과세, 세액공제·감면은 반영하지 않은 기본세율 산출세액입니다.",
    "지방소득세는 산출세액의 10%로 추정했습니다.",
  ];
  if (ed.caution) notes.push(ed.caution);
  return {
    legalBasis: ed.legalBasis,
    taxBase,
    computedTax: r.tax,
    localIncomeTax: Math.floor(r.tax / 10),
    effectivePct: taxBase ? Math.round((r.tax / taxBase) * 10000) / 100 : 0,
    marginalPct: r.marginal,
    lines: r.lines,
    notes,
  };
}
