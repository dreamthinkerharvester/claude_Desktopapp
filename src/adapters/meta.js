// Meta 직접 연결 (무료): Instagram 릴스, Facebook 페이지 릴스·사진.
// 개발 모드 앱 + 본인(관리자) 계정이면 앱 검수 없이 쓸 수 있고, 만료 없는 페이지 토큰을 씁니다.
// 로컬 파일을 rupload.facebook.com 으로 바로 올리므로 공개 저장소가 필요 없습니다.
// Instagram 이미지(카드뉴스)는 API 가 공개 URL 만 받기 때문에 이 경로로는 지원하지 않습니다
// → channels.instagram.imagesRoute 를 "uploadpost" 또는 "manual" 로 지정하세요.
//
// 게시 확정 전 확인 규칙 (Meta 문서·Postiz 분석): Instagram 은 media_publish 를 다시 부르기 전에
// 컨테이너 상태를 먼저 봅니다. PUBLISHED 면 이미 게시된 것, FINISHED 면 아직 안 된 것 → 중복 게시가 없습니다.

import { openAsBlob } from 'node:fs';
import { authError, invalid, rateLimited, transient, uncertain } from '../errors.js';
import { DEFAULT_GRAPH_VERSION, graphBase } from '../oauth/meta.js';

const RATE_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002]);

export function graphClassify(res) {
  const e = res.json?.error;
  if (!e) return undefined;
  const code = Number(e.code);
  const sub = Number(e.error_subcode) || undefined;
  const msg = `${e.error_user_msg || e.message || ''} (code ${code}${sub ? `/${sub}` : ''})`;
  if (code === 190 || code === 102) return authError(`Meta 토큰이 만료되었거나 취소되었습니다. 토큰을 다시 등록해 주세요: ${msg}`);
  if (RATE_CODES.has(code) || sub === 2207042) return rateLimited(`Meta 호출/게시 한도 초과: ${msg}`, { retryAfterSec: 3600 });
  if (code === 9007 || sub === 2207027) return transient(`Instagram 이 아직 영상을 처리 중입니다: ${msg}`);
  if (code === 1 || code === 2 || e.is_transient === true || [2207001, 2207003, 2207008].includes(sub)) return transient(`Meta 일시 오류: ${msg}`);
  if (code === 3 || code === 10 || (code >= 200 && code <= 299)) return authError(`Meta 권한 문제 (앱 권한·페이지 역할 확인): ${msg}`);
  if (code === 368 || [2207050, 2207051].includes(sub)) return invalid(`Meta 정책에 따라 게시가 제한되었습니다: ${msg}`);
  return invalid(`Meta 오류: ${msg}`);
}

function tokenData(ctx) {
  const t = ctx.tokens.get('meta');
  if (!t?.pageToken) throw authError('Meta 토큰이 없습니다. 채널 화면의 [Meta 토큰 등록] 또는 "snspub auth meta --token <토큰>" 으로 등록해 주세요');
  return t;
}

const q = (params) => new URLSearchParams(params);
const version = (ctx) => ctx.route.graphVersion || DEFAULT_GRAPH_VERSION;

// 결과를 모르는(되돌릴 수 없는) 요청 실패는 "확인 필요"로
async function irreversible(promise, what) {
  try {
    return await promise;
  } catch (err) {
    if (err.kind === 'transient') throw uncertain(`${what} 요청의 결과를 알 수 없습니다 (${err.message}). 채널에서 게시 여부를 확인해 주세요`);
    throw err;
  }
}

// ---------- 공통: 대용량 파일 올리기 (rupload) ----------

