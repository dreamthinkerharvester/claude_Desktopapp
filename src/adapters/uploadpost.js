// Upload-Post (게시 대행 서비스) 경로 — 보고서의 1순위 권장안.
// YouTube·TikTok 심사를 업체가 이미 통과했으므로 본인 앱 심사 없이 공개 게시가 됩니다.
// 로컬 파일을 그대로 올리므로(multipart) 별도 공개 저장소(R2 등)가 필요 없습니다.
//
// 요청 1건 = 채널 1개. 채널마다 예약 시각이 달라 따로 보내고, 한 채널 실패가 다른 채널에 번지지 않게 합니다.
// Idempotency-Key 헤더: 같은 키로 24시간 안에 다시 보내면 Upload-Post 가 원래 작업을 돌려주므로 중복 게시가 되지 않습니다.
// 24시간이 지나면 키가 효력을 잃으므로, 그 뒤에는 절대 다시 보내지 않고 "확인 필요"로 멈춥니다.
// 참고: https://github.com/Upload-Post/upload-post-npm (API parity SDK), docs.upload-post.com

import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { extname } from 'node:path';
import { authError, invalid, rateLimited, transient, uncertain } from '../errors.js';

const BASE = 'https://api.upload-post.com/api';
const PLATFORM = { youtube: 'youtube', tiktok: 'tiktok', instagram: 'instagram', facebook: 'facebook', threads: 'threads', x: 'x' };
const RUNNING = new Set(['pending', 'queued', 'processing', 'in_progress', 'uploading', 'started']);
const URL_WAIT_MS = 6 * 60_000; // TikTok 은 게시 주소가 나오기까지 몇 분 걸릴 수 있음
const KEY_WINDOW_MS = 23 * 60 * 60_000; // Idempotency-Key 유효 24시간 — 여유를 두고 23시간

const bool = (v) => (v ? 'true' : 'false');
const nowMs = (ctx) => (ctx.now ? ctx.now().getTime() : Date.now());

function headers(route, extra = {}) {
  return { Authorization: `Apikey ${route.apiKey}`, ...extra };
}

function requireConfig(route) {
  if (!route.apiKey) throw authError('config.jsonc 의 routes.uploadpost.apiKey 가 비어 있습니다 (Upload-Post 대시보드 → API Keys)');
  if (!route.user) throw invalid('config.jsonc 의 routes.uploadpost.user 에 Upload-Post 프로필 이름을 적어 주세요');
}

function errorText(json, text) {
  return String(json?.message ?? json?.error ?? json?.detail ?? text ?? '').slice(0, 400);
}

function classify(res) {
  const msg = errorText(res.json, res.text);
  if (res.status === 401) return authError(`Upload-Post API 키가 올바르지 않습니다 (${msg})`);
  if (res.status === 403) return authError(`Upload-Post 권한/요금제 문제: ${msg}`);
  if (res.status === 429) return rateLimited(`Upload-Post 호출 한도 초과: ${msg}`, { retryAfterSec: Number(res.headers?.get?.('retry-after')) || 900 });
  if (res.status === 404) return invalid(`Upload-Post: 찾을 수 없음 (${msg})`);
  if (res.status >= 500) return transient(`Upload-Post 서버 오류 ${res.status}: ${msg}`);
  if (res.status >= 400) return platformError(msg);
  return undefined;
}

// 플랫폼별 실패 사유 해석 (Postiz 의 분류표 참고). "Caption" 의 cap 같은 부분 일치를 피하려고 단어 경계를 씁니다.
export function platformError(message) {
  const m = String(message ?? '');
  if (/rate.?limit|too many|\b429\b|quota|daily.?(?:limit|cap)|\bcap(?:ped)?\b|limit (?:reached|exceeded)/i.test(m)) {
    return rateLimited(`업로드 한도: ${m}`, { retryAfterSec: 3600 });
  }
  if (/\btoken\b|expired|reconnect|re-?auth|unauthori[sz]ed|not connected|disconnected|permission/i.test(m)) return authError(`계정 연결을 확인해 주세요: ${m}`);
  if (/timeout|temporar|try again|unavailable|internal error/i.test(m)) return transient(m);
  return invalid(m || '업로드 실패');
}

