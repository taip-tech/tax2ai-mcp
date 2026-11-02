// 강의 도구: 교재 읽기(read_lesson), 반 참여(join_class), 학습 결과 제출(submit_learning_result).
// 수강생이 claude.ai·ChatGPT에서 TAX2.AI 커넥터를 연결하면, 자기 AI 계정이 TAX2 AI비서가 되고
// 교재 근거와 제출 창구만 이 서버가 맡는다(설치 없음, tax2.ai가 AI 비용을 내지 않음).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AccessEnded, TranscriptAsFile, Classroom, ClassroomUnavailable, DEFAULT_SLUG, NotInClass, RESULT_EXTS, normalizeLessonKey, type LessonDoc } from "../learn/classroom.js";
import { failure, paged, text } from "./reply.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function safe<A>(fn: (a: A) => Promise<CallToolResult>) {
  return async (a: A): Promise<CallToolResult> => {
    try {
      return await fn(a);
    } catch (err) {
      if (err instanceof AccessEnded) return text(`[ACCESS_ENDED] ${err.message} 이 반의 교재 읽기·제출 도구는 더 이상 쓸 수 없습니다. 사용자에게 그대로 알리고, 다시 열어야 하면 강사에게 문의하도록 안내하세요. 교재 내용을 기억으로 대신 설명하지 마세요.`);
      if (err instanceof TranscriptAsFile) return text(`[USE_TRANSCRIPT] ${err.message} 사용자에게 묻지 말고 바로 다시 호출하세요.`);
      if (err instanceof NotInClass) return text(`[NEEDS_CLASS] ${err.message} 강사가 알려 준 6자리 반 참여 코드를 사용자에게 물어본 뒤 join_class로 참여하고 다시 시도하세요.`);
      if (err instanceof ClassroomUnavailable) return text(`[CLASS_UNAVAILABLE] ${err.message}`);
      return failure(err);
    }
  };
}

export function tutorGuide(l: LessonDoc): string {
  return [
    `당신은 "${l.course ?? "TAX2.AI 강의"}" 과정의 TAX2 AI비서입니다. 지금 수업은 ${l.label} "${l.title}"입니다.`,
    "한국어 존댓말로 답하세요.",
    "- 아래 강의자료를 1순위 근거로 답하고, 근거가 된 섹션 제목을 [섹션: 제목]으로 표시하세요.",
    "- 강의자료에 없는 내용은 \"강의자료에는 없는 내용이에요\"라고 먼저 밝힌 뒤 일반 지식으로 보충하세요.",
    "- 실습 결과물을 통째로 대신 만들기보다, 수강생이 스스로 해낼 수 있게 단계와 확인 방법을 알려 주세요.",
    "- 수강생이 \"제출\"을 원하면 학습 소감을 수강생 말로 받고, 대화 요약·핵심 질문·만든 결과물(HTML 등)을 정리해 submit_learning_result로 바로 제출하세요(대화 기록은 transcript로). 미리 다 보여 주고 확인받을 필요는 없습니다.",
    `교재 화면: ${l.url}`,
  ].join("\n");
}

function lessonBody(l: LessonDoc, sectionFilter?: string): string {
  const q = sectionFilter?.trim();
  const sections = q ? l.sections.filter((s) => s.id === q || s.title.includes(q)) : l.sections;
  if (q && !sections.length) throw new RangeError(`"${q}" 섹션을 찾지 못했습니다. 섹션: ${l.sections.map((s) => s.title).join(" / ")}`);
  return [tutorGuide(l), "", `<강의자료 교시="${l.label}">`, ...sections.map((s) => `## ${s.title}\n\n${s.text}`), "</강의자료>"].join("\n\n");
}

