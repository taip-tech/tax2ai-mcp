// 세무 현장 계산: 가산세(감면 포함), 기업업무추진비 한도, 가지급금 인정이자.
// 각 결과에 근거 조문을 붙이고, 반영하지 않은 특례는 notes로 밝힌다.

import { parseDay } from "./dueDates.js";

const DAY = 86_400_000;
const floor = Math.floor;

// ───────────────────────── 가산세 ─────────────────────────

/** 납부지연가산세 일 이자율 (국세기본법 시행령 제27조의4) — 적용 시작일 기준 */
const LATE_RATES: Array<{ from: string; perDay: number }> = [
  { from: "2019-02-12", perDay: 25 / 100_000 },
  { from: "2022-02-15", perDay: 22 / 100_000 },
];
const OLDEST_LATE_RATE = 30 / 100_000;

function lateRateOn(iso: string): number {
  let r = OLDEST_LATE_RATE;
  for (const e of LATE_RATES) if (iso >= e.from) r = e.perDay;
  return r;
}

/** 경과기간별 감면율 (국세기본법 제48조제2항) — [개월 이내, 감면율] */
const AMENDED_RETURN_RELIEF: Array<[number, number]> = [
  [1, 90],
  [3, 75],
  [6, 50],
  [12, 30],
  [18, 20],
  [24, 10],
];
const LATE_RETURN_RELIEF: Array<[number, number]> = [
  [1, 50],
  [3, 30],
  [6, 20],
];

function monthsAfter(due: Date, months: number): Date {
  const t = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(due.getUTCDate(), last)));
}

function reliefPct(due: Date, filed: Date, table: Array<[number, number]>): number {
  for (const [m, pct] of table) if (filed.getTime() <= monthsAfter(due, m).getTime()) return pct;
  return 0;
}

export interface PenaltyInput {
  kind: "unfiled" | "underreported";
  /** 무신고·과소신고로 덜 낸 세액 (원) */
  shortTax: number;
  fraud?: boolean;
  /** 법인·복식부기의무자의 수입금액 (무신고·부정과소 시 수입금액 기준 비교) */
  revenue?: number;
  /** 법정신고기한 */
  dueDate: string;
  /** 수정신고·기한후신고일 (감면 판정). 없으면 감면 없음 */
  filedOn?: string;
  /** 실제 납부일 (납부지연가산세 계산). 없으면 filedOn */
  paidOn?: string;
}

export interface PenaltyResult {
  reportPenalty: number;
  reportBasis: string;
  reliefPct: number;
  reportAfterRelief: number;
  latePaymentPenalty: number;
  lateDays: number;
  total: number;
  lines: string[];
  notes: string[];
}

