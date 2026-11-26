// 서울외국환중개(www.smbs.biz) 매매기준율·재정된 매매기준율 조회
// 일자별 고시 환율을 가져와 캐시하고, 휴일이면 직전 고시일 환율로 대체한다.

import { TtlStore } from "../lawgo/ttlStore.js";

export const SMBS_PAGE = "http://www.smbs.biz/ExRate/TodayExRate.jsp";
const SMBS_DATA = "http://www.smbs.biz/Flash/TodayExRate_flash.jsp";

export type FxFetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface FxRate {
  code: string;
  name: string;
  /** 환율이 몇 단위 기준인지 (JPY·IDR·VND는 100) */
  unit: number;
  /** 원화 환율 (unit 단위당 원) */
  rate: number;
  /** 전일 대비 */
  change: number;
}

export interface FxDay {
  /** 요청한 날짜 */
  requested: string;
  /** 실제 환율이 고시된 날짜 (휴일이면 직전 고시일) */
  used: string;
  rates: Map<string, FxRate>;
}

export class FxFault extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/** 서울외국환중개 통화 순서와 한글명 */
export const CURRENCIES: Record<string, string> = {
  USD: "미국 달러", JPY: "일본 엔", EUR: "유로", GBP: "영국 파운드", CAD: "캐나다 달러", CHF: "스위스 프랑",
  AUD: "호주 달러", NZD: "뉴질랜드 달러", CNH: "중국 위안(역외)", HKD: "홍콩 달러", TWD: "대만 달러",
  MNT: "몽골 투그릭", KZT: "카자흐스탄 텡게", THB: "태국 바트", SGD: "싱가포르 달러", IDR: "인도네시아 루피아",
  MYR: "말레이시아 링깃", PHP: "필리핀 페소", VND: "베트남 동", BND: "브루나이 달러", INR: "인도 루피",
  PKR: "파키스탄 루피", BDT: "방글라데시 타카", KHR: "캄보디아 리엘", MOP: "마카오 파타카", NPR: "네팔 루피",
  LKR: "스리랑카 루피", UZS: "우즈베키스탄 숨", MMK: "미얀마 짯", MXN: "멕시코 페소", BRL: "브라질 헤알",
  ARS: "아르헨티나 페소", CLP: "칠레 페소", COP: "콜롬비아 페소", SEK: "스웨덴 크로나", DKK: "덴마크 크로네",
  NOK: "노르웨이 크로네", RUB: "러시아 루블", HUF: "헝가리 포린트", PLN: "폴란드 즐로티", CZK: "체코 코루나",
  RON: "루마니아 레우", SAR: "사우디 리얄", QAR: "카타르 리얄", ILS: "이스라엘 셰켈", JOD: "요르단 디나르",
  KWD: "쿠웨이트 디나르", BHD: "바레인 디나르", AED: "아랍에미리트 디르함", TRY: "튀르키예 리라",
  OMR: "오만 리알", ZAR: "남아공 랜드", EGP: "이집트 파운드", KES: "케냐 실링", LYD: "리비아 디나르",
  ETB: "에티오피아 비르", FJD: "피지 달러",
};

/** 100단위로 고시되는 통화 */
const PER_100 = new Set(["JPY", "IDR", "VND"]);

/** 고시 단위 (JPY·IDR·VND는 100) */
export const unitOf = (code: string) => (PER_100.has(code) ? 100 : 1);

const ALIASES: Record<string, string> = {
  달러: "USD", 미국달러: "USD", 미화: "USD", 불: "USD", "US$": "USD", $: "USD",
  엔: "JPY", 엔화: "JPY", 일본엔: "JPY", "¥": "JPY", JPY100: "JPY",
  유로: "EUR", 유로화: "EUR", "€": "EUR",
  파운드: "GBP", 영국파운드: "GBP", "£": "GBP",
  위안: "CNH", 위안화: "CNH", 중국위안: "CNH", 인민폐: "CNH", RMB: "CNH", CNY: "CNH",
  홍콩달러: "HKD", 대만달러: "TWD", 캐나다달러: "CAD", 호주달러: "AUD", 뉴질랜드달러: "NZD",
  싱가포르달러: "SGD", 스위스프랑: "CHF", 프랑: "CHF", 동: "VND", 베트남동: "VND", 바트: "THB",
  루피아: "IDR", 링깃: "MYR", 페소: "PHP", 루피: "INR", 루블: "RUB", 리라: "TRY", 디르함: "AED",
};

/** 통화 표기(코드·한글·기호)를 서울외국환중개 통화코드로 */
export function normalizeCurrency(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, "").replace(/\(100\)$/, "");
  const up = s.toUpperCase();
  if (CURRENCIES[up]) return up;
  if (ALIASES[s]) return ALIASES[s];
  if (ALIASES[up]) return ALIASES[up];
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** 엑셀에서 흔한 날짜 표기를 YYYY-MM-DD로 (2026.11.20 / 2026/11/20 / 20261120 / 엑셀 일련번호 46346) */
export function normalizeDate(raw: string | number): string | null {
  const s = String(raw).trim();
  let y: number, m: number, d: number;
  let hit = s.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?(?:[ T].*)?$/);
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else if ((hit = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 20000 && Number(s) < 80000) {
    // 엑셀 1900 날짜 체계 일련번호 (1899-12-30 기준)
    const t = Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000;
    return ymd(new Date(t));
  } else return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return ymd(t);
}

