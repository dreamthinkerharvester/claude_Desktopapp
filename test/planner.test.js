import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import uploadpost from '../src/adapters/uploadpost.js';
import { createPost, planPost } from '../src/planner.js';
import { fakeAdapter, makeMp4, makePng, tempEnv } from './helpers.js';

const deps = (env, adapters, extra = {}) => ({ config: env.config, store: env.store, adapters, now: env.clock.now(), rng: () => 0.5, ...extra });

test('채널 순서대로 시각을 나누고(간격 무작위) 채널별 문구를 만든다', async () => {
  const env = tempEnv();
  try {
    const video = env.write('통화형_KK-C1.mp4', makeMp4());
    const plan = await planPost({ media: [video], caption: '소개글', hashtags: '#a #b #c #d', at: '2026-09-28 12:50', gapMinutes: [25, 40] }, deps(env, { fake: fakeAdapter() }));
    assert.equal(plan.ok, true, plan.errors.join());
    assert.equal(plan.post.title, '통화형_KK-C1');
    assert.deepEqual(plan.jobs.map((j) => [j.channel, j.runAtLocal]), [
      ['youtube', '2026-09-28 12:50'],
      ['instagram', '2026-09-28 13:23'],
      ['x', '2026-09-28 13:56'],
    ]);
    assert.equal(plan.jobs[2].options.caption, '소개글\n#a #b');
    assert.equal(plan.jobs[0].options.caption, '소개글\n\n#a #b #c');
    assert.equal(plan.jobs[0].id, `${plan.post.id}.youtube`);
  } finally {
    env.cleanup();
  }
});

test('카드뉴스: 이미지를 못 올리는 채널은 빼고(기본), 직접 고른 경우엔 오류', async () => {
  const env = tempEnv();
  try {
    env.write('card/1.png', makePng());
    env.write('card/2.png', makePng(1080, 1350, 'x'));
    const folder = join(env.inbox, 'card');
    const auto = await planPost({ media: [folder] }, deps(env, { fake: fakeAdapter() }));
    assert.equal(auto.ok, true);
    assert.deepEqual(auto.jobs.map((j) => j.channel), ['instagram', 'x']);
    assert.match(auto.warnings.join(), /YouTube 쇼츠: 이미지 게시가 없는 채널입니다 — 이번 발행에서 제외/);

    const explicit = await planPost({ media: [folder], channels: ['youtube', 'x'] }, deps(env, { fake: fakeAdapter() }));
    assert.equal(explicit.ok, false);
    assert.match(explicit.errors.join(), /YouTube 쇼츠: 이미지 게시가 없는 채널입니다/);

    const noRoute = await planPost({ media: [folder], channels: ['x'] }, deps(env, { fake: fakeAdapter({ supports: (ch, kind) => kind === 'video' }) }));
    assert.match(noRoute.errors.join(), /X: 현재 게시 경로\(fake\)로는 이미지/);
  } finally {
    env.cleanup();
  }
});

test('imagesRoute: 카드뉴스만 다른 경로로 보낸다', async () => {
  const env = tempEnv({ channels: { instagram: { enabled: true, route: 'fake', imagesRoute: 'other' } } });
  try {
    env.write('card/1.jpg', makePng());
    const onlyVideo = fakeAdapter({ supports: (ch, kind) => kind === 'video' });
    const plan = await planPost({ media: [join(env.inbox, 'card')] }, deps(env, { fake: onlyVideo, other: fakeAdapter() }));
    assert.equal(plan.ok, true, plan.errors.join());
    assert.equal(plan.jobs[0].route, 'other');
  } finally {
    env.cleanup();
  }
});

test('같은 파일을 같은 채널에 두 번 등록하지 않는다 (필요하면 allowDuplicate)', async () => {
  const env = tempEnv({ channels: { x: { enabled: true, route: 'fake' } } });
  const adapters = { fake: fakeAdapter() };
  try {
    const video = env.write('v.mp4', makeMp4());
    await createPost({ media: [video] }, deps(env, adapters));
    await assert.rejects(createPost({ media: [video] }, deps(env, adapters)), /이미 등록되어/);
    const again = await createPost({ media: [video], allowDuplicate: true }, deps(env, adapters));
    assert.equal(again.ok, true);
  } finally {
    env.cleanup();
  }
});

test('지난 시각·너무 긴 X 문구·채널별 직접 수정·채널별 시각 지정', async () => {
  const env = tempEnv();
  const adapters = { fake: fakeAdapter() };
  try {
    const video = env.write('v.mp4', makeMp4());
    const past = await planPost({ media: [video], at: '2026-09-27 09:00' }, deps(env, adapters));
    assert.match(past.errors.join(), /이미 지났습니다/);

    const long = await planPost({ media: [video], caption: '가'.repeat(150) }, deps(env, adapters));
    assert.equal(long.ok, false);
    assert.match(long.channelNotes.x.errors.join(), /너무 깁니다/);

    const fixed = await planPost(
      { media: [video], caption: '가'.repeat(150), overrides: { x: { text: '짧은 X 버전' } }, times: { x: '2026-09-28 20:00' } },
      deps(env, adapters),
    );
    assert.equal(fixed.ok, true, fixed.errors.join());
    const x = fixed.jobs.find((j) => j.channel === 'x');
    assert.equal(x.options.caption, '짧은 X 버전');
    assert.equal(x.runAtLocal, '2026-09-28 20:00');
  } finally {
    env.cleanup();
  }
});

test('영상 길이 제한: X 는 140초, YouTube 쇼츠는 3분', async () => {
  const env = tempEnv();
  try {
    const video = env.write('long.mp4', makeMp4({ durationMs: 150_000 }));
    const plan = await planPost({ media: [video] }, deps(env, { fake: fakeAdapter() }));
    assert.match(plan.channelNotes.x.errors.join(), /140초/);
    assert.equal(plan.channelNotes.youtube.errors.length, 0);
  } finally {
    env.cleanup();
  }
});

test('채널이 받는 장수보다 많으면 앞장만 보낸다 (X 는 4장)', async () => {
  const env = tempEnv({ channels: { x: { enabled: true, route: 'fake' }, instagram: { enabled: true, route: 'fake' } } });
  const fake = fakeAdapter();
  const adapters = { fake };
  try {
    for (let i = 1; i <= 6; i += 1) env.write(`card/${i}.png`, makePng(1080, 1350, String(i)));
    const plan = await createPost({ media: [join(env.inbox, 'card')], gapMinutes: [0, 0] }, deps(env, adapters, { rng: () => 0 }));
    assert.equal(plan.ok, true, plan.errors.join());
    assert.match(plan.channelNotes.x.warnings.join(), /앞 4장만/);
    const engine = env.engine(adapters);
    const { promises } = await engine.tick();
    await Promise.all(promises);
    const sent = Object.fromEntries(fake.calls.filter((c) => c[0] === 'publish').map((c) => [c[1], c[2].post.files.length]));
    assert.deepEqual(sent, { instagram: 6, x: 4 });
  } finally {
    env.cleanup();
  }
});

test('Upload-Post 경로 검사: TikTok 사진은 JPG 만', async () => {
  const env = tempEnv({ channels: { tiktok: { enabled: true, route: 'uploadpost' } }, routes: { uploadpost: { apiKey: 'k', user: 'u' } } });
  try {
    env.write('card/1.png', makePng());
    const plan = await planPost({ media: [join(env.inbox, 'card')] }, deps(env, { uploadpost }));
    assert.equal(plan.ok, false);
    assert.match(plan.errors.join(), /JPG/);
  } finally {
    env.cleanup();
  }
});
