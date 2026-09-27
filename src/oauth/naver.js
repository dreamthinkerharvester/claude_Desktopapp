// 네이버 로그인 (네이버 카페 글쓰기 API용). 접근 토큰은 1시간, 갱신 토큰으로 자동 연장합니다.

import { authError, invalid } from '../errors.js';
import { request } from '../http.js';

const AUTH_URL = 'https://nid.naver.com/oauth2.0/authorize';
const TOKEN_URL = 'https://nid.naver.com/oauth2.0/token';

export function naverAuthUrl({ clientId, redirectUri, state }) {
  return `${AUTH_URL}?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state })}`;
}

// 네이버는 오류도 HTTP 200 + {"error": ...} 로 돌려주는 경우가 있어 본문을 직접 봅니다.
function tokenOrThrow(json, what) {
  if (json?.access_token) return json;
  const code = json?.error ?? 'unknown';
  const desc = json?.error_description ?? '';
  if (['invalid_grant', 'invalid_request', 'invalid_client', 'unauthorized_client'].includes(code) || /refresh|token|expired/i.test(desc)) {
    return authError(`네이버 ${what} 실패 (${code}${desc ? `: ${desc}` : ''}). "snspub auth naver" 로 다시 로그인해 주세요`);
  }
  return invalid(`네이버 ${what} 실패 (${code}${desc ? `: ${desc}` : ''})`);
}

function toTokenData(json, previous = {}) {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? previous.refreshToken,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
}

export async function naverExchangeCode({ clientId, clientSecret, code, state, fetchImpl }) {
  const params = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret ?? '', code, state });
  const res = await request(`${TOKEN_URL}?${params}`, { method: 'GET', idempotent: true, fetchImpl, label: '네이버 토큰 발급' });
  const json = tokenOrThrow(res.json, '토큰 발급');
  if (json instanceof Error) throw json;
  return toTokenData(json);
}

export async function naverAccessToken(ctx) {
  const { clientId, clientSecret } = ctx.route;
  const saved = ctx.tokens.get('naver');
  if (!saved?.refreshToken) throw authError('네이버 로그인이 필요합니다. "snspub auth naver" 를 실행해 주세요');
  if (saved.accessToken && saved.expiresAt > Date.now() + 60_000) return saved.accessToken;
  if (!clientId) throw invalid('config.jsonc 의 routes.naver_cafe.clientId 가 비어 있습니다');
  const params = new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret ?? '', refresh_token: saved.refreshToken });
  const res = await request(`${TOKEN_URL}?${params}`, { method: 'GET', idempotent: true, fetchImpl: ctx.fetch, label: '네이버 토큰 갱신' });
  const json = tokenOrThrow(res.json, '토큰 갱신');
  if (json instanceof Error) throw json;
  const next = toTokenData(json, saved);
  ctx.tokens.set('naver', next);
  return next.accessToken;
}
