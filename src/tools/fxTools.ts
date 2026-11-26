// 외국환 환율: 서울외국환중개 매매기준율(USD)·재정된 매매기준율(기타 통화) 조회와 엑셀 행 단위 원화 환산

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CURRENCIES, normalizeCurrency, normalizeDate, SMBS_PAGE, type FxDay, type FxDesk, type FxRate, unitOf } from "../fx/smbs.js";
import { READ_ONLY } from "./context.js";
import { guarded, paged, text } from "./reply.js";

const MAJOR = ["USD", "JPY", "EUR", "CNH", "GBP", "HKD", "VND"];

const dateLike = z.union([z.string(), z.number()]).describe("YYYY-MM-DD 권장. 2026.11.20, 20261120, 엑셀 날짜 일련번호도 가능");

const fmt = (n: number, digits = 2) => n.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (n: number) => (n > 0 ? `▲${fmt(n)}` : n < 0 ? `▼${fmt(-n)}` : "-");
const unitLabel = (code: string) => (unitOf(code) === 100 ? `${code}(100)` : code);

function usedNote(day: FxDay): string {
  if (!day.used) return "고시 없음";
  return day.used === day.requested ? day.used : `${day.used} (요청일 ${day.requested} 고시 없음 → 직전 고시일)`;
}

const SOURCE = `출처: 서울외국환중개 매매기준율 (${SMBS_PAGE}) — USD는 매매기준율, 그 외 통화는 재정된 매매기준율`;

const TAX_NOTES = [
  "※ 세무 적용 시 확인: 부가가치세 과세표준의 외화 환산은 공급시기 이전에 원화로 바꾼 금액은 그 환가 금액, 그 외에는 공급시기의 「외국환거래법」에 따른 기준환율 또는 재정환율(부가가치세법 시행령 제59조). 법인 외화자산·부채 평가는 사업연도 종료일 현재 매매기준율 등(법인세법 시행령 제76조).",
  "※ 휴일 대체(직전 고시일)·원 미만 처리는 사무소 기준과 거래 계약 조건을 확인하세요.",
];