async function ruploadFile(ctx, { uri, statusUrl, token, file, label }) {
  let offset = 0;
  if (statusUrl) {
    const st = await ctx.request(statusUrl, { classify: graphClassify, label: `${label} 진행 확인` });
    const phase = st.json?.video_status?.uploading_phase ?? st.json?.status?.uploading_phase;
    offset = Number(phase?.bytes_transferred) || 0;
    if (phase?.status === 'complete' || offset >= file.size) return;
  }
  const blob = await openAsBlob(file.path, { type: 'application/octet-stream' });
  const res = await ctx.request(uri, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, offset: String(offset), file_size: String(file.size), 'Content-Type': 'application/octet-stream' },
    body: offset > 0 ? blob.slice(offset) : blob,
    idempotent: true, // offset 기준 이어올리기
    timeoutMs: 30 * 60_000,
    classify: graphClassify,
    label,
  });
  if (res.json?.success === false) throw transient(`${label} 실패: ${res.json?.message ?? res.text.slice(0, 200)}`);
}

// ---------- Instagram 릴스 ----------

async function igStart(job, ctx) {
  const t = tokenData(ctx);
  if (!t.igUserId) throw invalid('이 Facebook 페이지에 연결된 Instagram 비즈니스(프로페셔널) 계정이 없습니다');
  const base = graphBase(ctx.route);
  if (!job.remote.containerId) {
    const res = await ctx.request(`${base}/${t.igUserId}/media`, {
      method: 'POST',
      body: q({ media_type: 'REELS', upload_type: 'resumable', caption: job.options.caption, share_to_feed: 'true', access_token: t.pageToken }),
      idempotent: true, // 컨테이너는 게시 전 단계 (24시간 뒤 자동 만료)
      classify: graphClassify,
      label: 'Instagram 준비',
    });
    if (!res.json?.id) throw transient('Instagram 이 컨테이너 ID 를 주지 않았습니다');
    ctx.checkpoint({ containerId: res.json.id, uploadUri: res.json.uri, stage: 'created' });
  }
  return igUpload(job, ctx, t);
}

async function igUpload(job, ctx, t) {
  const base = graphBase(ctx.route);
  const { containerId } = job.remote;
  const resuming = job.remote.stage === 'uploading';
  ctx.checkpoint({ stage: 'uploading' });
  await ruploadFile(ctx, {
    uri: job.remote.uploadUri ?? `https://rupload.facebook.com/ig-api-upload/${version(ctx)}/${containerId}`,
    statusUrl: resuming ? `${base}/${containerId}?${q({ fields: 'video_status', access_token: t.pageToken })}` : undefined,
    token: t.pageToken,
    file: job.post.files[0],
    label: 'Instagram 파일 업로드',
  });
  ctx.checkpoint({ stage: 'uploaded' });
  return { status: 'processing', pollAfterSec: 20 };
}

async function igFindPublished(job, ctx, t) {
  const base = graphBase(ctx.route);
  if (!job.remote.mediaId) {
    const list = await ctx.request(`${base}/${t.igUserId}/media?${q({ fields: 'id,permalink,caption,timestamp', limit: '10', access_token: t.pageToken })}`, {
      classify: graphClassify,
      label: 'Instagram 게시물 찾기',
    });
    const caption = String(job.options.caption ?? '').trim();
    const found = (list.json?.data ?? []).find((m) => String(m.caption ?? '').trim() === caption);
    if (!found) return { status: 'published', warning: '게시는 됐지만 게시물 주소를 찾지 못했습니다' };
    return { status: 'published', url: found.permalink, id: found.id };
  }
  const media = await ctx.request(`${base}/${job.remote.mediaId}?${q({ fields: 'permalink', access_token: t.pageToken })}`, { classify: graphClassify, label: 'Instagram 주소 확인' }).catch(() => undefined);
  return { status: 'published', url: media?.json?.permalink, id: job.remote.mediaId };
}

