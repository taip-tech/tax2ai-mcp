// 부동산 공시가격 알리미(www.realtyprice.kr) 조회
// 화면이 쓰는 JSON 조회 주소를 그대로 호출한다: 지역코드, 개별공시지가, 개별주택가격, 공동주택가격(단지→동→호→연도별 가격).

import { TtlStore } from "../lawgo/ttlStore.js";

export const REALTY_SITE = "https://www.realtyprice.kr/notice/main/mainBody.htm";
const BASE = "https://www.realtyprice.kr/notice";

export type RealtyFetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class RealtyFault extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface Region {
  code: string;
  name: string;
}

/** 주소를 해석한 결과 */
export interface Parcel {
  sido: Region;
  sgg: Region;
  eub: Region;
  /** 산 여부 */
  san: boolean;
  bun1?: number;
  bun2?: number;
  /** 지번 뒤에 남은 글자 (단지명·동·호 등) */
  rest: string;
  /** 사람이 읽는 주소 */
  label: string;
}

export interface LandPrice {
  year: string;
  baseDate: string;
  pricePerM2: number;
  noticeDate: string;
  note: string;
  addr: string;
}

export interface HousePrice {
  baseDate: string;
  price: number;
  addr: string;
  landArea: string;
  calcLandArea: string;
  floorArea: string;
  residentialArea: string;
  building: string;
}

export interface AptOption {
  code: string;
  name: string;
  noticeDate: string;
}

export interface AptPrice {
  baseDate: string;
  noticeDate: string;
  price: number;
  area: string;
  apt: string;
  dong: string;
  ho: string;
  addr: string;
  roadAddr: string;
}

