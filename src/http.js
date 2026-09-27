import { PublishError } from './errors.js';

// 서버에 요청이 "닿기 전"에 실패한 경우 → 게시가 일어났을 리 없으므로 재시도해도 안전합니다.
// (주소 찾기 실패, 연결 거부, 연결 시간 초과, 보안 연결(TLS) 확인 실패)
const PRE_SEND_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
// 네트워크 끊김 계열은 "연결하는 중"(syscall=connect)일 때만 보내기 전으로 봅니다. 보내는 도중이면 결과를 알 수 없음.
const CONNECT_ONLY_CODES = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);

export function redact(text) {
  return String(text ?? '')
    .replace(/(access_token|refresh_token|client_secret|fb_exchange_token|apikey|api_key)=([^&\s"']+)/gi, '$1=***')
    .replace(/("(?:access_token|refresh_token|client_secret|token)"\s*:\s*")[^"]+"/gi, '$1***"')
    .replace(/(Bearer|OAuth|Apikey)\s+[A-Za-z0-9._\-~+/=]+/g, '$1 ***');
}

function errorSource(err) {
  if (err?.cause?.code) return err.cause;
  if (err?.code) return err;
  return err?.cause?.cause;
}

export function isPreSendFailure(err) {
  const src = errorSource(err);
  const code = src?.code;
  if (!code) return false;
  return PRE_SEND_CODES.has(code) || (CONNECT_ONLY_CODES.has(code) && src.syscall === 'connect');
}

function retryAfterSeconds(headers) {
  const value = headers?.get?.('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return undefined;
}

/**
 * fetch 래퍼. 실패를 PublishError 로 바꿔 던집니다.
 * @param {string} url
 * @param {object} opts
 * @param {boolean} opts.idempotent  같은 요청을 다시 보내도 게시가 두 번 되지 않는가 (조회·이어올리기 = true, 게시 생성 = false)
 * @param {number[]} [opts.accept]   오류로 보지 않을 추가 상태 코드 (예: YouTube 이어올리기 308)
 * @param {(res) => PublishError|undefined} [opts.classify] 서비스별 오류 본문 해석
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 60_000,
    idempotent = method === 'GET',
    accept = [],
    classify,
    fetchImpl = globalThis.fetch,
    label = '',
    signal,
    redirect,
  } = opts;

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body,
      ...(redirect ? { redirect } : {}),
      signal: AbortSignal.any(signals),
      ...(body && typeof body === 'object' && typeof body.getReader === 'function' ? { duplex: 'half' } : {}),
    });
  } catch (err) {
    const code = errorSource(err)?.code;
    const where = label ? `${label}: ` : '';
    if (isPreSendFailure(err)) {
      throw new PublishError('transient', `${where}네트워크 연결 실패 (${code})`, { cause: err });
    }
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const reason = timedOut ? '응답 시간 초과' : `연결 끊김 (${code ?? err?.message ?? '알 수 없음'})`;
    if (idempotent) throw new PublishError('transient', `${where}${reason}`, { cause: err });
    throw new PublishError('uncertain', `${where}${reason} — 게시 요청이 처리됐는지 알 수 없습니다`, { cause: err });
  }

  const text = await res.text().catch(() => '');
  let json;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  const result = { status: res.status, headers: res.headers, text, json, ok: res.ok || accept.includes(res.status) };
  if (result.ok) return result;

  const custom = classify?.(result);
  if (custom) throw custom;
  throw httpError(result, { idempotent, label });
}

export function httpError(result, { idempotent = false, label = '' } = {}) {
  const { status, text, headers } = result;
  const where = label ? `${label}: ` : '';
  const snippet = redact(text).slice(0, 400);
  const message = `${where}HTTP ${status}${snippet ? ` — ${snippet}` : ''}`;
  if (status === 429) {
    return new PublishError('rate_limit', message, { status, retryAfterSec: retryAfterSeconds(headers) });
  }
  if (status === 401 || status === 403) return new PublishError('auth', message, { status });
  if (status === 408 || status === 503) return new PublishError('transient', message, { status, retryAfterSec: retryAfterSeconds(headers) });
  if (status >= 500) return new PublishError(idempotent ? 'transient' : 'uncertain', message, { status });
  return new PublishError('invalid', message, { status });
}
