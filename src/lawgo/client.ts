// 법제처 국가법령정보 DRF 호출기.
// - lawSearch.do (목록) / lawService.do (본문) 두 엔드포인트만 사용
// - 동시 호출 수 제한, 일시 장애 재시도, TTL 캐시, 오류 분류를 담당한다.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Settings } from "../config.js";
import { TtlStore } from "./ttlStore.js";
import { isObj, type Json } from "./shape.js";

export type FaultCode =
  | "KEY_MISSING" // OC 미설정
  | "KEY_REJECTED" // OC 검증 실패 / 미승인 IP·도메인
  | "UPSTREAM_DOWN" // 네트워크·5xx·타임아웃
  | "BAD_PAYLOAD" // JSON 아님 / 해석 불가
  | "NO_MATCH" // 조건에 맞는 자료 없음
  | "QUOTA_EXCEEDED" // 서버 공용 키 일일 한도 소진
  | "BAD_INPUT"; // 호출 인자 문제

export class LawgoFault extends Error {
  constructor(public readonly code: FaultCode, message: string) {
    super(message);
    this.name = "LawgoFault";
  }
}

type Endpoint = "lawSearch" | "lawService";
export type Params = Record<string, string | number | undefined>;

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

// 요청 단위로 사용자 본인 OC를 전달한다 (HTTP 헤더·쿼리 → 도구 → 업스트림 호출)
const userKeyScope = new AsyncLocalStorage<string>();

export const OC_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** fn 실행 동안 발생하는 법제처 호출에 사용자 OC를 쓴다 */
export function runWithUserKey<T>(oc: string | undefined, fn: () => T): T {
  return oc ? userKeyScope.run(oc, fn) : fn();
}

const REJECT_HINTS = ["사용자 정보 검증", "인증", "등록되지 않은", "미신청", "허용되지"];

export class LawgoClient {
  private readonly store = new TtlStore<Json>(800);
  private readonly gate: Gate;
  private readonly fetcher: Fetcher;
  private serverKeyDay = "";
  private serverKeyUsed = 0;

  constructor(private readonly cfg: Settings, fetcher?: Fetcher) {
    this.gate = new Gate(cfg.maxParallel);
    this.fetcher = fetcher ?? (globalThis.fetch as unknown as Fetcher);
  }

  /** 서버 기본 키 설정 여부 */
  get hasKey(): boolean {
    return this.cfg.oc.length > 0;
  }

  /** 이번 호출에 쓸 OC: 사용자 키 우선, 없으면 서버 키 (사용자 키 필수 모드에선 서버 키 미사용) */
  private activeKey(): { oc: string; fromUser: boolean } {
    const user = userKeyScope.getStore();
    if (user) return { oc: user, fromUser: true };
    return { oc: this.cfg.requireUserOc ? "" : this.cfg.oc, fromUser: false };
  }

  search(target: string, params: Params): Promise<Json> {
    return this.call("lawSearch", target, params, this.cfg.ttlSearchSec);
  }

  detail(target: string, params: Params): Promise<Json> {
    return this.call("lawService", target, params, this.cfg.ttlDocumentSec);
  }

  buildUrl(endpoint: Endpoint, target: string, params: Params, oc = this.cfg.oc): string {
    return `${this.cfg.baseUrl}/${endpoint}.do?OC=${encodeURIComponent(oc)}&${this.queryPart(target, params)}`;
  }

  private queryPart(target: string, params: Params): string {
    const qs = new URLSearchParams({ target, type: "JSON" });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    return qs.toString();
  }

