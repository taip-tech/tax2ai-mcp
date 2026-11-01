// 신고 자료요청: 세목·고객 유형별 기본 서류 목록과 신고기한·자료 마감일 계산.
// 목록은 일반적인 기본값이며, 사무소·고객 사정에 맞게 덜어 내거나 보태서 쓴다.

import { fmtDay, monthEndPlus, parseDay, rollToBusinessDay, statutoryFilingDue } from "./dueDates.js";

export type RequestKind =
  | "vat_final"
  | "vat_preliminary"
  | "corporate"
  | "personal_income"
  | "year_end"
  | "withholding"
  | "capital_gains"
  | "inheritance"
  | "gift";

export type ClientType = "individual" | "corporation";
export type VatType = "general" | "simplified";

export const REQUEST_KINDS: { value: RequestKind; label: string }[] = [
  { value: "vat_final", label: "부가가치세 확정신고" },
  { value: "vat_preliminary", label: "부가가치세 예정신고 (법인)" },
  { value: "corporate", label: "법인세 신고" },
  { value: "personal_income", label: "종합소득세 신고" },
  { value: "year_end", label: "근로소득 연말정산" },
  { value: "withholding", label: "원천세 신고 (매월)" },
  { value: "capital_gains", label: "양도소득세 예정신고 (부동산)" },
  { value: "inheritance", label: "상속세 신고" },
  { value: "gift", label: "증여세 신고" },
];

export const kindLabel = (k: RequestKind) => REQUEST_KINDS.find((x) => x.value === k)?.label ?? k;

/** 고객이 보낼 수 있는 파일 형식 */
export const SUBMIT_FORMATS = [
  { value: "pdf", label: "PDF 파일" },
  { value: "photo", label: "사진 촬영본 (JPG·PNG)" },
  { value: "excel", label: "엑셀 파일" },
  { value: "hometax", label: "홈택스·카드사 다운로드 파일" },
  { value: "original", label: "원본 우편·방문 제출" },
] as const;
export type SubmitFormat = (typeof SUBMIT_FORMATS)[number]["value"];

export interface RequestPeriod {
  year?: number;
  /** 부가세 1기/2기 */
  half?: 1 | 2;
  /** 원천세 지급월 1~12 */
  month?: number;
  /** 법인 사업연도 종료일 (기본: year-12-31) */
  periodEnd?: string;
  /** 양도일(잔금일)·상속개시일·증여일 */
  eventDate?: string;
}

export interface Schedule {
  periodLabel: string;
  filingDue: string;
  basis: string;
  shiftedFrom?: string;
}

const roll = (d: Date) => rollToBusinessDay(d);

