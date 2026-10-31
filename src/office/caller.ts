// 요청 단위 로그인 사용자 정보. HTTP 처리기가 토큰 검증 후 채우고, 사무소 도구가 읽는다.

import { AsyncLocalStorage } from "node:async_hooks";

export interface SignedInUser {
  userId: string;
  /** 인증 서버가 발급한 액세스 토큰 원문 (저장소 RLS 통과용, 기록하지 않음) */
  token: string;
}

const scope = new AsyncLocalStorage<SignedInUser>();

export function runAsUser<T>(user: SignedInUser | undefined, fn: () => T): T {
  return user ? scope.run(user, fn) : fn();
}

export function currentUser(): SignedInUser | undefined {
  return scope.getStore();
}
