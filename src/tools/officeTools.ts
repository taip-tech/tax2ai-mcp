// 사무소 업무 도구: 사무소 프로필, 신고 자료요청문, 채용공고 작성·법률 점검.
// 문안은 서버가 규칙대로 만들고(사무소 정보·기한 자동 반영), 모델은 다듬기만 한다.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildChecklist,
  industryApplies,
  industrySection,
  kindLabel,
  REQUEST_KINDS,
  requestDeadline,
  requestSchedule,
  SUBMIT_FORMATS,
  type ClientType,
  type Industry,
  type RequestKind,
  type SubmitFormat,
  type VatType,
} from "../domain/docRequests.js";
import {
  checkMinimumWage,
  EMPLOYMENT_TYPES,
  employmentLabel,
  HIRE_ROLES,
  ROLE_DEFAULTS,
  roleLabel,
  scanPosting,
  type EmploymentType,
  type HireRole,
  type PayUnit,
  type PostingFinding,
} from "../domain/hiring.js";
import { parseDay } from "../domain/dueDates.js";
import {
  CLIENT_SEGMENTS,
  describeProfile,
  MY_ROLES,
  mergeProfile,
  OFFICE_SIZES,
  PRACTICE_AREAS,
  ProfileUnavailable,
  type ClientSegment,
  type OfficeProfile,
  type OfficeSize,
  type ProfileStore,
} from "../office/profile.js";
import { OFFLINE, READ_ONLY, type Desks } from "./context.js";
import { needsInput, type Question } from "./intake.js";
import { guarded, text } from "./reply.js";