/** 세목별 신고 대상 기간과 법정신고기한. 필요한 기간 정보가 없으면 그 인자 이름을 돌려준다. */
export function requestSchedule(
  kind: RequestKind,
  p: RequestPeriod,
  opts: { vatType?: VatType; diligentFiler?: boolean } = {},
): Schedule | { missing: (keyof RequestPeriod)[] } {
  const y = p.year;
  switch (kind) {
    case "vat_final": {
      if (!y) return { missing: ["year"] };
      if (opts.vatType === "simplified") {
        const f = statutoryFilingDue({ kind: "vat", periodEnd: `${y}-12-31` });
        return { periodLabel: `${y}년(1.1.~12.31.)`, filingDue: f.due, shiftedFrom: f.shiftedFrom, basis: "부가가치세법 제67조 (간이과세자 과세기간 종료 후 25일 이내)" };
      }
      if (!p.half) return { missing: ["half"] };
      const end = p.half === 1 ? `${y}-06-30` : `${y}-12-31`;
      const f = statutoryFilingDue({ kind: "vat", periodEnd: end });
      return { periodLabel: `${y}년 ${p.half}기(${p.half === 1 ? "1.1.~6.30." : "7.1.~12.31."})`, filingDue: f.due, shiftedFrom: f.shiftedFrom, basis: f.basis };
    }
    case "vat_preliminary": {
      if (!y) return { missing: ["year"] };
      if (!p.half) return { missing: ["half"] };
      const end = p.half === 1 ? `${y}-03-31` : `${y}-09-30`;
      const f = statutoryFilingDue({ kind: "vat", periodEnd: end });
      return { periodLabel: `${y}년 ${p.half}기(${p.half === 1 ? "1.1.~3.31." : "7.1.~9.30."})`, filingDue: f.due, shiftedFrom: f.shiftedFrom, basis: "부가가치세법 제48조제1항 (예정신고기간 종료 후 25일 이내)" };
    }
    case "corporate": {
      const end = p.periodEnd ?? (y ? `${y}-12-31` : undefined);
      if (!end) return { missing: ["year"] };
      const f = statutoryFilingDue({ kind: "corporate", periodEnd: end, diligentFiler: opts.diligentFiler });
      return { periodLabel: `${end.slice(0, 4)} 사업연도(${end.slice(5).replace("-", ".")}. 종료)`, filingDue: f.due, shiftedFrom: f.shiftedFrom, basis: f.basis };
    }
    case "personal_income": {
      if (!y) return { missing: ["year"] };
      const f = statutoryFilingDue({ kind: "personal", periodEnd: `${y}-12-31`, diligentFiler: opts.diligentFiler });
      return { periodLabel: `${y}년 귀속`, filingDue: f.due, shiftedFrom: f.shiftedFrom, basis: f.basis };
    }
    case "year_end": {
      if (!y) return { missing: ["year"] };
      const s = roll(parseDay(`${y + 1}-03-10`));
      return { periodLabel: `${y}년 귀속 근로소득`, filingDue: fmtDay(s.date), shiftedFrom: s.shiftedFrom, basis: "소득세법 제137조·제164조 (2월분 급여 지급 시 연말정산, 지급명세서 다음 연도 3월 10일까지 제출)" };
    }
    case "withholding": {
      if (!y) return { missing: ["year"] };
      if (!p.month) return { missing: ["month"] };
      const s = roll(new Date(Date.UTC(y, p.month, 10)));
      return { periodLabel: `${y}년 ${p.month}월 지급분`, filingDue: fmtDay(s.date), shiftedFrom: s.shiftedFrom, basis: "소득세법 제128조제1항 (징수일이 속하는 달의 다음 달 10일)" };
    }
    case "capital_gains": {
      if (!p.eventDate) return { missing: ["eventDate"] };
      const s = roll(monthEndPlus(parseDay(p.eventDate), 2));
      return { periodLabel: `양도일 ${p.eventDate}`, filingDue: fmtDay(s.date), shiftedFrom: s.shiftedFrom, basis: "소득세법 제105조제1항 (양도일이 속하는 달의 말일부터 2개월)" };
    }
    case "inheritance":
    case "gift": {
      if (!p.eventDate) return { missing: ["eventDate"] };
      const f = statutoryFilingDue({ kind, periodEnd: p.eventDate });
      return { periodLabel: `${kind === "gift" ? "증여일" : "상속개시일"} ${p.eventDate}`, filingDue: f.due, shiftedFrom: f.shiftedFrom, basis: f.basis };
    }
  }
}

/** 신고기한 n일 전, 휴일이면 앞당긴 영업일 */
export function requestDeadline(filingDue: string, leadDays: number): string {
  const DAY = 86_400_000;
  let d = new Date(parseDay(filingDue).getTime() - leadDays * DAY);
  while (rollToBusinessDay(d).shiftedFrom) d = new Date(d.getTime() - DAY);
  return fmtDay(d);
}

export interface ChecklistSection {
  title: string;
  items: string[];
}

interface Ctx {
  client: ClientType;
  vat: VatType;
}

type Item = string | [string, (c: Ctx) => boolean];
const corpOnly = (c: Ctx) => c.client === "corporation";
const indivOnly = (c: Ctx) => c.client === "individual";
const generalVat = (c: Ctx) => c.vat === "general";

