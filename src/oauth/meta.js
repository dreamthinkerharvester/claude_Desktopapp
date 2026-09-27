// Meta(Instagram·Facebook 페이지) 토큰 등록.
// 그래프 API 탐색기에서 받은 짧은 사용자 토큰 → 장기 사용자 토큰(약 60일) → 페이지 토큰(만료 없음)으로 바꿔 저장합니다.
// 페이지 토큰은 만료되지 않으므로, 비밀번호 변경·권한 해제 전까지 다시 로그인할 필요가 없습니다.

import { invalid } from '../errors.js';
import { request } from '../http.js';

export const DEFAULT_GRAPH_VERSION = 'v25.0';

export function graphBase(route) {
  return `https://graph.facebook.com/${route?.graphVersion || DEFAULT_GRAPH_VERSION}`;
}

export async function registerMetaToken({ route, userToken, pageId, store, fetchImpl }) {
  const { appId, appSecret } = route ?? {};
  if (!appId || !appSecret) throw invalid('config.jsonc 의 routes.meta.appId / appSecret 을 먼저 채워 주세요');
  if (!userToken) throw invalid('그래프 API 탐색기에서 받은 사용자 토큰을 붙여 넣어 주세요');
  const base = graphBase(route);

  const exchanged = await request(
    `${base}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: userToken.trim() })}`,
    { idempotent: true, fetchImpl, label: 'Meta 장기 토큰 교환' },
  );
  const longUserToken = exchanged.json?.access_token;
  if (!longUserToken) throw invalid('Meta 장기 토큰을 받지 못했습니다');

  const accounts = await request(
    `${base}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100', access_token: longUserToken })}`,
    { idempotent: true, fetchImpl, label: 'Meta 페이지 목록' },
  );
  const pages = accounts.json?.data ?? [];
  const wanted = String(pageId || route.pageId || '');
  const pageEntry = wanted ? pages.find((p) => String(p.id) === wanted) : pages.length === 1 ? pages[0] : undefined;
  if (!pageEntry) {
    const list = pages.map((p) => `${p.name} (${p.id})`).join(', ') || '없음';
    throw invalid(`게시할 페이지를 찾지 못했습니다. config.jsonc 의 routes.meta.pageId 를 지정해 주세요. 권한 있는 페이지: ${list}`);
  }

  const data = {
    pageId: String(pageEntry.id),
    pageName: pageEntry.name,
    pageToken: pageEntry.access_token,
    igUserId: pageEntry.instagram_business_account?.id ? String(pageEntry.instagram_business_account.id) : undefined,
    igUsername: pageEntry.instagram_business_account?.username,
    userToken: longUserToken,
    userTokenExpiresAt: exchanged.json?.expires_in ? Date.now() + Number(exchanged.json.expires_in) * 1000 : undefined,
    savedAt: new Date().toISOString(),
  };
  store.setToken('meta', data);
  store.addEvent('info', `Meta 토큰 등록: 페이지 ${data.pageName}${data.igUsername ? ` / Instagram @${data.igUsername}` : ' (연결된 Instagram 계정 없음)'}`);
  return { ok: true, pageId: data.pageId, pageName: data.pageName, igUserId: data.igUserId, igUsername: data.igUsername };
}