export function penaltyEstimate(p: PenaltyInput): PenaltyResult {
  if (!(p.shortTax >= 0)) throw new RangeError("덜 낸 세액은 0 이상이어야 합니다.");
  const due = parseDay(p.dueDate);
  const lines: string[] = [];
  const notes: string[] = [];

  let base: number;
  let basis: string;
  if (p.kind === "unfiled") {
    const pct = p.fraud ? 40 : 20;
    const revRate = p.fraud ? 14 / 10_000 : 7 / 10_000;
    const byTax = floor((p.shortTax * pct) / 100);
    const byRev = p.revenue ? floor(p.revenue * revRate) : 0;
    base = Math.max(byTax, byRev);
    basis = `국세기본법 제47조의2 (${p.fraud ? "부정행위" : "일반"} 무신고 ${pct}%${p.revenue ? `, 수입금액 ${p.fraud ? "14" : "7"}/10,000과 비교` : ""})`;
    lines.push(`무신고가산세: 세액기준 ${byTax.toLocaleString()}원${p.revenue ? ` / 수입금액기준 ${byRev.toLocaleString()}원 → 큰 금액` : ""}`);
  } else {
    const pct = p.fraud ? 40 : 10;
    const byTax = floor((p.shortTax * pct) / 100);
    const byRev = p.fraud && p.revenue ? floor(p.revenue * (14 / 10_000)) : 0;
    base = Math.max(byTax, byRev);
    basis = `국세기본법 제47조의3 (${p.fraud ? "부정행위" : "일반"} 과소신고 ${pct}%${byRev ? ", 수입금액 14/10,000과 비교" : ""})`;
    lines.push(`과소신고가산세: 세액기준 ${byTax.toLocaleString()}원${byRev ? ` / 수입금액기준 ${byRev.toLocaleString()}원 → 큰 금액` : ""}`);
  }

  let relief = 0;
  if (p.filedOn) {
    const filed = parseDay(p.filedOn);
    if (filed.getTime() <= due.getTime()) throw new RangeError("수정·기한후신고일은 법정신고기한 이후여야 합니다.");
    if (p.fraud) {
      notes.push("부정행위로 인한 무신고·과소신고도 감면 규정 적용 여부는 사안별로 확인하세요 (경정할 것을 미리 알고 제출한 경우 감면 제외).");
    }
    relief = reliefPct(due, filed, p.kind === "unfiled" ? LATE_RETURN_RELIEF : AMENDED_RETURN_RELIEF);
    lines.push(
      `${p.kind === "unfiled" ? "기한후신고" : "수정신고"} 감면: ${p.filedOn} 제출 → ${relief}% (국세기본법 제48조제2항)`,
    );
  }
  const afterRelief = base - floor((base * relief) / 100);

  let late = 0;
  let lateDays = 0;
  const paid = p.paidOn ?? p.filedOn;
  if (paid && p.shortTax > 0) {
    const end = parseDay(paid);
    // 법정납부기한 다음 날부터 납부일까지
    for (let t = due.getTime() + DAY; t <= end.getTime(); t += DAY) {
      late += p.shortTax * lateRateOn(new Date(t).toISOString().slice(0, 10));
      lateDays++;
    }
    late = floor(late);
    lines.push(`납부지연가산세: ${lateDays}일 × 일 이자율(2022.2.15. 이후 0.022%) → ${late.toLocaleString()}원 (국세기본법 제47조의4)`);
  }

  notes.push("납부고지 후 미납 시의 3% 가산, 납부지연가산세 5년 한도, 세목별 특칙(원천징수·부가세 등)은 반영하지 않았습니다.");
  notes.push("법정신고기한과 법정납부기한이 같다고 가정했습니다.");

  return {
    reportPenalty: base,
    reportBasis: basis,
    reliefPct: relief,
    reportAfterRelief: afterRelief,
    latePaymentPenalty: late,
    lateDays,
    total: afterRelief + late,
    lines,
    notes,
  };
}

// ─────────────────── 기업업무추진비(접대비) 한도 ───────────────────

export interface EntertainmentInput {
  fiscalStart: string;
  months?: number;
  sme: boolean;
  /** 일반 수입금액 (특수관계인 거래분 제외) */
  revenue: number;
  /** 특수관계인과의 거래 수입금액 */
  relatedRevenue?: number;
  /** 부동산임대업 주업 등 법인세법 제25조제5항 대상 */
  passiveCompany?: boolean;
  /** 실제 지출액 (한도초과액 계산용) */
  spent?: number;
}

function revenueTier(amount: number): number {
  const EOK = 100_000_000;
  if (amount <= 100 * EOK) return amount * 0.003;
  if (amount <= 500 * EOK) return 30_000_000 + (amount - 100 * EOK) * 0.002;
  return 110_000_000 + (amount - 500 * EOK) * 0.0003;
}

