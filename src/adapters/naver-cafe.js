// 네이버 카페 공식 글쓰기 API (무료). 글 + 이미지(카드뉴스). 동영상은 API 가 지원하지 않아
// 영상 콘텐츠는 소개글 + 먼저 올라간 채널 링크({links}, 예: 유튜브 쇼츠)로 올립니다.
//
// 인코딩 주의 (공식 샘플·커뮤니티 검증): 폼(urlencoded) 전송은 URL 인코딩을 두 번,
// 이미지 첨부(multipart) 전송은 한 번 해야 한글이 깨지지 않습니다.
// 참고: https://developers.naver.com/docs/login/cafe-api/cafe-api.md

import { openAsBlob } from 'node:fs';
import { authError, invalid, rateLimited, uncertain } from '../errors.js';
import { naverAccessToken } from '../oauth/naver.js';

const articlesUrl = (clubId, menuId) => `https://openapi.naver.com/v1/cafe/${encodeURIComponent(clubId)}/menu/${encodeURIComponent(menuId)}/articles`;

const CAFE_ERRORS = {
  '0005': '멤버만 글을 쓸 수 있는 카페입니다 (카페 가입 필요)',
  AP001: '요청 값이 올바르지 않습니다',
  AP002: '글쓰기가 제한된 게시판입니다',
  AP003: '특정 등급만 글을 쓸 수 있는 게시판입니다',
  AP004: '이 메뉴에는 글을 쓸 수 없습니다 (menuId 확인)',
  AP005: '스팸 필터에 걸려 스팸 보관함으로 이동했습니다',
  AP006: '카페를 찾을 수 없습니다 (clubId 확인)',
  AP007: '카페 활동이 정지된 상태입니다',
  AP008: '아이디가 정지되었습니다',
};

export function cafeClassify(res) {
  const err = res.json?.message?.error;
  const code = err?.code ?? res.json?.errorCode;
  const msg = err?.msg ?? res.json?.errorMessage ?? res.text ?? '';
  if (res.status === 401 || code === '024' || code === '028') {
    return authError(`네이버 로그인 만료 또는 카페 권한 동의가 필요합니다 (${code ?? res.status}). 화면의 [네이버 로그인]을 다시 눌러 "카페" 항목에 동의해 주세요`);
  }
  if (res.status === 429) return rateLimited('네이버 API 하루 호출 한도를 넘었습니다', { retryAfterSec: 3600 });
  if (code && CAFE_ERRORS[code]) return invalid(`네이버 카페: ${CAFE_ERRORS[code]} (${code})`);
  if (res.status === 403) return authError(`네이버 API 권한이 없습니다 — 애플리케이션 설정에 "카페" API 를 추가해 주세요 (${msg})`);
  if (res.status >= 500) return uncertain(`네이버 서버 오류 (${code ?? res.status}) — 글이 올라갔는지 카페에서 확인해 주세요`);
  return invalid(`네이버 카페 오류 (${code ?? res.status}): ${String(msg).slice(0, 200)}`);
}

// 알려진 문제를 피하기: 큰따옴표는 오류, 이모지(4바이트 문자)는 가끔 500 오류
export function cafeText(text) {
  return String(text ?? '')
    .replace(/"/g, "'")
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[️‍]/g, '');
}

export function toCafeHtml(text) {
  const clean = cafeText(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
  const escaped = clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linked = escaped.replace(/https?:\/\/[^\s<>']+/g, (url) => `<a href='${url}'>${url}</a>`);
  return linked.replace(/\n/g, '<br>');
}

function requireConfig(route) {
  if (!route.clubId || !route.menuId) throw invalid('config.jsonc 의 routes.naver_cafe.clubId / menuId 를 채워 주세요 (카페 게시판 주소의 cafes/숫자/menus/숫자)');
}

export default {
  name: 'naver_cafe',
  label: '네이버 카페 공식 API (무료)',
  supports: (channel) => channel === 'naver_cafe',
  validate(channel, post) {
    const warnings = [];
    if (post.kind === 'video') warnings.push('카페 API 는 영상을 올릴 수 없어 소개글과 먼저 올라간 채널 링크로 올립니다');
    return { errors: [], warnings };
  },
  async check(channel, ctx) {
    requireConfig(ctx.route);
    const token = await naverAccessToken(ctx);
    let account;
    try {
      const me = await ctx.request('https://openapi.naver.com/v1/nid/me', {
        headers: { Authorization: `Bearer ${token}` },
        classify: (res) => (res.status === 401 ? authError('네이버 로그인이 만료되었습니다') : undefined),
        label: '네이버 계정 확인',
      });
      account = me.json?.response?.nickname ?? me.json?.response?.id;
    } catch (err) {
      if (err.kind === 'auth') throw err;
    }
    const where = `카페 ${ctx.route.clubId} / 게시판 ${ctx.route.menuId}`;
    return { ok: true, account: account ? `${account} · ${where}` : where, message: ctx.route.public === false ? '멤버 공개로 올립니다' : '전체 공개로 올립니다' };
  },
  async publish(job, ctx) {
    const { route } = ctx;
    requireConfig(route);
    const token = await naverAccessToken(ctx);
    const subject = cafeText(job.options.title || job.post.title).trim();
    let html = toCafeHtml(job.options.caption);
    const images = job.post.kind === 'images' ? job.post.files : [];
    const openyn = route.public === false ? 'false' : 'true';

    let body;
    if (images.length) {
      if (route.imagePlaceholders !== false) html = `${images.map((_, i) => `<img src='#${i}' />`).join('<br>')}<br><br>${html}`;
      const form = new FormData();
      form.append('subject', encodeURIComponent(subject)); // multipart: 한 번 인코딩
      form.append('content', encodeURIComponent(html));
      form.append('openyn', openyn);
      for (const [i, f] of images.entries()) form.append('image', await openAsBlob(f.path, { type: f.mime }), `card${i}${f.ext}`);
      body = form;
    } else {
      // urlencoded: 여기서 한 번 + URLSearchParams 가 한 번 더 = 두 번 인코딩
      body = new URLSearchParams({ subject: encodeURIComponent(subject), content: encodeURIComponent(html), openyn });
    }

    ctx.checkpoint({ phase: 'posting', sentAt: new Date().toISOString() }); // 여기부터는 되돌릴 수 없음
    const res = await ctx.request(articlesUrl(route.clubId, route.menuId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body,
      idempotent: false,
      timeoutMs: 180_000,
      classify: cafeClassify,
      label: '네이버 카페 글쓰기',
    });
    const message = res.json?.message;
    if (String(message?.status) === '200' && message?.result?.articleUrl) {
      return { status: 'published', url: message.result.articleUrl, id: String(message.result.articleId ?? '') };
    }
    throw uncertain(`네이버 카페 응답을 해석할 수 없습니다 — 카페에서 글이 올라갔는지 확인해 주세요: ${res.text.slice(0, 200)}`);
  },
  canResume: () => false,
};
