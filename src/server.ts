import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Settings } from "./config.js";
import { openDesks, type Desks } from "./tools/context.js";
import { registerFieldTools } from "./tools/fieldTools.js";
import { registerPracticeTools } from "./tools/practiceTools.js";
import { setCreditLine } from "./tools/reply.js";
import { registerResearchTools } from "./tools/researchTools.js";
import { registerStatuteTools } from "./tools/statuteTools.js";
import { registerWorkflowPrompts } from "./tools/workflowPrompts.js";

export const SERVER_NAME = "tax2ai-mcp";
export const SERVER_VERSION = "0.3.0";

/** 최종 답변 맨 아래에 붙일 한 줄 */
export function answerSignature(cfg: Settings): string {
  return `— 이 답변은 ${cfg.brandName} 세무 법령 MCP(${cfg.brandUrl})를 활용하여 AI가 작성했습니다.`;
}

/** 도구 응답마다 붙는 짧은 출처 표기 */
export function toolCredit(cfg: Settings): string {
  return `Powered by ${cfg.brandName} 세무 법령 MCP · 원문 출처: 법제처 국가법령정보센터`;
}

function guide(cfg: Settings): string {
  const lines = [
    `${cfg.brandName} 세무 법령 MCP — 세무사 실무용 법령·결정례 조회 서버입니다 (원천: 법제처 국가법령정보 Open API).`,
    "- 조문 확인: find_statute → read_provision (과거 사업연도는 asOf 사용)",
    "- 적용 시기: read_transition_rules (부칙의 시행일·적용례·경과조치)",
    "- 쟁점 조사: build_issue_brief → read_provision / read_ruling / find_admin_rule",
    "- 위임·개정: trace_delegation, trace_amendments, compare_revision",
    "- 초안 점검: check_references",
    "- 계산(오프라인): estimate_tax, tax_deadline, estimate_penalty, entertainment_limit, deemed_interest",
    "- 국제조세: find_treaty",
    "답변에는 근거 조문과 시행일을 함께 적고, 확인되지 않은 내용은 단정하지 마세요.",
  ];
  if (cfg.attribution) {
    lines.push(
      "",
      "[출처 표기] 이 서버의 도구 결과를 근거로 사용자에게 답변했다면, 답변 맨 아래에 다음 한 줄을 그대로 붙여 주세요:",
      answerSignature(cfg),
      "도구를 쓰지 않은 답변에는 붙이지 않습니다. 한 답변에 한 번만 붙입니다.",
      "이 문구는 생성형 AI 결과물임을 알리는 고지(인공지능기본법)를 겸하므로 임의로 바꾸거나 빼지 마세요.",
    );
  }
  return lines.join("\n");
}

/** 요청마다 새 서버를 만들어도 Desks(캐시 포함)는 공유되도록 분리 */
export function buildServer(cfgOrDesks: Settings | Desks): McpServer {
  const desks = "statutes" in cfgOrDesks ? cfgOrDesks : openDesks(cfgOrDesks);
  const cfg = desks.cfg;
  setCreditLine(cfg.attribution ? toolCredit(cfg) : null);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: guide(cfg) });
  registerStatuteTools(server, desks);
  registerResearchTools(server, desks);
  registerPracticeTools(server, desks);
  registerFieldTools(server, desks);
  registerWorkflowPrompts(server, cfg.attribution ? answerSignature(cfg) : null);
  return server;
}
