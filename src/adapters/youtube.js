// YouTube 직접 연결 (무료). Google OAuth + 이어올리기(resumable upload).
// 주의: 감사(audit)를 통과하지 않은 API 프로젝트로 올린 영상은 "비공개로 잠겨" 나중에 공개로 바꿀 수 없습니다.
// 그래서 routes.youtube.audited 가 true 일 때만 올립니다. 감사 전에는 uploadpost 경로를 쓰세요.
// 참고: developers.google.com/youtube/v3/guides/using_resumable_upload_protocol

import { openAsBlob } from 'node:fs';
import { authError, invalid, rateLimited, transient, uncertain } from '../errors.js';
import { googleAccessToken } from '../oauth/google.js';

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const API = 'https://www.googleapis.com/youtube/v3';

const NOT_AUDITED =
  'YouTube API 프로젝트 감사(audit) 통과 전에는 올린 영상이 비공개로 잠겨 다시 올려야 합니다. 감사를 통과했으면 config.jsonc 의 routes.youtube.audited 를 true 로 바꾸고, 아니면 이 채널의 route 를 "uploadpost" 로 바꾸세요';

export function youtubeClassify(res) {
  const err = res.json?.error;
  const reason = err?.errors?.[0]?.reason ?? err?.status ?? '';
  const msg = `${reason ? `${reason}: ` : ''}${err?.message ?? res.text ?? ''}`.slice(0, 300);
  if (res.status === 401) return authError(`YouTube 로그인이 만료되었습니다 (${msg})`);
  if (['quotaExceeded', 'uploadLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(reason)) {
    return rateLimited(`YouTube 한도 초과 (${reason}). 한도는 태평양 시간 자정(한국 오후 4~5시)에 초기화됩니다`, { retryAfterSec: 3600 });
  }
  if (res.status === 403) return authError(`YouTube 권한 문제: ${msg}`);
  if (res.status >= 500) return transient(`YouTube 서버 오류 ${res.status}`);
  if (res.status === 400) return invalid(`YouTube 가 요청을 거절했습니다: ${msg}`);
  return undefined;
}

const shortsUrl = (id) => `https://www.youtube.com/shorts/${id}`;

function metadata(job, route, config) {
  const tags = [];
  let total = 0;
  for (const tag of (job.options.hashtags ?? []).map((t) => t.replace(/^#/, ''))) {
    const cost = tag.length + (tag.includes(' ') ? 2 : 0) + (tags.length ? 1 : 0);
    if (total + cost > 480) break; // 태그 전체 500자 제한
    tags.push(tag);
    total += cost;
  }
  return {
    snippet: {
      title: job.options.title,
      description: job.options.caption,
      tags,
      categoryId: String(route.categoryId ?? '22'),
      defaultLanguage: route.language ?? 'ko',
      defaultAudioLanguage: route.language ?? 'ko',
    },
    status: {
      privacyStatus: route.privacy ?? 'public',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: !!config.aiGenerated,
    },
  };
}

async function startSession(job, ctx, token) {
  const file = job.post.files[0];
  const notify = ctx.route.notifySubscribers === false ? '&notifySubscribers=false' : '';
  const res = await ctx.request(`${UPLOAD_URL}${notify}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(file.size),
      'X-Upload-Content-Type': file.mime,
    },
    body: JSON.stringify(metadata(job, ctx.route, ctx.config)),
    idempotent: true, // 세션만 만들고 영상은 아직 생기지 않음
    classify: youtubeClassify,
    label: 'YouTube 업로드 준비',
  });
  const uploadUrl = res.headers.get('location');
  if (!uploadUrl) throw transient('YouTube 가 업로드 주소를 주지 않았습니다');
  ctx.checkpoint({ uploadUrl, bytesStarted: false });
}

async function uploadBytes(job, ctx, token) {
  const file = job.post.files[0];
  const { uploadUrl } = job.remote;
  let offset = 0;
  if (job.remote.bytesStarted) {
    // 끊긴 업로드: 서버가 몇 바이트까지 받았는지 확인하고 이어서 보냅니다 (중복 영상이 생기지 않음)
    let probe;
    try {
      probe = await ctx.request(uploadUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${file.size}` },
        body: '',
        redirect: 'manual',
        accept: [308],
        idempotent: true,
        classify: youtubeClassify,
        label: 'YouTube 이어올리기 확인',
      });
    } catch (err) {
      if (err.status === 404 || err.status === 410) {
        ctx.checkpoint({ uploadUrl: null, bytesStarted: false });
        throw transient('YouTube 업로드 세션이 만료되어 처음부터 다시 올립니다');
      }
      throw err;
    }
    if (probe.status === 200 || probe.status === 201) return afterUpload(job, ctx, probe.json);
    const m = /bytes=0-(\d+)/.exec(probe.headers.get('range') ?? '');
    offset = m ? Number(m[1]) + 1 : 0;
  }
  ctx.checkpoint({ bytesStarted: true });
  const blob = await openAsBlob(file.path, { type: file.mime });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': file.mime };
  if (offset > 0) headers['Content-Range'] = `bytes ${offset}-${file.size - 1}/${file.size}`;
  const res = await ctx.request(uploadUrl, {
    method: 'PUT',
    headers,
    body: offset > 0 ? blob.slice(offset) : blob,
    redirect: 'manual',
    accept: [308],
    idempotent: true,
    timeoutMs: 60 * 60_000,
    classify: youtubeClassify,
    label: 'YouTube 업로드',
  });
  if (res.status === 308) throw transient('YouTube 업로드가 중간에 끊겼습니다 — 이어서 올립니다');
  return afterUpload(job, ctx, res.json);
}