const BOOK: Record<RequestKind, { title: string; items: Item[] }[]> = {
  vat_final: [
    {
      title: "매출 자료",
      items: [
        "신용카드·간편결제 매출 내역 (카드사·PG사 정산내역)",
        "현금매출 내역 (현금영수증 미발행분 포함)",
        "배달앱·오픈마켓·플랫폼 정산내역",
        "종이로 발행한 세금계산서·계산서 사본",
        ["수출 실적 자료 (수출신고필증, 외화입금 증명)", generalVat],
      ],
    },
    {
      title: "매입 자료",
      items: [
        "종이로 받은 세금계산서·계산서",
        "홈택스에 등록하지 않은 사업용 카드 사용내역",
        "지출증빙용 현금영수증 외 영수증",
        ["고정자산(차량·비품·인테리어 등) 구입 계약서·세금계산서", generalVat],
        ["면세 농·수산물 구입 영수증 (의제매입세액공제 대상 업종)", generalVat],
      ],
    },
    {
      title: "기타",
      items: ["사업장 임대차계약서 (새로 맺거나 바뀐 경우)", "부동산 임대업: 임차인별 보증금·월세 현황", "폐업·휴업·사업장 이전 등 변동 사항"],
    },
  ],
  vat_preliminary: [
    {
      title: "매출·매입 자료 (예정신고 기간분)",
      items: [
        "카드·현금·플랫폼 매출 내역",
        "종이 세금계산서·계산서 (발행·수취분)",
        "홈택스 미등록 법인카드 사용내역",
        "고정자산 취득 계약서·세금계산서",
        "수출 실적 자료 (해당 시)",
      ],
    },
  ],
  corporate: [
    {
      title: "결산 기본 자료",
      items: [
        "전 계좌 거래내역과 사업연도 말 예금 잔액증명서",
        "차입금 잔액증명서와 이자 지급 내역",
        "사업연도 말 재고자산 실사표",
        "매출채권·매입채무 거래처별 잔액",
        "유형자산 취득·처분 계약서, 리스·렌탈 계약서",
      ],
    },
    {
      title: "인건비·임원",
      items: ["연간 급여대장과 4대보험 납부 내역", "퇴직금 지급 내역 및 퇴직연금 납입 내역", "임원 보수·상여·퇴직금 규정 및 주주총회(이사회) 의사록"],
    },
    {
      title: "손금 한도·세무조정 관련",
      items: [
        "기업업무추진비(접대비) 사용 내역과 증빙",
        "기부금 영수증",
        "대표이사·주주 가지급금·가수금 내역과 금전소비대차 약정서",
        "업무용 승용차 운행기록부와 차량 보험 가입 내역",
      ],
    },
    {
      title: "세액공제·감면 검토 자료",
      items: ["연구소·전담부서 인정서와 연구원 인건비·연구비 내역 (해당 시)", "상시근로자 명부 (고용 관련 세액공제 검토용)", "사업용 자산 투자 내역 (통합투자세액공제 검토용)"],
    },
    {
      title: "회사 변동 사항",
      items: ["주주 변동 내역 (주식 양수도 계약서)", "정관·법인등기 변경 사항", "신규 수임인 경우 직전 사업연도 세무조정계산서"],
    },
  ],
  personal_income: [
    {
      title: "사업소득 자료 (사업자인 경우)",
      items: [
        "장부 또는 매출·매입 증빙 (부가세 신고 후 추가분)",
        "직원 급여·4대보험 납부 내역",
        "사업용 차량 관련 비용과 운행 내역",
        "사업장 임대차계약서, 대출 이자 내역 (사업용)",
      ],
    },
    {
      title: "다른 소득 (해당 시)",
      items: ["근로소득 원천징수영수증 (직장을 함께 다닌 경우)", "강의료·원고료 등 기타소득 지급명세", "연금소득·금융소득 내역 (홈택스 조회 동의로 대체 가능)"],
    },
    {
      title: "공제 자료",
      items: [
        "부양가족 변동 사항과 자료조회 동의",
        "노란우산공제 납입증명서",
        "연금저축·IRP 납입증명서",
        "기부금 영수증",
        "국민연금·건강보험료 납부 내역 (홈택스 조회 가능)",
      ],
    },
  ],
  year_end: [
    {
      title: "직원별 자료",
      items: [
        "직원별 소득·세액공제신고서",
        "직원별 연말정산 간소화 자료 (PDF)",
        "부양가족 변동 사항 (결혼·출산·분가 등)",
        "중도 입사자: 종전 근무지 근로소득 원천징수영수증",
      ],
    },
    {
      title: "회사 자료",
      items: [
        "연간 급여대장 (상여·성과급 포함)",
        "비과세 급여 지급 내역 (식대·자가운전보조금·출산·보육수당 등)",
        "입사·퇴사자 명단과 입·퇴사일",
        "중소기업 취업자 소득세 감면 신청서 (해당 직원)",
      ],
    },
  ],
  withholding: [
    {
      title: "해당 월 지급 자료",
      items: [
        "급여대장 (상여·수당 포함)",
        "신규 입사자 인적사항과 입사일, 퇴사자 퇴사일",
        "사업소득(3.3%) 지급 내역: 지급받는 분 성명·주민등록번호·금액",
        "기타소득(강사료 등) 지급 내역",
        "퇴직금 지급 내역 (해당 시)",
      ],
    },
  ],
  capital_gains: [
    {
      title: "양도·취득 자료",
      items: ["양도 매매계약서", "취득 당시 매매계약서 (상속·증여 취득이면 당시 신고서)", "취득세 납부 영수증", "등기사항전부증명서"],
    },
    {
      title: "필요경비 증빙",
      items: ["양도·취득 시 중개수수료·법무사 비용 영수증", "자본적 지출 증빙 (발코니 확장·샷시·보일러 교체 등 세금계산서·계좌이체 내역)"],
    },
    {
      title: "비과세·감면 판단 자료",
      items: ["세대원 전원의 주택 보유 현황", "주민등록초본 (거주기간 확인)", "일시적 2주택 등 특례 해당 시 관련 계약서"],
    },
  ],
  inheritance: [
    {
      title: "기본 서류",
      items: ["피상속인 기본증명서·가족관계증명서·제적등본", "상속인 전원 신분 확인 자료", "상속재산 분할협의서 (작성된 경우)"],
    },
    {
      title: "재산·채무",
      items: [
        "부동산 목록과 등기사항전부증명서",
        "금융재산 잔액증명서 (사망일 기준, 안심상속 조회 결과)",
        "보험·퇴직금·사망보험금 내역",
        "대출 잔액증명서, 임대보증금 계약서",
        "장례비용 영수증",
      ],
    },
    {
      title: "사전증여·인출 검토",
      items: ["상속인에게 10년(상속인 외 5년) 내 증여한 재산 내역", "사망 전 2년 내 재산 처분·예금 인출 내역과 사용처"],
    },
  ],
  gift: [
    {
      title: "증여 자료",
      items: ["증여계약서", "증여재산 평가 자료 (부동산 시세·감정평가서, 주식 평가 자료)", "증여받는 분의 최근 10년 내 같은 증여자(배우자 포함)로부터의 증여 내역"],
    },
    {
      title: "해당 시",
      items: ["부담부증여: 인수 채무 증빙 (대출 잔액증명·임대차계약서)", "혼인·출산 증여재산공제: 혼인관계증명서·출생증명 자료", "가족관계증명서"],
    },
  ],
};

