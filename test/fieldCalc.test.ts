import { test } from "node:test";
import assert from "node:assert/strict";
import { deemedInterest, entertainmentLimit, penaltyEstimate } from "../src/domain/fieldCalc.ts";

test("과소신고 + 1개월 내 수정신고(90% 감면) + 납부지연", () => {
  const r = penaltyEstimate({ kind: "underreported", shortTax: 10_000_000, dueDate: "2025-03-31", filedOn: "2025-04-20" });
  assert.equal(r.reportPenalty, 1_000_000);
  assert.equal(r.reliefPct, 90);
  assert.equal(r.reportAfterRelief, 100_000);
  assert.equal(r.lateDays, 20);
  assert.equal(r.latePaymentPenalty, 44_000); // 1,000만 × 20일 × 0.022%
  assert.equal(r.total, 144_000);
});

test("무신고: 수입금액 기준이 더 크면 그 금액, 3개월 내 기한후신고 30% 감면", () => {
  const r = penaltyEstimate({ kind: "unfiled", shortTax: 10_000_000, revenue: 5_000_000_000, dueDate: "2025-03-31", filedOn: "2025-06-15", paidOn: "2025-03-31" });
  assert.equal(r.reportPenalty, 3_500_000); // 50억 × 7/10,000 > 1,000만 × 20%
  assert.equal(r.reliefPct, 30);
  assert.equal(r.reportAfterRelief, 2_450_000);
  assert.equal(r.latePaymentPenalty, 0);
});

test("2년 지난 수정신고는 감면 없음, 부정 과소신고 40%", () => {
  const r = penaltyEstimate({ kind: "underreported", shortTax: 1_000_000, fraud: true, dueDate: "2022-05-31", filedOn: "2024-06-30", paidOn: "2022-05-31" });
  assert.equal(r.reportPenalty, 400_000);
  assert.equal(r.reliefPct, 0);
});

test("납부지연 이자율 변경일(2022.2.15.) 전후 구간 계산", () => {
  const r = penaltyEstimate({ kind: "underreported", shortTax: 1_000_000, dueDate: "2022-02-10", paidOn: "2022-02-20" });
  assert.equal(r.lateDays, 10);
  assert.equal(r.latePaymentPenalty, 2_320); // 4일×0.025% + 6일×0.022%
});

test("기업업무추진비 한도: 중소기업, 특수관계 수입 10%, 50% 법인", () => {
  const base = entertainmentLimit({ fiscalStart: "2025-01-01", sme: true, revenue: 20_000_000_000, spent: 100_000_000 });
  assert.equal(base.basic, 36_000_000);
  assert.equal(base.byRevenue, 50_000_000);
  assert.equal(base.limit, 86_000_000);
  assert.equal(base.excess, 14_000_000);
  const rel = entertainmentLimit({ fiscalStart: "2025-01-01", sme: true, revenue: 20_000_000_000, relatedRevenue: 10_000_000_000 });
  assert.equal(rel.byRevenue, 52_000_000);
  const half = entertainmentLimit({ fiscalStart: "2025-01-01", months: 6, sme: false, revenue: 1_000_000_000, passiveCompany: true });
  assert.equal(half.limit, Math.floor((6_000_000 + 3_000_000) / 2));
  assert.throws(() => entertainmentLimit({ fiscalStart: "2019-01-01", sme: true, revenue: 1 }), RangeError);
});

test("가지급금 인정이자와 5% 기준 판정", () => {
  const seg = [{ from: "2025-01-01", to: "2025-12-31", balance: 100_000_000 }];
  const r = deemedInterest({ segments: seg, ratePct: 4.6, rateKind: "overdraft" });
  assert.equal(r.product, 36_500_000_000);
  assert.equal(r.interest, 4_600_000);
  assert.equal(r.triggersAdjustment, true);
  const near = deemedInterest({ segments: seg, ratePct: 4.6, rateKind: "overdraft", receivedInterest: 4_400_000 });
  assert.equal(near.gap, 200_000);
  assert.equal(near.triggersAdjustment, false); // 200,000 < 230,000(5%)
});
