import type { Settings } from "../config.js";
import { LawgoClient } from "../lawgo/client.js";
import { GuidanceDesk } from "../lawgo/guidance.js";
import { RulingDesk } from "../lawgo/rulings.js";
import { StatuteDesk } from "../lawgo/statutes.js";
import { openProfileStore, type ProfileStore } from "../office/profile.js";

export interface Desks {
  cfg: Settings;
  api: LawgoClient;
  statutes: StatuteDesk;
  rulings: RulingDesk;
  guidance: GuidanceDesk;
  profiles: ProfileStore;
}

/** remote=true: HTTP 서버(로그인 사용자별 저장), false: 로컬 stdio(파일 저장) */
export function openDesks(cfg: Settings, api = new LawgoClient(cfg), remote = false): Desks {
  return {
    cfg,
    api,
    statutes: new StatuteDesk(api),
    rulings: new RulingDesk(api),
    guidance: new GuidanceDesk(api),
    profiles: openProfileStore(cfg, remote),
  };
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const OFFLINE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