function shiftDay(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return ymd(t);
}

/** 한국 시간 기준 오늘 */
export function todayKst(now = new Date()): string {
  return ymd(new Date(now.getTime() + 9 * 3_600_000));
}

/** 응답 예: ?test0=test&updown=0&USD=1,343.90&updown1=0&&diff1 =.3&JPY=844.37&...&loading=ok& */
export function parseSmbs(body: string): Map<string, FxRate> {
  const out = new Map<string, FxRate>();
  const fields = new Map<string, string>();
  for (const part of body.trim().replace(/^\?/, "").split("&")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    fields.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const codes = Object.keys(CURRENCIES);
  for (const [key, value] of fields) {
    if (!codes.includes(key)) continue;
    const rate = Number(value.replace(/,/g, ""));
    if (!Number.isFinite(rate) || rate <= 0) continue;
    // diffN의 N은 응답에 나온 통화 순서 (USD=1). 순서가 바뀌어도 맞도록 바로 다음 diff를 찾는다.
    const order = [...fields.keys()].filter((k) => codes.includes(k)).indexOf(key) + 1;
    const diff = Number((fields.get(`diff${order}`) ?? "0").replace(/,/g, ""));
    const updown = fields.get(`updown${order}`);
    // updown: 0=상승, 1=하락, 3=보합. diff가 부호 없이 오는 경우를 대비해 하락이면 음수로 맞춘다.
    const change = updown === "1" ? -Math.abs(diff) : updown === "3" ? 0 : Math.abs(diff);
    out.set(key, { code: key, name: CURRENCIES[key], unit: unitOf(key), rate, change: Number.isFinite(change) ? change : 0 });
  }
  return out;
}

export class FxDesk {
  private readonly cache = new TtlStore<Promise<Map<string, FxRate>>>(2000);
  private readonly fetcher: FxFetcher;

  constructor(fetcher?: FxFetcher, private readonly now: () => Date = () => new Date(), private readonly timeoutMs = 10_000) {
    this.fetcher = fetcher ?? ((url, init) => fetch(url, init));
  }

  /** 그 날짜에 고시된 환율. 휴일·고시 전이면 빈 Map */
  publishedOn(date: string): Promise<Map<string, FxRate>> {
    const hit = this.cache.get(date);
    if (hit) return hit;
    const job = this.download(date);
    const today = todayKst(this.now());
    // 과거 고시분은 바뀌지 않으므로 오래 보관. 오늘 분은 고시 전후로 달라질 수 있어 짧게.
    this.cache.put(date, job, date < today ? 7 * 86_400 : 600);
    job.catch(() => this.cache.put(date, job, 0));
    return job;
  }

  private async download(date: string): Promise<Map<string, FxRate>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${SMBS_DATA}?tr_date=${date}`, {
        signal: ctrl.signal,
        headers: { "X-Requested-With": "XMLHttpRequest", Referer: SMBS_PAGE, Accept: "text/plain, */*; q=0.01" },
      });
      if (!res.ok) throw new FxFault("UPSTREAM", `서울외국환중개 응답 오류 (HTTP ${res.status}, ${date})`);
      return parseSmbs(await res.text());
    } catch (err) {
      if (err instanceof FxFault) throw err;
      const msg = ctrl.signal.aborted ? "응답 시간 초과" : err instanceof Error ? err.message : String(err);
      throw new FxFault("UPSTREAM", `서울외국환중개 연결 실패 (${date}): ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 요청일 환율. 고시가 없으면 previous=true일 때 최대 maxBack일 전까지 직전 고시일을 찾는다. */
  async resolve(date: string, previous = true, maxBack = 14): Promise<FxDay> {
    const today = todayKst(this.now());
    if (date > today) throw new FxFault("BAD_INPUT", `${date}은 아직 오지 않은 날짜입니다 (오늘 ${today}).`);
    if (date < "1995-01-01") throw new FxFault("BAD_INPUT", `${date}: 서울외국환중개 조회 범위를 벗어난 날짜입니다.`);
    let probe = date;
    for (let back = 0; back <= (previous ? maxBack : 0); back++) {
      const rates = await this.publishedOn(probe);
      if (rates.size) return { requested: date, used: probe, rates };
      probe = shiftDay(probe, -1);
    }
    return { requested: date, used: "", rates: new Map() };
  }

  /** 여러 날짜를 동시에 몇 개씩만 조회 */
  async resolveMany(dates: string[], previous = true, parallel = 4): Promise<Map<string, FxDay>> {
    const unique = [...new Set(dates)].sort();
    const out = new Map<string, FxDay>();
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        const d = unique[next++];
        out.set(d, await this.resolve(d, previous));
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, unique.length) }, worker));
    return out;
  }
}