export function registerFxTools(server: McpServer, fx: FxDesk): void {
  server.registerTool(
    "exchange_rate",
    {
      title: "외국환 환율 조회·원화 환산 (서울외국환중개)",
      description: [
        "서울외국환중개(smbs.biz)가 고시한 일자별 매매기준율(USD)·재정된 매매기준율(그 외 57개 통화)을 조회합니다. 휴일·고시 전이면 직전 고시일 환율을 쓰고 그 사실을 표시합니다.",
        "사용자가 엑셀·CSV·표를 올리면 먼저 파일을 읽어 각 행의 거래일자·통화·외화금액을 찾아 rows로 넘기세요. 행마다 적용 환율과 원화 환산액을 돌려주므로, 결과를 원래 표에 열로 붙여 주면 됩니다.",
        "엑셀 날짜가 일련번호(예: 46346)로 보이면 그대로 넣어도 됩니다. 통화는 USD·JPY 같은 코드나 '달러', '엔화', '위안' 같은 한글도 됩니다. JPY·IDR·VND 환율은 100단위입니다.",
      ].join("\n"),
      inputSchema: {
        dates: z.array(dateLike).max(100).optional().describe("환율을 볼 날짜들 (rows 없이 날짜별 환율표만 볼 때)"),
        currencies: z.array(z.string()).max(60).optional().describe("보여 줄 통화 (없으면 날짜 1개는 전 통화, 여러 날짜는 주요 통화)"),
        rows: z
          .array(
            z.object({
              date: dateLike,
              currency: z.string().describe("통화 코드 또는 한글 (USD, 엔화 등)"),
              amount: z.number().optional().describe("외화 금액 (있으면 원화 환산)"),
              ref: z.string().max(80).optional().describe("엑셀 행 번호·거래처 등 원본 행 식별자"),
            }),
          )
          .max(1000)
          .optional()
          .describe("엑셀 등에서 읽은 거래 행. 행마다 해당 일자 환율과 원화 환산액을 계산"),
        holiday: z.enum(["previous", "none"]).default("previous").describe("previous=고시 없는 날은 직전 고시일 환율, none=비워 둠"),
        rounding: z.enum(["floor", "round", "none"]).default("floor").describe("원화 환산액 원 미만 처리: floor=절사, round=반올림, none=소수 둘째 자리"),
        cursor: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ dates, currencies, rows, holiday, rounding, cursor }) => {
      const previous = holiday === "previous";
      if (!rows?.length && !dates?.length) return text("[BAD_INPUT] dates 또는 rows 중 하나는 필요합니다. 예: dates=[\"2026-11-20\"]");

      if (rows?.length) {
        const bad: string[] = [];
        const parsed = rows.map((r, i) => {
          const date = normalizeDate(r.date);
          const code = normalizeCurrency(r.currency);
          const ref = r.ref ?? `${i + 1}행`;
          if (!date) bad.push(`${ref}: 날짜 '${r.date}'를 읽지 못함`);
          if (!code) bad.push(`${ref}: 통화 '${r.currency}'는 서울외국환중개 고시 통화가 아님`);
          return { ...r, ref, date, code };
        });
        const days = await fx.resolveMany(parsed.flatMap((p) => (p.date ? [p.date] : [])), previous);

        const hasAmount = parsed.some((p) => p.amount !== undefined);
        const head = hasAmount
          ? "| 행 | 거래일 | 적용 고시일 | 통화 | 외화금액 | 환율 | 원화환산액 |\n|---|---|---|---|---:|---:|---:|"
          : "| 행 | 거래일 | 적용 고시일 | 통화 | 환율 |\n|---|---|---|---|---:|";
        let total = 0;
        let substituted = 0;
        const lines = parsed.map((p) => {
          const day = p.date ? days.get(p.date) : undefined;
          const rate = day && p.code ? day.rates.get(p.code) : undefined;
          if (day?.used && day.used !== day.requested) substituted++;
          const usedCell = !p.date ? "날짜 오류" : !day?.used ? "고시 없음" : day.used === day.requested ? day.used : `${day.used}*`;
          const rateCell = rate ? `${fmt(rate.rate)}${rate.unit === 100 ? " /100" : ""}` : p.code ? "확인 불가" : "통화 오류";
          const base = [p.ref, p.date ?? "-", usedCell, p.code ? unitLabel(p.code) : p.currency];
          if (!hasAmount) return `| ${[...base, rateCell].join(" | ")} |`;
          let krw = "";
          if (rate && p.amount !== undefined) {
            const raw = (p.amount * rate.rate) / rate.unit;
            const v = rounding === "floor" ? Math.trunc(raw) : rounding === "round" ? Math.round(raw) : Math.round(raw * 100) / 100;
            total += v;
            krw = rounding === "none" ? fmt(v) : v.toLocaleString("ko-KR");
          }
          return `| ${[...base, p.amount !== undefined ? fmt(p.amount) : "", rateCell, krw].join(" | ")} |`;
        });

        const body = [
          `■ 거래 ${parsed.length}건 환율 적용 (${SOURCE})`,
          "",
          head,
          ...lines,
          "",
          hasAmount ? `원화 환산액 합계: **${rounding === "none" ? fmt(total) : total.toLocaleString("ko-KR")}원** (원 미만 ${rounding === "floor" ? "절사" : rounding === "round" ? "반올림" : "소수 둘째 자리"}, 통화 혼합 시 단순 합계)` : "",
          substituted ? `* 표시: 거래일에 고시가 없어(주말·공휴일·당일 고시 전) 직전 고시일 환율을 적용한 행 ${substituted}건` : "",
          bad.length ? `\n[확인 필요]\n${bad.map((b) => `- ${b}`).join("\n")}` : "",
          "",
          ...TAX_NOTES,
        ]
          .filter((l, i, a) => l !== "" || a[i - 1] !== "")
          .join("\n");
        return paged(body, cursor, 12_000, false);
      }

      const wanted = (currencies ?? []).map((c) => ({ raw: c, code: normalizeCurrency(c) }));
      const unknown = wanted.filter((w) => !w.code).map((w) => w.raw);
      const dateList = dates!.map((d) => ({ raw: d, iso: normalizeDate(d) }));
      const badDates = dateList.filter((d) => !d.iso).map((d) => String(d.raw));
      const isoDates = [...new Set(dateList.flatMap((d) => (d.iso ? [d.iso] : [])))].sort();
      if (!isoDates.length) return text(`[BAD_INPUT] 날짜를 읽지 못했습니다: ${badDates.join(", ")}`);
      const days = await fx.resolveMany(isoDates, previous);
      const codes = wanted.length ? wanted.flatMap((w) => (w.code ? [w.code] : [])) : isoDates.length === 1 ? Object.keys(CURRENCIES) : MAJOR;

      const out: string[] = [];
      if (isoDates.length === 1) {
        const day = days.get(isoDates[0])!;
        out.push(`■ ${isoDates[0]} 환율 — 적용 고시일 ${usedNote(day)}`, SOURCE, "");
        if (!day.used) out.push("고시된 환율이 없습니다. holiday=previous로 다시 조회하거나 날짜를 확인하세요.");
        else {
          out.push("| 통화 | 통화명 | 환율(원) | 전일대비 |", "|---|---|---:|---:|");
          for (const c of codes) {
            const r = day.rates.get(c);
            out.push(r ? `| ${unitLabel(r.code)} | ${r.name} | ${fmt(r.rate)} | ${signed(r.change)} |` : `| ${c} | ${CURRENCIES[c] ?? ""} | 고시 없음 | |`);
          }
        }
      } else {
        out.push(`■ 날짜별 환율 ${isoDates.length}일 (${SOURCE})`, "");
        out.push(`| 날짜 | 적용 고시일 | ${codes.map(unitLabel).join(" | ")} |`);
        out.push(`|---|---|${codes.map(() => "---:").join("|")}|`);
        for (const d of isoDates) {
          const day = days.get(d)!;
          const used = !day.used ? "고시 없음" : day.used === d ? day.used : `${day.used}*`;
          out.push(`| ${d} | ${used} | ${codes.map((c) => { const r = day.rates.get(c); return r ? fmt(r.rate) : "-"; }).join(" | ")} |`);
        }
        if (isoDates.some((d) => days.get(d)!.used && days.get(d)!.used !== d)) out.push("", "* 고시가 없어(주말·공휴일·당일 고시 전) 직전 고시일 환율을 적용");
      }
      if (unknown.length) out.push("", `[확인 필요] 서울외국환중개 고시 통화가 아님: ${unknown.join(", ")}`);
      if (badDates.length) out.push("", `[확인 필요] 읽지 못한 날짜: ${badDates.join(", ")}`);
      out.push("", ...TAX_NOTES);
      return paged(out.join("\n"), cursor, 12_000, false);
    }, "서울외국환중개(smbs.biz)"),
  );
}
