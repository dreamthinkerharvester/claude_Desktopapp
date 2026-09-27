import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import uploadpost from '../src/adapters/uploadpost.js';
import { createPost } from '../src/planner.js';
import { formFields, makeJpeg, makeMp4, mockFetch, tempEnv, tickAll } from './helpers.js';

const BASE = 'https://api.upload-post.com/api';

function setup(channels, extra = {}) {
  const env = tempEnv({
    channels: Object.fromEntries(channels.map((ch) => [ch, { enabled: true, route: 'uploadpost' }])),
    routes: { uploadpost: { apiKey: 'KEY', user: 'harvester', facebookPageId: '123' } },
    extra: { aiGenerated: true, ...extra },
  });
  return env;
}

async function add(env, input) {
  const path = input.media ?? env.write('v.mp4', makeMp4());
  return createPost({ media: [path], caption: '소개글', hashtags: '#전세금 #법률', gapMinutes: [0, 0], ...input, media: [path] }, { config: env.config, store: env.store, adapters: { uploadpost }, now: env.clock.now(), rng: () => 0 });
}

test('YouTube: 로컬 영상을 multipart 로 보내고(Idempotency-Key) 상태 조회로 완료를 확인한다', async () => {
  const env = setup(['youtube']);
  const fetch = mockFetch([
    { method: 'POST', match: `${BASE}/upload`, reply: { json: { success: true, request_id: 'req-1', total_platforms: 1 } } },
    { match: 'status?request_id=req-1', once: true, reply: { json: { status: 'in_progress', results: [] } } },
    { match: 'status?request_id=req-1', reply: { json: { status: 'completed', results: [{ platform: 'youtube', success: true, url: 'https://www.youtube.com/shorts/abc' }] } } },
  ]);
  const engine = env.engine({ uploadpost }, { fetchImpl: fetch });
  try {
    const plan = await add(env, { title: '전세금 3단계' });
    const jobId = `${plan.post.id}.youtube`;
    await tickAll(engine);
    const sent = fetch.calls[0];
    assert.equal(sent.headers.Authorization, 'Apikey KEY');
    assert.ok(sent.headers['Idempotency-Key']);
    const f = await formFields(sent.body);
    assert.deepEqual(f.user, ['harvester']);
    assert.deepEqual(f['platform[]'], ['youtube']);
    assert.deepEqual(f.title, ['전세금 3단계']);
    assert.deepEqual(f.description, ['소개글\n\n#전세금 #법률']);
    assert.deepEqual(f.privacyStatus, ['public']);
    assert.deepEqual(f['tags[]'], ['전세금', '법률']);
    assert.deepEqual(f.containsSyntheticMedia, ['true']);
    assert.deepEqual(f.async_upload, ['true']);
    assert.equal(f.video[0].type, 'video/mp4');
    assert.equal(env.store.getJob(jobId).status, 'processing');

    env.clock.advance(1);
    await tickAll(engine);
    assert.equal(env.store.getJob(jobId).status, 'processing');
    env.clock.advance(1);
    await tickAll(engine);
    const job = env.store.getJob(jobId);
    assert.equal(job.status, 'published');
    assert.equal(job.resultUrl, 'https://www.youtube.com/shorts/abc');
  } finally {
    env.cleanup();
  }
});

test('TikTok: 공개 범위·AI 표시·초안 전환 방지를 보내고, 주소는 기록에서 찾는다', async () => {
  const env = setup(['tiktok']);
  const fetch = mockFetch([
    { method: 'POST', match: `${BASE}/upload`, reply: { json: { success: true, request_id: 'r2' } } },
    { match: 'status?request_id=r2', reply: { json: { status: 'completed', results: [{ platform: 'tiktok', success: true }] } } },
    { match: 'uploadposts/history', reply: { json: { history: [{ platform: 'tiktok', request_id: 'r2', success: true, post_url: 'https://www.tiktok.com/@me/video/1' }] } } },
  ]);
  const engine = env.engine({ uploadpost }, { fetchImpl: fetch });
  try {
    const plan = await add(env, {});
    await tickAll(engine);
    const f = await formFields(fetch.calls[0].body);
    assert.deepEqual(f.privacy_level, ['PUBLIC_TO_EVERYONE']);
    assert.deepEqual(f.is_aigc, ['true']);
    assert.deepEqual(f.disable_inbox_fallback, ['true']);
    assert.deepEqual(f.title, ['소개글\n\n#전세금 #법률']);
    env.clock.advance(1);
    await tickAll(engine);
    const job = env.store.getJob(`${plan.post.id}.tiktok`);
    assert.equal(job.status, 'published');
    assert.equal(job.resultUrl, 'https://www.tiktok.com/@me/video/1');
  } finally {
    env.cleanup();
  }
});

