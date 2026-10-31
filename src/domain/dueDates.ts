// 법정신고기한·경정청구기한·부과제척기간 계산.
// 날짜는 모두 'YYYY-MM-DD' 문자열, 내부 계산은 UTC 자정 기준으로 한다.

export type ReturnKind = "corporate" | "personal" | "vat" | "inheritance" | "gift";

const DAY = 86_400_000;

/** 국세기본법 제5조: 토요일·일요일·공휴일·근로자의 날이면 다음 날로 */
const FIXED_OFF_DAYS = ["01-01", "03-01", "05-01", "05-05", "06-06", "08-15", "10-03", "10-09", "12-25"];

export function parseDay(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) throw new RangeError(`날짜 형식은 YYYY-MM-DD 이어야 합니다: ${s}`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) throw new RangeError(`존재하지 않는 날짜입니다: ${s}`);
  return d;
}

export const fmtDay = (d: Date) => d.toISOString().slice(0, 10);

/** 해당 월의 말일 */
function monthEnd(year: number, month0: number): Date {
  return new Date(Date.UTC(year, month0 + 1, 0));
}

/** 기준일이 속한 달의 말일로부터 n개월이 되는 날(그 달 말일) */
export function monthEndPlus(base: Date, n: number): Date {
  return monthEnd(base.getUTCFullYear(), base.getUTCMonth() + n);
}

/** n년 뒤 같은 날 (2/29 → 2/28) */
export function plusYears(d: Date, n: number): Date {
  const y = d.getUTCFullYear() + n;
  const last = monthEnd(y, d.getUTCMonth()).getUTCDate();
  return new Date(Date.UTC(y, d.getUTCMonth(), Math.min(d.getUTCDate(), last)));
}

export function plusMonths(d: Date, n: number): Date {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = monthEnd(target.getUTCFullYear(), target.getUTCMonth()).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), last)));
}

export interface ShiftResult {
  date: Date;
  shiftedFrom?: string;
}

export function rollToBusinessDay(d: Date, extraOff: string[] = []): ShiftResult {
  const off = new Set(extraOff);
  let cur = d;
  const isOff = (x: Date) => {
    const wd = x.getUTCDay();
    const iso = fmtDay(x);
    return wd === 0 || wd === 6 || FIXED_OFF_DAYS.includes(iso.slice(5)) || off.has(iso);
  };
  while (isOff(cur)) cur = new Date(cur.getTime() + DAY);
  return cur.getTime() === d.getTime() ? { date: d } : { date: cur, shiftedFrom: fmtDay(d) };
}

export interface FilingInput {
  kind: ReturnKind;
  /** corporate: 사업연도 종료일 / personal: 귀속연도 12-31 / vat: 과세기간 종료일 / inheritance: 상속개시일 / gift: 증여일 */
  periodEnd: string;
  /** 성실신고확인 대상 여부 (법인 4개월, 개인 6/30) */
  diligentFiler?: boolean;
  /** 상속세: 피상속인·상속인 전원 국외 거주 */
  abroad?: boolean;
  extraHolidays?: string[];
}

export interface FilingDue {
  rawDue: string;
  due: string;
  shiftedFrom?: string;
  basis: string;
}

