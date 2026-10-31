// 세무 현장 계산(가산세·기업업무추진비·인정이자)과 조세조약 조회

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { outline } from "../lawgo/guidance.js";
import { deemedInterest, entertainmentLimit, penaltyEstimate } from "../domain/fieldCalc.js";
import { OFFLINE, READ_ONLY, type Desks } from "./context.js";
import { guarded, paged, text, won } from "./reply.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function registerFieldTools(server: McpServer, d: Desks): void {
  server.registerTool(
    "estimate_penalty",
    {
      title: "가산세 추정 (감면 포함)",
      description:
        "무신고·과소신고 가산세와 납부지연가산세를 계산하고, 수정신고·기한후신고 시점에 따른 감면율(국세기본법 제48조)을 적용합니다. 수정신고 시점별 부담 비교에 사용하세요.",
      inputSchema: {
        kind: z.enum(["unfiled", "underreported"]).describe("unfiled=무신고(기한후신고), underreported=과소신고(수정신고)"),
        shortTax: z.number().min(0).describe("덜 낸 세액 (원)"),
        fraud: z.boolean().default(false).describe("부정행위 여부"),
        revenue: z.number().min(0).optional().describe("법인·복식부기의무자 수입금액 (수입금액 기준 비교)"),
        dueDate: day.describe("법정신고(납부)기한"),
        filedOn: day.optional().describe("수정신고·기한후신고일"),
        paidOn: day.optional().describe("납부일 (없으면 filedOn)"),
      },
      annotations: OFFLINE,
    },
    guarded(async (args) => {
      const r = penaltyEstimate(args);
      return text(
        [
          "■ 가산세 추정",
          `근거: ${r.reportBasis}`,
          ...r.lines.map((l) => `- ${l}`),
          "",
          `신고불성실 가산세: ${won(r.reportPenalty)} → 감면 ${r.reliefPct}% 후 ${won(r.reportAfterRelief)}`,
          `납부지연가산세: ${won(r.latePaymentPenalty)} (${r.lateDays}일)`,
          `합계: **${won(r.total)}**`,
          "",
          ...r.notes.map((n) => `- ${n}`),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "entertainment_limit",
    {
      title: "기업업무추진비 한도",
      description: "법인의 기업업무추진비(접대비) 손금 한도와 한도초과액을 계산합니다. 기본한도(중소기업 여부·사업연도 월수)와 수입금액 기준 한도(특수관계인 거래분 10%)를 반영합니다.",
      inputSchema: {
        fiscalStart: day.describe("사업연도 개시일 (2020~2026)"),
        months: z.number().int().min(1).max(12).default(12),
        sme: z.boolean().describe("중소기업 여부"),
        revenue: z.number().min(0).describe("일반 수입금액 (특수관계인 거래 제외, 원)"),
        relatedRevenue: z.number().min(0).default(0).describe("특수관계인 거래 수입금액"),
        passiveCompany: z.boolean().default(false).describe("부동산임대업 주업 등 한도 50% 적용 법인"),
        spent: z.number().min(0).optional().describe("손금불산입 전 실제 지출액"),
      },
      annotations: OFFLINE,
    },
    guarded(async (args) => {
      const r = entertainmentLimit(args);
      return text(
        [
          "■ 기업업무추진비 한도",
          `근거: ${r.legalBasis}`,
          `기본한도: ${won(r.basic)}`,
          `수입금액 기준 한도: ${won(r.byRevenue)}`,
          `한도 합계: **${won(r.limit)}**`,
          r.excess !== undefined ? `한도초과액(손금불산입): **${won(r.excess)}**` : "",
          "",
          ...r.notes.map((n) => `- ${n}`),
        ]
          .filter((l, i, a) => l !== "" || a[i - 1] !== "")
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "deemed_interest",
    {
      title: "가지급금 인정이자",
      description:
        "특수관계인 가지급금 잔액 구간으로 적수와 인정이자를 계산하고, 실제 받은 이자와의 차이가 부당행위계산 기준(5% 또는 3억원)에 걸리는지 판정합니다.",
      inputSchema: {
        segments: z
          .array(z.object({ from: day, to: day, balance: z.number().min(0) }))
          .min(1)
          .max(400)
          .describe("잔액이 바뀔 때마다 구간을 나눠 입력"),
        ratePct: z.number().min(0).max(30).describe("적용 이자율(연 %, 예: 4.6)"),
        rateKind: z.enum(["weighted", "overdraft"]).describe("weighted=가중평균차입이자율, overdraft=당좌대출이자율"),
        receivedInterest: z.number().min(0).default(0).describe("실제 받은(받기로 한) 이자"),
        yearDays: z.union([z.literal(365), z.literal(366)]).default(365).describe("윤년이면 366"),
      },
      annotations: OFFLINE,
    },
    guarded(async (args) => {
      const r = deemedInterest(args);
      return text(
        [
          "■ 가지급금 인정이자",
          `근거: ${r.legalBasis}`,
          ...r.lines.map((l) => `- ${l}`),
          `적수 합계: ${r.product.toLocaleString("ko-KR")}`,
          `인정이자: ${won(r.interest)} (연 ${args.ratePct}%, ${args.yearDays}일)`,
          `실제 이자: ${won(r.received)} → 차액 ${won(r.gap)}`,
          r.triggersAdjustment ? `판정: ⚠ 현저한 이익 분여 기준 해당 → 차액 ${won(r.gap)} 익금산입 검토` : "판정: 기준 미달 (부당행위계산 부인 대상 아님)",
          "",
          ...r.notes.map((n) => `- ${n}`),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "find_treaty",
    {
      title: "조세조약 찾기",
      description: "법제처 조약 자료에서 조세조약(이중과세방지협약)을 검색하거나 id로 본문을 읽습니다. 국가명과 함께 검색하세요 (예: \"미국 소득\", \"베트남 이중과세\").",
      inputSchema: {
        query: z.string().optional(),
        id: z.string().optional().describe("검색 결과의 조약 id → 본문"),
        keyword: z.string().optional().describe("본문 중 이 말이 든 부분만 (예: 배당, 고정사업장)"),
        limit: z.number().int().min(1).max(50).default(10),
        cursor: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ query, id, keyword, limit, cursor }) => {
      if (id) {
        const tree = await d.guidance.readTreaty(id);
        const keep = keyword ? (b: string) => b.includes(keyword) : undefined;
        const body = outline(tree, keep);
        if (!body.trim()) return text(`[NO_MATCH] 조약 ${id}에서 '${keyword}'가 든 부분을 찾지 못했습니다.`);
        return paged(`■ 조약 ${id}\n\n${body}`, cursor, d.cfg.charBudget);
      }
      if (!query) return text("[BAD_INPUT] query 또는 id 중 하나는 필요합니다.");
      const rows = await d.guidance.findTreaties(query, limit);
      if (!rows.length) return text(`[NO_MATCH] '${query}' 조약 검색 결과가 없습니다. 국가명만 넣어 보세요.`);
      return text(
        rows
          .map((r, i) => `${i + 1}. ${r.name} [${[r.kind, r.treatyNo && `조약 제${r.treatyNo}호`, r.effective && `발효 ${r.effective}`].filter(Boolean).join(" · ")}] → id=${r.id}`)
          .join("\n"),
      );
    }),
  );
}