/** 법인·개인 구분에 따라 일부 항목을 바꾼다 */
const CLIENT_NOTES: Partial<Record<RequestKind, Item[]>> = {
  vat_final: [["법인카드 사용내역 중 홈택스 미등록분", corpOnly], ["대표자 개인카드 중 사업용으로 쓴 내역 (표시해서)", indivOnly]],
};

export function buildChecklist(kind: RequestKind, client: ClientType = "individual", vat: VatType = "general"): ChecklistSection[] {
  const ctx: Ctx = { client, vat };
  const pick = (items: Item[]) => items.filter((i) => typeof i === "string" || i[1](ctx)).map((i) => (typeof i === "string" ? i : i[0]));
  const sections = BOOK[kind].map((s) => ({ title: s.title, items: pick(s.items) }));
  const extra = pick(CLIENT_NOTES[kind] ?? []);
  // 매입 관련 보충 항목은 매입 자료 묶음에 붙인다
  const target = Math.max(0, sections.findIndex((s) => s.title.includes("매입")));
  if (extra.length) sections[target] = { ...sections[target], items: [...sections[target].items, ...extra] };
  return sections.filter((s) => s.items.length);
}

/** 고객 업종별로 더 받을 자료. 값은 사무소 프로필의 주요 고객층과 같다. */
export type Industry = "restaurant" | "rental" | "manufacturing" | "freelancer" | "medical" | "ecommerce" | "construction";

