// 로그인 사용자가 마이페이지에 저장한 본인 법제처 OC 조회.
// 서비스 키 없이 사용자 토큰 + RLS로 본인 행만 읽는다. 값은 기록하지 않는다.

import type { Settings } from "../config.js";
import { OC_PATTERN } from "../lawgo/client.js";
import { TtlStore } from "../lawgo/ttlStore.js";
import type { SignedInUser } from "./caller.js";

/** 저장소 장애 시 undefined를 돌려준다 (키 없음과 같은 경로). 예외로 요청 전체를 깨뜨리지 않는다 */
export type SavedKeyLookup = (user: SignedInUser) => Promise<string | undefined>;

const TABLE = "mcp_user_keys";
/** 웹에서 키를 바꾸면 이 시간 안에 반영된다 */
const TTL_SEC = 60;

export function openSavedKeys(cfg: Settings, fetcher: typeof fetch = fetch): SavedKeyLookup {
  if (cfg.authMode !== "oauth" || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return async () => undefined;
  // 키 없음("")도 캐시해 호출마다 저장소를 부르지 않는다
  const cache = new TtlStore<string>(2000);
  return async ({ userId, token }) => {
    const hit = cache.get(userId);
    if (hit !== undefined) return hit || undefined;
    try {
      const r = await fetcher(`${cfg.supabaseUrl}/rest/v1/${TABLE}?select=oc&user_id=eq.${encodeURIComponent(userId)}`, {
        headers: { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) throw new Error(`키 저장소 응답 ${r.status}`);
      const rows = (await r.json()) as { oc?: string }[];
      const oc = rows[0]?.oc && OC_PATTERN.test(rows[0].oc) ? rows[0].oc : "";
      cache.put(userId, oc, TTL_SEC);
      return oc || undefined;
    } catch (err) {
      console.error(`[saved-key] 조회 실패: ${err instanceof Error ? err.message : "unknown"}`);
      return undefined;
    }
  };
}
