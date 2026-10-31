// Vercel 함수 진입점. 빌드(npm run build)로 생성된 dist를 그대로 사용한다.
// 인스턴스가 살아 있는 동안 캐시·호출 제한 상태를 재사용한다 (Fluid Compute).
import { loadSettings } from "../dist/config.js";
import { createMcpHandler } from "../dist/httpHandler.js";

const handler = createMcpHandler({
  ...loadSettings(),
  // Vercel 앞단 프록시가 넣는 X-Forwarded-For를 신뢰
  trustProxy: true,
});

export default handler;
