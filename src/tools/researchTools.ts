import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RULING_KINDS, RULING_SOURCES, type RulingKind } from "../lawgo/sources.js";
import type { RulingRow } from "../lawgo/rulings.js";
import { canonicalLawName } from "../domain/taxLawBook.js";
import { READ_ONLY, type Desks } from "./context.js";
import { guarded, paged, text } from "./reply.js";

const kindArg = z.enum(RULING_KINDS as [RulingKind, ...RulingKind[]]);
const KIND_HELP = "court=법원 판례, constitutional=헌재 결정, tribunal=조세심판원 심판례, moleg=법제처 법령해석례";

function rulingLine(r: RulingRow, i: number): string {
  const meta = [r.caseNo, r.date, r.org].filter(Boolean).join(" · ");
  const nts = r.origin.includes("국세법령") ? "  (본문: 국세법령정보시스템)" : "";
  return `${i + 1}. ${r.title || "(제목 없음)"}${meta ? `  [${meta}]` : ""}  → source=${r.kind}, id=${r.id}${nts}`;
}

export function registerResearchTools(server: McpServer, d: Desks): void {
  server.registerTool(
    "find_rulings",
    {
      title: "결정례·해석례 찾기",
      description: `판례·헌재 결정·조세심판원 심판례·법제처 해석례를 한 번에 검색합니다 (${KIND_HELP}). 결과의 source/id를 read_ruling에 넘기세요.`,
      inputSchema: {
        query: z.string().min(1).describe("쟁점 키워드 또는 사건번호 (예: 부당행위계산 가지급금 인정이자)"),
        sources: z.array(kindArg).min(1).default(["court", "tribunal", "moleg"]).describe(KIND_HELP),
        perSource: z.number().int().min(1).max(30).default(5),
        fullText: z.boolean().default(false).describe("true면 본문까지 검색 (기본은 제목·사건명)"),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ query, sources, perSource, fullText }) => {
      const settled = await Promise.allSettled(sources.map((k) => d.rulings.find(k, query, { limit: perSource, fullText })));
      const blocks = settled.map((s, i) => {
        const label = RULING_SOURCES[sources[i]].label;
        if (s.status === "rejected") return `■ ${label}: [조회 실패] ${s.reason instanceof Error ? s.reason.message : s.reason}`;
        if (!s.value.rows.length) return `■ ${label}: 결과 없음`;
        return `■ ${label} (총 ${s.value.total}건 중 ${s.value.rows.length}건)\n${s.value.rows.map(rulingLine).join("\n")}`;
      });
      return text(blocks.join("\n\n"));
    }),
  );

  server.registerTool(
    "read_ruling",
    {
      title: "결정례·해석례 본문",
      description: "find_rulings 결과의 source와 id로 요지·주문·이유 등 본문을 읽습니다.",
      inputSchema: {
        source: kindArg.describe(KIND_HELP),
        id: z.string().min(1),
        sectionsOnly: z.array(z.string()).optional().describe("특정 섹션만 (예: [\"판결요지\",\"참조조문\"])"),
        cursor: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ source, id, sectionsOnly, cursor }) => {
      const doc = await d.rulings.read(source, id);
      const secs = sectionsOnly?.length ? doc.sections.filter((s) => sectionsOnly.includes(s.heading)) : doc.sections;
      const head = `■ [${doc.source}] ${doc.title}\n${[doc.caseNo, doc.date, doc.org].filter(Boolean).join(" · ")}`;
      const body = secs.map((s) => `\n【${s.heading}】\n${s.text}`).join("\n");
      return paged(head + "\n" + body, cursor, d.cfg.charBudget);
    }),
  );

  server.registerTool(
    "find_admin_rule",
    {
      title: "행정규칙 (기본통칙·고시·훈령·예규)",
      description:
        "국세청·재정경제부 등의 행정규칙(훈령·예규·고시, 예: 법인세 사무처리규정)을 검색하거나(query), id로 본문을 읽습니다. 국세청 기본통칙·집행기준은 법제처 자료에 없으므로 국세법령정보시스템에서 확인해야 합니다.",
      inputSchema: {
        query: z.string().optional().describe("행정규칙명 키워드 (예: 법인세 기본통칙)"),
        id: z.string().optional().describe("검색 결과의 행정규칙 id → 본문 조회"),
        inBody: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(10),
        cursor: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ query, id, inBody, limit, cursor }) => {
      if (id) {
        const doc = await d.guidance.readAdminRule(id);
        return paged(`■ ${doc.name}\n${doc.meta}\n\n${doc.body}`, cursor, d.cfg.charBudget);
      }
      if (!query) return text("[BAD_INPUT] query 또는 id 중 하나는 필요합니다.");
      let rows = await d.guidance.findAdminRules(query, { inBody, limit });
      let note = "";
      const words = query.trim().split(/\s+/);
      if (!rows.length && words.length > 1) {
        // "법인세 기본통칙"처럼 법제처에 없는 자료명이 섞인 경우 첫 단어로 다시 찾는다
        rows = await d.guidance.findAdminRules(words[0], { inBody, limit });
        if (rows.length) note = `'${query}' 결과가 없어 '${words[0]}'로 다시 찾았습니다.\n`;
      }
      if (/기본통칙|집행기준/.test(query)) note += "※ 국세청 기본통칙·집행기준은 법제처 자료에 없습니다. 국세법령정보시스템(taxlaw.nts.go.kr)에서 확인하세요.\n";
      if (!rows.length) return text(`[NO_MATCH] '${query}' 행정규칙 검색 결과가 없습니다.\n${note}`.trim());
      return text(
        note +
          rows
            .map((r, i) => `${i + 1}. ${r.name} [${[r.type, r.ministry, r.issued && `발령 ${r.issued}`].filter(Boolean).join(" · ")}] → id=${r.id}`)
            .join("\n"),
      );
    }),
  );

  server.registerTool(
    "find_form",
    {
      title: "별표·서식 찾기",
      description: "세법 시행규칙 서식(신고서·명세서)과 별표(세율표·기준표)를 찾고 HWP/PDF 내려받기 링크를 제공합니다.",
      inputSchema: {
        query: z.string().min(1).describe("서식명 또는 법령명 (예: 가지급금 인정이자 조정명세서)"),
        byLawName: z.boolean().default(false).describe("true면 query를 법령명으로 보고 해당 법령의 별표·서식 전체 나열"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ query, byLawName, limit }) => {
      const rows = await d.guidance.findAnnexes(query, { byLawName, limit });
      if (!rows.length) return text(`[NO_MATCH] '${query}' 별표·서식이 없습니다. byLawName 옵션을 바꿔 보세요.`);
      return text(
        rows
          .map((r, i) =>
            [
              `${i + 1}. ${r.name} — ${r.lawName}${r.annexType ? ` (${r.annexType}${r.annexNo ? ` ${r.annexNo}` : ""})` : ""}`,
              r.fileLink && `   파일: ${r.fileLink}`,
              r.pdfLink && `   PDF: ${r.pdfLink}`,
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "explain_term",
    {
      title: "법령용어 풀이",
      description: "법령에서 정의한 용어(예: 특수관계인, 사업연도, 내국법인)의 법령별 정의와 출처를 보여줍니다. law를 주면 그 법령의 정의만 남깁니다.",
      inputSchema: {
        term: z.string().min(1),
        law: z.string().optional().describe("정의를 볼 법령 (예: 법인세법)"),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ term, law }) => {
      const r = await d.guidance.explainTerm(term, law ? canonicalLawName(law) : undefined);
      if (!r.definitions.length) return text(`[NO_MATCH] '${r.term}'의 정의 본문이 없습니다. find_statute(scope=body)로 정의 조문을 찾아보세요.`);
      const head = `■ ${r.term}${r.term !== term ? ` ('${term}'와 가장 가까운 용어)` : ""} — 정의 ${r.definitions.length}건`;
      const body = r.definitions.slice(0, 8).map((x, i) => `${i + 1}. ${x.definition}${x.source ? `\n   출처: ${x.source}` : ""}`).join("\n");
      const rel = r.related.length ? `\n\n관련 용어: ${r.related.join(", ")}` : "";
      return text(`${head}\n\n${body}${rel}`);
    }),
  );
}
