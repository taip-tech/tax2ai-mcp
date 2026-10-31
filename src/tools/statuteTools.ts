import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LawgoFault } from "../lawgo/client.js";
import { delegationEntries, revisionPairs } from "../lawgo/guidance.js";
import { ymd } from "../lawgo/shape.js";
import type { Provision, ResolvedStatute, StatuteRow } from "../lawgo/statutes.js";
import { articleLabel, parseArticleInput } from "../domain/citation.js";
import { READ_ONLY, type Desks } from "./context.js";
import { guarded, paged, text } from "./reply.js";

const lawArg = z.string().min(2).describe("법령명. 줄임말 허용 (예: 법법, 조특법 시행령, 상증법)");
const articleArg = z.string().describe("조문번호 (예: 52, 제52조, 52의2, 10-2)");
const cursorArg = z.number().int().min(0).optional().describe("이전 응답의 [MORE] 안내에 나온 이어받기 위치");
const asOfArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("이 날짜에 시행 중이던 버전으로 조회 (YYYY-MM-DD). 생략하면 현행");

function rowLine(r: StatuteRow, i: number): string {
  const bits = [
    r.kind && `[${r.kind}]`,
    r.effective && `시행 ${ymd(r.effective)}`,
    r.promulgated && `공포 ${ymd(r.promulgated)}`,
    r.revision,
    r.ministry,
    r.status,
    `MST ${r.mst}`,
  ].filter(Boolean);
  return `${i + 1}. ${r.name}${r.nickname && r.nickname !== r.name ? ` (약칭: ${r.nickname})` : ""}  ${bits.join(" · ")}`;
}

function needArticle(raw: string) {
  const parsed = parseArticleInput(raw);
  if (!parsed) throw new LawgoFault("BAD_INPUT", `조문번호를 해석할 수 없습니다: ${raw}`);
  return parsed;
}

function provisionBlock(law: ResolvedStatute, p: Provision, paragraph?: number): string {
  const head = `■ ${law.name} ${articleLabel(p)}${p.title ? `(${p.title})` : ""}`;
  const when = law.asOf ? `${ymd(law.asOf)} 시점 버전 · 시행 ${ymd(law.effective)}` : `현행 · 시행 ${ymd(law.effective)}`;
  const status = p.repealed ? " · ⚠ 삭제된 조문" : "";
  let bodyText = p.text;
  if (paragraph) {
    const c = p.clauses.find((x) => x.no === paragraph);
    if (!c) throw new LawgoFault("NO_MATCH", `${law.name} ${articleLabel(p)}에 제${paragraph}항이 없습니다 (항 ${p.clauses.length}개).`);
    bodyText = [c.text, ...c.items.map((it) => "  " + it.text)].join("\n");
  }
  return `${head}\n(${when}${p.effective ? ` · 조문시행 ${ymd(p.effective)}` : ""}${status})\n\n${bodyText}`;
}

async function upcomingNote(d: Desks, law: ResolvedStatute): Promise<string> {
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const pending = (await d.statutes.versions(law.name, { upcomingOnly: true })).filter((v) => v.effective > today);
    if (!pending.length) return "";
    // 현행보다 늦게 공포된 것만 '새 개정'으로 보고, 오래전 공포분은 시행이 유예된 과거 개정으로 따로 안내한다
    const fresh = pending.filter((v) => v.promulgated >= law.promulgated);
    const deferred = pending.length - fresh.length;
    const parts: string[] = [];
    if (fresh.length) {
      const list = fresh.slice(0, 3).map((v) => `${ymd(v.effective)} 시행(공포 ${ymd(v.promulgated)}, ${v.revision})`);
      parts.push(`⚠ 시행 예정 개정이 있습니다: ${list.join("; ")}. 해당 날짜를 asOf로 넣어 개정 후 문언을 확인하세요.`);
    }
    if (deferred) {
      const dates = pending.filter((v) => v.promulgated < law.promulgated).map((v) => ymd(v.effective));
      parts.push(`참고: 과거 개정 중 시행이 유예된 부분이 ${deferred}건 있습니다 (시행 ${dates.join(", ")}). 이 조문과 관련 있는지는 asOf로 확인하세요.`);
    }
    return "\n\n" + parts.join("\n");
  } catch {
    return ""; // 부가 정보이므로 실패해도 본 응답은 유지
  }
}