function afterUpload(job, ctx, video) {
  if (!video?.id) throw uncertain('YouTube 가 영상 ID 를 돌려주지 않았습니다. YouTube 스튜디오에서 확인해 주세요');
  ctx.checkpoint({ videoId: video.id });
  const wanted = ctx.route.privacy ?? 'public';
  if (wanted !== 'private' && video.status?.privacyStatus === 'private') {
    return { status: 'needs_check', message: `영상이 비공개로 올라갔습니다. ${NOT_AUDITED}`, url: shortsUrl(video.id), id: video.id };
  }
  return { status: 'processing', pollAfterSec: 30 };
}

async function pollVideo(job, ctx, token) {
  const id = job.remote.videoId;
  const res = await ctx.request(`${API}/videos?part=status,processingDetails&id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
    classify: youtubeClassify,
    label: 'YouTube 처리 상태',
  });
  const item = res.json?.items?.[0];
  if (!item) throw invalid('YouTube 에서 영상을 찾을 수 없습니다 (삭제되었을 수 있음)');
  const st = item.status ?? {};
  if (st.uploadStatus === 'rejected') throw invalid(`YouTube 가 영상을 거부했습니다: ${st.rejectionReason ?? ''}`);
  if (st.uploadStatus === 'failed') throw invalid(`YouTube 처리 실패: ${st.failureReason ?? ''}`);
  if (st.uploadStatus === 'deleted') throw invalid('영상이 삭제되었습니다');
  const wanted = ctx.route.privacy ?? 'public';
  if (wanted !== 'private' && st.privacyStatus === 'private') {
    return { status: 'needs_check', message: `영상이 비공개 상태입니다. ${NOT_AUDITED}`, url: shortsUrl(id), id };
  }
  if (st.uploadStatus === 'processed' || item.processingDetails?.processingStatus === 'succeeded') {
    return { status: 'published', url: shortsUrl(id), id };
  }
  return { status: 'processing', pollAfterSec: 30 };
}

export default {
  name: 'youtube',
  label: 'YouTube 직접 연결 (무료, 감사 필요)',
  supports: (channel, kind) => channel === 'youtube' && kind === 'video',
  async check(channel, ctx) {
    const token = await googleAccessToken(ctx);
    const res = await ctx.request(`${API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${token}` }, classify: youtubeClassify, label: 'YouTube 채널 확인' });
    const ch = res.json?.items?.[0];
    if (!ch) return { ok: false, message: '이 Google 계정에 YouTube 채널이 없습니다' };
    const account = `${ch.snippet?.title ?? ch.id}${ch.snippet?.customUrl ? ` (${ch.snippet.customUrl})` : ''}`;
    if (!ctx.route.audited) return { ok: false, account, message: `로그인은 정상입니다. 하지만 ${NOT_AUDITED}` };
    return { ok: true, account };
  },
  async publish(job, ctx) {
    if (!ctx.route.audited) throw invalid(NOT_AUDITED);
    const token = await googleAccessToken(ctx);
    if (!job.remote.uploadUrl) await startSession(job, ctx, token);
    return uploadBytes(job, ctx, token);
  },
  async resume(job, ctx) {
    const token = await googleAccessToken(ctx);
    if (job.remote.videoId) return pollVideo(job, ctx, token);
    if (job.remote.uploadUrl) return uploadBytes(job, ctx, token);
    throw uncertain('이어갈 업로드 기록이 없습니다. YouTube 스튜디오에서 확인해 주세요');
  },
  canResume: (job) => !!(job.remote?.videoId || job.remote?.uploadUrl),
};
