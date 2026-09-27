// 코드 검토에서 찾은 문제들이 다시 생기지 않도록 확인하는 테스트
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import meta from '../src/adapters/meta.js';
import uploadpost, { platformError } from '../src/adapters/uploadpost.js';
import youtube from '../src/adapters/youtube.js';
import { request } from '../src/http.js';
import { createPost } from '../src/planner.js';
import { acquireLock } from '../src/system.js';
import { parseDateTime } from '../src/util/time.js';
import { fakeAdapter, makeMp4, mockFetch, tempEnv, tickAll } from './helpers.js';

const UP = 'https://api.upload-post.com/api';

function upEnv(channels = ['x']) {
  return tempEnv({
    channels: Object.fromEntries(channels.map((ch) => [ch, { enabled: true, route: 'uploadpost' }])),
    routes: { uploadpost: { apiKey: 'KEY', user: 'me' } },
  });
}
const addVideo = (env, adapters, extra = {}) =>
  createPost({ media: [env.write('v.mp4', makeMp4())], caption: '소개글', gapMinutes: [0, 0], ...extra }, { config: env.config, store: env.store, adapters, now: env.clock.now(), rng: () => 0 });

test('Upload-Post: 응답을 못 받고 24시간이 지나면 다시 보내지 않는다 (중복 방지 키 만료)', async () => {
  const env = upEnv();
  let posts = 0;
  const fetch = mockFetch([
    {
      method: 'POST',
      match: `${UP}/upload`,
      reply: () => {
        posts += 1;
        return Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET', syscall: 'write' } });
      },
    },
  ]);
  const engine = env.engine({ uploadpost }, { fetchImpl: fetch });
  try {
    const plan = await addVideo(env, { uploadpost });
    const jobId = `${plan.post.id}.x`;
    await tickAll(engine);
    assert.equal(env.store.getJob(jobId).status, 'processing');
    // 사람이 하루 넘게 확인하지 않다가 "상태 다시 확인"
    env.store.transition(jobId, ['processing'], { status: 'needs_check' });
    env.clock.advance(25 * 60);
    engine.recheck(jobId);
    await tickAll(engine);
    const job = env.store.getJob(jobId);
    assert.equal(job.status, 'needs_check');
    assert.match(job.lastError, /24시간/);
    assert.equal(posts, 1, '다시 보내지 않음');
  } finally {
    env.cleanup();
  }
});

test('Upload-Post: 즉시 성공 응답에 주소가 없어도 다시 보내지 않고 완료로 둔다', async () => {
  const env = upEnv();
  const fetch = mockFetch([{ method: 'POST', match: `${UP}/upload`, reply: { json: { success: true, results: { x: { success: true } } } } }]);
  const engine = env.engine({ uploadpost }, { fetchImpl: fetch });
  try {
    const plan = await addVideo(env, { uploadpost });
    await tickAll(engine);
    env.clock.advance(10);
    await tickAll(engine);
    const job = env.store.getJob(`${plan.post.id}.x`);
    assert.equal(job.status, 'published');
    assert.match(job.lastError, /주소를 아직 받지 못했습니다/);
    assert.equal(fetch.calls.filter((c) => c.method === 'POST').length, 1);
  } finally {
    env.cleanup();
  }
});

test('Upload-Post: 작업을 못 찾으면(404) 실패가 아니라 확인 필요', async () => {
  const env = upEnv();
  const fetch = mockFetch([
    { method: 'POST', match: `${UP}/upload`, reply: { json: { success: true, request_id: 'gone' } } },
    { match: 'status?request_id=gone', reply: { status: 404, json: { success: false, status: 'not_found' } } },
  ]);
  const engine = env.engine({ uploadpost }, { fetchImpl: fetch });
  try {
    const plan = await addVideo(env, { uploadpost });
    await tickAll(engine);
    env.clock.advance(1);
    await tickAll(engine);
    assert.equal(env.store.getJob(`${plan.post.id}.x`).status, 'needs_check');
  } finally {
    env.cleanup();
  }
});

test('Upload-Post: TikTok 이 초안함으로 넘어가면 게시 완료로 치지 않는다', async () => {
  const env = upEnv(['tiktok']);
  const fetch = mockFetch([
    { method: 'POST', match: `${UP}/upload`, reply: { json: { success: true, request_id: 'r' } } },
    { match: 'status?request_id=r', reply: { json: { status: 'completed', results: [{ platform: 'tiktok', success: true, fallback_to_inbox: true, publish_id: 'v_inbox_file~1' }] } } },
  ]);
  const engine = env.engine({ uploadpost }, { fetchImpl: fetch });
  try {
    const plan = await addVideo(env, { uploadpost });
    await tickAll(engine);
    env.clock.advance(1);
    await tickAll(engine);
    const job = env.store.getJob(`${plan.post.id}.tiktok`);
    assert.equal(job.status, 'needs_check');
    assert.match(job.lastError, /초안함/);
  } finally {
    env.cleanup();
  }
});

