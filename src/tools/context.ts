import type { Settings } from "../config.js";
import { LawgoClient } from "../lawgo/client.js";
import { GuidanceDesk } from "../lawgo/guidance.js";
import { RulingDesk } from "../lawgo/rulings.js";
import { StatuteDesk } from "../lawgo/statutes.js";

export interface Desks {
  cfg: Settings;
  api: LawgoClient;
  statutes: StatuteDesk;
  rulings: RulingDesk;
  guidance: GuidanceDesk;
}

export function openDesks(cfg: Settings, api = new LawgoClient(cfg)): Desks {
  return {
    cfg,
    api,
    statutes: new StatuteDesk(api),
    rulings: new RulingDesk(api),
    guidance: new GuidanceDesk(api),
  };
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const OFFLINE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
