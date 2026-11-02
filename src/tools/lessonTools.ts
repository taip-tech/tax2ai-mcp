// 강의 도구: 교재 읽기(read_lesson), 반 참여(join_class), 학습 결과 제출(submit_learning_result).
// 수강생이 claude.ai·ChatGPT에서 TAX2.AI 커넥터를 연결하면, 자기 AI 계정이 튜터가 되고
// 교재 근거와 제출 창구만 이 서버가 맡는다(설치 없음, tax2.ai가 AI 비용을 내지 않음).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Classroom, ClassroomUnavailable, DEFAULT_SLUG, NotInClass, RESULT_EXTS, normalizeLessonKey, type LessonDoc } from "../learn/classroom.js";
import { failure, paged, text } from "./reply.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function safe<A>(fn: (a: A) => Promise<CallToolResult>) {
  return async (a: A): Promise<CallToolResult> => {
    try {
      return await fn(a);
    } catch (err) {
      if (err instanceof NotInClass) return text(`[NEEDS_CLASS] ${err.message} 강사가 알려 준 6자리 반 참여 코드를 사용자에게 물어본 뒤 join_class로 참여하고 다시 시도하세요.`);
      if (err instanceof ClassroomUnavailable) return text(`[CLASS_UNAVAILABLE] ${err.message}`);
      return failure(err);
    }
  };
}

export function tutorGuide(l: LessonDoc): string {
  return [
    `당신은 "${l.course ?? "TAX2.AI 강의"}" 과정의 AI 튜터입니다. 지금 수업은 ${l.label} "${l.title}"입니다.`,
    "한국어 존댓말로 답하세요.",
    "- 아래 강의자료를 1순위 근거로 답하고, 근거가 된 섹션 제목을 [섹션: 제목]으로 표시하세요.",
    "- 강의자료에 없는 내용은 \"강의자료에는 없는 내용이에요\"라고 먼저 밝힌 뒤 일반 지식으로 보충하세요.",
    "- 실습 결과물을 통째로 대신 만들기보다, 수강생이 스스로 해낼 수 있게 단계와 확인 방법을 알려 주세요.",
    "- 수강생이 \"제출\"을 원하면 학습 소감을 수강생 말로 받고, 대화 요약·핵심 질문·만든 결과물(HTML 등)을 정리해 submit_learning_result로 제출하세요. 제출 전에 보낼 내용을 보여 주고 확인을 받으세요.",
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
        "TAX2.AI 강의 교재(서울지방세무사회 2기 'AI를 활용한 세무사 사업현장 업무 혁신')를 읽어 AI 튜터로 답할 근거를 가져옵니다. lesson 없이 부르면 교시 목록과 열림 여부를, lesson('1일차 1교시', 'day1-session1', '보충')을 주면 그 교시 본문을 돌려줍니다. 강사가 아직 열지 않은 교시는 본문을 주지 않습니다. 수강생이 수업 내용을 물으면 먼저 이 도구로 해당 교시를 읽고 답하세요.",
      inputSchema: {
        lesson: z.string().max(40).optional().describe("교시 (예: 1일차 1교시, day1-session1, 보충). 비우면 목록"),
        section: z.string().max(60).optional().describe("이 섹션만 (섹션 제목 일부 또는 id)"),
        cursor: z.number().int().min(0).optional().describe("긴 교재 이어받기 위치 ([MORE] 안내 값)"),
      },
      annotations: READ,
    },
    safe(async ({ lesson, section, cursor }) => {
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
        return text(m ? `■ 참여 중인 반: ${m.className}\n- 이름: ${m.name}${m.org ? `\n- 소속: ${m.org}` : ""}` : "아직 참여한 반이 없습니다. 강사에게 받은 6자리 참여 코드와 이름을 물어 join_class(action=join)으로 참여하세요.");
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
        `수강생의 학습 결과를 강사에게 제출합니다(tax2.ai 관리자 > 학습 결과). 수강생이 제출을 요청했을 때만, 보낼 내용을 보여 주고 확인을 받은 뒤 호출하세요. reflection은 수강생 본인의 학습 소감(대신 지어내지 말 것), summary는 이 대화에서 배운 내용·막힌 점 요약, questions는 수강생이 한 핵심 질문, files는 만든 결과물(${RESULT_EXTS.join("·")} 텍스트, 각 1MB 이하). 대화 원문 전체는 보내지 않습니다. 다시 제출하면 새 제출물로 추가됩니다.`,
      inputSchema: {
        lesson: z.string().max(40).describe("교시 (예: 1일차 1교시, day1-session1)"),
        reflection: z.string().min(1).max(5000).describe("수강생의 학습 소감 (수강생 말 그대로)"),
        summary: z.string().max(8000).optional().describe("대화에서 배운 내용·막힌 점 요약"),
        questions: z.array(z.string().max(1000)).max(50).optional().describe("수강생이 한 핵심 질문"),
        files: z.array(z.object({
          name: z.string().regex(/^[^/\\]{1,80}\.[A-Za-z0-9]{1,5}$/).describe("파일 이름 (예: 카드내역변환기.html)"),
          content: z.string().max(1_000_000).describe("파일 내용 (텍스트)"),
        })).max(5).optional().describe("만든 결과물"),
      },
      annotations: WRITE,
    },
    safe(async ({ lesson, reflection, summary, questions, files }) => {
      const l = await room.readLesson(normalizeLessonKey(lesson));
      const r = await room.submit({ lesson: l, reflection, summary, questions, files });
      return text([
        `✓ ${r.membership.className} 반 강사에게 제출했습니다 — ${l.label} "${l.title}"`,
        `- 제출자: ${r.membership.name}`,
        `- 질문 ${questions?.length ?? 0}개${r.files.length ? ` · 결과 파일 ${r.files.join(", ")}` : ""}`,
        "다시 제출하면 새 제출물로 추가됩니다.",
      ].join("\n"));
    }),
  );
}
