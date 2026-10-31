// 세무사 실무 보조 도구: 인용 점검, 세액·기한 계산, 쟁점 자료 묶음

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LawgoFault } from "../lawgo/client.js";
import type { Provision, ResolvedStatute } from "../lawgo/statutes.js";
import { RULING_SOURCES, type RulingKind } from "../lawgo/sources.js";
import { articleLabel, extractArticleRefs, type ArticleRef } from "../domain/citation.js";
import { canonicalLawName } from "../domain/taxLawBook.js";
import { corporateTax, personalIncomeTax } from "../domain/rateTables.js";
import { claimAndAssessmentWindows } from "../domain/dueDates.js";
import { OFFLINE, READ_ONLY, type Desks } from "./context.js";
import { guarded, NOTICE, paged, text, won } from "./reply.js";

type Verdict = "확인" | "조문 없음" | "항 없음" | "호 없음" | "삭제된 조문" | "법령 미확인" | "조회 실패";

interface RefCheck {
  ref: ArticleRef;
  verdict: Verdict;
  title?: string;
  detail?: string;
}

async function auditOne(
  d: Desks,
  ref: ArticleRef,
  lawCache: Map<string, Promise<{ law: ResolvedStatute; provisions: Provision[] }>>,
  asOf?: string,
): Promise<RefCheck> {
  if (!ref.law) return { ref, verdict: "법령 미확인", detail: "앞뒤 문맥에서 법령명을 찾지 못했습니다. defaultLaw를 지정하세요." };
  let entry = lawCache.get(ref.law);
  if (!entry) {
    entry = d.statutes.resolve(ref.law, asOf).then(async (law) => ({ law, provisions: await d.statutes.provisions(law) }));
    lawCache.set(ref.law, entry);
  }
  try {
    const { provisions } = await entry;
    const p = provisions.find((x) => x.article === ref.article && x.branch === ref.branch);
    if (!p) return { ref, verdict: "조문 없음" };
    if (p.repealed) return { ref, verdict: "삭제된 조문", title: p.title };
    if (ref.paragraph) {
      const c = p.clauses.find((x) => x.no === ref.paragraph);
      // 항 구분이 없는 조문(단일 문단)에서 제1항 인용은 허용
      if (!c && !(ref.paragraph === 1 && p.clauses.length <= 1)) {
        return { ref, verdict: "항 없음", title: p.title, detail: `항 ${p.clauses.length}개` };
      }
      if (c && ref.item && !c.items.some((it) => it.no === ref.item)) {
        return { ref, verdict: "호 없음", title: p.title, detail: `호 ${c.items.length}개` };
      }
    }
    return { ref, verdict: "확인", title: p.title };
  } catch (err) {
    if (err instanceof LawgoFault && err.code === "NO_MATCH") return { ref, verdict: "법령 미확인", detail: err.message };
    return { ref, verdict: "조회 실패", detail: err instanceof Error ? err.message : String(err) };
  }
}

