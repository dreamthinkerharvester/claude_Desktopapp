// Google OAuth (YouTube 직접 업로드용). "데스크톱 앱" 클라이언트 + 로컬 주소(127.0.0.1) 콜백 + PKCE.
// 주의: OAuth 동의 화면이 "테스트" 상태면 refresh token 이 7일 뒤 만료됩니다 → "프로덕션"으로 바꿔 두세요.

import { createHash, randomBytes } from 'node:crypto';
import { authError, invalid } from '../errors.js';
import { request } from '../http.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function googleAuthUrl({ clientId, redirectUri, state, codeChallenge, scopes = YOUTUBE_SCOPES }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params}`;
}

function toTokenData(json, previous = {}) {
  return {
    accessToken: json.access_token,
    // 갱신 응답에 refresh_token 이 없으면 기존 것을 계속 씁니다
    refreshToken: json.refresh_token ?? previous.refreshToken,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scope: json.scope ?? previous.scope,
  };
}

function classifyTokenError(res) {
  const code = res.json?.error;
  if (code === 'invalid_grant' || code === 'unauthorized_client' || code === 'invalid_client') {
    return authError(`Google 로그인이 만료되었거나 취소되었습니다 (${code}). "snspub auth google" 로 다시 로그인해 주세요`);
  }
  return undefined;
}

export async function googleExchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier, fetchImpl }) {
  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
    idempotent: true,
    classify: classifyTokenError,
    fetchImpl,
    label: 'Google 토큰 발급',
  });
  if (!res.json?.refresh_token) {
    throw invalid('Google 이 refresh token 을 주지 않았습니다. https://myaccount.google.com/permissions 에서 앱 권한을 지운 뒤 다시 로그인해 주세요');
  }
  return toTokenData(res.json);
}

// 만료 1분 전이면 갱신한 뒤 access token 을 돌려줍니다.
export async function googleAccessToken(ctx) {
  const { clientId, clientSecret } = ctx.route;
  const saved = ctx.tokens.get('google');
  if (!saved?.refreshToken) throw authError('YouTube(Google) 로그인이 필요합니다. "snspub auth google" 을 실행해 주세요');
  if (saved.accessToken && saved.expiresAt > Date.now() + 60_000) return saved.accessToken;
  if (!clientId) throw invalid('config.jsonc 의 routes.youtube.clientId 가 비어 있습니다');
  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret ?? '',
      refresh_token: saved.refreshToken,
      grant_type: 'refresh_token',
    }),
    idempotent: true,
    classify: classifyTokenError,
    fetchImpl: ctx.fetch,
    label: 'Google 토큰 갱신',
  });
  const next = toTokenData(res.json, saved);
  ctx.tokens.set('google', next);
  return next.accessToken;
}
