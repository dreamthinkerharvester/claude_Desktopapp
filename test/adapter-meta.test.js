import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import meta, { graphClassify } from '../src/adapters/meta.js';
import { createPost } from '../src/planner.js';
import { formFields, makeJpeg, makeMp4, mockFetch, tempEnv, tickAll } from './helpers.js';

const G = 'https://graph.facebook.com/v26.0';

function setup(channels) {
  const env = tempEnv({
    channels: Object.fromEntries(channels.map((ch) => [ch, { enabled: true, route: 'meta' }])),
    routes: { meta: { appId: 'app', appSecret: 'sec', graphVersion: 'v26.0' } },
  });
  env.store.setToken('meta', { pageId: 'P1', pageName: '법굿집', pageToken: 'PT', igUserId: 'IG1', igUsername: 'lawgoodjib' });
  return env;
}

const add = (env, media, caption = '릴스 소개글') =>
  createPost({ media: [media], caption, gapMinutes: [0, 0] }, { config: env.config, store: env.store, adapters: { meta }, now: env.clock.now() });

test('Instagram 릴스: 컨테이너 → 파일 업로드 → 처리 대기 → 게시 → 주소', async () => {
  const env = setup(['instagram']);
  let polls = 0;
  const fetch = mockFetch([
    { method: 'POST', match: `${G}/IG1/media_publish`, reply: { json: { id: 'M1' } } },
    { method: 'POST', match: `${G}/IG1/media`, reply: { json: { id: 'C1', uri: 'https://rupload.facebook.com/ig-api-upload/v26.0/C1' } } },
    { method: 'POST', match: 'rupload.facebook.com/ig-api-upload/v26.0/C1', reply: { json: { success: true, message: 'Upload successful.' } } },
    { match: `${G}/C1?`, reply: () => ({ json: { status_code: (polls += 1) === 1 ? 'IN_PROGRESS' : 'FINISHED' } }) },
    { match: `${G}/M1?`, reply: { json: { permalink: 'https://www.instagram.com/reel/abc/' } } },
  ]);
  const engine = env.engine({ meta }, { fetchImpl: fetch });
  try {
    const plan = await add(env, env.write('v.mp4', makeMp4()));
    const jobId = `${plan.post.id}.instagram`;
    await tickAll(engine);
    const create = fetch.calls[0];
    assert.equal(create.body.get('media_type'), 'REELS');
    assert.equal(create.body.get('upload_type'), 'resumable');
    assert.equal(create.body.get('share_to_feed'), 'true');
    assert.equal(create.body.get('caption'), '릴스 소개글');
    const upload = fetch.calls[1];
    assert.equal(upload.headers.Authorization, 'OAuth PT');
    assert.equal(upload.headers.offset, '0');
    assert.equal(Number(upload.headers.file_size), env.store.getPost(plan.post.id).media[0].size);
    assert.equal(env.store.getJob(jobId).status, 'processing');

    env.clock.advance(1);
    await tickAll(engine); // IN_PROGRESS
    assert.equal(env.store.getJob(jobId).status, 'processing');
    env.clock.advance(1);
    await tickAll(engine); // FINISHED → 게시
    const job = env.store.getJob(jobId);
    assert.equal(job.status, 'published');
    assert.equal(job.resultUrl, 'https://www.instagram.com/reel/abc/');
    assert.equal(fetch.calls.filter((c) => c.url.includes('media_publish')).length, 1);
  } finally {
    env.cleanup();
  }
});

test('Instagram: 게시 요청 뒤 응답을 못 받아도 컨테이너가 PUBLISHED 면 다시 게시하지 않고 게시물을 찾는다', async () => {
  const env = setup(['instagram']);
  const fetch = mockFetch([
    { method: 'POST', match: `${G}/IG1/media_publish`, reply: () => Object.assign(new Error('timeout'), { name: 'TimeoutError' }) },
    { method: 'POST', match: `${G}/IG1/media`, reply: { json: { id: 'C9', uri: 'https://rupload.facebook.com/ig-api-upload/v26.0/C9' } } },
    { method: 'POST', match: 'rupload.facebook.com', reply: { json: { success: true } } },
    { match: `${G}/C9?`, once: true, reply: { json: { status_code: 'FINISHED' } } },
    { match: `${G}/C9?`, reply: { json: { status_code: 'PUBLISHED' } } },
    { match: `${G}/IG1/media?`, reply: { json: { data: [{ id: 'X', caption: '다른 글' }, { id: 'M9', caption: '릴스 소개글', permalink: 'https://www.instagram.com/reel/m9/' }] } } },
  ]);
  const engine = env.engine({ meta }, { fetchImpl: fetch });
  try {
    const plan = await add(env, env.write('v.mp4', makeMp4()));
    const jobId = `${plan.post.id}.instagram`;
    await tickAll(engine);
    env.clock.advance(1);
    await tickAll(engine); // FINISHED → 게시 요청 시간 초과
    assert.equal(env.store.getJob(jobId).status, 'processing');
    env.clock.advance(2);
    await tickAll(engine); // PUBLISHED → 찾기
    const job = env.store.getJob(jobId);
    assert.equal(job.status, 'published');
    assert.equal(job.resultUrl, 'https://www.instagram.com/reel/m9/');
    assert.equal(fetch.calls.filter((c) => c.url.includes('media_publish')).length, 1, '게시 요청은 한 번뿐');
  } finally {
    env.cleanup();
  }
});