const INDUSTRY_ITEMS: Record<Industry, { vat?: string[]; income?: string[] }> = {
  restaurant: {
    vat: ["면세 농·수산물 매입 계산서·영수증 (의제매입세액공제)", "배달앱별 매출·수수료 정산내역", "신용카드 매출전표 발행금액 집계 (카드매출 세액공제)"],
    income: ["식자재 매입 증빙과 월별 매입 합계", "주방 설비·인테리어 투자 내역"],
  },
  rental: {
    vat: ["임차인별 보증금·월세·관리비 현황 (부동산임대공급가액명세서용)", "임대차계약 신규·변경·종료 내역", "임대 부동산의 취득·자본적 지출 증빙"],
    income: ["임대 부동산별 대출 이자 내역", "임대 부동산 재산세·보험료·수선비 증빙"],
  },
  manufacturing: {
    vat: ["원재료·상품 매입 세금계산서 (종이 발행분)", "수출 실적 증빙 (해당 시)"],
    income: ["기말 재고자산 실사표", "원재료 수불 내역", "외주 가공비 지급 내역"],
  },
  freelancer: {
    vat: [],
    income: ["사업소득 원천징수영수증·지급명세서 (3.3% 공제분)", "업무용 장비·교통비·통신비 등 경비 증빙", "작업실·사무실 임대료 내역"],
  },
  medical: {
    vat: ["비급여(과세) 진료 매출 구분 내역 (미용·성형 목적 등)", "의료장비 리스·구입 계약서"],
    income: ["건강보험공단 요양급여 지급 내역", "비급여 진료 현금영수증 발급 내역", "의료장비 리스료·감가상각 자산 목록"],
  },
  ecommerce: {
    vat: ["오픈마켓·자사몰·PG사별 정산내역", "해외 판매(수출)·구매대행 매출 구분 자료", "광고비(키워드·SNS) 결제 내역"],
    income: ["택배비·포장재 등 판매 부대비용 증빙", "재고 현황"],
  },
  construction: {
    vat: ["공사 도급계약서와 기성·준공 내역", "하도급 세금계산서와 지급 내역"],
    income: ["현장별 공사 원가 집계", "건설기계·장비 임차료 내역", "일용직 노무비 지급명세"],
  },
};

const VAT_KINDS: RequestKind[] = ["vat_final", "vat_preliminary"];
const INCOME_KINDS: RequestKind[] = ["personal_income", "corporate"];
export const industryApplies = (kind: RequestKind) => VAT_KINDS.includes(kind) || INCOME_KINDS.includes(kind);

export function industrySection(kind: RequestKind, industry: Industry, label: string): ChecklistSection | undefined {
  const set = INDUSTRY_ITEMS[industry];
  const items = VAT_KINDS.includes(kind) ? set.vat : INCOME_KINDS.includes(kind) ? [...(set.vat ?? []), ...(set.income ?? [])] : undefined;
  return items?.length ? { title: `${label} 업종 추가 자료`, items } : undefined;
}
