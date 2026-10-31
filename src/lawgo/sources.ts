// 결정례·해석례 계열 자료원 정의. DRF target 값과 응답 필드 후보를 한곳에 모은다.
// 필드명이 바뀌거나 표기가 다를 수 있어 후보를 여러 개 둔다.

export type RulingKind = "court" | "constitutional" | "tribunal" | "moleg";

export interface RulingSource {
  kind: RulingKind;
  label: string;
  target: string;
  rowKeys: string[];
  idKeys: string[];
  titleKeys: string[];
  caseNoKeys: string[];
  dateKeys: string[];
  bodyOrgKeys: string[];
  /** 본문 응답에서 순서대로 출력할 섹션 (제목, 후보 키들) */
  sections: Array<[string, string[]]>;
}

export const RULING_SOURCES: Record<RulingKind, RulingSource> = {
  court: {
    kind: "court",
    label: "법원 판례",
    target: "prec",
    rowKeys: ["prec"],
    idKeys: ["판례일련번호", "판례정보일련번호", "id"],
    titleKeys: ["사건명"],
    caseNoKeys: ["사건번호"],
    dateKeys: ["선고일자"],
    bodyOrgKeys: ["법원명"],
    sections: [
      ["판시사항", ["판시사항"]],
      ["판결요지", ["판결요지"]],
      ["참조조문", ["참조조문"]],
      ["참조판례", ["참조판례"]],
      ["전문", ["판례내용"]],
    ],
  },
  constitutional: {
    kind: "constitutional",
    label: "헌법재판소 결정례",
    target: "detc",
    rowKeys: ["Detc", "detc"],
    idKeys: ["헌재결정례일련번호", "id"],
    titleKeys: ["사건명"],
    caseNoKeys: ["사건번호"],
    dateKeys: ["종국일자", "선고일"],
    bodyOrgKeys: [],
    sections: [
      ["판시사항", ["판시사항"]],
      ["결정요지", ["결정요지"]],
      ["심판대상조문", ["심판대상조문"]],
      ["참조조문", ["참조조문"]],
      ["전문", ["전문"]],
    ],
  },
  tribunal: {
    kind: "tribunal",
    label: "조세심판원 심판례",
    target: "ttSpecialDecc",
    rowKeys: ["decc", "Decc", "ttSpecialDecc"],
    idKeys: ["특별행정심판재결례일련번호", "행정심판재결례일련번호", "일련번호", "id"],
    titleKeys: ["사건명", "재결례명"],
    caseNoKeys: ["청구번호", "사건번호"],
    dateKeys: ["의결일자", "재결일자", "결정일자"],
    bodyOrgKeys: ["재결청", "처분청"],
    sections: [
      ["재결요지", ["재결요지", "결정요지"]],
      ["주문", ["주문"]],
      ["청구취지", ["청구취지"]],
      ["이유", ["이유"]],
      ["참조조문", ["관련법령", "참조조문"]],
    ],
  },
  moleg: {
    kind: "moleg",
    label: "법제처 법령해석례",
    target: "expc",
    rowKeys: ["expc", "Expc"],
    idKeys: ["법령해석례일련번호", "id"],
    titleKeys: ["안건명"],
    caseNoKeys: ["안건번호"],
    dateKeys: ["회신일자", "해석일자"],
    bodyOrgKeys: ["질의기관명", "회신기관명"],
    sections: [
      ["질의요지", ["질의요지"]],
      ["회답", ["회답"]],
      ["이유", ["이유"]],
      ["관련법령", ["관련법령"]],
    ],
  },
};

export const RULING_KINDS = Object.keys(RULING_SOURCES) as RulingKind[];
