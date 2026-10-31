// MCP 프롬프트: 세무사가 자주 쓰는 검토 흐름을 도구 호출 순서로 안내한다.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerWorkflowPrompts(server: McpServer, signature: string | null): void {
  const closing = signature ? `\n\n작성한 결과물 맨 아래에 다음 한 줄을 붙여 주세요:\n${signature}` : "";
  const user = (body: string) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: body + closing } }],
  });

  server.registerPrompt(
    "refund_claim_review",
    {
      title: "경정청구 검토",
      description: "과다납부 가능 항목을 법령·결정례 근거와 기한까지 묶어 검토메모로 정리",
      argsSchema: {
        taxType: z.string().describe("세목 (예: 법인세)"),
        periodEnd: z.string().describe("사업연도(과세기간) 종료일 YYYY-MM-DD"),
        items: z.string().describe("검토 후보 항목 (줄바꿈 구분)"),
      },
    },
    ({ taxType, periodEnd, items }) =>
      user(
        [
          `${taxType} (과세기간 종료 ${periodEnd}) 경정청구 가능성을 검토해 주세요.`,
          "",
          "진행 순서:",
          "1. tax_deadline으로 법정신고기한과 경정청구 기한을 먼저 확인하고, 기한이 지났으면 그 사실부터 알립니다.",
          "2. 항목마다 build_issue_brief로 근거 후보를 모읍니다.",
          "3. 핵심 조문은 read_provision(asOf=해당 사업연도 개시일)으로 당시 시행 문언을 확인합니다.",
          "4. 납세자에게 유리·불리한 결정례를 각각 read_ruling으로 대조합니다.",
          "5. 결과를 표로 정리: 항목 | 세액 영향 방향(증·감) | 근거 조문 | 결정례 | 확신도(상/중/하) | 추가 확인 자료",
          "6. 마지막에 check_references로 메모의 인용 조문을 점검합니다.",
          "",
          "금액 확정이나 청구 여부 결정은 담당 세무사 판단 사항으로 남겨 두세요.",
          "",
          "검토 후보:",
          items,
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "opinion_citation_audit",
    {
      title: "의견서 인용 점검",
      description: "의견서·답변서 초안의 조문·결정례 인용을 원문과 대조",
      argsSchema: { draft: z.string().describe("초안 본문") },
    },
    ({ draft }) =>
      user(
        [
          "아래 초안의 법적 근거 인용을 점검해 주세요.",
          "1. check_references로 조문 존재·삭제·항호 범위를 확인합니다.",
          "2. ⚠ 판정 항목은 read_provision으로 원문을 열어 올바른 조문을 제안합니다.",
          "3. 사건번호·심판번호가 있으면 find_rulings로 실재 여부를 확인합니다.",
          "4. 수정 제안은 '원문 표기 → 제안 표기 (사유)' 형식으로 정리합니다.",
          "",
          "--- 초안 ---",
          draft,
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "client_question_memo",
    {
      title: "고객 질의 답변 메모",
      description: "고객 질의에 대해 근거 조문·해석례를 붙인 답변 메모 초안",
      argsSchema: { question: z.string().describe("고객 질의 내용"), asOf: z.string().optional().describe("사실관계 기준일 YYYY-MM-DD") },
    },
    ({ question, asOf }) =>
      user(
        [
          `고객 질의: ${question}`,
          asOf ? `사실관계 기준일: ${asOf} (조문 조회 시 asOf로 사용)` : "",
          "",
          "1. 질의를 세법상 쟁점 1~3개로 나눕니다.",
          "2. 쟁점별로 build_issue_brief → read_provision → read_ruling 순으로 근거를 확보합니다.",
          "3. 메모 형식: 결론(요약) / 사실관계 가정 / 관련 법령 / 해석·결정례 / 검토의견 / 유의사항.",
          "4. 근거가 확인되지 않은 내용은 '확인 필요'로 표시하고 단정하지 않습니다.",
          "5. check_references로 인용을 점검한 뒤 최종본을 제시합니다.",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
  );

  server.registerPrompt(
    "document_request",
    {
      title: "신고 자료요청문",
      description: "고객에게 보낼 신고 자료요청문(카톡·이메일·공문)을 객관식으로 골라 가며 작성",
      argsSchema: { memo: z.string().optional().describe("고객·세목 등 아는 정보 (예: 행복식당 2026년 2기 부가세, 카톡)") },
    },
    ({ memo }) =>
      user(
        [
          "고객에게 보낼 신고 자료요청문을 만들어 주세요.",
          memo ? `아는 정보: ${memo}` : "",
          "",
          "1. 아는 정보로 draft_document_request를 먼저 호출합니다.",
          "2. [NEEDS_INPUT]이 오면 질문을 객관식(선택지)으로 보여 주고, 고른 값으로 다시 호출합니다. 한 번에 모아서 물어보세요.",
          "3. [문안 시작]~[문안 끝] 부분을 그대로 보여 주고, 고객 사정에 맞게 더하거나 뺄 항목이 있는지 물어봅니다.",
          "4. 사무소 정보가 비어 있다는 안내가 있으면 office_profile 등록을 제안합니다.",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
  );

  server.registerPrompt(
    "job_posting",
    {
      title: "채용공고 작성",
      description: "근무세무사·직원 채용공고를 객관식으로 골라 가며 작성하고 법률 점검까지",
      argsSchema: { memo: z.string().optional().describe("채용 조건 메모 (예: 경력 직원 1명, 월 280만원, 주5일)") },
    },
    ({ memo }) =>
      user(
        [
          "우리 사무소 채용공고를 만들어 주세요.",
          memo ? `조건 메모: ${memo}` : "",
          "",
          "1. 메모의 조건으로 draft_job_posting을 호출합니다.",
          "2. [NEEDS_INPUT]이 오면 질문을 객관식(선택지)으로 보여 주고, 고른 값으로 다시 호출합니다.",
          "3. [공고 시작]~[공고 끝] 공고와 법률 점검 결과를 보여 줍니다. 문제가 있으면 고친 공고 전문도 함께 제시합니다.",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
  );
}