async function igResume(job, ctx) {
  const t = tokenData(ctx);
  const base = graphBase(ctx.route);
  const { containerId, stage } = job.remote;
  if (stage === 'published') return igFindPublished(job, ctx, t);
  if (stage === 'created' || stage === 'uploading') return igUpload(job, ctx, t);

  const st = await ctx.request(`${base}/${containerId}?${q({ fields: 'status_code,status', access_token: t.pageToken })}`, { classify: graphClassify, label: 'Instagram 처리 상태' });
  const code = st.json?.status_code;
  if (code === 'IN_PROGRESS' || !code) return { status: 'processing', pollAfterSec: 20 };
  if (code === 'ERROR') throw invalid(`Instagram 이 영상을 처리하지 못했습니다: ${st.json?.status ?? ''} (형식: MP4/H.264, 9:16, 3초~15분)`);
  if (code === 'EXPIRED') {
    ctx.checkpoint({ containerId: null, uploadUri: null, stage: null });
    throw transient('Instagram 준비 단계가 만료되어 처음부터 다시 올립니다');
  }
  if (code === 'PUBLISHED') {
    ctx.checkpoint({ stage: 'published' });
    return igFindPublished(job, ctx, t);
  }
  // FINISHED: 이제 게시. 결과를 모르면 다음 확인에서 컨테이너 상태로 판단하므로 안전합니다.
  ctx.checkpoint({ stage: 'publishing' });
  let pub;
  try {
    pub = await ctx.request(`${base}/${t.igUserId}/media_publish`, {
      method: 'POST',
      body: q({ creation_id: containerId, access_token: t.pageToken }),
      idempotent: true,
      classify: graphClassify,
      label: 'Instagram 게시',
    });
  } catch (err) {
    if (['transient', 'rate_limit', 'auth'].includes(err.kind)) throw err;
    // 오류를 돌려줘도 실제로는 게시된 사례가 있어 컨테이너 상태를 다시 봅니다
    const again = await ctx
      .request(`${base}/${containerId}?${q({ fields: 'status_code', access_token: t.pageToken })}`, { classify: graphClassify, label: 'Instagram 게시 재확인' })
      .catch(() => undefined);
    const after = again?.json?.status_code;
    if (after === 'PUBLISHED') {
      ctx.checkpoint({ stage: 'published' });
      return igFindPublished(job, ctx, t);
    }
    if (after === 'ERROR' || after === 'EXPIRED') throw err;
    throw uncertain(`Instagram 게시 요청이 오류를 돌려줬지만 게시됐을 수도 있습니다 (${err.message}). 채널에서 확인해 주세요`);
  }
  if (!pub.json?.id) return { status: 'processing', pollAfterSec: 20 };
  ctx.checkpoint({ mediaId: pub.json.id, stage: 'published' });
  return igFindPublished(job, ctx, t);
}

// ---------- Facebook 페이지 릴스 ----------

async function fbVideoStart(job, ctx) {
  const t = tokenData(ctx);
  const base = graphBase(ctx.route);
  if (!job.remote.videoId) {
    const res = await ctx.request(`${base}/${t.pageId}/video_reels`, {
      method: 'POST',
      body: q({ upload_phase: 'start', access_token: t.pageToken }),
      idempotent: true,
      classify: graphClassify,
      label: 'Facebook 릴스 준비',
    });
    if (!res.json?.video_id) throw transient('Facebook 이 영상 ID 를 주지 않았습니다');
    ctx.checkpoint({ videoId: res.json.video_id, uploadUri: res.json.upload_url, stage: 'created' });
  }
  return fbVideoUpload(job, ctx, t);
}

async function fbVideoUpload(job, ctx, t) {
  const base = graphBase(ctx.route);
  const { videoId } = job.remote;
  const resuming = job.remote.stage === 'uploading';
  ctx.checkpoint({ stage: 'uploading' });
  await ruploadFile(ctx, {
    uri: job.remote.uploadUri ?? `https://rupload.facebook.com/video-upload/${version(ctx)}/${videoId}`,
    statusUrl: resuming ? `${base}/${videoId}?${q({ fields: 'status', access_token: t.pageToken })}` : undefined,
    token: t.pageToken,
    file: job.post.files[0],
    label: 'Facebook 파일 업로드',
  });
  ctx.checkpoint({ stage: 'uploaded' });
  return fbVideoFinish(job, ctx, t);
}