export function statutoryFilingDue(input: FilingInput): FilingDue {
  const end = parseDay(input.periodEnd);
  let raw: Date;
  let basis: string;
  switch (input.kind) {
    case "corporate":
      raw = monthEndPlus(end, input.diligentFiler ? 4 : 3);
      basis = input.diligentFiler
        ? "법인세법 제60조제1항·제60조의2 (성실신고확인: 사업연도 종료일이 속하는 달의 말일부터 4개월)"
        : "법인세법 제60조제1항 (사업연도 종료일이 속하는 달의 말일부터 3개월)";
      break;
    case "personal": {
      const y = end.getUTCFullYear() + 1;
      raw = input.diligentFiler ? new Date(Date.UTC(y, 5, 30)) : new Date(Date.UTC(y, 4, 31));
      basis = input.diligentFiler
        ? "소득세법 제70조의2 (성실신고확인대상: 다음 연도 6월 30일)"
        : "소득세법 제70조제1항 (다음 연도 5월 1일~5월 31일)";
      break;
    }
    case "vat":
      raw = new Date(end.getTime() + 25 * DAY);
      basis = "부가가치세법 제49조제1항 (과세기간 종료 후 25일 이내 확정신고)";
      break;
    case "inheritance":
      raw = monthEndPlus(end, input.abroad ? 9 : 6);
      basis = `상속세 및 증여세법 제67조제1항·제4항 (상속개시일이 속하는 달의 말일부터 ${input.abroad ? 9 : 6}개월)`;
      break;
    case "gift":
      raw = monthEndPlus(end, 3);
      basis = "상속세 및 증여세법 제68조제1항 (증여일이 속하는 달의 말일부터 3개월)";
      break;
  }
  const shifted = rollToBusinessDay(raw, input.extraHolidays);
  return { rawDue: fmtDay(raw), due: fmtDay(shifted.date), shiftedFrom: shifted.shiftedFrom, basis };
}

export type AssessmentCase = "standard" | "unfiled" | "fraud";

const ASSESSMENT_YEARS: Record<"general" | "estate", Record<AssessmentCase, number>> = {
  general: { standard: 5, unfiled: 7, fraud: 10 },
  estate: { standard: 10, unfiled: 15, fraud: 15 },
};

export interface WindowReport {
  filing: FilingDue;
  refundClaimUntil: string;
  refundClaimBasis: string;
  assessmentUntil: string;
  assessmentYears: number;
  assessmentBasis: string;
  daysLeftForRefund: number;
  lateEventClaimUntil?: string;
  caveats: string[];
}

export function claimAndAssessmentWindows(
  input: FilingInput & { assessmentCase?: AssessmentCase; lateEventKnownOn?: string; today?: string },
): WindowReport {
  const filing = statutoryFilingDue(input);
  const due = parseDay(filing.due);
  const refund = rollToBusinessDay(plusYears(due, 5), input.extraHolidays);

  const family = input.kind === "inheritance" || input.kind === "gift" ? "estate" : "general";
  const kase = input.assessmentCase ?? "standard";
  const years = ASSESSMENT_YEARS[family][kase];
  // 제척기간은 법정신고기한 다음 날부터 기산 → n년이 되는 날 종료
  const assessment = plusYears(due, years);

  const today = input.today ? parseDay(input.today) : parseDay(new Date().toISOString().slice(0, 10));
  const daysLeft = Math.round((refund.date.getTime() - today.getTime()) / DAY);

  const caveats = [
    "음력 공휴일(설·추석)·부처님오신날·대체공휴일·임시공휴일은 자동 반영되지 않습니다. extraHolidays로 추가하세요.",
    "역외거래, 조세쟁송 결과에 따른 특례 제척기간(국세기본법 제26조의2 제3항 이하)은 별도 검토가 필요합니다.",
  ];
  if (input.kind === "vat") caveats.push("부가가치세 예정신고·조기환급 신고분은 별도 기한을 적용하세요.");

  const out: WindowReport = {
    filing,
    refundClaimUntil: fmtDay(refund.date),
    refundClaimBasis: "국세기본법 제45조의2제1항 (법정신고기한이 지난 후 5년 이내)",
    assessmentUntil: fmtDay(assessment),
    assessmentYears: years,
    assessmentBasis: `국세기본법 제26조의2 (${family === "estate" ? "상속세·증여세" : "일반 세목"}, ${
      { standard: "일반", unfiled: "무신고", fraud: "부정행위" }[kase]
    } ${years}년)`,
    daysLeftForRefund: daysLeft,
    caveats,
  };
  if (input.lateEventKnownOn) {
    const known = parseDay(input.lateEventKnownOn);
    out.lateEventClaimUntil = fmtDay(rollToBusinessDay(plusMonths(known, 3), input.extraHolidays).date);
  }
  return out;
}
