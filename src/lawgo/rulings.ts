// 판례·헌재결정·조세심판·법령해석례 목록과 본문

import { LawgoClient, LawgoFault } from "./client.js";
import { field, isObj, locateRows, plain, totalCount, unwrapRoot, ymd } from "./shape.js";
import { RULING_SOURCES, type RulingKind } from "./sources.js";

export interface RulingRow {
  kind: RulingKind;
  source: string;
  id: string;
  title: string;
  caseNo: string;
  date: string;
  org: string;
}

export interface RulingDoc extends RulingRow {
  sections: Array<{ heading: string; text: string }>;
}

export class RulingDesk {
  constructor(private readonly api: LawgoClient) {}

  async find(kind: RulingKind, query: string, opts: { limit?: number; page?: number; fullText?: boolean } = {}) {
    const src = RULING_SOURCES[kind];
    const payload = await this.api.search(src.target, {
      query,
      search: opts.fullText ? 2 : 1,
      display: Math.min(opts.limit ?? 10, 100),
      page: opts.page ?? 1,
    });
    const rows: RulingRow[] = locateRows(payload, src.rowKeys).map((r) => ({
      kind,
      source: src.label,
      id: field(r, ...src.idKeys),
      title: plain(field(r, ...src.titleKeys)),
      caseNo: field(r, ...src.caseNoKeys),
      date: ymd(field(r, ...src.dateKeys)),
      org: field(r, ...src.bodyOrgKeys),
    }));
    return { total: totalCount(payload) || rows.length, rows };
  }

  async read(kind: RulingKind, id: string): Promise<RulingDoc> {
    const src = RULING_SOURCES[kind];
    const payload = await this.api.detail(src.target, { ID: id });
    const root = unwrapRoot(payload);
    if (!isObj(root) || !Object.keys(root).length) throw new LawgoFault("NO_MATCH", `${src.label} ${id} 본문을 찾지 못했습니다.`);
    const sections = src.sections
      .map(([heading, keys]) => ({ heading, text: plain(field(root, ...keys)) }))
      .filter((s) => s.text);
    if (!sections.length) throw new LawgoFault("NO_MATCH", `${src.label} ${id} 본문이 비어 있습니다.`);
    return {
      kind,
      source: src.label,
      id,
      title: plain(field(root, ...src.titleKeys)),
      caseNo: field(root, ...src.caseNoKeys),
      date: ymd(field(root, ...src.dateKeys)),
      org: field(root, ...src.bodyOrgKeys),
      sections,
    };
  }
}
