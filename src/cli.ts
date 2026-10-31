#!/usr/bin/env node
// 실행: 기본 stdio / --http 옵션 시 Streamable HTTP(무상태) 서버

import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadSettings, type Settings } from "./config.js";
import { createMcpHandler } from "./httpHandler.js";
import { buildServer, SERVER_NAME } from "./server.js";

async function serveHttp(cfg: Settings): Promise<void> {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(cfg.httpHost);
  if (!loopback && !cfg.accessToken && !cfg.publicMode) {
    throw new Error("외부 인터페이스에 바인딩하려면 MCP_ACCESS_TOKEN을 설정하거나 PUBLIC_MODE=1(호출 제한 적용)로 공개하세요.");
  }
  const http = createServer(createMcpHandler(cfg));
  await new Promise<void>((resolve) => http.listen(cfg.httpPort, cfg.httpHost, resolve));
  const mode = cfg.accessToken ? "토큰 인증" : cfg.publicMode ? `공개 · IP당 분당 ${cfg.ratePerMinute}회` : "로컬 전용";
  console.error(`[${SERVER_NAME}] HTTP 대기 중: http://${cfg.httpHost}:${cfg.httpPort}/mcp (${mode}) · 공개 주소 ${cfg.publicEndpoint}`);
}

async function main(): Promise<void> {
  const cfg = loadSettings();
  if (!cfg.oc) console.error(`[${SERVER_NAME}] 경고: LAWGO_OC 미설정 — 법령 조회 도구는 KEY_MISSING 오류를 반환합니다 (계산 도구는 사용 가능).`);
  if (process.argv.includes("--http")) return serveHttp(cfg);
  const server = buildServer(cfg);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] 시작 실패:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
