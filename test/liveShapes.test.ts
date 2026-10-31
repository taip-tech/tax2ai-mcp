// 2026-10 실제 법제처 응답에서 확인한 형태로 만든 파서 회귀 테스트

import { test } from "node:test";
import assert from "node:assert/strict";
import { delegationEntries, revisionPairs, treatyArticles } from "../src/lawgo/guidance.ts";

test("3단 비교: 법률 조문별 시행령·시행규칙 연결 (중복 제거·정렬)", () => {
  const root = {
    위임조문삼단비교: {
      법률조문: [
        { 조번호: "0052", 조가지번호: "00", 조내용: "제8관 소득금액 계산의 특례" },
        {
          조번호: "0052", 조가지번호: "00",
          시행령조문: { 조번호: "0089", 조가지번호: "00", 조제목: "" },
          시행규칙조문: { 조번호: "0043", 조가지번호: "00", 조제목: "제43조(가중평균차입이자율의 계산방법 등)" },
        },
        {
          조번호: "0052", 조가지번호: "00",
          시행령조문: [{ 조번호: "0088", 조가지번호: "00", 조제목: "" }, { 조번호: "0089", 조가지번호: "00", 조제목: "" }],
          시행규칙조문: { 조번호: "0042", 조가지번호: "03", 조제목: "제42조의3(임차사택의 범위)" },
        },
        { 조번호: "0053", 조가지번호: "00", 조내용: "" },
      ],
    },
  };
  const entries = delegationEntries(root);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].decree.map((d) => d.no), [88, 89]);
  assert.deepEqual(entries[0].rule.map((r) => `${r.no}-${r.branch}`), ["42-3", "43-0"]);
});

test("신구조문: 항 단위 조각을 조문별로 묶고 바뀐 부분을 【】로 표시", () => {
  const root = {
    구조문목록: { 조문: [
      { content: "제3조(납세의무자) ①·② (생  략)", no: "1" },
      { content: "③ 연결법인은 <P>투자ㆍ상생협력</P> 촉진을 위한", no: "2" },
      { content: "제55조(세율) ① 생략", no: "3" },
    ] },
    신조문목록: { 조문: [
      { content: "제3조(납세의무자) ①·② (현행과 같음)", no: "1" },
      { content: "③ 연결법인은 <P>투자ㆍ배당 및 상생협력</P> 촉진을 위한", no: "2" },
      { content: "제57조의2(신설 조문)", no: "3" },
    ] },
  };
  const pairs = revisionPairs(root);
  assert.deepEqual(pairs.map((p) => p.label), ["제3조", "제55조", "제57조의2"]);
  assert.match(pairs[0].after, /【투자ㆍ배당 및 상생협력】/);
  assert.equal(pairs[1].after, "(삭제)");
  assert.equal(pairs[2].before, "(신설)");
});

test("조약 본문을 조문 단위로 분리", () => {
  const root = { 조약내용: "[조약번호]⊙조약 제693호[/조약번호][전문]대한민국 정부와...[/전문][본문]제1조 대상조세(1)\t이 협약의 대상...제12조 배당(1) 일방체약국의 거주자가 받는 배당...제13조 이자(1) 이자는..." };
  const arts = treatyArticles(root);
  const heads = arts.map((a) => a.heading);
  assert.ok(heads.includes("제12조 배당"));
  assert.ok(arts.find((a) => a.heading === "제12조 배당")!.text.includes("거주자가 받는 배당"));
  assert.equal(arts.filter((a) => a.text.includes("이자는")).length, 1);
});