export function registerPracticeTools(server: McpServer, d: Desks): void {
  server.registerTool(
    "check_references",
    {
      title: "인용 조문 점검",
      description:
        "의견서·검토메모·답변 초안에 적힌 조문 인용(예: '법인세법 시행령 제89조제3항', '같은 법 제52조')을 뽑아 실제 존재·삭제 여부와 항·호 범위를 법제처 원문과 대조합니다. 문언의 의미가 맞는지까지는 판단하지 않습니다.",
      inputSchema: {
        draft: z.string().min(5).max(40_000).describe("점검할 원고 텍스트"),
        defaultLaw: z.string().optional().describe("법령명이 생략된 인용에 적용할 법령 (예: 법인세법)"),
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("해당 시점 시행 법령 기준으로 점검"),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ draft, defaultLaw, asOf }) => {
      const fallback = defaultLaw ? canonicalLawName(defaultLaw) : "";
      const refs = extractArticleRefs(draft).map((r) => (r.law ? r : { ...r, law: fallback }));
      if (!refs.length) return text("원고에서 '제N조' 형태의 인용을 찾지 못했습니다.");
      const limited = refs.slice(0, 60);
      const cache = new Map<string, Promise<{ law: ResolvedStatute; provisions: Provision[] }>>();
      const results = await Promise.all(limited.map((r) => auditOne(d, r, cache, asOf)));

      const bad = results.filter((r) => r.verdict !== "확인");
      const lines = [
        `■ 인용 점검 결과: 총 ${results.length}건 · 확인 ${results.length - bad.length}건 · 주의 ${bad.length}건${asOf ? ` (기준일 ${asOf})` : " (현행 기준)"}`,
        ...(refs.length > limited.length ? [`(인용이 많아 앞의 ${limited.length}건만 점검했습니다)`] : []),
        "",
        "| # | 원문 표기 | 해석된 인용 | 판정 | 비고 |",
        "|---|---|---|---|---|",
        ...results.map(
          (r, i) =>
            `| ${i + 1} | ${r.ref.raw.replace(/\|/g, "/")} | ${r.ref.law || "?"} ${articleLabel(r.ref)} | ${r.verdict === "확인" ? "✅ 확인" : `⚠ ${r.verdict}`} | ${[r.title, r.detail].filter(Boolean).join(" / ")} |`,
        ),
        "",
        "판정은 조문·항·호의 '존재' 기준입니다. 인용 취지가 해당 문언과 맞는지는 read_provision으로 원문을 확인하세요.",
      ];
      return text(lines.join("\n") + `\n\n${NOTICE}`);
    }),
  );

  server.registerTool(
    "estimate_tax",
    {
      title: "산출세액 계산",
      description:
        "과세표준으로 법인세(사업연도 개시일 기준) 또는 종합소득세(귀속연도 기준) 산출세액을 누진 구간별로 계산합니다. 등록되지 않은 연도는 계산하지 않습니다.",
      inputSchema: {
        taxType: z.enum(["corporate", "personal"]).describe("corporate=법인세, personal=종합소득세"),
        taxBase: z.number().min(0).describe("과세표준 (원)"),
        fiscalStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("법인세: 사업연도 개시일"),
        months: z.number().int().min(1).max(12).default(12).describe("법인세: 사업연도 월수 (1년 미만 환산)"),
        year: z.number().int().optional().describe("종합소득세: 귀속연도"),
      },
      annotations: OFFLINE,
    },
    guarded(async ({ taxType, taxBase, fiscalStart, months, year }) => {
      let r;
      if (taxType === "corporate") {
        if (!fiscalStart) throw new RangeError("법인세는 fiscalStart(사업연도 개시일)가 필요합니다.");
        r = corporateTax(taxBase, fiscalStart, months);
      } else {
        if (!year) throw new RangeError("종합소득세는 year(귀속연도)가 필요합니다.");
        r = personalIncomeTax(taxBase, year);
      }
      const lines = [
        `■ ${taxType === "corporate" ? "법인세" : "종합소득세"} 산출세액`,
        `근거: ${r.legalBasis}`,
        `과세표준: ${won(r.taxBase)}`,
        "",
        "| 구간 | 세율 | 해당 금액 | 세액 |",
        "|---|---|---|---|",
        ...r.lines.map((l) => `| ${l.range} | ${l.pct}% | ${won(l.slice)} | ${won(l.tax)} |`),
        "",
        `산출세액: **${won(r.computedTax)}** (실효세율 ${r.effectivePct}%, 한계세율 ${r.marginalPct}%)`,
        `지방소득세(추정): ${won(r.localIncomeTax)}`,
        "",
        ...r.notes.map((n) => `- ${n}`),
      ];
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "tax_deadline",
    {
      title: "신고·경정청구·제척기간",
      description:
        "세목과 과세기간 종료일로 법정신고기한, 경정청구 가능 기한(5년), 부과제척기간 만료일, 후발적 경정청구 기한을 계산합니다. 주말·고정 공휴일은 자동으로 다음 날로 넘깁니다.",
      inputSchema: {
        kind: z.enum(["corporate", "personal", "vat", "inheritance", "gift"]),
        periodEnd: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("법인=사업연도 종료일, 개인=귀속연도 12-31, 부가세=과세기간 종료일(06-30/12-31), 상속=상속개시일, 증여=증여일"),
        diligentFiler: z.boolean().default(false).describe("성실신고확인 대상 여부"),
        abroad: z.boolean().default(false).describe("상속세 국외 거주 특례"),
        assessmentCase: z.enum(["standard", "unfiled", "fraud"]).default("standard").describe("제척기간 유형: 일반/무신고/부정행위"),
        lateEventKnownOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("후발적 사유(판결 확정 등)를 안 날"),
        extraHolidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]).describe("추가 휴일 (설·추석·대체공휴일 등)"),
        today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("남은 일수 계산 기준일 (기본: 오늘)"),
      },
      annotations: OFFLINE,
    },
    guarded(async (args) => {
      const r = claimAndAssessmentWindows(args);
      const left = r.daysLeftForRefund >= 0 ? `D-${r.daysLeftForRefund}` : `기한 경과 ${-r.daysLeftForRefund}일`;
      const lines = [
        "■ 기한 계산",
        `법정신고기한: ${r.filing.due}${r.filing.shiftedFrom ? ` (원래 ${r.filing.shiftedFrom}, 휴일로 순연)` : ""}`,
        `  근거: ${r.filing.basis}`,
        `경정청구 기한: ${r.refundClaimUntil} (${left})`,
        `  근거: ${r.refundClaimBasis}`,
        r.lateEventClaimUntil ? `후발적 경정청구 기한: ${r.lateEventClaimUntil}\n  근거: 국세기본법 제45조의2제2항 (사유를 안 날부터 3개월)` : "",
        `부과제척기간 만료: ${r.assessmentUntil}`,
        `  근거: ${r.assessmentBasis}`,
        "",
        ...r.caveats.map((c) => `- ${c}`),
      ];
      return text(lines.filter(Boolean).join("\n"));
    }),
  );

  server.registerTool(
    "build_issue_brief",
    {
      title: "쟁점 자료 묶음",
      description:
        "하나의 세무 쟁점에 대해 관련 법령 조문(본문 검색), 행정규칙, 판례·심판례·해석례 후보를 한 번에 모아 후속 조회용 식별자와 함께 돌려줍니다. 검토메모 작성의 첫 단계로 사용하세요.",
      inputSchema: {
        issue: z.string().min(2).describe("쟁점 키워드 (예: 업무무관 가지급금 지급이자 손금불산입)"),
        perSource: z.number().int().min(1).max(10).default(4),
        rulingSources: z
          .array(z.enum(["court", "constitutional", "tribunal", "moleg"]))
          .default(["court", "tribunal", "moleg"]),
        cursor: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ issue, perSource, rulingSources, cursor }) => {
      const [statutes, rules, ...rulings] = await Promise.allSettled([
        d.statutes.find(issue, { inBody: true, limit: perSource * 2 }),
        d.guidance.findAdminRules(issue, { inBody: true, limit: perSource }),
        ...rulingSources.map((k) => d.rulings.find(k as RulingKind, issue, { limit: perSource, fullText: true })),
      ]);
      const out: string[] = [`■ 쟁점: ${issue}`, ""];

      out.push("【1. 관련 법령 (본문 검색)】");
      if (statutes.status === "fulfilled" && statutes.value.rows.length) {
        statutes.value.rows.forEach((r, i) => out.push(`${i + 1}. ${r.name} [${r.kind}] → read_provision(law="${r.name}")`));
      } else out.push(statutes.status === "rejected" ? `[조회 실패] ${String(statutes.reason)}` : "결과 없음");

      out.push("", "【2. 행정규칙 (통칙·고시·예규)】");
      if (rules.status === "fulfilled" && rules.value.length) {
        rules.value.forEach((r, i) => out.push(`${i + 1}. ${r.name} (${r.ministry}) → find_admin_rule(id="${r.id}")`));
      } else out.push(rules.status === "rejected" ? `[조회 실패] ${String(rules.reason)}` : "결과 없음");

      rulings.forEach((s, i) => {
        const kind = rulingSources[i] as RulingKind;
        out.push("", `【${3 + i}. ${RULING_SOURCES[kind].label}】`);
        if (s.status === "rejected") return void out.push(`[조회 실패] ${String(s.reason)}`);
        if (!s.value.rows.length) return void out.push("결과 없음");
        s.value.rows.forEach((r, j) =>
          out.push(`${j + 1}. ${r.title} [${[r.caseNo, r.date].filter(Boolean).join(" · ")}] → read_ruling(source="${kind}", id="${r.id}")`),
        );
      });

      out.push(
        "",
        "다음 단계 제안: ① 핵심 조문을 read_provision으로 확인 → ② trace_delegation으로 시행령 위임 범위 확인 → ③ 유리·불리 결정례 본문 대조 → ④ 초안 작성 후 check_references로 인용 점검",
      );
      return paged(out.join("\n"), cursor, d.cfg.charBudget);
    }),
  );
}