const WEEKDAYS = "일월화수목금토";
const kday = (iso: string) => {
  const d = parseDay(iso);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${WEEKDAYS[d.getUTCDay()]})`;
};
const todayIso = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST

const PROFILE_HINT =
  "※ 사무소 정보를 등록하면 [ ] 자리가 자동으로 채워집니다. 대화로 등록(office_profile)하거나 tax2.ai 마이페이지 > 우리 사무소에서 설정하세요 (두 곳은 같은 정보입니다).";
const keysOf = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

async function loadProfileSafe(store: ProfileStore): Promise<{ profile: OfficeProfile; note?: string }> {
  try {
    return { profile: (await store.load()) ?? {} };
  } catch (err) {
    return { profile: {}, note: `※ 사무소 프로필을 불러오지 못했습니다: ${err instanceof Error ? err.message : err}` };
  }
}

// ── 자료요청문 ─────────────────────────────────────────────

type Channel = "kakao" | "email" | "letter";
const CHANNELS: { value: Channel; label: string }[] = [
  { value: "kakao", label: "카카오톡·문자 (짧게)" },
  { value: "email", label: "이메일 (제목·서명 포함)" },
  { value: "letter", label: "공문·안내문 (인쇄용)" },
];

interface RequestDraftInput {
  kind: RequestKind;
  channel: Channel;
  client: ClientType;
  vat: VatType;
  formats: SubmitFormat[];
  clientName?: string;
  periodLabel: string;
  filingDue: string;
  requestBy: string;
  sections: { title: string; items: string[] }[];
  profile: OfficeProfile;
}

export function renderDocumentRequest(x: RequestDraftInput): string {
  const p = x.profile;
  const office = p.officeName ?? "[사무소명]";
  const formal = (p.tone ?? "formal") === "formal";
  const who = x.clientName ? `${x.clientName}${x.client === "corporation" ? " 담당자님" : "님"}` : "고객님";
  const title = `${x.periodLabel} ${kindLabel(x.kind)} 자료 요청`;
  const please = formal ? "보내 주시기 바랍니다" : "보내 주세요";
  const formats = x.formats.map((f) => SUBMIT_FORMATS.find((s) => s.value === f)?.label ?? f).join(", ");
  const submit = p.submitChannel ?? "[자료 받는 곳: 이메일·카카오톡 채널 등]";
  const contact = [p.phone, p.email].filter(Boolean).join(" / ") || "[연락처]";
  const intro = `${x.periodLabel} ${kindLabel(x.kind)}(신고기한 ${kday(x.filingDue)}) 준비를 위해 아래 자료를 ${kday(x.requestBy)}까지 ${please}.`;
  const notApplicable = formal ? "해당 사항이 없는 항목은 '없음'으로 회신해 주시면 됩니다." : "해당 없는 항목은 '없음'이라고만 알려 주셔도 돼요.";

  if (x.channel === "kakao") {
    return [
      `[${office}] ${title}`,
      "",
      `안녕하세요, ${who}. ${office}입니다.`,
      intro,
      "",
      ...x.sections.flatMap((s) => [`▪ ${s.title}`, ...s.items.map((i) => ` - ${i}`)]),
      "",
      `보내실 수 있는 형식: ${formats}`,
      `보내실 곳: ${submit}`,
      notApplicable,
      `문의: ${contact}`,
    ].join("\n");
  }

  const numbered = x.sections.flatMap((s, i) => [`${i + 1}. ${s.title}`, ...s.items.map((it) => `   □ ${it}`), ""]);
  const signature = [
    office,
    p.representative ? `대표세무사 ${p.representative}` : "[대표세무사]",
    contact,
    p.address,
    p.website,
  ].filter(Boolean) as string[];

  if (x.channel === "email") {
    return [
      `제목: [${office}] ${title} (${kday(x.requestBy)}까지)`,
      "",
      `${who}, 안녕하세요. ${office}입니다.`,
      "",
      intro,
      "",
      ...numbered,
      `■ 제출 형식: ${formats}`,
      `■ 제출 방법: ${submit}`,
      "",
      notApplicable,
      formal ? "자료가 늦어지면 신고 준비 기간이 짧아질 수 있으니 기한 내 송부를 부탁드립니다." : "자료가 늦어지면 신고 준비가 빠듯해지니 기한 안에 부탁드려요.",
      p.closingNote ?? (formal ? "늘 믿고 맡겨 주셔서 감사합니다." : "항상 감사합니다!"),
      "",
      "--",
      ...signature,
    ].join("\n");
  }

  return [
    `수신: ${who === "고객님" ? "[고객명] 귀하" : `${x.clientName} 귀하`}`,
    `발신: ${office}`,
    `제목: ${title}`,
    "",
    `1. 귀하의 무궁한 발전을 기원합니다.`,
    `2. ${x.periodLabel} ${kindLabel(x.kind)}의 법정신고기한은 ${kday(x.filingDue)}입니다. 원활한 신고를 위하여 아래 자료를 ${kday(x.requestBy)}까지 송부하여 주시기 바랍니다.`,
    "",
    "- 아   래 -",
    "",
    ...numbered,
    `제출 형식: ${formats}`,
    `제출 방법: ${submit}`,
    "",
    `3. ${notApplicable}`,
    "",
    `${todayIso().replace(/-/g, ".")}.`,
    ...signature,
  ].join("\n");
}

// ── 채용공고 ──────────────────────────────────────────────

type PostingStyle = "jobsite" | "short";

interface PostingInput {
  role: HireRole;
  employmentType: EmploymentType;
  headcount?: number;
  pay: string;
  workDays?: string;
  workHours?: string;
  location?: string;
  duties: string[];
  requirements: string[];
  preferred: string[];
  benefits: string[];
  probation?: string;
  process?: string;
  deadline?: string;
  applyMethod?: string;
  style: PostingStyle;
  profile: OfficeProfile;
}

export function renderPosting(x: PostingInput): string {
  const office = x.profile.officeName ?? "[사무소명]";
  const title = `[${office}] ${roleLabel(x.role)} ${x.headcount ? `${x.headcount}명 ` : ""}채용 (${employmentLabel(x.employmentType)})`;
  const location = x.location ?? x.profile.address ?? "[근무지 주소]";
  const apply = x.applyMethod ?? (x.profile.email ? `이메일 접수 (${x.profile.email})` : "[접수 방법]");
  const deadline = x.deadline ? `${kday(x.deadline)}까지 (채용 시 조기 마감될 수 있음)` : "채용 시 마감";
  const list = (xs: string[]) => xs.map((s) => `- ${s}`);

  if (x.style === "short") {
    return [
      title,
      "",
      `▪ 하는 일: ${x.duties.slice(0, 3).join(", ")}`,
      `▪ 자격: ${x.requirements.join(", ")}`,
      x.preferred.length ? `▪ 우대: ${x.preferred.join(", ")}` : "",
      `▪ 급여: ${x.pay}`,
      `▪ 근무: ${[x.workDays, x.workHours].filter(Boolean).join(" ") || "[근무 요일·시간]"} / ${location}`,
      `▪ 지원: ${apply} · ${deadline}`,
      x.profile.phone ? `▪ 문의: ${x.profile.phone}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    title,
    "",
    "■ 모집 부문",
    `- ${roleLabel(x.role)} / ${employmentLabel(x.employmentType)}${x.headcount ? ` / ${x.headcount}명` : ""}`,
    "",
    "■ 담당 업무",
    ...list(x.duties),
    "",
    "■ 자격 요건",
    ...list(x.requirements),
    "",
    ...(x.preferred.length ? ["■ 우대 사항", ...list(x.preferred), ""] : []),
    "■ 근무 조건",
    `- 급여: ${x.pay}`,
    `- 근무 요일·시간: ${[x.workDays, x.workHours].filter(Boolean).join(", ") || "[근무 요일·시간]"}`,
    `- 근무지: ${location}`,
    ...(x.probation ? [`- 수습: ${x.probation}`] : []),
    "",
    ...(x.benefits.length ? ["■ 복리후생", ...list(x.benefits), ""] : []),
    "■ 전형 절차",
    `- ${x.process ?? "서류 전형 → 면접 → 최종 합격"}`,
    "",
    "■ 접수",
    `- 방법: ${apply}`,
    `- 기간: ${deadline}`,
    "- 제출 서류: 이력서, 경력기술서(경력자) / 사진 첨부 불필요",
    ...(x.profile.phone ? [`- 문의: ${x.profile.phone}`] : []),
  ].join("\n");
}