const squash = (s: string) => s.replace(/\s+/g, "");
const num = (s: unknown) => Number(String(s ?? "").replace(/[,\s]/g, ""));
const ymdDots = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6)}` : s);

/** 행정구역 이름(정식) → 사용자가 흔히 쓰는 줄임 이름들 */
const SIDO_EXTRA: Record<string, string[]> = {
  전남광주통합특별시: ["전남", "광주", "전라남도", "광주광역시", "전남광주"],
  강원특별자치도: ["강원도"],
  전북특별자치도: ["전라북도"],
  제주특별자치도: ["제주도"],
};

export function sidoAliases(name: string): string[] {
  const full = squash(name);
  const stem = full.replace(/(특별자치시|특별자치도|특별시|광역시|도)$/, "");
  const out = new Set([full, stem, ...(SIDO_EXTRA[full] ?? [])]);
  // 충청북도→충북, 경상남도→경남
  if (/^(충청|경상|전라)(남|북)도$/.test(full)) out.add(full[0] + full[2]);
  return [...out].filter(Boolean);
}

/** 시군구 이름 변형: 사이트는 '고양덕양구'처럼 '시' 없이 적는다 */
export function sggAliases(name: string): string[] {
  const n = squash(name);
  const out = new Set([n]);
  if (/구$/.test(n) && n.length >= 4 && !n.includes("시")) {
    out.add(`${n.slice(0, 2)}시${n.slice(2)}`);
    out.add(n.slice(2));
  }
  return [...out];
}

/** 읍면동 이름 변형: '가평읍 개곡리' → '가평읍개곡리', '개곡리' */
export function eubAliases(name: string): string[] {
  const trimmed = name.trim();
  const out = new Set([squash(trimmed)]);
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) out.add(parts[parts.length - 1]);
  return [...out].filter(Boolean);
}

/** 문자열 앞부분과 가장 길게 맞는 후보 */
function longestPrefix<T>(text: string, items: T[], aliases: (t: T) => string[]): { item: T; used: string }[] {
  let best = 0;
  let hits: { item: T; used: string }[] = [];
  for (const item of items) {
    for (const a of aliases(item)) {
      if (!a || !text.startsWith(a)) continue;
      if (a.length > best) {
        best = a.length;
        hits = [{ item, used: a }];
      } else if (a.length === best && !hits.some((h) => h.item === item)) hits.push({ item, used: a });
    }
  }
  return hits;
}

/** 지번 부분: '산 12-3번지', '757', '4-9' */
export function parseJibun(text: string): { san: boolean; bun1?: number; bun2?: number; rest: string } {
  const m = text.match(/^(산)?\s*(\d{1,4})(?:\s*-\s*(\d{1,4}))?\s*(?:번지)?/);
  if (!m || !m[2]) return { san: false, rest: text.trim() };
  return { san: Boolean(m[1]), bun1: Number(m[2]), bun2: m[3] ? Number(m[3]) : undefined, rest: text.slice(m[0].length).trim() };
}

const pad4 = (n: number | undefined) => String(n ?? 0).padStart(4, "0");

export class RealtyDesk {
  private readonly cache = new TtlStore<Promise<unknown>>(3000);
  private readonly fetcher: RealtyFetcher;

  constructor(fetcher?: RealtyFetcher, private readonly now: () => Date = () => new Date(), private readonly timeoutMs = 12_000) {
    this.fetcher = fetcher ?? ((url, init) => fetch(url, init));
  }

  private async getJson(path: string, params: Record<string, string>, referer: string): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams(params).toString();
    const url = `${BASE}${path}?${qs}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(url, {
        signal: ctrl.signal,
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${BASE}${referer}`,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "User-Agent": "Mozilla/5.0 (compatible; tax2ai-mcp)",
        },
      });
      if (!res.ok) throw new RealtyFault("UPSTREAM", `부동산 공시가격 알리미 응답 오류 (HTTP ${res.status})`);
      const body = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        throw new RealtyFault("UPSTREAM", "부동산 공시가격 알리미가 조회 결과 대신 오류 화면을 돌려줬습니다. 잠시 후 다시 시도하거나 사이트에서 직접 열람하세요.");
      }
      const model = (data as { model?: Record<string, unknown> }).model;
      if (!model) throw new RealtyFault("UPSTREAM", "부동산 공시가격 알리미 응답 형식이 바뀌었습니다.");
      return model;
    } catch (err) {
      if (err instanceof RealtyFault) throw err;
      const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
      const detail = cause?.code ?? cause?.message;
      const msg = ctrl.signal.aborted ? "응답 시간 초과" : `${err instanceof Error ? err.message : String(err)}${detail ? ` (${detail})` : ""}`;
      throw new RealtyFault("UPSTREAM", `부동산 공시가격 알리미 연결 실패: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private cached<T>(key: string, ttlSec: number, job: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const p = job();
    this.cache.put(key, p, ttlSec);
    p.catch(() => this.cache.put(key, p, 0));
    return p;
  }

  private regions(gubun: "" | "sgg" | "eub", sido = "", sgg = ""): Promise<Region[]> {
    return this.cached(`bjd:${gubun}:${sido}:${sgg}`, 86_400, async () => {
      const m = await this.getJson("/bjd/searchBjdApi.bjd", { gbn: "1", gubun, addr_gbn: "", sido, sgg, eub: "" }, "/gsindividual/search.htm");
      const list = (m.list as Array<{ code: string; name: string }> | null) ?? [];
      return list.map((r) => ({ code: String(r.code), name: String(r.name).trim() }));
    });
  }

  /** '서울 강남구 역삼동 757' 같은 지번 주소를 지역코드·지번으로 */
  async resolveAddress(address: string): Promise<Parcel> {
    const text = squash(address.replace(/[,()]/g, " "));
    const sidos = await this.regions("");
    const sidoHits = longestPrefix(text, sidos, (r) => sidoAliases(r.name));
    let rest = text;
    let sido: Region;
    let sgg: Region;

    if (sidoHits.length) {
      sido = sidoHits[0].item;
      rest = text.slice(sidoHits[0].used.length);
      const sggs = await this.regions("sgg", sido.code);
      const sggHits = longestPrefix(rest, sggs, (r) => sggAliases(r.name));
      if (sggHits.length === 1) {
        sgg = sggHits[0].item;
        rest = rest.slice(sggHits[0].used.length);
      } else if (sggs.length === 1) {
        sgg = sggs[0]; // 세종처럼 시군구가 하나
        if (rest.startsWith(squash(sgg.name))) rest = rest.slice(squash(sgg.name).length);
      } else if (sggHits.length > 1) {
        throw new RealtyFault("NEEDS_INPUT", `시군구가 여러 곳과 맞습니다: ${sggHits.map((h) => h.item.name).join(", ")}. 주소에 시군구를 정확히 적어 주세요.`);
      } else {
        throw new RealtyFault("NOT_FOUND", `'${sido.name}'에서 시군구를 찾지 못했습니다. 예: ${sggs.slice(0, 6).map((r) => r.name).join(", ")} …`);
      }
    } else {
      // 시도 없이 '강남구 역삼동 …'으로 온 경우: 전국 시군구에서 찾는다
      const all = await Promise.all(sidos.map(async (s) => ({ s, list: await this.regions("sgg", s.code) })));
      const flat = all.flatMap(({ s, list }) => list.map((g) => ({ s, g })));
      const hits = longestPrefix(text, flat, (x) => sggAliases(x.g.name));
      if (!hits.length) throw new RealtyFault("NOT_FOUND", `주소 '${address}'에서 시도·시군구를 읽지 못했습니다. '서울 강남구 역삼동 757'처럼 지번 주소로 적어 주세요.`);
      if (hits.length > 1) {
        throw new RealtyFault("NEEDS_INPUT", `'${hits[0].used}'가 여러 시도에 있습니다: ${hits.map((h) => `${h.item.s.name} ${h.item.g.name}`).join(", ")}. 시도를 붙여 주세요.`);
      }
      sido = hits[0].item.s;
      sgg = hits[0].item.g;
      rest = text.slice(hits[0].used.length);
    }

    const eubs = await this.regions("eub", sido.code, sgg.code);
    const eubHits = longestPrefix(rest, eubs, (r) => eubAliases(r.name));
    if (!eubHits.length) {
      throw new RealtyFault("NOT_FOUND", `'${sido.name} ${sgg.name}'에서 읍면동(법정동)을 찾지 못했습니다. 도로명 주소라면 지번 주소(법정동·지번)로 바꿔 주세요.`);
    }
    if (eubHits.length > 1) {
      throw new RealtyFault("NEEDS_INPUT", `읍면동이 여러 곳과 맞습니다: ${eubHits.map((h) => h.item.name).join(", ")}. 읍·면 이름까지 적어 주세요.`);
    }
    const eub = eubHits[0].item;
    rest = rest.slice(eubHits[0].used.length);
    // 지번은 원래 띄어쓰기를 살려 다시 읽는다 ('757 역삼래미안' → 757, 역삼래미안)
    const tail = address.slice(Math.max(0, address.search(/(산\s*)?\d/))).trim();
    const j = /^(산)?\d/.test(rest) ? parseJibun(tail) : { san: false, rest };
    const label = `${sido.name} ${sgg.name} ${eub.name.replace(/\s+/g, " ")}${j.bun1 !== undefined ? ` ${j.san ? "산" : ""}${j.bun1}${j.bun2 ? `-${j.bun2}` : ""}` : ""}`;
    return { sido, sgg, eub, san: j.san, bun1: j.bun1, bun2: j.bun2, rest: j.rest, label };
  }

  /** 개별공시지가 (연도별 전체) */
  landPrices(p: Parcel): Promise<LandPrice[]> {
    if (p.bun1 === undefined) throw new RealtyFault("BAD_INPUT", "개별공시지가는 지번(본번)이 필요합니다. 예: 서울 강남구 역삼동 737");
    const key = `gsi:${p.sgg.code}:${p.eub.code}:${p.san}:${p.bun1}:${p.bun2 ?? 0}`;
    return this.cached(key, 6 * 3600, async () => {
      const m = await this.getJson(
        "/search/gsiSearchListApi.search",
        { page_no: "1", gbn: "1", year: "", reg: p.sgg.code, eub: p.eub.code, san: p.san ? "2" : "1", bun1: pad4(p.bun1), bun2: pad4(p.bun2), road_code: "", p_initialword: "", build_bun1: "", build_bun2: "", tabGbn: "Text" },
        "/gsindividual/search.htm",
      );
      const list = (m.list as Array<Record<string, string>> | null) ?? [];
      return list.map((r) => ({
        year: String(r.base_year ?? ""),
        baseDate: `${r.base_year}.${String(r.base_md ?? "").replace(/(\d+)월(\d+)일/, "$1.$2")}`,
        pricePerM2: num(r.gakuka_w),
        noticeDate: ymdDots(String(r.notice_ymd ?? "")),
        note: String(r.etc_cntn ?? "").trim(),
        addr: String(r.addr ?? r.full_addr_name ?? ""),
      }));
    });
  }

  /** 개별주택가격 (연도별 전체) */
  housePrices(p: Parcel): Promise<HousePrice[]> {
    if (p.bun1 === undefined) throw new RealtyFault("BAD_INPUT", "개별주택가격은 지번(본번)이 필요합니다. 예: 서울 강남구 논현동 4-9");
    const year = String(new Date(this.now().getTime() + 9 * 3_600_000).getUTCFullYear());
    const key = `hpi:${p.sgg.code}:${p.eub.code}:${p.san}:${p.bun1}:${p.bun2 ?? 0}`;
    return this.cached(key, 6 * 3600, async () => {
      const m = await this.getJson(
        "/search/hpiSearchListApi.search",
        { page_no: "1", gbn: "1", year: "", reg: p.sgg.code, eub: p.eub.code, san: p.san ? "2" : "1", bun1: pad4(p.bun1), bun2: pad4(p.bun2), road_code: "", p_initialword: "", build_bun1: "", build_bun2: "", from_year: "1990", to_year: year, dong_gbn: "", tabGbn: "Text" },
        "/hpindividual/search.htm",
      );
      const list = (m.list as Array<Record<string, string>> | null) ?? [];
      return list.map((r) => ({
        baseDate: String(r.base_ymd ?? "").replace(/\//g, "."),
        price: num(r.hprice_w),
        addr: String(r.addr ?? ""),
        landArea: String(r.tbook_area ?? ""),
        calcLandArea: String(r.calc_larea ?? ""),
        floorArea: String(r.bldg_garea ?? ""),
        residentialArea: String(r.res_area ?? ""),
        building: String(r.dong_gbn ?? "") === "99999" ? "" : String(r.dong_gbn ?? ""),
      }));
    });
  }

  private aptParams(p: Parcel, extra: Record<string, string>): Record<string, string> {
    return {
      gbn: "1", year: "", notice_date: "", notice_date_year: "", gbnApt: "", road_reg: "", road: "", initialword: "", build_bun1: "", build_bun2: "",
      reg: p.sgg.code, eub: p.eub.code, apt_name: "", bun1: "", bun2: "", apt_code: "", dong_code: "", ho_code: "",
      past_yn: "1", init_gbn: "N", searchGbnRoad: "", searchGbnBunji: "", searchGbnBunjiYear: "",
      ...extra,
    };
  }

  private async aptList(p: Parcel, extra: Record<string, string>): Promise<AptOption[]> {
    const params = this.aptParams(p, extra);
    const key = `apt:${JSON.stringify(params)}`;
    return this.cached(key, 6 * 3600, async () => {
      const m = await this.getJson("/search/searchApt.search", params, "/town/nfSiteLink.htm");
      const list = (m.list as Array<Record<string, unknown>> | null) ?? [];
      return list.map((r) => ({ code: String(r.code), name: String(r.name ?? "").trim(), noticeDate: String(r.notice_date ?? "") }));
    });
  }

  /** 공동주택 단지 목록: 지번이 있으면 지번으로, 없으면 단지명으로 */
  complexes(p: Parcel, name?: string): Promise<AptOption[]> {
    if (p.bun1 !== undefined) {
      return this.aptList(p, { searchGbnBunji: "1", bun1: String(p.bun1), bun2: p.bun2 ? String(p.bun2) : "" });
    }
    if (!name) throw new RealtyFault("BAD_INPUT", "공동주택은 지번 또는 단지명이 필요합니다. 예: 서울 강남구 역삼동 757 또는 complex='역삼래미안'");
    return this.aptList(p, { searchGbnBunji: "0", apt_name: name });
  }

  dongs(p: Parcel, apt: AptOption): Promise<AptOption[]> {
    return this.aptList(p, { gbnApt: "DONG", apt_code: apt.code, notice_date: apt.noticeDate });
  }

  hos(p: Parcel, apt: AptOption, dong: AptOption): Promise<AptOption[]> {
    return this.aptList(p, { gbnApt: "HO", apt_code: apt.code, dong_code: dong.code, notice_date: dong.noticeDate || apt.noticeDate });
  }

  /** 공동주택가격 연도별 */
  aptPrices(p: Parcel, apt: AptOption, dong: AptOption, ho: AptOption): Promise<AptPrice[]> {
    const params = {
      page_no: "1", reg_name: "", sreg: "", seub: "", old_reg: "", old_eub: "", gbn: "1", year: "", notice_date: ho.noticeDate || apt.noticeDate, notice_date_year: "",
      reg: p.sgg.code, eub: p.eub.code, apt_name: "", bun1: "", bun2: "", road_code: "", initialword: "", build_bun1: "", build_bun2: "", gbnApt: "",
      apt_code: apt.code, dong_code: dong.code, ho_code: ho.code, tabGbn: "Text", full_addr_name: "", dong_name: "", ho_name: "", notice_amt: "", ktown_ho_seq: "",
      print_yn: "0", past_yn: "1", capcha: "", capcha_chk_yn: "",
    };
    return this.cached(`town:${apt.code}:${dong.code}:${ho.code}`, 6 * 3600, async () => {
      const m = await this.getJson("/search/townPriceListPastYearMap.search", params, "/town/nfSiteLink.htm");
      if (m.message) {
        const why = m.error_gbn === "ERROR_STOP" ? " (사이트가 보안문자 입력을 요구합니다)" : m.error_gbn === "ERROR_LIMIT" ? " (열람 한도 초과)" : "";
        throw new RealtyFault("UPSTREAM", `${String(m.message)}${why} — 부동산 공시가격 알리미(${REALTY_SITE})에서 직접 열람하세요.`);
      }
      const list = (m.list as Array<Record<string, string>> | null) ?? [];
      return list.map((r) => ({
        baseDate: String(r.notice_date_name ?? ""),
        noticeDate: ymdDots(String(r.notice_date ?? "")),
        price: num(r.notice_amt),
        area: String(r.priv_area ?? ""),
        apt: String(r.apt_name ?? ""),
        dong: String(r.dong_name ?? ""),
        ho: String(r.ho_name ?? ""),
        addr: String(r.full_addr_name ?? "").replace(/\s+/g, " "),
        roadAddr: String(r.full_road_name ?? ""),
      }));
    });
  }
}

/** 동·호 표기 비교용: '101동'·'제101동'·'101' → '101' */
export function unitKey(s: string): string {
  return squash(s).replace(/^제/, "").replace(/(동|호)$/, "").toUpperCase();
}

/** 단지명 비교용: '(757) 역삼래미안' → '역삼래미안' */
export function complexKey(s: string): string {
  return squash(s).replace(/^\([^)]*\)/, "").replace(/아파트$/, "").toUpperCase();
}
