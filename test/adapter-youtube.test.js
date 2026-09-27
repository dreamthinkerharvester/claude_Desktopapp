import assert from 'node:assert/strict';
import { test } from 'node:test';
import youtube from '../src/adapters/youtube.js';
import { createPost } from '../src/planner.js';
import { makeMp4, mockFetch, tempEnv, tickAll } from './helpers.js';

const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=S1';

function setup({ audited = true } = {}) {
  const env = tempEnv({
    channels: { youtube: { enabled: true, route: 'youtube' } },
    routes: { youtube: { clientId: 'cid', clientSecret: 'sec', audited, privacy: 'public', categoryId: '27' } },
    extra: { aiGenerated: true },
  });
  env.store.setToken('google', { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3600_000 });
  return env;
}

async function add(env) {
  const path = env.write('v.mp4', makeMp4({ filler: 'x'.repeat(1000) }));
  return createPost({ media: [path], title: '전세금 3단계', caption: '설명', hashtags: '#전세금 #임차권등기' }, { config: env.config, store: env.store, adapters: { youtube }, now: env.clock.now() });
}

test('감사(audit) 전이면 올리지 않는다 (비공개로 잠기는 것을 막음)', async () => {
  const env = setup({ audited: false });
  const fetch = mockFetch([]);
  const engine = env.engine({ youtube }, { fetchImpl: fetch });
  try {
    const plan = await add(env);
    await tickAll(engine);
    const job = env.store.getJob(`${plan.post.id}.youtube`);
    assert.equal(job.status, 'failed');
    assert.match(job.lastError, /audit/);
    assert.equal(fetch.calls.length, 0);
  } finally {
    env.cleanup();
  }
});

test('이어올리기: 세션 → 업로드 중 끊김 → 받은 바이트 확인 → 나머지만 전송 → 처리 완료', async () => {
  const env = setup();
  let puts = 0;
  const fetch = mockFetch([
    { method: 'POST', match: 'upload/youtube/v3/videos?uploadType=resumable', reply: { status: 200, headers: { location: SESSION } } },
    {
      method: 'PUT',
      match: 'upload_id=S1',
      reply: (call) => {
        puts += 1;
        if (puts === 1) return Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } });
        if (call.headers['Content-Range']?.startsWith('bytes */')) return { status: 308, headers: { range: 'bytes=0-99' } };
        return { status: 201, json: { id: 'vid1', status: { privacyStatus: 'public', uploadStatus: 'uploaded' } } };
      },
    },
    { match: '/youtube/v3/videos?part=status', reply: { json: { items: [{ id: 'vid1', status: { uploadStatus: 'processed', privacyStatus: 'public' } }] } } },
  ]);
  const engine = env.engine({ youtube }, { fetchImpl: fetch });
  try {
    const plan = await add(env);
    const jobId = `${plan.post.id}.youtube`;
    await tickAll(engine);
    const start = fetch.calls[0];
    assert.equal(start.headers.Authorization, 'Bearer AT');
    assert.equal(start.headers['X-Upload-Content-Type'], 'video/mp4');
    const meta = JSON.parse(start.body);
    assert.equal(meta.snippet.title, '전세금 3단계');
    assert.equal(meta.snippet.categoryId, '27');
    assert.deepEqual(meta.snippet.tags, ['전세금', '임차권등기']);
    assert.equal(meta.status.privacyStatus, 'public');
    assert.equal(meta.status.containsSyntheticMedia, true);
    assert.equal(meta.status.selfDeclaredMadeForKids, false);

    let job = env.store.getJob(jobId);
    assert.equal(job.status, 'processing', '끊겨도 세션이 남아 있으니 이어서 올림');
    assert.equal(job.remote.uploadUrl, SESSION);

    env.clock.advance(1);
    await tickAll(engine);
    const probe = fetch.calls.find((c) => c.headers['Content-Range']?.startsWith('bytes */'));
    assert.ok(probe, '받은 바이트를 먼저 확인');
    assert.equal(probe.redirect, 'manual');
    const size = env.store.getPost(plan.post.id).media[0].size;
    const rest = fetch.calls.filter((c) => c.method === 'PUT').at(-1);
    assert.equal(rest.headers['Content-Range'], `bytes 100-${size - 1}/${size}`);
    assert.equal(rest.body.size, size - 100);
    job = env.store.getJob(jobId);
    assert.equal(job.remote.videoId, 'vid1');
    assert.equal(job.status, 'processing');

    env.clock.advance(1);
    await tickAll(engine);
    job = env.store.getJob(jobId);
    assert.equal(job.status, 'published');
    assert.equal(job.resultUrl, 'https://www.youtube.com/shorts/vid1');
  } finally {
    env.cleanup();
  }
});

test('비공개로 잠겨 올라가면 확인 필요로 알린다', async () => {
  const env = setup();
  const fetch = mockFetch([
    { method: 'POST', match: 'uploadType=resumable', reply: { headers: { location: SESSION } } },
    { method: 'PUT', match: 'upload_id=S1', reply: { status: 200, json: { id: 'v2', status: { privacyStatus: 'private' } } } },
  ]);
  const engine = env.engine({ youtube }, { fetchImpl: fetch });
  try {
    const plan = await add(env);
    await tickAll(engine);
    const job = env.store.getJob(`${plan.post.id}.youtube`);
    assert.equal(job.status, 'needs_check');
    assert.match(job.lastError, /비공개/);
    assert.equal(job.resultUrl, 'https://www.youtube.com/shorts/v2');
  } finally {
    env.cleanup();
  }
});

test('토큰이 만료되면 refresh token 으로 갱신하고, 갱신이 거절되면 채널을 보류한다', async () => {
  const env = setup();
  env.store.setToken('google', { accessToken: 'OLD', refreshToken: 'RT', expiresAt: Date.now() - 1000 });
  const fetch = mockFetch([
    { method: 'POST', match: 'oauth2.googleapis.com/token', once: true, reply: { json: { access_token: 'NEW', expires_in: 3599 } } },
    { match: 'youtube/v3/channels', reply: { json: { items: [{ id: 'UC1', snippet: { title: '드림하베스터', customUrl: '@dream_harvester' } }] } } },
    { method: 'POST', match: 'oauth2.googleapis.com/token', reply: { status: 400, json: { error: 'invalid_grant' } } },
  ]);
  const engine = env.engine({ youtube }, { fetchImpl: fetch });
  try {
    const ok = await engine.checkChannel('youtube');
    assert.equal(ok.ok, true, ok.message);
    assert.equal(ok.account, '드림하베스터 (@dream_harvester)');
    assert.equal(env.store.getToken('google').accessToken, 'NEW');
    assert.equal(env.store.getToken('google').refreshToken, 'RT', '새 refresh token 이 없으면 기존 것 유지');
    const body = fetch.calls[0].body;
    assert.equal(body.get('grant_type'), 'refresh_token');

    env.store.setToken('google', { accessToken: 'OLD', refreshToken: 'RT', expiresAt: 0 });
    const bad = await engine.checkChannel('youtube');
    assert.equal(bad.ok, false);
    assert.match(bad.message, /다시 로그인/);
  } finally {
    env.cleanup();
  }
});
