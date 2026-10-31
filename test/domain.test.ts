import { test } from "node:test";
import assert from "node:assert/strict";
import { extractArticleRefs, joCode, parseArticleInput, articleLabel } from "../src/domain/citation.ts";
import { canonicalLawName, sameLawName } from "../src/domain/taxLawBook.ts";
import { corporateTax, personalIncomeTax } from "../src/domain/rateTables.ts";
import { claimAndAssessmentWindows, statutoryFilingDue } from "../src/domain/dueDates.ts";

test("법령 줄임말 정규화", () => {
  assert.equal(canonicalLawName("법법"), "법인세법");
  assert.equal(canonicalLawName("조특법 시행령"), "조세특례제한법 시행령");
  assert.equal(canonicalLawName("상증법시행규칙"), "상속세 및 증여세법 시행규칙");
  assert.equal(canonicalLawName("처음보는법"), "처음보는법");
  assert.ok(sameLawName("상속세및증여세법", "상증법"));
});

test("JO 코드와 조문번호 입력 해석", () => {
  assert.equal(joCode(52), "005200");
  assert.equal(joCode(10, 2), "001002");
  assert.deepEqual(parseArticleInput("제52조의2"), { article: 52, branch: 2 });
  assert.deepEqual(parseArticleInput("10-2"), { article: 10, branch: 2 });
  assert.deepEqual(parseArticleInput("89"), { article: 89, branch: 0 });
  assert.equal(parseArticleInput("오십이조"), null);
  assert.equal(articleLabel({ article: 45, branch: 2, paragraph: 1 }), "제45조의2 제1항");
});

test("원고 속 인용 추출: 법령명·같은 법·같은 조·연속 인용", () => {
  const draft =
    "법인세법 시행령 제89조제3항에 따라 인정이자를 계산하며, 같은 법 제52조제1항 및 제53조도 검토한다. " +
    "또한 조특법 제10조의2 제1항 제2호와 같은 조 제3항, 국세기본법 제45조의2를 적용한다.";
  const refs = extractArticleRefs(draft);
  const flat = refs.map((r) => `${r.law}|${articleLabel(r)}`);
  assert.deepEqual(flat, [
    "법인세법 시행령|제89조 제3항",
    "법인세법|제52조 제1항",
    "법인세법|제53조",
    "조세특례제한법|제10조의2 제1항 제2호",
    "조세특례제한법|제10조의2 제3항",
    "국세기본법|제45조의2",
  ]);
});

test("사전에 없는 법률명도 인용에서 인식", () => {
  const refs = extractArticleRefs("자본시장과 금융투자업에 관한 법률 제9조제1항, 민법 제103조");
  assert.equal(refs[0].law, "자본시장과 금융투자업에 관한 법률");
  assert.equal(refs[1].law, "민법");
});

test("법령명이 없는 인용은 law가 빈 값", () => {
  const refs = extractArticleRefs("이 경우 제5조를 준용한다.");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].law, "");
});

test("법인세 산출세액: 2025 사업연도", () => {
  const r = corporateTax(500_000_000, "2025-01-01");
  // 2억×9% + 3억×19% = 1,800만 + 5,700만
  assert.equal(r.computedTax, 75_000_000);
  assert.equal(r.marginalPct, 19);
  assert.equal(r.localIncomeTax, 7_500_000);
});

test("법인세 산출세액: 2022 사업연도·1년 미만 환산", () => {
  assert.equal(corporateTax(300_000_000, "2022-01-01").computedTax, 40_000_000);
  const short = corporateTax(100_000_000, "2024-07-01", 6);
  // 연환산 2억 → 1,800만 × 6/12
  assert.equal(short.computedTax, 9_000_000);
});

test("세율표 범위 밖 연도는 계산 거부", () => {
  assert.throws(() => corporateTax(1, "2015-01-01"), RangeError);
  assert.throws(() => personalIncomeTax(1, 2019), RangeError);
});

test("종합소득세 산출세액", () => {
  // 2024: 1,400만×6% + 3,600만×15% + 1,000만×24% = 84만+540만+240만
  assert.equal(personalIncomeTax(60_000_000, 2024).computedTax, 8_640_000);
  // 2022: 1,200만×6% + 3,400만×15% + 1,400만×24% = 72만+510만+336만
  assert.equal(personalIncomeTax(60_000_000, 2022).computedTax, 9_180_000);
});

test("법정신고기한: 법인·개인·부가세·증여", () => {
  assert.equal(statutoryFilingDue({ kind: "corporate", periodEnd: "2021-12-31" }).due, "2022-03-31");
  assert.equal(statutoryFilingDue({ kind: "corporate", periodEnd: "2024-06-30" }).due, "2024-09-30");
  // 2024-03-31은 일요일 → 4/1
  const shifted = statutoryFilingDue({ kind: "corporate", periodEnd: "2023-12-31" });
  assert.equal(shifted.due, "2024-04-01");
  assert.equal(shifted.shiftedFrom, "2024-03-31");
  assert.equal(statutoryFilingDue({ kind: "personal", periodEnd: "2024-12-31", diligentFiler: true }).due, "2025-06-30");
  assert.equal(statutoryFilingDue({ kind: "vat", periodEnd: "2025-06-30" }).due, "2025-07-25");
  assert.equal(statutoryFilingDue({ kind: "gift", periodEnd: "2025-02-10" }).due, "2025-06-02"); // 5/31 토·6/1 일 → 6/2
});

test("경정청구 기한과 제척기간", () => {
  const w = claimAndAssessmentWindows({ kind: "corporate", periodEnd: "2021-12-31", today: "2026-10-31" });
  assert.equal(w.filing.due, "2022-03-31");
  assert.equal(w.refundClaimUntil, "2027-03-31");
  assert.equal(w.assessmentUntil, "2027-03-31");
  assert.equal(w.daysLeftForRefund, 151);
  const fraud = claimAndAssessmentWindows({ kind: "gift", periodEnd: "2020-01-15", assessmentCase: "fraud", today: "2026-01-01" });
  assert.equal(fraud.assessmentYears, 15);
  const late = claimAndAssessmentWindows({ kind: "personal", periodEnd: "2023-12-31", lateEventKnownOn: "2026-11-30", today: "2026-10-31" });
  assert.equal(late.lateEventClaimUntil, "2027-03-02"); // 2/28 일요일 → 3/1 공휴일 → 3/2
});