function appendCommon(form, job, ctx) {
  const { route, config } = ctx;
  const p = PLATFORM[job.channel];
  const { title, caption, hashtags = [] } = job.options;
  form.append('user', route.user);
  form.append('platform[]', p);
  if (p === 'youtube') {
    form.append('title', title);
    form.append('description', caption);
  } else {
    form.append('title', caption);
  }
  const ai = !!config.aiGenerated;
  switch (p) {
    case 'youtube': {
      const yt = route.youtube ?? {};
      form.append('privacyStatus', yt.privacy ?? 'public');
      form.append('categoryId', String(yt.categoryId ?? '22'));
      form.append('selfDeclaredMadeForKids', 'false');
      form.append('containsSyntheticMedia', bool(ai));
      for (const tag of hashtags.map((t) => t.replace(/^#/, '')).filter(Boolean)) form.append('tags[]', tag);
      break;
    }
    case 'tiktok': {
      const tt = route.tiktok ?? {};
      form.append('privacy_level', tt.privacy ?? 'PUBLIC_TO_EVERYONE');
      form.append('disable_comment', bool(tt.disableComment));
      if (job.post.kind === 'video') {
        form.append('disable_duet', bool(tt.disableDuet));
        form.append('disable_stitch', bool(tt.disableStitch));
        form.append('is_aigc', bool(ai));
      } else {
        form.append('tiktok_is_ai_generated', bool(ai));
      }
      // 하루 한도에 걸리면 '초안'으로 바뀌는 대신 오류로 알려 달라는 옵션 (무시되더라도 아래에서 초안 전환을 감지합니다)
      form.append('disable_inbox_fallback', 'true');
      break;
    }
    case 'instagram':
      form.append('media_type', job.post.kind === 'video' ? 'REELS' : 'IMAGE');
      form.append('share_to_feed', 'true');
      break;
    case 'facebook':
      if (route.facebookPageId) form.append('facebook_page_id', String(route.facebookPageId));
      if (job.post.kind === 'video') form.append('facebook_media_type', 'REELS');
      break;
    default:
      break;
  }
}

async function send(job, ctx) {
  const { route } = ctx;
  requireConfig(route);
  const remote = ctx.checkpoint({
    idemKey: job.remote.idemKey ?? randomUUID(),
    phase: 'uploading',
    sentAt: job.remote.sentAt ?? new Date(nowMs(ctx)).toISOString(),
  });
  const form = new FormData();
  appendCommon(form, job, ctx);
  const files = job.post.files;
  let endpoint;
  if (job.post.kind === 'video') {
    endpoint = `${BASE}/upload`;
    const f = files[0];
    form.append('video', await openAsBlob(f.path, { type: f.mime }), `video${extname(f.path).toLowerCase() || '.mp4'}`);
  } else {
    endpoint = `${BASE}/upload_photos`;
    for (const [i, f] of files.entries()) form.append('photos[]', await openAsBlob(f.path, { type: f.mime }), `card${String(i + 1).padStart(2, '0')}${f.ext}`);
  }
  form.append('async_upload', 'true');

  const res = await ctx.request(endpoint, {
    method: 'POST',
    headers: headers(route, { 'Idempotency-Key': remote.idemKey }),
    body: form,
    timeoutMs: 20 * 60_000,
    idempotent: true, // Idempotency-Key 덕분에 24시간 안에는 같은 요청을 다시 보내도 한 번만 게시됩니다
    classify,
    label: 'Upload-Post 업로드',
  });
  const json = res.json ?? {};
  if (json.success === false) throw platformError(errorText(json, res.text));
  if (json.request_id) {
    ctx.checkpoint({ requestId: json.request_id, phase: 'sent' });
    const done = json.results ? await fromResults(job, ctx, json.results, json.request_id) : undefined;
    return done ?? { status: 'processing', pollAfterSec: 15 };
  }
  if (json.results) {
    const done = await fromResults(job, ctx, json.results, undefined);
    if (done) return done;
  }
  throw uncertain(`Upload-Post 응답을 해석할 수 없습니다 — 채널에서 게시 여부를 확인해 주세요: ${res.text.slice(0, 200)}`);
}

function entryFor(results, platform) {
  if (!results) return undefined;
  if (Array.isArray(results)) return results.find((r) => String(r.platform ?? '').toLowerCase() === platform);
  return results[platform];
}

// 게시 기록에서 request_id 로만 찾습니다 (시간만 보고 남의 업로드를 가져오지 않도록)
async function findInHistory(ctx, { platform, requestId }) {
  const res = await ctx.request(`${BASE}/uploadposts/history?page=1&limit=50`, { headers: headers(ctx.route), classify, label: 'Upload-Post 기록 조회' });
  const items = res.json?.history ?? res.json?.items ?? res.json?.data ?? (Array.isArray(res.json) ? res.json : []);
  return items.find((it) => String(it.platform ?? '').toLowerCase() === platform && it.request_id === requestId);
}

async function fromResults(job, ctx, results, requestId) {
  const platform = PLATFORM[job.channel];
  const entry = entryFor(results, platform);
  if (!entry) return undefined;
  if (entry.success === false) throw platformError(entry.error ?? entry.message ?? entry.error_message);
  if (entry.success !== true) return undefined;
  let url = entry.url ?? entry.post_url;
  let id = entry.platform_post_id ?? entry.post_id ?? entry.publish_id;
  // TikTok 하루 한도로 '초안함'으로 들어간 경우: 공개 게시가 아니므로 알려 줌
  if (entry.fallback_to_inbox === true || /^v_inbox/.test(String(id ?? ''))) {
    return { status: 'needs_check', message: 'TikTok 하루 게시 한도에 걸려 TikTok 앱의 초안함으로 들어갔습니다. 앱에서 마무리한 뒤 [게시됨으로 표시]를 눌러 주세요' };
  }
  const successAt = job.remote.successAt ?? ctx.checkpoint({ successAt: new Date(nowMs(ctx)).toISOString() }).successAt;
  if (!url && requestId) {
    // 주소 찾기는 부가 기능이라 실패해도 게시 결과를 바꾸지 않습니다
    const hist = await findInHistory(ctx, { platform, requestId }).catch(() => undefined);
    url = hist?.post_url;
    id = id ?? hist?.platform_post_id;
  }
  if (url) return { status: 'published', url, id };
  if (requestId && nowMs(ctx) - Date.parse(successAt) < URL_WAIT_MS) return { status: 'processing', pollAfterSec: 60 };
  return { status: 'published', id, warning: '게시는 됐지만 주소를 아직 받지 못했습니다 (채널에서 확인)' };
}

async function poll(job, ctx) {
  const { requestId } = job.remote;
  const res = await ctx.request(`${BASE}/uploadposts/status?request_id=${encodeURIComponent(requestId)}`, {
    headers: headers(ctx.route),
    accept: [404],
    classify,
    label: 'Upload-Post 상태 조회',
  });
  const json = res.json ?? {};
  const status = String(json.status ?? '').toLowerCase();
  if (res.status === 404 || status === 'not_found') {
    return { status: 'needs_check', message: 'Upload-Post 에서 이 작업을 찾을 수 없습니다. 채널에서 게시 여부를 확인해 주세요' };
  }
  const done = await fromResults(job, ctx, json.results, requestId);
  if (done) return done;
  if (!status || RUNNING.has(status)) return { status: 'processing', pollAfterSec: 20 };
  if (status === 'failed' || status === 'error' || status === 'retryable') throw platformError(errorText(json) || `Upload-Post 작업 실패 (${status})`);
  if (status === 'completed') {
    // 결과 목록에 이 채널이 없을 때: 기록에서 찾아봄 (조회 실패는 일시 오류로 보고 나중에 다시 확인)
    const hist = await findInHistory(ctx, { platform: PLATFORM[job.channel], requestId });
    if (hist?.success) return { status: 'published', url: hist.post_url, id: hist.platform_post_id };
    if (hist && hist.success === false) throw platformError(hist.error_message);
    return { status: 'needs_check', message: 'Upload-Post 는 완료라고 하지만 이 채널 결과가 없습니다. 채널에서 확인해 주세요' };
  }
  return { status: 'processing', pollAfterSec: 30 };
}

export default {
  name: 'uploadpost',
  label: 'Upload-Post (게시 대행)',
  supports(channel, kind) {
    if (!PLATFORM[channel]) return false;
    return kind === 'video' || channel !== 'youtube';
  },
  validate(channel, post) {
    const errors = [];
    const warnings = [];
    if (post.kind === 'images' && channel === 'tiktok' && post.files.some((f) => f.ext === '.png')) {
      errors.push('TikTok 사진 게시는 JPG 만 됩니다 (PNG 를 JPG 로 바꿔 주세요: 미리보기 앱 → 내보내기)');
    }
    if (post.kind === 'images' && channel === 'instagram' && post.files.some((f) => f.ext === '.png')) {
      warnings.push('Instagram 은 JPG 를 권장합니다 (PNG 는 변환 과정에서 실패할 수 있음)');
    }
    return { errors, warnings };
  },
  textWarnings(channel, caption) {
    if (channel === 'x' && /https?:\/\//.test(caption)) return ['Upload-Post 는 X 글의 링크를 지웁니다 (유료 추가 기능 필요)'];
    return [];
  },
  async check(channel, ctx) {
    requireConfig(ctx.route);
    let res;
    try {
      res = await ctx.request(`${BASE}/uploadposts/users`, { headers: headers(ctx.route), classify, label: 'Upload-Post 연결 확인' });
    } catch (err) {
      if (err.kind !== 'invalid') throw err;
      // 프로필 목록을 못 읽으면 기록 조회로 API 키만 확인합니다
      await ctx.request(`${BASE}/uploadposts/history?page=1&limit=20`, { headers: headers(ctx.route), classify, label: 'Upload-Post 연결 확인' });
      return { ok: true, account: `Upload-Post 프로필 ${ctx.route.user}`, message: 'API 키 정상 (채널별 계정 연결은 Upload-Post 화면에서 확인해 주세요)' };
    }
    const profiles = res.json?.profiles ?? res.json?.users ?? [];
    const profile = profiles.find((p) => p.username === ctx.route.user);
    if (profiles.length && !profile) return { ok: false, message: `Upload-Post 에 "${ctx.route.user}" 프로필이 없습니다 (있는 프로필: ${profiles.map((p) => p.username).join(', ')})` };
    const accounts = profile?.social_accounts;
    const keys = channel === 'x' ? ['x', 'twitter'] : [PLATFORM[channel]];
    const key = accounts ? keys.find((k) => k in accounts) : undefined;
    const account = key ? accounts[key] : undefined;
    // 키가 있는데 비어 있으면 미연결, 키 자체가 없으면 (형식을 몰라) 확인 불가로 둡니다
    if (key && !account) return { ok: false, message: `Upload-Post 프로필에 ${channel} 계정이 연결되어 있지 않습니다` };
    const name = account && typeof account === 'object' ? account.display_name ?? account.username ?? account.handle : undefined;
    return {
      ok: true,
      account: name ? `${name} (Upload-Post)` : `Upload-Post 프로필 ${ctx.route.user}`,
      message: accounts && !key ? '채널 연결 여부는 Upload-Post 화면에서 확인해 주세요' : undefined,
    };
  },
  async publish(job, ctx) {
    return send(job, ctx);
  },
  async resume(job, ctx) {
    if (job.remote.requestId) return poll(job, ctx);
    // 게시 성공은 확인했지만 추적 번호가 없는 경우: 다시 보내지 않고 완료로 둠
    if (job.remote.successAt) return { status: 'published', warning: '게시는 됐지만 주소를 받지 못했습니다 (채널에서 확인)' };
    requireConfig(ctx.route);
    // 업로드 응답을 못 받은 경우: 24시간 안이면 같은 Idempotency-Key 로 다시 보냄 → Upload-Post 가 원래 작업을 돌려줌(중복 없음)
    const sentAt = Date.parse(job.remote.sentAt ?? '');
    if (!Number.isFinite(sentAt) || nowMs(ctx) - sentAt > KEY_WINDOW_MS) {
      return {
        status: 'needs_check',
        message: 'Upload-Post 응답을 받지 못한 채 중복 방지 키의 유효 시간(24시간)이 지나 자동으로 다시 보내지 않습니다. 채널에서 게시 여부를 확인해 주세요',
      };
    }
    return send(job, ctx);
  },
  canResume(job) {
    return !!(job.remote?.requestId || job.remote?.idemKey || job.remote?.successAt);
  },
};
