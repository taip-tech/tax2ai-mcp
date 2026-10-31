// 객관식 되묻기: 필수 정보가 빠지면 도구가 선택지를 돌려주고,
// 모델이 사용자에게 보여 준 뒤 고른 값으로 같은 도구를 다시 부른다.
// (서버가 직접 선택창을 띄우는 방식은 무상태 운영과 맞지 않아 쓰지 않는다)

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface Choice {
  label: string;
  value: string;
}

export interface Question {
  /** 도구 인자 이름 */
  arg: string;
  ask: string;
  choices?: Choice[];
  /** true면 여러 개 고르기 (값은 배열로 전달) */
  multi?: boolean;
  /** 선택지 대신 직접 입력받을 때의 예시 */
  example?: string;
}

const NUMS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫";

export function needsInput(tool: string, purpose: string, questions: Question[], known: string[] = []): CallToolResult {
  const blocks = questions.map((q, i) => {
    const head = `Q${i + 1}. ${q.ask}${q.multi ? " (여러 개 선택 가능)" : ""}  → 인자 \`${q.arg}\``;
    if (q.choices?.length) {
      return [head, ...q.choices.map((c, j) => `   ${NUMS[j] ?? `${j + 1}.`} ${c.label}  [${c.value}]`)].join("\n");
    }
    return `${head}\n   직접 입력${q.example ? ` (예: ${q.example})` : ""}`;
  });
  const lines = [
    `[NEEDS_INPUT] ${purpose}에 필요한 정보가 부족합니다.`,
    "아래 질문을 사용자에게 객관식으로 보여 주세요 (가능하면 선택 버튼·목록 형태로, 대괄호 안의 값은 보여 주지 않아도 됩니다).",
    `사용자가 고르면 [ ] 안의 값을 해당 인자에 넣어 ${tool}을(를) 다시 호출하세요. 사용자가 이미 말한 내용은 다시 묻지 말고 바로 채우세요.`,
    "",
    ...blocks,
  ];
  if (known.length) lines.push("", `이미 받은 값: ${known.join(", ")}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
