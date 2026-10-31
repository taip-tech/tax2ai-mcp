// 세무사 사무소 채용공고: 직무별 기본 문안과 공고 문구 법률 점검 규칙.
// 점검은 표현 패턴 기반 1차 선별이며, 최종 판단은 사람이 한다.

export type HireRole = "tax_accountant" | "office_manager" | "experienced_staff" | "junior_staff" | "seasonal";
export type EmploymentType = "permanent" | "contract" | "part_time";
export type PayUnit = "annual" | "monthly" | "hourly";

export const HIRE_ROLES: { value: HireRole; label: string }[] = [
  { value: "tax_accountant", label: "근무세무사" },
  { value: "office_manager", label: "사무장" },
  { value: "experienced_staff", label: "경력 직원 (기장·신고)" },
  { value: "junior_staff", label: "신입 직원" },
  { value: "seasonal", label: "신고 시즌 단기 (5월 종소세·연말정산 등)" },
];

export const EMPLOYMENT_TYPES: { value: EmploymentType; label: string }[] = [
  { value: "permanent", label: "정규직" },
  { value: "contract", label: "계약직" },
  { value: "part_time", label: "아르바이트·단시간" },
];

export const roleLabel = (r: HireRole) => HIRE_ROLES.find((x) => x.value === r)?.label ?? r;
export const employmentLabel = (e: EmploymentType) => EMPLOYMENT_TYPES.find((x) => x.value === e)?.label ?? e;

export const ROLE_DEFAULTS: Record<HireRole, { duties: string[]; requirements: string[]; preferred: string[] }> = {
  tax_accountant: {
    duties: ["법인·개인 거래처 세무조정 및 각종 신고 검토", "세무 상담 및 의견서·검토메모 작성", "세무조사·불복 대응 지원", "직원 신고 업무 검토 및 지도"],
    requirements: ["세무사 자격 소지 및 세무사 등록(또는 등록 예정)"],
    preferred: ["세무사무소·회계법인 실무 경력", "법인 세무조정 경험", "조사 대응·불복 경험"],
  },
  office_manager: {
    duties: ["사무소 운영·직원 업무 관리", "거래처 관리 및 신규 수임 상담", "기장·신고 업무 일정 관리와 검토"],
    requirements: ["세무사무소 실무 경력"],
    preferred: ["직원 관리 경험", "전산세무 자격", "거래처 상담 경험"],
  },
  experienced_staff: {
    duties: ["거래처 기장 및 결산", "부가가치세·원천세·종합소득세·법인세 신고 실무", "거래처 증빙 관리 및 응대"],
    requirements: ["세무사무소 또는 기업 회계 실무 경력"],
    preferred: ["전산세무 2급 이상", "법인 결산 경험", "세무회계 프로그램 사용 능숙"],
  },
  junior_staff: {
    duties: ["전표 입력 및 증빙 정리", "부가가치세·원천세 신고 보조", "거래처 자료 수집·응대 보조"],
    requirements: ["성실하게 배우려는 자세"],
    preferred: ["전산회계·전산세무 자격", "회계·세무 관련 전공 또는 교육 이수", "엑셀 활용 가능"],
  },
  seasonal: {
    duties: ["신고 자료 정리 및 입력 보조", "간소화 자료 취합 등 신고 시즌 업무 지원"],
    requirements: ["신고 기간 중 정해진 근무일 출근 가능"],
    preferred: ["세무·회계 관련 자격 또는 교육 이수", "세무사무소 단기 근무 경험"],
  },
};

/** 연도별 최저시급 (최저임금위원회 고시). 표에 없는 연도는 확인 필요로 안내한다. */
export const MINIMUM_HOURLY: Record<number, number> = {
  2024: 9_860,
  2025: 10_030,
  2026: 10_320,
};
/** 주 40시간 + 주휴 → 월 환산 209시간 */
export const MONTHLY_HOURS = 209;

export interface PayCheck {
  ok: boolean | null;
  message: string;
}

export function checkMinimumWage(unit: PayUnit, amount: number, year: number, monthlyHours = MONTHLY_HOURS): PayCheck {
  const rate = MINIMUM_HOURLY[year];
  if (!rate) return { ok: null, message: `${year}년 최저임금은 내장 표에 없습니다. 최저임금위원회 고시액을 확인하세요.` };
  const monthlyMin = rate * monthlyHours;
  const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
  if (unit === "hourly") {
    return amount >= rate
      ? { ok: true, message: `시급 ${won(amount)} ≥ ${year}년 최저시급 ${won(rate)}` }
      : { ok: false, message: `시급 ${won(amount)}이 ${year}년 최저시급 ${won(rate)}보다 낮습니다 (최저임금법 제6조).` };
  }
  const monthly = unit === "monthly" ? amount : amount / 12;
  const label = unit === "monthly" ? `월급 ${won(amount)}` : `연봉 ${won(amount)} (월 ${won(monthly)})`;
  if (monthly >= monthlyMin) return { ok: true, message: `${label} ≥ ${year}년 월 환산 최저임금 ${won(monthlyMin)} (${monthlyHours}시간 기준)` };
  return {
    ok: false,
    message: `${label}이 ${year}년 월 환산 최저임금 ${won(monthlyMin)} (${monthlyHours}시간 기준)보다 낮을 수 있습니다. 연봉에 퇴직금을 포함했다면 따로 표시하고, 소정근로시간을 확인하세요 (최저임금법 제6조).`,
  };
}