test('오류 문구 해석: "Caption" 을 한도 초과로 오해하지 않는다', () => {
  assert.equal(platformError('Caption exceeds 2200 characters').kind, 'invalid');
  assert.equal(platformError('TikTok daily cap reached').kind, 'rate_limit');
  assert.equal(platformError('Rate limit exceeded').kind, 'rate_limit');
  assert.equal(platformError('Access token expired, please reconnect').kind, 'auth');
});

test('잠금 파일: 재부팅 뒤 다른 프로그램이 같은 PID 를 쓰면 남은 잠금으로 보고 무시한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snspub-lock-'));
  const other = spawn('sleep', ['30']);
  const fakeSnspub = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'snspub-test-holder']);
  try {
    writeFileSync(join(dir, 'snspub.lock'), String(other.pid));
    const release = acquireLock(dir);
    release();
    writeFileSync(join(dir, 'snspub.lock'), String(fakeSnspub.pid));
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => acquireLock(dir), /이미 실행 중/);
  } finally {
    other.kill();
    fakeSnspub.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('네이버 카페({links})는 앞 채널이 처리 중이면 기다렸다가 링크를 넣어 올린다', async () => {
  const env = tempEnv({ channels: { youtube: { enabled: true, route: 'fake' }, naver_cafe: { enabled: true, route: 'fake' } } });
  let ytPolls = 0;
  const fake = fakeAdapter({
    publish: (job, ctx) => {
      if (job.channel === 'youtube') {
        ctx.checkpoint({ videoId: 'v1' });
        return { status: 'processing', pollAfterSec: 60 };
      }
      return { status: 'published', url: 'https://cafe.naver.com/a/1' };
    },
    resume: () => ((ytPolls += 1) < 3 ? { status: 'processing', pollAfterSec: 60 } : { status: 'published', url: 'https://www.youtube.com/shorts/v1' }),
    canResume: (job) => !!job.remote?.videoId,
  });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const plan = await addVideo(env, adapters, { times: { youtube: '2026-09-28 12:00', naver_cafe: '2026-09-28 12:00' } });
    for (let i = 0; i < 6; i += 1) {
      await tickAll(engine);
      env.clock.advance(2);
    }
    const cafe = fake.calls.find((c) => c[0] === 'publish' && c[1] === 'naver_cafe');
    assert.ok(cafe, '결국 올라감');
    assert.match(cafe[2].options.caption, /youtube\.com\/shorts\/v1/);
    assert.equal(env.store.getPost(plan.post.id).status, 'done');
  } finally {
    env.cleanup();
  }
});

test('같은 원본을 쓰는 다른 발행이 남아 있으면 보관 폴더로 옮기지 않는다', async () => {
  const env = tempEnv({ channels: { youtube: { enabled: true, route: 'fake' }, instagram: { enabled: true, route: 'fake' } } });
  const fake = fakeAdapter();
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const path = env.write('shared.mp4', makeMp4());
    const deps = { config: env.config, store: env.store, adapters, now: env.clock.now() };
    const a = await createPost({ media: [path], channels: ['youtube'] }, deps);
    const b = await createPost({ media: [path], channels: ['instagram'], times: { instagram: '2026-09-28 18:00' } }, deps);
    await tickAll(engine);
    assert.equal(env.store.getPost(a.post.id).status, 'done');
    assert.equal(env.store.getPost(a.post.id).media[0].path, path, 'B 가 아직 써야 하므로 그대로');
    env.clock.advance(6 * 60);
    await tickAll(engine);
    assert.equal(env.store.getJob(`${b.post.id}.instagram`).status, 'published');
    assert.notEqual(env.store.getPost(b.post.id).media[0].path, path, '마지막 발행이 끝나면 옮김');
  } finally {
    env.cleanup();
  }
});

test('처리 중에 멈춘 작업도 취소하거나 게시됨으로 표시할 수 있다', async () => {
  const env = tempEnv({ channels: { youtube: { enabled: true, route: 'fake' }, x: { enabled: true, route: 'fake' } } });
  const fake = fakeAdapter({
    publish: (job, ctx) => {
      ctx.checkpoint({ id: 1 });
      return { status: 'processing' };
    },
    resume: () => ({ status: 'processing' }),
    canResume: () => true,
  });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const plan = await addVideo(env, adapters, { times: { youtube: '2026-09-28 12:00', x: '2026-09-28 12:00' } });
    await tickAll(engine);
    engine.cancel(`${plan.post.id}.youtube`);
    engine.markDone(`${plan.post.id}.x`, 'https://x.com/1');
    assert.equal(env.store.getPost(plan.post.id).status, 'done');
  } finally {
    env.cleanup();
  }
});

