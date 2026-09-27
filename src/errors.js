// 게시 실패를 "다시 시도해도 되는가"로 분류합니다. 이 분류가 중복 게시를 막는 핵심입니다.
//
//  transient   : 요청이 서버에 닿지 않았거나 서버가 처리하지 않았음이 확실 → 자동 재시도
//  rate_limit  : 호출 한도 초과 → 기다렸다가 자동 재시도
//  auth        : 토큰 만료·권한 없음 → 해당 채널만 보류, 재연결 후 자동 재개
//  invalid     : 파일·문구·설정 문제 → 실패 처리(사람이 고쳐야 함)
//  uncertain   : 게시됐는지 알 수 없음 → 자동 재시도 금지, "확인 필요"로 멈춤

export const ERROR_KINDS = ['transient', 'rate_limit', 'auth', 'invalid', 'uncertain'];

export class PublishError extends Error {
  constructor(kind, message, { retryAfterSec, status, detail, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PublishError';
    this.kind = ERROR_KINDS.includes(kind) ? kind : 'uncertain';
    this.retryAfterSec = retryAfterSec;
    this.status = status;
    this.detail = detail;
  }
}

export const transient = (message, opts) => new PublishError('transient', message, opts);
export const rateLimited = (message, opts) => new PublishError('rate_limit', message, opts);
export const authError = (message, opts) => new PublishError('auth', message, opts);
export const invalid = (message, opts) => new PublishError('invalid', message, opts);
export const uncertain = (message, opts) => new PublishError('uncertain', message, opts);

export function asPublishError(err) {
  if (err instanceof PublishError) return err;
  const message = err?.message ? `예상하지 못한 오류: ${err.message}` : '예상하지 못한 오류';
  return new PublishError('uncertain', message, { cause: err });
}