const SEVERITY_LABEL = { high: "위반 소지 높음", caution: "주의" } as const;

/** 점검 결과의 근거 조문을 법제처 원문에서 실제로 확인한다 (실패해도 결과는 낸다) */
async function verifyLawRefs(d: Desks, findings: PostingFinding[]): Promise<Map<string, string>> {
  const keys = [...new Set(findings.map((f) => `${f.rule.law}|${f.rule.article}|${f.rule.branch ?? 0}`))];
  const out = new Map<string, string>();
  await Promise.all(
    keys.map(async (k) => {
      const [law, a, b] = k.split("|");
      try {
        const resolved = await d.statutes.resolve(law);
        const [p] = await d.statutes.provisions(resolved, { article: +a, branch: +b });
        out.set(k, p ? `✓ 원문 확인: ${resolved.name} 제${a}조${+b ? `의${b}` : ""}(${p.title})` : "원문에서 조문을 찾지 못함");
      } catch {
        out.set(k, "원문 확인 실패 (법령 조회 불가)");
      }
    }),
  );
  return out;
}

function reportFindings(findings: PostingFinding[], verified: Map<string, string>, size?: OfficeSize): string {
  if (!findings.length) return "✅ 표현 점검: 연령·성별·신체조건·개인정보·무급수습 관련 문제 표현이 발견되지 않았습니다.";
  const rows = findings.map((f, i) => {
    const r = f.rule;
    const ref = `${r.law} 제${r.article}조${r.branch ? `의${r.branch}` : ""}`;
    return [
      `${i + 1}. [${SEVERITY_LABEL[r.severity]}] ${r.issue}`,
      `   문제 표현: ${f.matches.map((m) => `"${m}"`).join(", ")}`,
      `   고칠 방법: ${r.fix}`,
      `   근거: ${ref}${verified.get(`${r.law}|${r.article}|${r.branch ?? 0}`) ? ` — ${verified.get(`${r.law}|${r.article}|${r.branch ?? 0}`)}` : ""}`,
      r.scopeNote
        ? `   적용 범위: ${r.scopeNote}${size === "large" ? " → 사무소 설정상 30명 이상이므로 적용 대상입니다." : size ? ` → 사무소 설정상 ${OFFICE_SIZES[size]} 규모라 직접 적용 대상은 아니지만 빼는 것을 권장합니다.` : ""}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [`⚠ 표현 점검: ${findings.length}건`, ...rows].join("\n");
}

// ── 등록 ──────────────────────────────────────────────────

export function registerOfficeTools(server: McpServer, d: Desks, store: ProfileStore): void {
  const webSettings = `${d.cfg.brandUrl.replace(/\/+$/, "")}/mypage/office`;

  server.registerTool(
    "office_profile",
    {
      title: "사무소 프로필",
      description:
        "자료요청문·채용공고에 자동으로 들어갈 사무소 정보(사무소명, 대표세무사, 연락처, 주소, 자료 제출 방법, 자료 마감 기준일수, 말투)와 사무소 구성(내 역할, 규모, 주력 업무, 주요 고객층)을 보거나 저장합니다. tax2.ai 마이페이지 > 우리 사무소 화면과 같은 정보라 어느 쪽에서 바꿔도 함께 반영됩니다. 저장할 때는 바꿀 항목만 넣으면 되고, 빈 문자열은 그 항목을 지웁니다. 고객 정보는 저장하지 않습니다.",
      inputSchema: {
        action: z.enum(["view", "save"]).default("view"),
        officeName: z.string().max(100).optional(),
        representative: z.string().max(50).optional().describe("대표세무사 이름"),
        phone: z.string().max(50).optional(),
        email: z.string().max(100).optional(),
        address: z.string().max(200).optional(),
        website: z.string().max(200).optional(),
        submitChannel: z.string().max(200).optional().describe("고객 자료 받는 방법 (예: 이메일 회신 또는 카카오톡 채널 'OO세무회계')"),
        leadDays: z.number().int().min(1).max(60).optional().describe("자료 마감 = 신고기한 며칠 전 (기본 10)"),
        tone: z.enum(["formal", "friendly"]).optional().describe("formal=격식체, friendly=친근체"),
        closingNote: z.string().max(200).optional().describe("메일 맺음 문구"),
        myRole: z.enum(keysOf(MY_ROLES)).optional().describe("owner=대표세무사, tax_accountant=근무세무사, staff=직원, student=수강생"),
        officeSize: z.enum(keysOf(OFFICE_SIZES)).optional().describe("solo=1인, small=2~9명, medium=10~29명, large=30명 이상"),
        practiceAreas: z.array(z.enum(keysOf(PRACTICE_AREAS))).max(4).optional().describe("bookkeeping=기장·신고, corporate_advisory=법인 컨설팅, property_estate=양도·상속·증여, audit_appeal=조사·불복 (빈 배열이면 지움)"),
        clientSegments: z.array(z.enum(keysOf(CLIENT_SEGMENTS))).max(7).optional().describe("restaurant=음식점, rental=부동산임대, manufacturing=제조·도소매, freelancer=프리랜서, medical=병의원, ecommerce=온라인 판매, construction=건설"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ action, ...fields }) => {
      try {
        if (action === "view") {
          const p = await store.load();
          return text(`■ 사무소 프로필 (저장 위치: ${store.where})\n${describeProfile(p)}\n\n웹에서 보기·수정: ${webSettings}${p ? "" : `\n${PROFILE_HINT.replace("※ ", "")}`}`);
        }
        const merged = mergeProfile(await store.load(), fields as OfficeProfile);
        await store.save(merged);
        return text(`■ 사무소 프로필을 저장했습니다 (저장 위치: ${store.where})\n${describeProfile(merged)}\n\n웹에서도 바로 확인할 수 있습니다: ${webSettings}`);
      } catch (err) {
        if (err instanceof ProfileUnavailable) return text(`[PROFILE_UNAVAILABLE] ${err.message}`);
        throw err;
      }
    }),
  );

  server.registerTool(
    "draft_document_request",
    {
      title: "신고 자료요청문 작성",
      description:
        "부가세·법인세·종소세·연말정산·원천세·양도세·상속세·증여세 신고에 필요한 고객 자료요청문을 만듭니다. 세목별 서류 체크리스트, 법정신고기한, 자료 마감일(휴일 반영)을 자동으로 넣고 사무소 프로필(사무소명·연락처·제출 방법·말투)을 반영합니다. 형식은 카카오톡·이메일·공문 중 선택. 필수 정보가 없으면 객관식 질문 목록을 돌려주니, 사용자에게 고르게 한 뒤 다시 호출하세요.",
      inputSchema: {
        kind: z.enum(REQUEST_KINDS.map((k) => k.value) as [RequestKind, ...RequestKind[]]).optional().describe("세목"),
        channel: z.enum(["kakao", "email", "letter"]).optional().describe("kakao=카톡·문자, email=이메일, letter=공문"),
        clientType: z.enum(["individual", "corporation"]).optional().describe("individual=개인사업자·개인, corporation=법인"),
        vatType: z.enum(["general", "simplified"]).optional().describe("부가세: general=일반과세, simplified=간이과세 (개인만)"),
        formats: z.array(z.enum(SUBMIT_FORMATS.map((f) => f.value) as [SubmitFormat, ...SubmitFormat[]])).optional().describe("고객이 보낼 수 있는 파일 형식"),
        year: z.number().int().min(2000).max(2100).optional().describe("귀속연도·과세연도"),
        half: z.union([z.literal(1), z.literal(2)]).optional().describe("부가세 1기=1, 2기=2"),
        month: z.number().int().min(1).max(12).optional().describe("원천세 지급월"),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("법인 사업연도 종료일 (12월 결산이 아닐 때)"),
        eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("양도일(잔금일)·상속개시일·증여일"),
        diligentFiler: z.boolean().optional().describe("성실신고확인 대상"),
        clientName: z.string().max(60).optional().describe("받는 고객 이름·상호 (저장하지 않음)"),
        requestBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("자료 마감일 직접 지정"),
        industry: z.enum([...keysOf(CLIENT_SEGMENTS), "general"]).optional().describe("고객 업종 (업종별 추가 자료 반영, general=해당 없음)"),
        addItems: z.array(z.string().max(120)).max(20).optional().describe("목록에 더할 항목"),
        removeKeywords: z.array(z.string().max(30)).max(20).optional().describe("이 단어가 들어간 항목은 뺌"),
      },
      annotations: OFFLINE,
    },
    guarded(async (a) => {
      const kind = a.kind;
      const client: ClientType | undefined = a.clientType ?? (kind === "corporate" || kind === "vat_preliminary" ? "corporation" : kind === "personal_income" || kind === "capital_gains" || kind === "inheritance" || kind === "gift" ? "individual" : undefined);
      const isVat = kind === "vat_final" || kind === "vat_preliminary";
      const vat: VatType | undefined = client === "corporation" ? "general" : a.vatType ?? (isVat ? undefined : "general");

      const qs: Question[] = [];
      if (!kind) qs.push({ arg: "kind", ask: "어떤 신고의 자료를 요청할까요?", choices: REQUEST_KINDS.map((k) => ({ label: k.label, value: k.value })) });
      if (!client && (!kind || kind === "vat_final" || kind === "year_end" || kind === "withholding"))
        qs.push({ arg: "clientType", ask: "고객 유형은?", choices: [{ label: "개인사업자", value: "individual" }, { label: "법인", value: "corporation" }] });
      if (kind === "vat_final" && client !== "corporation" && !a.vatType)
        qs.push({ arg: "vatType", ask: "과세 유형은?", choices: [{ label: "일반과세자", value: "general" }, { label: "간이과세자", value: "simplified" }] });
      if (kind) {
        const sched = requestSchedule(kind, { year: a.year, half: a.half, month: a.month, periodEnd: a.periodEnd, eventDate: a.eventDate }, { vatType: vat, diligentFiler: a.diligentFiler });
        if ("missing" in sched) {
          for (const m of sched.missing) {
            if (m === "year") {
              const y = +todayIso().slice(0, 4);
              qs.push({ arg: "year", ask: "몇 년 귀속(과세기간)인가요?", choices: [y - 1, y].map((v) => ({ label: `${v}년`, value: String(v) })) });
            } else if (m === "half") qs.push({ arg: "half", ask: "어느 과세기간인가요?", choices: [{ label: "1기 (1~6월)", value: "1" }, { label: "2기 (7~12월)", value: "2" }] });
            else if (m === "month") qs.push({ arg: "month", ask: "몇 월 지급분인가요?", example: "9" });
            else if (m === "eventDate") qs.push({ arg: "eventDate", ask: kind === "capital_gains" ? "양도일(잔금일)은?" : kind === "gift" ? "증여일은?" : "상속개시일은?", example: "2026-09-15" });
          }
        }
      }
      if (!a.channel) qs.push({ arg: "channel", ask: "어떤 형식으로 보낼까요?", choices: CHANNELS.map((c) => ({ label: c.label, value: c.value })) });
      // 사무소 설정의 주요 고객층이 있으면 업종을 물어 업종별 자료를 더한다
      const { profile, note } = await loadProfileSafe(store);
      const segments = profile.clientSegments ?? [];
      if (!a.industry && segments.length && (!kind || industryApplies(kind)))
        qs.push({ arg: "industry", ask: "이 고객의 업종은? (사무소 설정의 주요 고객층)", choices: [...segments.map((s) => ({ label: CLIENT_SEGMENTS[s], value: s })), { label: "해당 없음·기타", value: "general" }] });
      if (!a.formats?.length) qs.push({ arg: "formats", ask: "고객이 어떤 파일로 보내도 될까요?", multi: true, choices: SUBMIT_FORMATS.map((f) => ({ label: f.label, value: f.value })) });
      if (qs.length) return needsInput("draft_document_request", "자료요청문 작성", qs);

      const sched = requestSchedule(kind!, { year: a.year, half: a.half, month: a.month, periodEnd: a.periodEnd, eventDate: a.eventDate }, { vatType: vat, diligentFiler: a.diligentFiler });
      if ("missing" in sched) throw new RangeError(`기간 정보가 부족합니다: ${sched.missing.join(", ")}`);
      const lead = profile.leadDays ?? 10;
      const requestBy = a.requestBy ?? requestDeadline(sched.filingDue, lead);

      let sections = buildChecklist(kind!, client!, vat!);
      if (a.removeKeywords?.length) {
        sections = sections.map((s) => ({ ...s, items: s.items.filter((i) => !a.removeKeywords!.some((k) => i.includes(k))) })).filter((s) => s.items.length);
      }
      if (a.industry && a.industry !== "general") {
        const extra = industrySection(kind!, a.industry as Industry, CLIENT_SEGMENTS[a.industry as ClientSegment]);
        if (extra) sections.push(extra);
      }
      if (a.addItems?.length) sections.push({ title: "추가 요청 자료", items: a.addItems });

      const draft = renderDocumentRequest({
        kind: kind!,
        channel: a.channel!,
        client: client!,
        vat: vat!,
        formats: a.formats!,
        clientName: a.clientName,
        periodLabel: sched.periodLabel,
        filingDue: sched.filingDue,
        requestBy,
        sections,
        profile,
      });

      const warnings: string[] = [];
      const today = todayIso();
      if (requestBy <= today) warnings.push(`⚠ 자료 마감일(${requestBy})이 오늘이거나 이미 지났습니다. requestBy로 직접 지정하세요.`);
      if (sched.filingDue < today) warnings.push(`⚠ 법정신고기한(${sched.filingDue})이 지났습니다. 기한후신고·가산세를 함께 안내하세요.`);
      if (sched.shiftedFrom) warnings.push(`신고기한은 휴일이라 ${sched.shiftedFrom} → ${sched.filingDue}로 미뤄졌습니다.`);
      warnings.push("설·추석·대체공휴일은 자동 반영되지 않으니 해당 시기에는 날짜를 확인하세요.");

      return text(
        [
          `■ 신고 정보: ${sched.periodLabel} ${kindLabel(kind!)} · 신고기한 ${sched.filingDue} (${sched.basis}) · 자료 마감 ${requestBy}${a.requestBy ? " (직접 지정)" : ` (신고기한 ${lead}일 전)`}`,
          "",
          "[문안 시작] — 아래 부분만 고객에게 보내세요",
          draft,
          "[문안 끝]",
          "",
          ...warnings,
          ...(note ? [note] : []),
          ...(profile.officeName ? [] : [PROFILE_HINT]),
          "목록은 일반적인 기본값입니다. 고객 사정에 맞게 addItems·removeKeywords로 조정할 수 있습니다.",
        ].join("\n"),
      );
    }),
  );

  const payDescribe = (unit?: PayUnit, amount?: number, negotiable?: boolean) => {
    if (!unit || !amount) return negotiable ? "면접 후 협의 (경력에 따라 결정)" : undefined;
    const won = `${Math.round(amount).toLocaleString("ko-KR")}원`;
    const base = unit === "annual" ? `연봉 ${won}` : unit === "monthly" ? `월 ${won}` : `시급 ${won}`;
    return negotiable ? `${base} 이상 (경력에 따라 협의)` : base;
  };

  server.registerTool(
    "draft_job_posting",
    {
      title: "채용공고 작성 + 법률 점검",
      description:
        "세무사 사무소 채용공고(근무세무사·사무장·경력·신입·신고 시즌 단기)를 직무별 기본 문안으로 만들고, 연령·성별·신체조건·개인정보 요구·무급수습 표현과 최저임금 미달 여부를 점검합니다. 근거 조문은 법제처 원문에서 실제로 확인해 표시합니다. 필수 정보가 없으면 객관식 질문 목록을 돌려주니, 사용자에게 고르게 한 뒤 다시 호출하세요.",
      inputSchema: {
        role: z.enum(HIRE_ROLES.map((r) => r.value) as [HireRole, ...HireRole[]]).optional(),
        employmentType: z.enum(EMPLOYMENT_TYPES.map((e) => e.value) as [EmploymentType, ...EmploymentType[]]).optional(),
        payUnit: z.enum(["annual", "monthly", "hourly"]).optional().describe("annual=연봉, monthly=월급, hourly=시급"),
        payAmount: z.number().positive().optional().describe("원 단위 금액 (예: 36000000)"),
        payNegotiable: z.boolean().optional().describe("금액 대신(또는 함께) '협의' 표시"),
        monthlyHours: z.number().int().min(20).max(260).optional().describe("월 소정근로시간 (주휴 포함, 기본 209)"),
        headcount: z.number().int().min(1).max(50).optional(),
        workDays: z.string().max(60).optional().describe("예: 주 5일(월~금)"),
        workHours: z.string().max(60).optional().describe("예: 09:00~18:00, 신고 기간 연장근무 시 수당 지급"),
        location: z.string().max(200).optional().describe("근무지 (생략 시 사무소 주소)"),
        extraDuties: z.array(z.string().max(120)).max(10).optional(),
        requirements: z.array(z.string().max(120)).max(10).optional().describe("기본 자격요건 대신 쓸 목록"),
        preferred: z.array(z.string().max(120)).max(10).optional().describe("기본 우대사항 대신 쓸 목록"),
        benefits: z.array(z.string().max(120)).max(15).optional().describe("예: 4대보험, 퇴직금, 신고 시즌 성과급"),
        probation: z.string().max(120).optional().describe("예: 3개월 (급여 100% 지급)"),
        process: z.string().max(120).optional(),
        deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        applyMethod: z.string().max(200).optional(),
        style: z.enum(["jobsite", "short"]).optional().describe("jobsite=채용사이트 붙여넣기용, short=카톡·SNS 짧은 버전"),
      },
      annotations: READ_ONLY,
    },
    guarded(async (a) => {
      const qs: Question[] = [];
      if (!a.role) qs.push({ arg: "role", ask: "어떤 자리를 채용하나요?", choices: HIRE_ROLES.map((r) => ({ label: r.label, value: r.value })) });
      if (!a.employmentType) qs.push({ arg: "employmentType", ask: "고용 형태는?", choices: EMPLOYMENT_TYPES.map((e) => ({ label: e.label, value: e.value })) });
      if (!(a.payUnit && a.payAmount) && !a.payNegotiable)
        qs.push({ arg: "payUnit + payAmount (또는 payNegotiable=true)", ask: "급여는 어떻게 표시할까요? 금액을 정했다면 단위와 금액을 알려 주세요.", choices: [{ label: "연봉 금액", value: "annual" }, { label: "월급 금액", value: "monthly" }, { label: "시급 금액", value: "hourly" }, { label: "면접 후 협의", value: "payNegotiable=true" }] });
      if (!a.style) qs.push({ arg: "style", ask: "어디에 올릴 공고인가요?", choices: [{ label: "채용사이트 (사람인·잡코리아 등) 붙여넣기용", value: "jobsite" }, { label: "카카오톡·SNS·블로그용 짧은 버전", value: "short" }] });
      if (qs.length) return needsInput("draft_job_posting", "채용공고 작성", qs);

      const { profile, note } = await loadProfileSafe(store);
      const base = ROLE_DEFAULTS[a.role!];
      const posting = renderPosting({
        role: a.role!,
        employmentType: a.employmentType!,
        headcount: a.headcount,
        pay: payDescribe(a.payUnit, a.payAmount, a.payNegotiable)!,
        workDays: a.workDays,
        workHours: a.workHours,
        location: a.location,
        duties: [...base.duties, ...(a.extraDuties ?? [])],
        requirements: a.requirements ?? base.requirements,
        preferred: a.preferred ?? base.preferred,
        benefits: a.benefits ?? ["4대보험", "퇴직금"],
        probation: a.probation,
        process: a.process,
        deadline: a.deadline,
        applyMethod: a.applyMethod,
        style: a.style!,
        profile,
      });

      const findings = scanPosting(posting);
      const verified = findings.length ? await verifyLawRefs(d, findings) : new Map<string, string>();
      const year = +(a.deadline ?? todayIso()).slice(0, 4);
      const wage = a.payUnit && a.payAmount ? checkMinimumWage(a.payUnit, a.payAmount, year, a.monthlyHours) : undefined;
      const extra: string[] = [];
      if (a.role === "tax_accountant") extra.push("ℹ 근무세무사는 세무사법에 따라 한국세무사회에 등록해야 직무를 수행할 수 있습니다. 공고의 자격요건에 등록 조건을 유지하세요.");

      return text(
        [
          "[공고 시작]",
          posting,
          "[공고 끝]",
          "",
          "■ 법률 점검",
          reportFindings(findings, verified, profile.officeSize),
          wage ? `${wage.ok === false ? "⚠" : wage.ok ? "✅" : "ℹ"} 최저임금: ${wage.message}` : "ℹ 최저임금: 금액이 없어 점검하지 않았습니다.",
          ...extra,
          ...(note ? [note] : []),
          ...(profile.officeName ? [] : [PROFILE_HINT]),
          "점검은 표현 패턴 기반 1차 선별입니다. 게시 전 최종 문구는 직접 확인하세요.",
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "check_job_posting",
    {
      title: "채용공고 법률 점검",
      description:
        "이미 작성된 채용공고 문구를 붙여 넣으면 연령·성별·신체조건·혼인 여부·출신지역·가족 재산 등 개인정보 요구·사진 요구·무급수습 표현을 찾아 근거 조문(법제처 원문 확인)과 고칠 문구를 제시합니다. 급여를 함께 주면 최저임금 미달 여부도 봅니다.",
      inputSchema: {
        posting: z.string().min(10).max(20_000),
        payUnit: z.enum(["annual", "monthly", "hourly"]).optional(),
        payAmount: z.number().positive().optional(),
        monthlyHours: z.number().int().min(20).max(260).optional(),
        year: z.number().int().min(2020).max(2100).optional().describe("최저임금 기준 연도 (기본 올해)"),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ posting, payUnit, payAmount, monthlyHours, year }) => {
      const { profile } = await loadProfileSafe(store);
      const findings = scanPosting(posting);
      const verified = findings.length ? await verifyLawRefs(d, findings) : new Map<string, string>();
      const y = year ?? +todayIso().slice(0, 4);
      const wage = payUnit && payAmount ? checkMinimumWage(payUnit, payAmount, y, monthlyHours) : undefined;
      return text(
        [
          "■ 채용공고 법률 점검",
          reportFindings(findings, verified, profile.officeSize),
          wage ? `${wage.ok === false ? "⚠" : wage.ok ? "✅" : "ℹ"} 최저임금: ${wage.message}` : "",
          "",
          "고친 공고 전문이 필요하면 문제 표현을 바꾼 버전을 사용자에게 함께 제시하세요.",
          "점검은 표현 패턴 기반 1차 선별입니다. 게시 전 최종 문구는 직접 확인하세요.",
        ]
          .filter((l, i, arr) => l !== "" || arr[i - 1] !== "")
          .join("\n"),
      );
    }),
  );
}