export function entertainmentLimit(e: EntertainmentInput) {
  const year = Number(e.fiscalStart.slice(0, 4));
  if (!(year >= 2020 && year <= 2026)) throw new RangeError("기업업무추진비 한도는 2020~2026년 개시 사업연도만 지원합니다.");
  const months = e.months ?? 12;
  if (!Number.isInteger(months) || months < 1 || months > 12) throw new RangeError("사업연도 월수는 1~12 정수여야 합니다.");
  const basic = floor(((e.sme ? 36_000_000 : 12_000_000) * months) / 12);
  const related = e.relatedRevenue ?? 0;
  // 수입금액 한도: 전체 수입금액 기준 금액 중 특수관계인 거래분은 10%만 인정
  const total = e.revenue + related;
  const tierAll = revenueTier(total);
  const tierGeneral = revenueTier(e.revenue);
  const byRevenue = floor(tierGeneral + (tierAll - tierGeneral) * 0.1);
  let limit = basic + byRevenue;
  const notes = [
    "문화·전통시장 기업업무추진비 추가 한도, 정부출자기관 특례는 반영하지 않았습니다.",
    "건당 3만원(경조사비 20만원) 초과 지출 중 적격증빙 미수취분은 한도 계산 전에 손금불산입됩니다.",
  ];
  if (e.passiveCompany) {
    limit = floor(limit / 2);
    notes.unshift("법인세법 제25조제5항 대상 법인: 한도의 50%를 적용했습니다.");
  }
  return {
    legalBasis: "법인세법 제25조제4항, 같은 법 시행령 제42조",
    basic,
    byRevenue,
    limit,
    excess: e.spent !== undefined ? Math.max(0, e.spent - limit) : undefined,
    notes,
  };
}

// ─────────────────── 가지급금 인정이자 ───────────────────

export interface LoanSegment {
  from: string; // 이 날부터 (포함)
  to: string; // 이 날까지 (포함)
  balance: number; // 기간 중 잔액
}

export function deemedInterest(input: {
  segments: LoanSegment[];
  ratePct: number;
  rateKind: "weighted" | "overdraft";
  receivedInterest?: number;
  yearDays?: 365 | 366;
}) {
  if (!input.segments.length) throw new RangeError("가지급금 잔액 구간을 1개 이상 입력하세요.");
  const yearDays = input.yearDays ?? 365;
  let product = 0; // 적수
  const lines: string[] = [];
  for (const s of input.segments) {
    const a = parseDay(s.from);
    const b = parseDay(s.to);
    if (b < a) throw new RangeError(`구간 종료일이 시작일보다 빠릅니다: ${s.from}~${s.to}`);
    const days = Math.round((b.getTime() - a.getTime()) / DAY) + 1;
    product += s.balance * days;
    lines.push(`${s.from}~${s.to} ${days}일 × ${s.balance.toLocaleString()}원 = ${(s.balance * days).toLocaleString()}`);
  }
  const interest = floor((product * input.ratePct) / 100 / yearDays);
  const received = input.receivedInterest ?? 0;
  const gap = interest - received;
  const threshold = gap > 0 && (gap >= interest * 0.05 || gap >= 300_000_000);
  return {
    legalBasis: "법인세법 제52조, 같은 법 시행령 제89조제3항·제5항",
    product,
    interest,
    received,
    gap,
    triggersAdjustment: threshold,
    lines,
    notes: [
      input.rateKind === "overdraft"
        ? "당좌대출이자율(시행규칙에서 정함, 2016.3.7. 이후 연 4.6%)을 선택한 경우 해당 사업연도와 이후 2개 사업연도에 계속 적용해야 합니다."
        : "가중평균차입이자율은 대여 시점의 차입금 잔액과 이자율로 계산합니다. 산정이 불가능한 경우 당좌대출이자율을 씁니다.",
      "현저한 이익 분여 기준: (인정이자 − 실제 이자)가 인정이자의 5% 이상이거나 3억원 이상이면 차액을 익금산입합니다.",
      "동일인에 대한 가수금 상계, 업무무관 가지급금 지급이자 손금불산입(제28조)은 별도로 계산하세요.",
    ],
  };
}