test('Instagram: 게시 요청이 오류를 돌려줘도 실제로 게시됐으면 완료, 불분명하면 확인 필요', async () => {
  for (const [after, expected] of [
    ['PUBLISHED', 'published'],
    ['FINISHED', 'needs_check'],
  ]) {
    const env = tempEnv({ channels: { instagram: { enabled: true, route: 'meta' } }, routes: { meta: { graphVersion: 'v26.0' } } });
    env.store.setToken('meta', { pageId: 'P', pageToken: 'PT', igUserId: 'IG' });
    let statusReads = 0;
    const fetch = mockFetch([
      { method: 'POST', match: '/IG/media_publish', reply: { status: 403, json: { error: { code: 368, message: 'blocked', error_subcode: 2207051 } } } },
      { method: 'POST', match: '/IG/media', reply: { json: { id: 'C', uri: 'https://rupload.facebook.com/ig-api-upload/v26.0/C' } } },
      { method: 'POST', match: 'rupload.facebook.com', reply: { json: { success: true } } },
      { match: '/C?', reply: () => ({ json: { status_code: (statusReads += 1) === 1 ? 'FINISHED' : after } }) },
      { match: '/IG/media?', reply: { json: { data: [{ id: 'M', caption: '소개글', permalink: 'https://instagram.com/reel/m' }] } } },
    ]);
    const engine = env.engine({ meta }, { fetchImpl: fetch });
    try {
      const plan = await addVideo(env, { meta });
      await tickAll(engine);
      env.clock.advance(1);
      await tickAll(engine);
      assert.equal(env.store.getJob(`${plan.post.id}.instagram`).status, expected, `컨테이너 ${after}`);
    } finally {
      env.cleanup();
    }
  }
});

test('YouTube: 올린 직후 목록에 아직 없으면 실패가 아니라 계속 기다린다', async () => {
  const env = tempEnv({ channels: { youtube: { enabled: true, route: 'youtube' } }, routes: { youtube: { audited: true } } });
  env.store.setToken('google', { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3600_000 });
  const fetch = mockFetch([
    { method: 'POST', match: 'uploadType=resumable', reply: { headers: { location: 'https://up/S' } } },
    { method: 'PUT', match: 'https://up/S', reply: { status: 201, json: { id: 'V', status: { privacyStatus: 'public' } } } },
    { match: 'youtube/v3/videos?part=status', once: true, reply: { json: { items: [] } } },
    { match: 'youtube/v3/videos?part=status', reply: { json: { items: [{ id: 'V', status: { uploadStatus: 'processed', privacyStatus: 'public' } }] } } },
  ]);
  const engine = env.engine({ youtube }, { fetchImpl: fetch });
  try {
    const plan = await addVideo(env, { youtube }, { title: '제목' });
    await tickAll(engine);
    env.clock.advance(1);
    await tickAll(engine);
    assert.equal(env.store.getJob(`${plan.post.id}.youtube`).status, 'processing');
    env.clock.advance(2);
    await tickAll(engine);
    assert.equal(env.store.getJob(`${plan.post.id}.youtube`).status, 'published');
  } finally {
    env.cleanup();
  }
});

test('네트워크 끊김: 연결 중이면 재시도, 보내는 도중이면 결과 불확실', async () => {
  const failing = (syscall) => async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH', syscall } });
  };
  await assert.rejects(request('https://a.example/x', { method: 'POST', idempotent: false, fetchImpl: failing('connect') }), (e) => e.kind === 'transient');
  await assert.rejects(request('https://a.example/x', { method: 'POST', idempotent: false, fetchImpl: failing('write') }), (e) => e.kind === 'uncertain');
  await assert.rejects(request('https://a.example/x', { method: 'POST', idempotent: false, fetchImpl: failing(undefined) }), (e) => e.kind === 'uncertain');
});

test('없는 날짜(2월 30일)는 다음 달로 넘기지 않고 오류', () => {
  assert.throws(() => parseDateTime('2026-02-30 10:00', 'Asia/Seoul'), /없는 날짜/);
  assert.equal(parseDateTime('2028-02-29 10:00', 'Asia/Seoul').toISOString(), '2028-02-29T01:00:00.000Z');
});
