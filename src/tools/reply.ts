// 도구 응답 공통 처리: 길이 제한·이어받기, 오류 표기, 면책 문구

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LawgoFault } from "../lawgo/client.js";

export const NOTICE =
  "※ 법제처 국가법령정보 원문을 가공한 참고자료입니다. 신고·의견 제출 전에는 원문과 적용 시점을 직접 확인하세요.";

// 도구 응답 끝에 붙는 출처 표기. buildServer가 설정값으로 지정한다 (null이면 생략).
let creditLine: string | null = null;

export function setCreditLine(line: string | null): void {
  creditLine = line;
}

export function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

/** budget 글자 단위로 자르고, 남은 분량이 있으면 다음 cursor를 안내한다. */
export function paged(body: string, cursor: number | undefined, budget: number, withNotice = true): CallToolResult {
  const start = Math.max(0, cursor ?? 0);
  if (start >= body.length && body.length > 0) {
    return text(`[END] 더 이상 이어받을 내용이 없습니다 (전체 ${body.length}자).`);
  }
  let end = Math.min(body.length, start + budget);
  if (end < body.length) {
    const nl = body.lastIndexOf("\n", end);
    if (nl > start + budget * 0.6) end = nl; // 줄 단위로 끊기
  }
  const chunk = body.slice(start, end);
  const tail =
    end < body.length
      ? `\n\n[MORE] ${end}/${body.length}자 표시. 이어서 보려면 같은 인자에 cursor=${end} 를 넣어 다시 호출하세요.`
      : withNotice
        ? `\n\n${NOTICE}`
        : "";
  return text(chunk + tail);
}

export function failure(err: unknown): CallToolResult {
  if (err instanceof LawgoFault) {
    return { isError: true, content: [{ type: "text", text: `[${err.code}] ${err.message}` }] };
  }
  if (err instanceof RangeError) {
    return { isError: true, content: [{ type: "text", text: `[BAD_INPUT] ${err.message}` }] };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: `[INTERNAL] ${msg}` }] };
}

/** 핸들러를 감싸 예외를 MCP 오류 응답으로 바꾼다. */
export function guarded<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      const result = await fn(args);
      if (creditLine && !result.isError) result.content.push({ type: "text", text: creditLine });
      return result;
    } catch (err) {
      return failure(err);
    }
  };
}

export const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
