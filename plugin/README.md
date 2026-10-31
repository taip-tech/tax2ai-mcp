# TAX2.AI 세무 법령 플러그인

세무사 실무용 Claude Code 플러그인입니다. 법제처 국가법령정보 원문을 근거로 세법 질문을 검토합니다.

## 들어 있는 것
- **MCP 연결**: `https://mcp.tax2.ai/mcp` 자동 등록 (도구 19종: 조문·부칙·위임·개정 조회, 판례·심판례·해석례, 행정규칙, 서식, 조세조약, 인용 점검, 산출세액·기한·가산세·기업업무추진비·인정이자 계산)
- **`/semu` 스킬**: `/semu [quick|deep] 질문`
- **서브에이전트 5종**: statute-navigator, precedent-analyst, refund-claim-examiner, citation-auditor, memo-drafter

## 설치
```
/plugin marketplace add taip-tech/tax2ai-mcp
/plugin install tax2ai@tax2ai
```
설치할 때 법제처 OC를 물어봅니다. 비워 두면 공용 키로 동작합니다(하루 사용량 제한이 있을 수 있음). 본인 OC를 넣으려면 먼저 open.law.go.kr 신청 정보의 서버 도메인에 `mcp.tax2.ai`를 등록하세요.

## 개인정보
입력한 질문·원고·OC는 저장하지 않습니다. 자세한 내용: https://mcp.tax2.ai/privacy

## 유의사항
출력은 공개 법령 데이터를 가공한 참고자료이며 유권해석이 아닙니다. 신고·불복 등 법적 판단 전에는 원문과 세무 전문가 검토를 거치세요.

라이선스: MIT