async function fbVideoFinish(job, ctx, t) {
  const base = graphBase(ctx.route);
  // 같은 영상 ID 로 게시하므로 다시 불러도 게시물이 두 개 생기지 않습니다
  ctx.checkpoint({ stage: 'finishing' });
  await ctx.request(`${base}/${t.pageId}/video_reels`, {
    method: 'POST',
    body: q({ upload_phase: 'finish', video_id: job.remote.videoId, video_state: 'PUBLISHED', description: job.options.caption, access_token: t.pageToken }),
    idempotent: true,
    classify: graphClassify,
    label: 'Facebook 릴스 게시',
  });
  ctx.checkpoint({ stage: 'finished' });
  return { status: 'processing', pollAfterSec: 20 };
}

async function fbVideoResume(job, ctx) {
  const t = tokenData(ctx);
  const base = graphBase(ctx.route);
  const { videoId, stage } = job.remote;
  if (stage === 'created' || stage === 'uploading') return fbVideoUpload(job, ctx, t);
  if (stage === 'uploaded') return fbVideoFinish(job, ctx, t);
  const res = await ctx.request(`${base}/${videoId}?${q({ fields: 'status,permalink_url', access_token: t.pageToken })}`, { classify: graphClassify, label: 'Facebook 처리 상태' });
  const status = res.json?.status ?? {};
  const failed = [status.uploading_phase, status.processing_phase, status.publishing_phase].find((p) => p?.status === 'error');
  if (status.video_status === 'error' || failed) throw invalid(`Facebook 이 영상을 처리하지 못했습니다: ${failed?.error?.message ?? status.video_status} (릴스는 3~90초, 9:16)`);
  if (status.video_status === 'expired') throw invalid('Facebook 영상 업로드가 만료되었습니다. 다시 올려 주세요');
  if (stage === 'finishing' && status.publishing_phase?.status !== 'complete' && status.publishing_phase?.status !== 'in_progress') {
    return fbVideoFinish(job, ctx, t);
  }
  if (status.publishing_phase?.status === 'complete' || (status.video_status === 'ready' && status.publishing_phase?.publish_status === 'published')) {
    const link = res.json?.permalink_url;
    const url = link ? (link.startsWith('http') ? link : `https://www.facebook.com${link}`) : `https://www.facebook.com/reel/${videoId}`;
    return { status: 'published', url, id: String(videoId) };
  }
  return { status: 'processing', pollAfterSec: 20 };
}

// ---------- Facebook 페이지 사진 (카드뉴스) ----------

