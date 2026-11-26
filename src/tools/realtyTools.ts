// 부동산 공시가격: 공동주택가격·개별공시지가·개별주택가격 연도별 조회 (부동산 공시가격 알리미)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { complexKey, type AptOption, type Parcel, REALTY_SITE, type RealtyDesk, unitKey } from "../realty/realtyprice.js";
import { READ_ONLY } from "./context.js";
import { guarded, paged, text } from "./reply.js";

const SOURCE = `출처: 부동산 공시가격 알리미 (국토교통부·한국부동산원, ${REALTY_SITE})`;

const won = (n: number) => n.toLocaleString("ko-KR");

const TAX_NOTES: Record<"apartment" | "land" | "house", string[]> = {
  land: [
    "※ 세무 적용 시 확인: 토지의 기준시가는 개별공시지가 × 면적(소득세법 제99조). 양도·취득·상속·증여일 현재 공시된 가격을 쓰고, 그해 가격이 아직 공시되기 전이면 직전 공시가격을 씁니다 — 적용 시점과 지목·면적은 토지대장·등기부와 함께 확인하세요.",
  ],
  house: [
    "※ 세무 적용 시 확인: 개별주택가격은 토지와 건물을 합친 주택 전체의 기준시가입니다(소득세법 제99조). 평가 기준일 현재 공시된 가격(공시 전이면 직전 가격)을 쓰고, 주택 외 부분이 섞인 건물은 안분 여부를 확인하세요.",
  ],
  apartment: [
    "※ 세무 적용 시 확인: 공동주택가격은 토지·건물을 합친 기준시가입니다(소득세법 제99조). 평가 기준일 현재 공시된 가격(공시 전이면 직전 가격)을 씁니다. 오피스텔·상업용 건물 기준시가는 국세청 고시(홈택스)에서 따로 확인하세요.",
  ],
};

const pick = (list: AptOption[], want: string | undefined, key: (s: string) => string) => {
  if (!want) return list.length === 1 ? list : [];
  const w = key(want);
  // 이름이 먼저: 호 '102'와 내부 코드 102(다른 호)가 겹칠 수 있다
  const byName = list.filter((o) => key(o.name) === w);
  if (byName.length) return byName;
  const byCode = list.filter((o) => o.code === want.trim());
  if (byCode.length) return byCode;
  return list.filter((o) => key(o.name).includes(w));
};