export type Severity = "high" | "caution";

export interface PostingRule {
  id: string;
  pattern: RegExp;
  severity: Severity;
  issue: string;
  fix: string;
  /** 법령명·조문 (원문 확인 대상) */
  law: string;
  article: number;
  branch?: number;
  scopeNote?: string;
}

export const POSTING_RULES: PostingRule[] = [
  {
    id: "age",
    pattern: /(만\s*)?\d{2}\s*세\s*(이하|미만|이상|까지|~)|\d{2}\s*[~∼-]\s*\d{2}\s*세|(나이|연령)\s*제한|\d{2}년생|[2-5]0대\s*(만|우대|선호|환영|지원)?|젊은\s*(분|인재|직원)/g,
    severity: "high",
    issue: "합리적 이유 없는 연령 제한·우대 표현",
    fix: "연령 표현을 지우고 '관련 경력 ○년 이상'처럼 직무 요건으로 바꾸세요.",
    law: "고용상 연령차별금지 및 고령자고용촉진에 관한 법률",
    article: 4,
    branch: 4,
  },
  {
    id: "gender",
    pattern: /(남|여)(성|자)\s*(만|우대|한정|선호|직원\s*모집)|(여|남)직원|(여|남)\s*사원|(남|여)성\s*지원\s*불가/g,
    severity: "high",
    issue: "성별을 제한하거나 우대하는 표현",
    fix: "'성별 무관'으로 바꾸거나 성별 표현을 지우세요.",
    law: "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률",
    article: 7,
  },
  {
    id: "body_marital",
    pattern: /(키|신장)\s*\d|체중|몸무게|용모\s*(단정|우수|단아)|외모|미혼|기혼\s*(자\s*)?(우대|불가)|결혼\s*(여부|계획)|출산\s*계획|인상\s*(좋은|이\s*좋은)/g,
    severity: "high",
    issue: "직무와 무관한 신체 조건·혼인 여부 요구",
    fix: "해당 표현을 지우세요. 응대 업무라면 '고객 응대에 친절한 분'처럼 행동 요건으로 쓰세요.",
    law: "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률",
    article: 7,
  },
  {
    id: "personal_info",
    pattern: /출신\s*(지역|학교)|본적|고향|(부모|가족|형제)(님)?\s*(의\s*)?(직업|학력|재산)|재산\s*(상황|정도)|혈액형|종교/g,
    severity: "high",
    issue: "출신지역·가족의 직업·재산 등 직무와 무관한 개인정보 요구",
    fix: "해당 항목을 지원서·공고에서 빼세요.",
    law: "채용절차의 공정화에 관한 법률",
    article: 4,
    branch: 3,
    scopeNote: "상시 근로자 30명 이상 사업장에 적용 (그 미만이라도 개인정보 최소 수집 원칙상 빼는 것이 안전).",
  },
  {
    id: "photo",
    pattern: /사진\s*(부착|첨부|필수|포함)|증명\s*사진/g,
    severity: "caution",
    issue: "지원서 사진 요구 (용모 정보 수집)",
    fix: "사진 요구를 빼거나 '사진 첨부 불필요'로 적으세요.",
    law: "채용절차의 공정화에 관한 법률",
    article: 4,
    branch: 3,
    scopeNote: "상시 근로자 30명 이상 사업장에 적용.",
  },
  {
    id: "health",
    pattern: /신체\s*(건강|건장)한|건강한\s*(분|사람)|장애\s*(인\s*)?(불가|제외)/g,
    severity: "caution",
    issue: "직무와 무관한 건강·장애 관련 제한",
    fix: "건강·장애 관련 표현을 지우고, 꼭 필요한 직무 수행 조건만 구체적으로 적으세요.",
    law: "장애인차별금지 및 권리구제 등에 관한 법률",
    article: 10,
  },
  {
    id: "unpaid_probation",
    pattern: /수습[^.\n]{0,20}(무급|급여\s*없|무보수)|무급\s*(수습|인턴|교육)/g,
    severity: "high",
    issue: "무급 수습·교육 기간",
    fix: "수습 기간에도 임금을 지급해야 합니다. 1년 이상 계약의 수습 3개월 이내라면 최저임금의 90%까지 감액할 수 있습니다.",
    law: "최저임금법",
    article: 5,
  },
];

export interface PostingFinding {
  rule: PostingRule;
  matches: string[];
}

export function scanPosting(text: string): PostingFinding[] {
  const out: PostingFinding[] = [];
  for (const rule of POSTING_RULES) {
    const found = new Set<string>();
    for (const m of text.matchAll(rule.pattern)) {
      const phrase = m[0].trim();
      // "남녀 무관", "성별 무관", "나이 무관" 같은 허용 표현은 건너뛴다
      const around = text.slice(Math.max(0, (m.index ?? 0) - 4), (m.index ?? 0) + phrase.length + 6);
      if (/무관|불문|상관\s*없|제한\s*없|불필요|없음/.test(around) && rule.id !== "unpaid_probation") continue;
      found.add(phrase);
    }
    if (found.size) out.push({ rule, matches: [...found].slice(0, 5) });
  }
  return out;
}