async function fbImages(job, ctx) {
  const t = tokenData(ctx);
  const base = graphBase(ctx.route);
  if (job.remote.postId) return fbPostLink(ctx, t, job.remote.postId);
  const photoIds = [...(job.remote.photoIds ?? [])];
  const files = job.post.files;
  for (let i = photoIds.length; i < files.length; i += 1) {
    const f = files[i];
    const form = new FormData();
    form.append('source', await openAsBlob(f.path, { type: f.mime }), `card${i + 1}${f.ext}`);
    form.append('published', 'false'); // 아직 보이지 않는 사진으로 올림
    form.append('access_token', t.pageToken);
    const res = await ctx.request(`${base}/${t.pageId}/photos`, { method: 'POST', body: form, idempotent: true, timeoutMs: 5 * 60_000, classify: graphClassify, label: `Facebook 사진 ${i + 1}/${files.length}` });
    if (!res.json?.id) throw transient('Facebook 이 사진 ID 를 주지 않았습니다');
    photoIds.push(res.json.id);
    ctx.checkpoint({ photoIds: [...photoIds] });
  }
  ctx.checkpoint({ stage: 'posting' }); // 여기부터는 되돌릴 수 없음
  const body = q({ message: job.options.caption, access_token: t.pageToken });
  photoIds.forEach((id, i) => body.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  const res = await irreversible(ctx.request(`${base}/${t.pageId}/feed`, { method: 'POST', body, idempotent: false, classify: graphClassify, label: 'Facebook 게시' }), 'Facebook 게시');
  if (!res.json?.id) throw uncertain('Facebook 이 게시물 ID 를 주지 않았습니다. 페이지에서 확인해 주세요');
  ctx.checkpoint({ postId: res.json.id, stage: 'posted' });
  return fbPostLink(ctx, t, res.json.id);
}

async function fbPostLink(ctx, t, postId) {
  const base = graphBase(ctx.route);
  const res = await ctx.request(`${base}/${postId}?${q({ fields: 'permalink_url', access_token: t.pageToken })}`, { classify: graphClassify, label: 'Facebook 주소 확인' }).catch(() => undefined);
  return { status: 'published', url: res?.json?.permalink_url ?? `https://www.facebook.com/${postId}`, id: postId };
}

export default {
  name: 'meta',
  label: 'Meta 직접 연결 (무료)',
  supports(channel, kind) {
    if (channel === 'instagram') return kind === 'video';
    if (channel === 'facebook') return kind === 'video' || kind === 'images';
    return false;
  },
  validate(channel, post) {
    const warnings = [];
    const errors = [];
    if (channel === 'facebook' && post.kind === 'images' && post.files.some((f) => f.size > 4 * 1024 * 1024)) {
      warnings.push('Facebook 사진은 4MB 이하를 권장합니다');
    }
    if (channel === 'instagram' && post.kind === 'video' && post.files[0]?.size > 300 * 1024 * 1024) {
      errors.push('Instagram 릴스는 300MB 이하만 올릴 수 있습니다');
    }
    return { errors, warnings };
  },
  async check(channel, ctx) {
    const t = tokenData(ctx);
    const base = graphBase(ctx.route);
    const res = await ctx.request(`${base}/${t.pageId}?${q({ fields: 'name,instagram_business_account{id,username}', access_token: t.pageToken })}`, { classify: graphClassify, label: 'Meta 연결 확인' });
    if (channel === 'instagram') {
      const ig = res.json?.instagram_business_account;
      if (!ig?.id) return { ok: false, message: '페이지에 Instagram 비즈니스(프로페셔널) 계정이 연결되어 있지 않습니다' };
      let message;
      try {
        const lim = await ctx.request(`${base}/${ig.id}/content_publishing_limit?${q({ fields: 'quota_usage,config', access_token: t.pageToken })}`, { classify: graphClassify, label: 'Instagram 한도 확인' });
        const d = lim.json?.data?.[0];
        if (d) message = `최근 24시간 API 게시 ${d.quota_usage ?? 0}/${d.config?.quota_total ?? '?'}건`;
      } catch {
        // 한도 조회 실패는 무시
      }
      return { ok: true, account: `@${ig.username ?? ig.id}`, message };
    }
    return { ok: true, account: `${res.json?.name ?? t.pageName} (페이지)` };
  },
  async publish(job, ctx) {
    if (job.channel === 'instagram') return igStart(job, ctx);
    if (job.post.kind === 'video') return fbVideoStart(job, ctx);
    return fbImages(job, ctx);
  },
  async resume(job, ctx) {
    if (job.channel === 'instagram') return igResume(job, ctx);
    if (job.post.kind === 'video') return fbVideoResume(job, ctx);
    return fbImages(job, ctx);
  },
  canResume(job) {
    const r = job.remote ?? {};
    if (job.channel === 'instagram') return !!r.containerId;
    if (r.photoIds || r.postId) return r.stage !== 'posting' || !!r.postId;
    return !!r.videoId;
  },
};