function needs(question: string, options: string[], limit = 120): string {
  const shown = options.slice(0, limit);
  return [
    `[NEEDS_INPUT] ${question}`,
    shown.map((o) => `- ${o}`).join("\n"),
    options.length > limit ? `… 외 ${options.length - limit}개` : "",
    "사용자에게 고르게 한 뒤 같은 address에 고른 값을 넣어 다시 호출하세요.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 주소 뒤에 붙은 '역삼래미안 101동 1502호'에서 단지·동·호를 뽑는다 */
export function splitUnit(rest: string): { complex?: string; dong?: string; ho?: string } {
  let s = rest.trim();
  const out: { complex?: string; dong?: string; ho?: string } = {};
  const ho = s.match(/(\d{1,5})\s*호\s*$/);
  if (ho) {
    out.ho = ho[1];
    s = s.slice(0, ho.index).trim();
  }
  // '101동', '제101동', 'A동', ' 가동'(한 글자 동은 앞에 띄어쓰기 필요)
  const dong = s.match(/(제?\d{1,4}[A-Za-z]?|[A-Za-z])\s*동\s*$/) ?? s.match(/(?:^|\s)([가-힣])\s*동\s*$/);
  if (dong) {
    out.dong = dong[1];
    s = s.slice(0, dong.index).trim();
  }
  s = s.replace(/[-\s]+$/, "").replace(/아파트$/, "").trim();
  if (s) out.complex = s;
  return out;
}

function yearOf(baseDate: string): string {
  return baseDate.slice(0, 4);
}

export function registerRealtyTools(server: McpServer, realty: RealtyDesk): void {
  server.registerTool(
    "public_price",
    {
      title: "부동산 공시가격 조회 (공동주택가격·개별공시지가·개별주택가격)",
      description: [
        "부동산 공시가격 알리미(realtyprice.kr)에서 연도별 공시가격을 조회합니다. 양도·상속·증여 기준시가, 재산세·종부세 과세표준 확인용.",
        "- kind=apartment: 공동주택(아파트·연립·다세대) 공동주택가격. 지번 또는 단지명 + 동 + 호.",
        "- kind=land: 개별공시지가(원/㎡). 면적(area)을 주면 토지 기준시가(공시지가×면적)도 계산.",
        "- kind=house: 개별주택가격(단독·다가구 등).",
        "address는 지번 주소로 주세요 (예: '서울 강남구 역삼동 757', '경기 가평군 가평읍 대곡리 산 12-3'). 도로명 주소만 있으면 먼저 지번 주소로 바꿔 넣으세요.",
        "공동주택은 address에 '역삼래미안 101동 102호'처럼 이어 써도 되고 complex·dong·ho로 나눠 줘도 됩니다. 동·호를 모르면 후보 목록을 [NEEDS_INPUT]으로 돌려줍니다.",
        "오피스텔·상업용 건물 기준시가(국세청 고시)는 이 도구 범위가 아닙니다.",
      ].join("\n"),
      inputSchema: {
        kind: z.enum(["apartment", "land", "house"]).describe("apartment=공동주택가격, land=개별공시지가, house=개별주택가격"),
        address: z.string().min(4).max(200).describe("지번 주소. 예: 서울 강남구 역삼동 757"),
        complex: z.string().max(60).optional().describe("공동주택 단지명 (지번이 없을 때 필수, 여러 단지가 한 지번에 있을 때 구분)"),
        dong: z.string().max(20).optional().describe("공동주택 동 (예: 101, 101동, 가동)"),
        ho: z.string().max(20).optional().describe("공동주택 호 (예: 1502, 1502호)"),
        year: z.number().int().min(1990).max(2100).optional().describe("특정 기준연도만 강조해서 보고 싶을 때"),
        area: z.number().positive().optional().describe("kind=land에서 토지 면적(㎡). 주면 연도별 토지 기준시가 계산"),
        cursor: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ kind, address, complex, dong, ho, year, area, cursor }) => {
      const parcel = await realty.resolveAddress(address);
      if (kind === "land") return paged(await landReply(realty, parcel, year, area), cursor, 12_000, false);
      if (kind === "house") return paged(await houseReply(realty, parcel, year), cursor, 12_000, false);
      return aptReply(realty, parcel, { complex, dong, ho }, year, cursor);
    }, "부동산 공시가격 알리미(realtyprice.kr)"),
  );
}

async function landReply(realty: RealtyDesk, p: Parcel, year: number | undefined, area: number | undefined): Promise<string> {
  const rows = await realty.landPrices(p);
  if (!rows.length) return `[NOT_FOUND] ${p.label}: 개별공시지가가 없습니다. 지번·산 여부를 확인하세요 (공공용지 등은 공시되지 않을 수 있음).\n${SOURCE}`;
  const focus = year ? rows.find((r) => r.year === String(year)) : rows[0];
  const out = [`■ 개별공시지가 — ${rows[0].addr || p.label}`, SOURCE, ""];
  if (focus) {
    out.push(`**${focus.year}년(기준일 ${focus.baseDate}) ${won(focus.pricePerM2)}원/㎡** · 공시일 ${focus.noticeDate}`);
    if (area) out.push(`토지 기준시가: ${won(focus.pricePerM2)}원 × ${area.toLocaleString("ko-KR")}㎡ = **${won(Math.trunc(focus.pricePerM2 * area))}원**`);
    out.push("");
  } else if (year) out.push(`${year}년 공시가격이 없습니다 (아직 공시 전이거나 그해 공시 대상이 아님).`, "");
  out.push(area ? "| 기준연도 | 기준일 | 공시지가(원/㎡) | 토지 기준시가(원) | 공시일 | 비고 |\n|---|---|---:|---:|---|---|" : "| 기준연도 | 기준일 | 공시지가(원/㎡) | 공시일 | 비고 |\n|---|---|---:|---|---|");
  for (const r of rows) {
    const cells = [r.year, r.baseDate, won(r.pricePerM2), ...(area ? [won(Math.trunc(r.pricePerM2 * area))] : []), r.noticeDate, r.note];
    out.push(`| ${cells.join(" | ")} |`);
  }
  out.push("", ...TAX_NOTES.land);
  return out.join("\n");
}

async function houseReply(realty: RealtyDesk, p: Parcel, year: number | undefined): Promise<string> {
  const rows = await realty.housePrices(p);
  if (!rows.length) {
    return `[NOT_FOUND] ${p.label}: 개별주택가격이 없습니다. 아파트·연립·다세대면 kind=apartment로, 나대지면 kind=land로 조회하세요.\n${SOURCE}`;
  }
  const focus = year ? rows.find((r) => yearOf(r.baseDate) === String(year)) : rows[0];
  const out = [`■ 개별주택가격 — ${rows[0].addr || p.label}`, SOURCE, ""];
  if (focus) out.push(`**${focus.baseDate} 기준 ${won(focus.price)}원**${focus.building ? ` (건물 ${focus.building})` : ""}`, "");
  else if (year) out.push(`${year}년 공시가격이 없습니다.`, "");
  out.push("| 기준일 | 주택가격(원) | 토지대장 면적(㎡) | 산정 대지면적(㎡) | 건물 연면적(㎡) | 주택 연면적(㎡) |", "|---|---:|---:|---:|---:|---:|");
  for (const r of rows) out.push(`| ${r.baseDate}${r.building ? ` (${r.building})` : ""} | ${won(r.price)} | ${r.landArea} | ${r.calcLandArea} | ${r.floorArea} | ${r.residentialArea} |`);
  out.push("", ...TAX_NOTES.house);
  return out.join("\n");
}

async function aptReply(
  realty: RealtyDesk,
  p: Parcel,
  given: { complex?: string; dong?: string; ho?: string },
  year: number | undefined,
  cursor: number | undefined,
) {
  const parsed = splitUnit(p.rest);
  const want = { complex: given.complex ?? parsed.complex, dong: given.dong ?? parsed.dong, ho: given.ho ?? parsed.ho };

  if (p.bun1 === undefined && !want.complex) {
    return text(`[BAD_INPUT] 공동주택은 지번 또는 단지명이 필요합니다. 예: address='${p.label} 757' 또는 complex='역삼래미안'`);
  }
  const apts = await realty.complexes(p, p.bun1 === undefined ? want.complex : undefined);
  if (!apts.length) return text(`[NOT_FOUND] ${p.label}${p.bun1 === undefined ? ` '${want.complex}'` : ""}: 공동주택가격 대상 단지를 찾지 못했습니다. 단독·다가구면 kind=house로 조회하세요.\n${SOURCE}`);
  const aptHits = apts.length === 1 ? apts : pick(apts, want.complex, complexKey);
  if (aptHits.length !== 1) {
    return text(needs(`${p.label}에 단지가 ${apts.length}개입니다. complex에 단지명을 넣어 주세요:`, apts.map((a) => a.name)));
  }
  const apt = aptHits[0];

  const dongs = await realty.dongs(p, apt);
  if (!dongs.length) return text(`[NOT_FOUND] ${apt.name}: 동 목록이 없습니다.\n${SOURCE}`);
  const dongHits = pick(dongs, want.dong, unitKey);
  if (dongHits.length !== 1) {
    const q = want.dong ? `'${want.dong}'동을 찾지 못했습니다. ${apt.name}의 동:` : `${apt.name}의 동을 골라 dong에 넣어 주세요:`;
    return text(needs(q, dongs.map((d) => d.name)));
  }
  const dong = dongHits[0];

  const hos = await realty.hos(p, apt, dong);
  if (!hos.length) return text(`[NOT_FOUND] ${apt.name} ${dong.name}동: 호 목록이 없습니다.\n${SOURCE}`);
  const hoHits = pick(hos, want.ho, unitKey);
  if (hoHits.length !== 1) {
    const q = want.ho ? `'${want.ho}'호를 찾지 못했습니다. ${apt.name} ${dong.name}동의 호:` : `${apt.name} ${dong.name}동의 호를 골라 ho에 넣어 주세요:`;
    return text(needs(q, hos.map((h) => h.name), 300));
  }
  const unit = hoHits[0];

  const rows = await realty.aptPrices(p, apt, dong, unit);
  if (!rows.length) return text(`[NOT_FOUND] ${apt.name} ${dong.name}동 ${unit.name}호: 공동주택가격이 없습니다.\n${SOURCE}`);
  const focus = year ? rows.find((r) => yearOf(r.baseDate) === String(year)) : rows[0];
  const head = rows[0];
  const out = [
    `■ 공동주택가격 — ${head.apt} ${head.dong}동 ${head.ho}호 (전용 ${head.area}㎡)`,
    `소재지: ${head.addr}${head.roadAddr ? ` / ${head.roadAddr}` : ""}`,
    SOURCE,
    "",
  ];
  if (focus) out.push(`**${focus.baseDate} 기준 ${won(focus.price)}원** · 공시일 ${focus.noticeDate}`, "");
  else if (year) out.push(`${year}년 공시가격이 없습니다.`, "");
  out.push("| 기준일 | 공동주택가격(원) | 전용면적(㎡) | 공시일 |", "|---|---:|---:|---|");
  for (const r of rows) out.push(`| ${r.baseDate} | ${won(r.price)} | ${r.area} | ${r.noticeDate} |`);
  out.push("", ...TAX_NOTES.apartment);
  return paged(out.join("\n"), cursor, 12_000, false);
}