  private async call(endpoint: Endpoint, target: string, params: Params, ttl: number): Promise<Json> {
    const { oc, fromUser } = this.activeKey();
    if (!oc) {
      throw new LawgoFault(
        "KEY_MISSING",
        this.cfg.requireUserOc
          ? "본인의 법제처 OC가 필요합니다. open.law.go.kr에서 OPEN API를 신청하고, 연결 주소에 ?oc=본인OC 를 붙이거나 X-Lawgo-OC 헤더로 보내세요."
          : "LAWGO_OC 환경변수가 비어 있습니다. open.law.go.kr에서 OPEN API 사용 신청 후 OC 값을 설정하세요.",
      );
    }
    // 법령 데이터는 공개 자료이므로 캐시는 키와 무관하게 공유한다
    const cacheKey = `${endpoint}?${this.queryPart(target, params)}`;
    const cached = this.store.get(cacheKey);
    if (cached !== undefined) return cached;

    if (!fromUser) this.chargeServerKey();
    const body = await this.gate.run(() => this.fetchWithRetry(this.buildUrl(endpoint, target, params, oc)));
    const parsed = this.decode(body, fromUser);
    this.store.put(cacheKey, parsed, ttl);
    return parsed;
  }

  /** 서버 공용 키의 하루 업스트림 호출 수 제한 (캐시 적중은 세지 않음, 0이면 무제한) */
  private chargeServerKey(): void {
    const limit = this.cfg.serverKeyDailyLimit;
    if (!limit) return;
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // 한국 시간 기준
    if (today !== this.serverKeyDay) {
      this.serverKeyDay = today;
      this.serverKeyUsed = 0;
    }
    if (this.serverKeyUsed >= limit) {
      throw new LawgoFault(
        "QUOTA_EXCEEDED",
        `오늘 공용 키 사용 한도를 모두 썼습니다 (매일 0시 초기화). 계속 쓰려면 본인 법제처 OC를 쓰세요: ① open.law.go.kr OPEN API 신청 정보의 서버 도메인에 ${new URL(this.cfg.publicEndpoint).hostname} 등록 ② 연결 주소에 ?oc=본인OC 를 붙이거나 X-Lawgo-OC 헤더로 전달.`,
      );
    }
    this.serverKeyUsed++;
  }

  private async fetchWithRetry(url: string, attempts = 3): Promise<string> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
      try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (this.cfg.upstreamReferer) headers.Referer = this.cfg.upstreamReferer;
        const res = await this.fetcher(url, { signal: ctrl.signal, headers });
        if (res.ok) return await res.text();
        const fault = new LawgoFault("UPSTREAM_DOWN", `법제처 응답 코드 ${res.status}`);
        if (res.status < 500) throw fault; // 4xx는 재시도해도 같은 결과
        lastErr = fault;
      } catch (err) {
        if (err instanceof LawgoFault) {
          if (err !== lastErr) throw err;
        } else {
          lastErr = err; // 네트워크 오류·타임아웃
        }
      } finally {
        clearTimeout(timer);
      }
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new LawgoFault("UPSTREAM_DOWN", `법제처 서버에 연결하지 못했습니다 (${reason})`);
  }

  private decode(body: string, fromUser = false): Json {
    const text = body.trim();
    const rejected = () =>
      new LawgoFault(
        "KEY_REJECTED",
        fromUser
          ? `입력한 OC 인증에 실패했습니다. open.law.go.kr OPEN API 신청 정보의 서버 도메인에 ${new URL(this.cfg.publicEndpoint).hostname} 를 등록했는지, 신청이 승인됐는지 확인하세요.`
          : "OC 인증에 실패했습니다. OPEN API 신청 승인 여부와 등록한 서버 IP/도메인을 확인하세요.",
      );
    if (!text.startsWith("{") && !text.startsWith("[")) {
      if (REJECT_HINTS.some((h) => text.includes(h))) throw rejected();
      throw new LawgoFault("BAD_PAYLOAD", `JSON이 아닌 응답을 받았습니다: ${text.slice(0, 120)}`);
    }
    let parsed: Json;
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      throw new LawgoFault("BAD_PAYLOAD", "응답 JSON을 해석할 수 없습니다.");
    }
    if (isObj(parsed) && typeof parsed.result === "string" && REJECT_HINTS.some((h) => String(parsed.result).includes(h))) {
      throw rejected();
    }
    return parsed;
  }
}