test('Instagram 카드뉴스: upload_photos 로 여러 장을 보낸다', async () => {
  const env = setup(['instagram', 'facebook']);
  const fetch = mockFetch([
    { method: 'POST', match: `${BASE}/upload_photos`, reply: { json: { success: true, request_id: 'r3' } } },
    { match: 'status?request_id=r3', reply: { json: { status: 'completed', results: [{ platform: 'instagram', success: true, url: 'https://instagram.com/p/1' }, { platform: 'facebook', success: true, url: 'https://facebook.com/1' }] } } },
  ]);
  const engine = env.engine({ uploadpost }, { fetchImpl: fetch });
  try {
    env.write('card/1.jpg', makeJpeg());
    env.write('card/2.jpg', makeJpeg(1080, 1350));
    await add(env, { media: join(env.inbox, 'card') });
    await tickAll(engine);
    const ig = await formFields(fetch.calls.find((c) => c.url.endsWith('/upload_photos')).body);
    assert.equal(ig['photos[]'].length, 2);
    assert.deepEqual(ig.media_type, ['IMAGE']);
  } finally {
    env.cleanup();
  }
});

test('API 키 오류(401)는 채널을 보류시키고, 서버 오류 뒤 재전송은 같은 Idempotency-Key 를 쓴다', async () => {
  const env = setup(['x', 'threads']);
  let xSends = 0;
  const fetch = mockFetch([
    {
      method: 'POST',
      match: `${BASE}/upload`,
      reply: (call) => {
        const platform = call.body.get('platform[]');
        if (platform === 'threads') return { status: 401, json: { success: false, message: 'Invalid API key' } };
        xSends += 1;
        return xSends === 1 ? { status: 502, text: 'Bad Gateway' } : { json: { success: true, request_id: 'r4' } };
      },
    },
    { match: 'uploadposts/history', reply: { json: { history: [] } } },
    { match: 'status?request_id=r4', reply: { json: { status: 'completed', results: [{ platform: 'x', success: true, url: 'https://x.com/i/1' }] } } },
  ]);
  const engine = env.engine({ uploadpost }, { fetchImpl: fetch });
  try {
    const plan = await add(env, {});
    await tickAll(engine);
    const x = () => env.store.getJob(`${plan.post.id}.x`);
    const threads = env.store.getJob(`${plan.post.id}.threads`);
    assert.equal(threads.errorKind, 'auth');
    assert.equal(env.store.getChannelState('threads').blocked, true);

    assert.equal(x().status, 'processing', 'Idempotency-Key 가 있어 다시 보내도 안전 → 이어서 처리');
    const firstKey = fetch.calls.find((c) => c.url === `${BASE}/upload` && c.body.get('platform[]') === 'x').headers['Idempotency-Key'];
    env.clock.advance(1);
    await tickAll(engine);
    const xCalls = fetch.calls.filter((c) => c.url === `${BASE}/upload` && c.body.get('platform[]') === 'x');
    assert.equal(xCalls.length, 2);
    assert.equal(xCalls[1].headers['Idempotency-Key'], firstKey);
    env.clock.advance(1);
    await tickAll(engine);
    assert.equal(x().status, 'published');
  } finally {
    env.cleanup();
  }
});

test('플랫폼이 실패를 알리면 실패로 두고 이유를 보여 준다', async () => {
  const env = setup(['facebook']);
  const fetch = mockFetch([
    { method: 'POST', match: `${BASE}/upload`, reply: { json: { success: true, request_id: 'r5' } } },
    { match: 'status?request_id=r5', reply: { json: { status: 'failed', results: [{ platform: 'facebook', success: false, message: 'Video duration exceeds 90 seconds' }] } } },
  ]);
  const engine = env.engine({ uploadpost }, { fetchImpl: fetch });
  try {
    const plan = await add(env, {});
    await tickAll(engine);
    env.clock.advance(1);
    await tickAll(engine);
    const job = env.store.getJob(`${plan.post.id}.facebook`);
    assert.equal(job.status, 'failed');
    assert.match(job.lastError, /90 seconds/);
    const f = await formFields(fetch.calls[0].body);
    assert.deepEqual(f.facebook_page_id, ['123']);
    assert.deepEqual(f.facebook_media_type, ['REELS']);
  } finally {
    env.cleanup();
  }
});

test('연결 확인: 프로필과 채널 계정 연결 여부', async () => {
  const env = setup(['instagram', 'tiktok', 'x', 'threads']);
  const fetch = mockFetch([
    {
      match: 'uploadposts/users',
      reply: { json: { success: true, profiles: [{ username: 'harvester', social_accounts: { instagram: { display_name: 'lawgoodjib' }, tiktok: '', twitter: { username: 'lawgoodzip' } } }] } },
    },
  ]);
  const engine = env.engine({ uploadpost }, { fetchImpl: fetch });
  try {
    const ig = await engine.checkChannel('instagram');
    assert.equal(ig.ok, true);
    assert.match(ig.account, /lawgoodjib/);
    const tt = await engine.checkChannel('tiktok');
    assert.equal(tt.ok, false);
    assert.match(tt.message, /연결되어 있지 않습니다/);
    const x = await engine.checkChannel('x');
    assert.equal(x.ok, true);
    assert.match(x.account, /lawgoodzip/);
    const threads = await engine.checkChannel('threads');
    assert.equal(threads.ok, true, '형식을 모르는 경우는 막지 않음');
    assert.match(threads.message, /Upload-Post 화면에서 확인/);
  } finally {
    env.cleanup();
  }
});