export function registerStatuteTools(server: McpServer, d: Desks): void {
  server.registerTool(
    "find_statute",
    {
      title: "세법 법령 찾기",
      description:
        "법령명(줄임말 자동 확장) 또는 본문 키워드로 법률·시행령·시행규칙을 찾습니다. 결과의 법령명을 read_provision 등에 그대로 넘기면 됩니다.",
      inputSchema: {
        query: z.string().min(1).describe("법령명 또는 본문 키워드"),
        scope: z.enum(["title", "body"]).default("title").describe("title=법령명 검색, body=조문 본문 검색"),
        limit: z.number().int().min(1).max(50).default(10),
        page: z.number().int().min(1).default(1),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ query, scope, limit, page }) => {
      const { query: used, rows } = await d.statutes.find(query, { inBody: scope === "body", limit, page });
      if (!rows.length) return text(`[NO_MATCH] '${used}' 검색 결과가 없습니다. scope를 바꾸거나 정식 법령명으로 다시 시도하세요.`);
      const head = used !== query ? `검색어 '${query}' → '${used}'로 확장\n` : "";
      return text(head + rows.map(rowLine).join("\n"));
    }),
  );

  server.registerTool(
    "read_provision",
    {
      title: "조문 원문 읽기",
      description:
        "법령의 특정 조문(및 항) 원문을 가져옵니다. asOf로 과거·미래 시점 버전을 볼 수 있고, 시행 예정 개정이 있으면 경고를 붙입니다. article을 생략하면 조문 목차를 돌려줍니다.",
      inputSchema: {
        law: lawArg,
        article: articleArg.optional(),
        paragraph: z.number().int().min(1).optional().describe("특정 항만 보고 싶을 때"),
        asOf: asOfArg,
        cursor: cursorArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ law, article, paragraph, asOf, cursor }) => {
      const resolved = await d.statutes.resolve(law, asOf);
      if (!article) {
        const all = await d.statutes.provisions(resolved);
        const toc = all.map((p) => `${articleLabel(p)}${p.title ? ` ${p.title}` : ""}${p.repealed ? " (삭제)" : ""}`);
        return paged(`■ ${resolved.name} 조문 목차 (시행 ${ymd(resolved.effective)}, ${all.length}개 조)\n\n${toc.join("\n")}`, cursor, d.cfg.charBudget);
      }
      const target = needArticle(article);
      const found = await d.statutes.provisions(resolved, target);
      if (!found.length) {
        throw new LawgoFault("NO_MATCH", `${resolved.name}에 ${articleLabel(target)}가 없습니다. article을 생략하면 목차를 볼 수 있습니다.`);
      }
      const note = asOf ? "" : await upcomingNote(d, resolved);
      return paged(found.map((p) => provisionBlock(resolved, p, paragraph)).join("\n\n") + note, cursor, d.cfg.charBudget);
    }),
  );

  server.registerTool(
    "trace_amendments",
    {
      title: "조문 개정 흐름",
      description:
        "법령의 시행일별 버전 목록을 보여주고, article을 주면 최근 버전들 사이에서 해당 조문 문언이 바뀐 시점을 표시합니다. 귀속연도별 적용 조문 확인에 사용하세요.",
      inputSchema: {
        law: lawArg,
        article: articleArg.optional(),
        depth: z.number().int().min(2).max(8).default(5).describe("비교할 최근 버전 수"),
        cursor: cursorArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ law, article, depth, cursor }) => {
      const versions = await d.statutes.versions(law);
      if (!versions.length) throw new LawgoFault("NO_MATCH", `${law}의 시행일 버전 정보를 찾지 못했습니다.`);
      const lines = [`■ ${versions[0].name} 시행일별 버전 (최근 ${Math.min(versions.length, 30)}건)`];
      versions.slice(0, 30).forEach((v, i) => lines.push(rowLine(v, i)));
      if (article) {
        const target = needArticle(article);
        lines.push("", `■ ${articleLabel(target)} 문언 비교 (최근 ${depth}개 버전, 최신 → 과거)`);
        const picked = versions.slice(0, depth);
        const texts = await Promise.all(
          picked.map((v) =>
            d.statutes
              .provisions({ ...v, asOf: v.effective }, target)
              .then((ps) => ps[0]?.text ?? "(해당 조문 없음)")
              .catch(() => "(조회 실패)"),
          ),
        );
        picked.forEach((v, i) => {
          const older = texts[i + 1];
          const tag = older === undefined ? "기준" : older === texts[i] ? "직전과 동일" : "⚑ 직전 버전과 다름";
          lines.push(`\n— 시행 ${ymd(v.effective)} (${v.revision}) : ${tag}`);
          if (tag !== "직전과 동일") lines.push(texts[i]);
        });
      }
      return paged(lines.join("\n"), cursor, d.cfg.charBudget);
    }),
  );

  server.registerTool(
    "read_transition_rules",
    {
      title: "부칙 (시행일·적용례·경과조치)",
      description:
        "법령 부칙에서 시행일, 적용례(\"~이후 개시하는 사업연도분부터 적용\"), 경과조치를 찾습니다. 개정 조문이 어느 사업연도·귀속연도부터 적용되는지 판단할 때 사용하세요. keyword로 특정 조문을 언급한 부칙만 걸러낼 수 있습니다.",
      inputSchema: {
        law: lawArg,
        keyword: z.string().optional().describe("부칙 본문에서 찾을 말 (예: 제55조, 사업연도)"),
        promulgatedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("특정 공포일의 부칙만"),
        limit: z.number().int().min(1).max(20).default(3).describe("최근 공포 순으로 보여줄 부칙 수"),
        asOf: asOfArg,
        cursor: cursorArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ law, keyword, promulgatedOn, limit, asOf, cursor }) => {
      const resolved = await d.statutes.resolve(law, asOf);
      let rows = await d.statutes.addenda(resolved);
      if (promulgatedOn) rows = rows.filter((a) => a.promulgated === promulgatedOn.replace(/-/g, ""));
      if (keyword) {
        const k = keyword.replace(/\s/g, "");
        rows = rows.filter((a) => a.text.replace(/\s/g, "").includes(k));
      }
      if (!rows.length) {
        throw new LawgoFault("NO_MATCH", `${resolved.name}에서 조건에 맞는 부칙을 찾지 못했습니다.${keyword ? " keyword를 바꾸거나 빼 보세요." : ""}`);
      }
      const shown = rows.slice(0, limit);
      const blocks = shown.map((a) => `■ 부칙 <${ymd(a.promulgated)}${a.number ? ` 제${a.number}호` : ""}>\n${a.text}`);
      const head = `■ ${resolved.name} 부칙 ${shown.length}건${rows.length > shown.length ? ` (조건에 맞는 ${rows.length}건 중 최근 순)` : ""}\n`;
      return paged(head + "\n" + blocks.join("\n\n"), cursor, d.cfg.charBudget);
    }),
  );

  server.registerTool(
    "trace_delegation",
    {
      title: "위임 법령 연결",
      description:
        "법률 조문이 시행령·시행규칙 어디로 위임되는지(또는 어디를 인용하는지) 법제처 3단 비교 자료로 보여줍니다. article을 주면 해당 조와 관련된 블록만 남깁니다.",
      inputSchema: {
        law: lawArg.describe("법률명 (시행령을 넣으면 시행령 기준)"),
        article: articleArg.optional(),
        mode: z.enum(["delegated", "cited"]).default("delegated").describe("delegated=위임조문, cited=인용조문"),
        cursor: cursorArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ law, article, mode, cursor }) => {
      const resolved = await d.statutes.resolve(law);
      const tree = await d.guidance.delegationOutline(resolved, mode);
      const target = article ? needArticle(article) : undefined;
      let entries = delegationEntries(tree);
      if (target) entries = entries.filter((e) => e.article === target.article && e.branch === target.branch);
      if (!entries.length) {
        throw new LawgoFault("NO_MATCH", `${resolved.name}${target ? ` ${articleLabel(target)}` : ""}에 대한 ${mode === "cited" ? "인용" : "위임"} 연결 정보가 없습니다.`);
      }
      // 시행령 조문 제목은 3단 비교에 비어 오는 경우가 많아 시행령 본문에서 채운다
      const decreeTitles = new Map<string, string>();
      try {
        const decree = await d.statutes.resolve(`${resolved.name.replace(/\s*(시행령|시행규칙)$/, "")} 시행령`);
        for (const p of await d.statutes.provisions(decree)) decreeTitles.set(`${p.article}-${p.branch}`, p.title);
      } catch {
        // 제목 없이도 연결 정보는 유효
      }
      const label = (k: { no: number; branch: number; title: string }, titles?: Map<string, string>) => {
        const t = k.title.replace(/^제\s*\d+\s*조(?:의\s*\d+)?\s*/, "").replace(/^\(|\)$/g, "") || titles?.get(`${k.no}-${k.branch}`) || "";
        return `제${k.no}조${k.branch ? `의${k.branch}` : ""}${t ? `(${t})` : ""}`;
      };
      const lines = entries.map((e) =>
        [
          `▶ ${resolved.name} ${articleLabel(e)}`,
          e.decree.length ? `   시행령: ${e.decree.map((k) => label(k, decreeTitles)).join(", ")}` : "",
          e.rule.length ? `   시행규칙: ${e.rule.map((k) => label(k)).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      const head = `■ ${resolved.name} ${mode === "cited" ? "인용" : "위임"} 연결 (${entries.length}개 조)\n각 조문 원문은 read_provision(law="${resolved.name} 시행령", article=…)으로 확인하세요.\n`;
      return paged(head + "\n" + lines.join("\n"), cursor, d.cfg.charBudget);
    }),
  );

  server.registerTool(
    "compare_revision",
    {
      title: "신구조문 대비",
      description: "법령의 최근 개정 전후 문언(신구조문 대비표)을 보여줍니다. article로 특정 조만 걸러낼 수 있습니다.",
      inputSchema: { law: lawArg, article: articleArg.optional(), cursor: cursorArg },
      annotations: READ_ONLY,
    },
    guarded(async ({ law, article, cursor }) => {
      const resolved = await d.statutes.resolve(law);
      const tree = await d.guidance.revisionComparison(resolved);
      let pairs = revisionPairs(tree);
      if (!pairs.length) throw new LawgoFault("NO_MATCH", `${resolved.name} 신구조문 자료가 없습니다.`);
      if (article) {
        const t = needArticle(article);
        pairs = pairs.filter((p) => p.article === t.article && p.branch === t.branch);
        if (!pairs.length) throw new LawgoFault("NO_MATCH", `최근 개정에서 ${articleLabel(t)}는 바뀌지 않았습니다. article을 빼면 바뀐 조문 목록을 볼 수 있습니다.`);
      }
      const head = `■ ${resolved.name} 신구조문 대비 (현행 시행 ${ymd(resolved.effective)}, 공포 ${ymd(resolved.promulgated)})\n【 】 안이 바뀐 부분입니다.\n`;
      const body = article
        ? pairs.map((p) => `▶ ${p.label}\n[개정 전]\n${p.before}\n\n[개정 후]\n${p.after}`).join("\n\n")
        : `바뀐 조문 ${pairs.length}개: ${pairs.map((p) => p.label).join(", ")}\n\n` +
          pairs.map((p) => `▶ ${p.label}\n[개정 전] ${p.before.split("\n")[0]}\n[개정 후] ${p.after.split("\n")[0]}`).join("\n\n");
      return paged(head + "\n" + body, cursor, d.cfg.charBudget);
    }),
  );
}