export function registerLessonTools(server: McpServer, room: Classroom, charBudget: number): void {
  server.registerTool(
    "read_lesson",
    {
      title: "강의 교재 읽기",
      description:
        "TAX2.AI 강의 교재(서울지방세무사회 2기 'AI를 활용한 세무사 사업현장 업무 혁신')를 읽어 TAX2 AI비서로 답할 근거를 가져옵니다. lesson 없이 부르면 교시 목록과 열림 여부를, lesson('1일차 1교시', 'day1-session1', '보충')을 주면 그 교시 본문을 돌려줍니다. 강사가 아직 열지 않은 교시는 본문을 주지 않습니다. 수강생이 수업 내용을 물으면 먼저 이 도구로 해당 교시를 읽고 답하세요.",
      inputSchema: {
        lesson: z.string().max(40).optional().describe("교시 (예: 1일차 1교시, day1-session1, 보충). 비우면 목록"),
        section: z.string().max(60).optional().describe("이 섹션만 (섹션 제목 일부 또는 id)"),
        cursor: z.number().int().min(0).optional().describe("긴 교재 이어받기 위치 ([MORE] 안내 값)"),
      },
      annotations: READ,
    },
    safe(async ({ lesson, section, cursor }) => {
      const ended = await room.accessEnded();
      if (ended) throw new AccessEnded(ended);
      if (!lesson) {
        const list = await room.listLessons(DEFAULT_SLUG);
        return text([
          "■ 강의 교시 목록 (🔓 열림 · 🔒 강사가 아직 열지 않음)",
          ...list.map((l) => `${l.open ? "🔓" : "🔒"} ${l.label} — ${l.title} (lesson="${l.key}")`),
          "",
          "수강생에게 지금 듣는 교시를 묻고 read_lesson(lesson=...)으로 본문을 읽으세요.",
        ].join("\n"));
      }
      const l = await room.readLesson(normalizeLessonKey(lesson));
      if (!l.open) return text(`[LESSON_CLOSED] ${l.label} "${l.title}"은(는) 강사가 아직 열지 않은 교시입니다. 수업 진행에 맞춰 열리면 다시 읽을 수 있습니다. 교재 화면: ${l.url}`);
      return paged(lessonBody(l, section), cursor, Math.max(charBudget, 20_000), false);
    }),
  );

  server.registerTool(
    "join_class",
    {
      title: "강의 반 참여",
      description:
        "강사가 알려 준 6자리 반 참여 코드로 반에 들어가거나(action=join), 지금 참여한 반을 확인합니다(action=view). 반에 참여해야 학습 결과가 강사 화면으로 제출됩니다. 이름은 강사 명단에 보일 실명을 사용자에게 받아 넣으세요.",
      inputSchema: {
        action: z.enum(["view", "join"]).default("view"),
        code: z.string().regex(/^[A-Za-z0-9]{6}$/).optional().describe("반 참여 코드 6자리"),
        name: z.string().min(1).max(40).optional().describe("강사 명단에 보일 이름"),
        org: z.string().max(80).optional().describe("소속 (선택)"),
      },
      annotations: WRITE,
    },
    safe(async ({ action, code, name, org }) => {
      if (action === "view") {
        const m = await room.membership();
        return text(m ? `■ 참여 중인 반: ${m.className}\n- 이름: ${m.name}${m.org ? `\n- 소속: ${m.org}` : ""}${m.ended ? `\n- [ACCESS_ENDED] ${m.ended}` : ""}` : "아직 참여한 반이 없습니다. 강사에게 받은 6자리 참여 코드와 이름을 물어 join_class(action=join)으로 참여하세요.");
      }
      if (!code || !name) return text("[NEEDS_INPUT] 반 참여 코드(6자리)와 강사 명단에 보일 이름을 사용자에게 물어 다시 호출하세요.");
      const m = await room.join(code, name.trim(), (org ?? "").trim());
      return text(`✓ "${m.className}" 반에 참여했습니다 (이름: ${m.name}). 이제 submit_learning_result로 제출한 결과가 강사 화면에 보입니다.`);
    }),
  );

  server.registerTool(
    "submit_learning_result",
    {
      title: "학습 결과 제출",
      description:
        `수강생의 학습 결과를 강사에게 제출합니다(tax2.ai 관리자 > 학습 결과). 수강생이 제출을 요청하면 바로 호출하세요 — 보낼 내용을 미리 다 보여 주거나 여러 번 확인받지 마세요. 소감이 없을 때만 한 번 물어보세요.
- reflection: 수강생 본인의 학습 소감(수강생 말 그대로, 대신 지어내지 말 것)
- transcript(기본으로 항상 포함): 이 대화의 채팅 화면에 보인 메시지를 처음부터 순서대로 메시지별로(role·text). 수강생 메시지와 수강생에게 보여 준 최종 답변을 줄이거나 요약하지 말고 그대로. 생각·추론 과정, 도구 호출과 도구 결과(교재 본문)는 넣지 마세요. 고객 실명·주민번호·계좌번호가 보이면 [가림]으로 바꿔 넣으세요(따로 묻지 않아도 됩니다). 수강생이 대화 기록은 빼 달라고 할 때만 생략하세요.
- 대화 기록을 .md·.txt 파일로 만들어 files에 넣지 마세요. 반드시 transcript에 넣어야 강사 화면에 대화 형태로 보입니다.
- summary: 배운 내용·막힌 점 요약, files: 수강생이 만든 결과물(${RESULT_EXTS.join("·")} 텍스트, 각 1MB 이하. 예: 만든 HTML 도구)
- 같은 교시에 이미 낸 제출물이 있으면 그 제출물이 새 내용으로 갱신됩니다(따로 쌓이지 않음). 수강생이 '새로 하나 더' 내길 원할 때만 new_submission=true.
- 이미지(화면 캡처)는 이 도구로 보낼 수 없습니다. 제출 후 돌려주는 '캡처 이미지 추가' 링크를 안내하세요(이미지를 글로 옮겨 파일로 만들지 마세요).`,
      inputSchema: {
        lesson: z.string().max(40).describe("교시 (예: 1일차 1교시, day1-session1)"),
        reflection: z.string().min(1).max(5000).describe("수강생의 학습 소감 (수강생 말 그대로)"),
        summary: z.string().max(8000).optional().describe("대화에서 배운 내용·막힌 점 요약"),
        questions: z.array(z.string().max(1000)).max(50).optional().describe("수강생이 한 핵심 질문"),
        transcript: z.array(z.object({
          role: z.enum(["user", "assistant"]).describe("user=수강생, assistant=TAX2 AI비서"),
          text: z.string().max(40_000).describe("화면에 보인 메시지 내용 (생각·추론 과정 제외)"),
        })).max(400).optional().describe("채팅 화면에 보인 대화 기록 — 메시지별, 처음부터 순서대로, 그대로"),
        new_submission: z.boolean().optional().describe("true면 기존 제출물을 갱신하지 않고 새로 추가"),
        files: z.array(z.object({
          name: z.string().regex(/^[^/\\]{1,80}\.[A-Za-z0-9]{1,5}$/).describe("파일 이름 (예: 카드내역변환기.html)"),
          content: z.string().max(1_000_000).describe("파일 내용 (텍스트)"),
        })).max(5).optional().describe("만든 결과물"),
      },
      annotations: WRITE,
    },
    safe(async ({ lesson, reflection, summary, questions, transcript, files, new_submission }) => {
      const l = await room.readLesson(normalizeLessonKey(lesson));
      const r = await room.submit({ lesson: l, reflection, summary, questions, transcript, files, newSubmission: new_submission });
      return text([
        `✓ ${r.membership.className} 반 강사에게 ${r.updated ? "제출물을 갱신했습니다" : "제출했습니다"} — ${l.label} "${l.title}"`,
        `- 제출자: ${r.membership.name}`,
        `- ${r.turns ? `대화 기록 ${r.turns}개 메시지` : `질문 ${questions?.length ?? 0}개`}${r.files.length ? ` · 결과 파일 ${r.files.join(", ")}` : ""}`,
        `- 캡처 이미지 추가: ${room.attachUrl(r.id)}`,
        "  (대화에 붙인 이미지는 도구로 보낼 수 없습니다. 캡처가 있으면 이 링크를 열어 붙여 넣기(Ctrl+V·⌘V)하라고 사용자에게 링크를 그대로 안내하세요.)",
        "사용자에게는 짧게 알리세요(무엇을 보냈는지 한두 줄 + 캡처 링크).",
      ].join("\n"));
    }),
  );

  server.registerTool(
    "capture_upload_link",
    {
      title: "캡처 이미지 추가 링크",
      description:
        "이미 제출한 학습 결과에 화면 캡처 이미지를 붙일 tax2.ai 링크를 돌려줍니다. 대화에 붙인 이미지는 도구로 직접 보낼 수 없으므로, 사용자가 캡처·이미지를 제출하고 싶어 하면 이 링크를 그대로 안내하세요(링크에서 붙여 넣기 Ctrl+V·⌘V, 끌어 놓기, 파일 선택). 그 교시에 제출물이 없으면 먼저 submit_learning_result로 제출해야 합니다.",
      inputSchema: {
        lesson: z.string().max(40).describe("교시 (예: 1일차 1교시, day1-session1)"),
      },
      annotations: READ,
    },
    safe(async ({ lesson }) => {
      const l = await room.readLesson(normalizeLessonKey(lesson));
      const ended = await room.accessEnded();
      if (ended) throw new AccessEnded(ended);
      const sub = await room.latestSubmission(l.aiLessonId);
      if (!sub) return text(`[NEEDS_SUBMISSION] ${l.label}에 낸 제출물이 아직 없습니다. 소감을 받아 submit_learning_result로 먼저 제출한 뒤, 돌려받은 캡처 링크를 안내하세요.`);
      return text([
        `■ ${l.label} 제출물(${new Date(sub.submittedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })})에 캡처 붙이기`,
        room.attachUrl(sub.id),
        "이 링크를 열고 캡처를 붙여 넣기(Ctrl+V·⌘V)하거나 끌어 놓은 뒤 '캡처 제출'을 누르면 강사 화면에 바로 보입니다. tax2.ai에 로그인되어 있어야 합니다.",
      ].join("\n"));
    }),
  );
}