test('Facebook 릴스: start → 업로드 → finish(PUBLISHED) → 상태 완료 → 주소', async () => {
  const env = setup(['facebook']);
  const fetch = mockFetch([
    { method: 'POST', match: `${G}/P1/video_reels`, reply: (call) => (call.body.get('upload_phase') === 'start' ? { json: { video_id: 'V1', upload_url: 'https://rupload.facebook.com/video-upload/v26.0/V1' } } : { json: { success: true } }) },
    { method: 'POST', match: 'rupload.facebook.com/video-upload/v26.0/V1', reply: { json: { success: true } } },
    { match: `${G}/V1?`, reply: { json: { status: { video_status: 'ready', publishing_phase: { status: 'complete' } }, permalink_url: '/reel/V1' } } },
  ]);
  const engine = env.engine({ meta }, { fetchImpl: fetch });
  try {
    const plan = await add(env, env.write('v.mp4', makeMp4()));
    await tickAll(engine);
    const finish = fetch.calls.find((c) => c.body instanceof URLSearchParams && c.body.get('upload_phase') === 'finish');
    assert.equal(finish.body.get('video_state'), 'PUBLISHED');
    assert.equal(finish.body.get('description'), '릴스 소개글');
    assert.equal(finish.body.get('video_id'), 'V1');
    env.clock.advance(1);
    await tickAll(engine);
    const job = env.store.getJob(`${plan.post.id}.facebook`);
    assert.equal(job.status, 'published');
    assert.equal(job.resultUrl, 'https://www.facebook.com/reel/V1');
  } finally {
    env.cleanup();
  }
});

test('Facebook 카드뉴스: 사진을 비공개로 올린 뒤 한 게시물로 묶고, 게시 요청 결과를 모르면 확인 필요', async () => {
  const env = setup(['facebook']);
  let photo = 0;
  const fetch = mockFetch([
    { method: 'POST', match: `${G}/P1/photos`, reply: () => ({ json: { id: `PH${(photo += 1)}` } }) },
    { method: 'POST', match: `${G}/P1/feed`, once: true, reply: { json: { id: 'P1_900' } } },
    { match: `${G}/P1_900?`, reply: { json: { permalink_url: 'https://www.facebook.com/p/900' } } },
    { method: 'POST', match: `${G}/P1/feed`, reply: { status: 500, json: { error: { message: 'An unknown error occurred', code: 1 } } } },
  ]);
  const engine = env.engine({ meta }, { fetchImpl: fetch });
  try {
    env.write('card/1.jpg', makeJpeg());
    env.write('card/2.jpg', makeJpeg(1080, 1080));
    const plan = await add(env, join(env.inbox, 'card'), '카드뉴스 소개');
    await tickAll(engine);
    const photos = fetch.calls.filter((c) => c.url.endsWith('/P1/photos'));
    assert.equal(photos.length, 2);
    const pf = await formFields(photos[0].body);
    assert.deepEqual(pf.published, ['false']);
    const feed = fetch.calls.find((c) => c.url.endsWith('/P1/feed'));
    assert.equal(feed.body.get('message'), '카드뉴스 소개');
    assert.equal(feed.body.get('attached_media[0]'), '{"media_fbid":"PH1"}');
    assert.equal(feed.body.get('attached_media[1]'), '{"media_fbid":"PH2"}');
    const job = env.store.getJob(`${plan.post.id}.facebook`);
    assert.equal(job.status, 'published');
    assert.equal(job.resultUrl, 'https://www.facebook.com/p/900');

    // 두 번째 게시물: 게시 요청이 일시 오류 → 게시됐는지 모름 → 확인 필요 (다시 올리지 않음)
    env.write('card2/1.jpg', makeJpeg(1080, 1350));
    const plan2 = await add(env, join(env.inbox, 'card2'), '두 번째');
    env.clock.advance(61);
    await tickAll(engine);
    const job2 = env.store.getJob(`${plan2.post.id}.facebook`);
    assert.equal(job2.status, 'needs_check');
  } finally {
    env.cleanup();
  }
});

test('Meta 오류 코드 분류', () => {
  const res = (error, status = 400) => ({ status, json: { error }, text: '' });
  assert.equal(graphClassify(res({ code: 190, error_subcode: 463, message: 'expired' })).kind, 'auth');
  assert.equal(graphClassify(res({ code: 4, message: 'Application request limit reached' })).kind, 'rate_limit');
  assert.equal(graphClassify(res({ code: 9, error_subcode: 2207042, message: 'publish limit' })).kind, 'rate_limit');
  assert.equal(graphClassify(res({ code: 352, error_subcode: 2207026, message: 'unsupported video' })).kind, 'invalid');
  assert.equal(graphClassify(res({ code: 2, message: 'Service temporarily unavailable', is_transient: true })).kind, 'transient');
  assert.equal(graphClassify(res({ code: 10, message: 'permission' })).kind, 'auth');
  assert.equal(graphClassify({ status: 500, json: undefined, text: 'oops' }), undefined);
});

test('Instagram 은 이 경로로 카드뉴스를 올리지 않는다 (공개 URL 필요) → 안내', async () => {
  const env = setup(['instagram']);
  try {
    env.write('card/1.jpg', makeJpeg());
    await assert.rejects(
      createPost({ media: [join(env.inbox, 'card')], channels: ['instagram'] }, { config: env.config, store: env.store, adapters: { meta }, now: env.clock.now() }),
      /imagesRoute/,
    );
  } finally {
    env.cleanup();
  }
});
