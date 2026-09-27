import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import manual from '../src/adapters/manual.js';
import { authError, invalid, transient, uncertain } from '../src/errors.js';
import { createPost } from '../src/planner.js';
import { fakeAdapter, makeMp4, tempEnv, tickAll } from './helpers.js';

async function addVideo(env, adapters, input = {}) {
  const path = input.path ?? env.write(input.name ?? 'v.mp4', makeMp4({ filler: input.name ?? 'v' }));
  const plan = await createPost(
    { media: [path], caption: '전세금 돌려받는 법', hashtags: '#전세금', gapMinutes: [30, 30], ...input.post },
    { config: env.config, store: env.store, adapters, now: env.clock.now(), rng: () => 0 },
  );
  return { plan, path, jobs: () => env.store.getJobs(plan.post.id), job: (ch) => env.store.getJob(`${plan.post.id}.${ch}`) };
}

test('예약 시각이 된 채널부터 올리고, 모두 끝나면 원본을 보관 폴더로 옮긴다', async () => {
  const env = tempEnv();
  const fake = fakeAdapter();
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { plan, path, job } = await addVideo(env, adapters);
    assert.deepEqual(plan.jobs.map((j) => [j.channel, j.runAtLocal]), [
      ['youtube', '2026-09-28 12:00'],
      ['instagram', '2026-09-28 12:30'],
      ['x', '2026-09-28 13:00'],
    ]);
    assert.equal(await tickAll(engine), 1);
    assert.equal(job('youtube').status, 'published');
    assert.equal(job('youtube').resultUrl, 'https://example.com/youtube');
    assert.equal(job('instagram').status, 'pending');

    env.clock.advance(30);
    await tickAll(engine);
    env.clock.advance(30);
    await tickAll(engine);
    assert.equal(job('x').status, 'published');

    const post = env.store.getPost(plan.post.id);
    assert.equal(post.status, 'done');
    const archived = join(env.archive, '2026-09', 'v.mp4');
    assert.ok(existsSync(archived), '보관 폴더로 옮겨져야 함');
    assert.ok(!existsSync(path), '수신함에서는 없어져야 함');
    assert.equal(post.media[0].path, archived);
  } finally {
    env.cleanup();
  }
});

test('연결이 끊기는 일시 오류는 1→2분 간격으로 자동 재시도하고, 한도를 넘으면 실패로 멈춘다', async () => {
  const env = tempEnv({ channels: { x: { enabled: true, route: 'fake' } }, extra: { retry: { maxAttempts: 3, backoffMinutes: [1, 2] } } });
  const fake = fakeAdapter({ publish: () => Promise.reject(transient('네트워크 연결 실패 (ECONNREFUSED)')) });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job } = await addVideo(env, adapters);
    await tickAll(engine);
    assert.equal(job('x').status, 'pending');
    assert.equal(job('x').attempts, 1);
    assert.equal(job('x').nextTryAt, '2026-09-28T03:01:00.000Z');

    assert.equal(await tickAll(engine), 0, '재시도 시각 전에는 다시 올리지 않음');
    env.clock.advance(1);
    await tickAll(engine);
    assert.equal(job('x').attempts, 2);
    assert.equal(job('x').nextTryAt, '2026-09-28T03:03:00.000Z');

    env.clock.advance(2);
    await tickAll(engine);
    assert.equal(job('x').status, 'failed');
    assert.match(job('x').lastError, /3회 모두 실패/);
    assert.equal(fake.calls.filter((c) => c[0] === 'publish').length, 3);
  } finally {
    env.cleanup();
  }
});

test('게시됐는지 모르는 경우 "확인 필요"로 멈추고 절대 자동으로 다시 올리지 않는다', async () => {
  const env = tempEnv({ channels: { x: { enabled: true, route: 'fake' } } });
  let first = true;
  const fake = fakeAdapter({
    publish: () => {
      if (first) {
        first = false;
        return Promise.reject(uncertain('응답 시간 초과 — 게시 요청이 처리됐는지 알 수 없습니다'));
      }
      return { status: 'published', url: 'https://x.com/p/2' };
    },
  });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job } = await addVideo(env, adapters);
    await tickAll(engine);
    assert.equal(job('x').status, 'needs_check');
    env.clock.advance(24 * 60);
    assert.equal(await tickAll(engine), 0);
    assert.equal(fake.calls.filter((c) => c[0] === 'publish').length, 1);

    // 사람이 확인한 뒤 "다시 올리기"
    engine.retry(job('x').id);
    await tickAll(engine);
    assert.equal(job('x').status, 'published');
  } finally {
    env.cleanup();
  }
});

test('로그인 문제는 그 채널만 보류하고, 다른 채널은 계속 올라가며, 연결 확인이 통과하면 이어서 올린다', async () => {
  const env = tempEnv();
  let igBroken = true;
  const fake = fakeAdapter({
    publish: (job) => {
      if (job.channel === 'instagram' && igBroken) return Promise.reject(authError('토큰 만료'));
      return { status: 'published', url: `https://example.com/${job.channel}` };
    },
  });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job, plan } = await addVideo(env, adapters, { post: { times: { youtube: '2026-09-28 12:00', instagram: '2026-09-28 12:00', x: '2026-09-28 12:00' } } });
    await tickAll(engine);
    assert.equal(job('instagram').status, 'pending');
    assert.equal(job('instagram').errorKind, 'auth');
    assert.equal(env.store.getChannelState('instagram').blocked, true);
    assert.equal(job('youtube').status, 'published');
    assert.equal(job('x').status, 'published');

    env.clock.advance(10);
    assert.equal(await tickAll(engine), 0, '보류된 채널은 건너뜀');

    igBroken = false;
    const check = await engine.checkChannel('instagram');
    assert.equal(check.ok, true);
    assert.equal(env.store.getChannelState('instagram').blocked, false);
    await tickAll(engine);
    assert.equal(job('instagram').status, 'published');
    assert.equal(env.store.getPost(plan.post.id).status, 'done');
  } finally {
    env.cleanup();
  }
});

test('파일·문구 문제(invalid)는 바로 실패로 두고 재시도하지 않는다', async () => {
  const env = tempEnv({ channels: { x: { enabled: true, route: 'fake' } } });
  const fake = fakeAdapter({ publish: () => Promise.reject(invalid('영상 형식이 올바르지 않습니다')) });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job } = await addVideo(env, adapters);
    await tickAll(engine);
    assert.equal(job('x').status, 'failed');
    env.clock.advance(120);
    assert.equal(await tickAll(engine), 0);
  } finally {
    env.cleanup();
  }
});

test('플랫폼 처리 중이면 상태만 다시 보고, 조회 중 끊겨도 다시 올리지 않고 조회만 반복한다', async () => {
  const env = tempEnv({ channels: { x: { enabled: true, route: 'fake' } } });
  let polls = 0;
  const fake = fakeAdapter({
    publish: (job, ctx) => {
      ctx.checkpoint({ requestId: 'req-1' });
      return { status: 'processing', pollAfterSec: 30 };
    },
    resume: (job) => {
      assert.equal(job.remote.requestId, 'req-1');
      polls += 1;
      if (polls === 1) return Promise.reject(transient('조회 중 연결 끊김'));
      if (polls === 2) return { status: 'processing', pollAfterSec: 30 };
      return { status: 'published', url: 'https://x.com/p/1' };
    },
    canResume: (job) => !!job.remote?.requestId,
  });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job } = await addVideo(env, adapters);
    await tickAll(engine);
    assert.equal(job('x').status, 'processing');
    assert.equal(await tickAll(engine), 0, '30초 전에는 조회하지 않음');

    env.clock.advance(1);
    await tickAll(engine); // 조회 실패 → 다시 processing
    assert.equal(job('x').status, 'processing');
    env.clock.advance(1);
    await tickAll(engine); // 아직 처리 중
    env.clock.advance(1);
    await tickAll(engine); // 완료
    assert.equal(job('x').status, 'published');
    assert.equal(fake.calls.filter((c) => c[0] === 'publish').length, 1, '다시 올리지 않음');
  } finally {
    env.cleanup();
  }
});

test('처리가 너무 오래 걸리면 확인 필요로 바꾼다', async () => {
  const env = tempEnv({ channels: { x: { enabled: true, route: 'fake' } }, extra: { processing: { pollSeconds: 60, timeoutMinutes: 10 } } });
  const fake = fakeAdapter({
    publish: (job, ctx) => {
      ctx.checkpoint({ requestId: 'r' });
      return { status: 'processing' };
    },
    resume: () => ({ status: 'processing' }),
    canResume: (job) => !!job.remote?.requestId,
  });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job } = await addVideo(env, adapters);
    await tickAll(engine);
    for (let i = 0; i < 12; i += 1) {
      env.clock.advance(1);
      await tickAll(engine);
    }
    assert.equal(job('x').status, 'needs_check');
    assert.match(job('x').lastError, /10분/);
  } finally {
    env.cleanup();
  }
});

test('올리는 도중 프로그램이 꺼졌을 때: 진행 기록이 없으면 확인 필요, 있으면 이어서 확인', async () => {
  const env = tempEnv({ channels: { x: { enabled: true, route: 'fake' }, instagram: { enabled: true, route: 'fake' } } });
  const fake = fakeAdapter({ canResume: (job) => !!job.remote?.containerId });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job } = await addVideo(env, adapters, { post: { times: { x: '2026-09-28 12:00', instagram: '2026-09-28 12:00' } } });
    // 실행 중 상태로 강제로 만들고(=꺼진 상황) 한쪽에만 진행 기록을 남김
    env.store.transition(job('x').id, ['pending'], { status: 'running' });
    env.store.transition(job('instagram').id, ['pending'], { status: 'running' });
    env.store.checkpoint(job('instagram').id, { containerId: 'c-1' });

    engine.recover();
    assert.equal(job('x').status, 'needs_check');
    assert.match(job('x').lastError, /프로그램이 꺼져/);
    assert.equal(job('instagram').status, 'processing');

    await tickAll(engine);
    assert.equal(job('instagram').status, 'published');
    assert.equal(fake.calls.filter((c) => c[0] === 'publish').length, 0);
  } finally {
    env.cleanup();
  }
});

test('업로드 도우미 채널은 "직접 올릴 차례"가 되고, 완료 표시하면 끝나며 보관된다', async () => {
  const env = tempEnv({ channels: { youtube: { enabled: true, route: 'fake' }, naver_clip: { enabled: true, route: 'manual' } } });
  const fake = fakeAdapter();
  const adapters = { fake, manual };
  const engine = env.engine(adapters);
  try {
    const { job, plan } = await addVideo(env, adapters, { post: { times: { youtube: '2026-09-28 12:00', naver_clip: '2026-09-28 12:00' } } });
    await tickAll(engine);
    assert.equal(job('naver_clip').status, 'manual');
    assert.equal(env.store.getPost(plan.post.id).status, 'active', '직접 올릴 채널이 남아 있으면 보관하지 않음');
    engine.markDone(job('naver_clip').id, 'https://clip.naver.com/abc');
    assert.equal(job('naver_clip').status, 'published');
    assert.equal(env.store.getPost(plan.post.id).status, 'done');
    assert.ok(existsSync(join(env.archive, '2026-09', 'v.mp4')));
  } finally {
    env.cleanup();
  }
});

test('실패한 채널을 취소하면 나머지 채널 기준으로 마무리한다', async () => {
  const env = tempEnv({ channels: { youtube: { enabled: true, route: 'fake' }, x: { enabled: true, route: 'fake' } } });
  const fake = fakeAdapter({ publish: (job) => (job.channel === 'x' ? Promise.reject(invalid('글이 너무 깁니다')) : { status: 'published', url: 'https://y/1' }) });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job, plan } = await addVideo(env, adapters, { post: { times: { youtube: '2026-09-28 12:00', x: '2026-09-28 12:00' } } });
    await tickAll(engine);
    assert.equal(job('x').status, 'failed');
    assert.equal(env.store.getPost(plan.post.id).status, 'active');
    engine.cancel(job('x').id);
    assert.equal(env.store.getPost(plan.post.id).status, 'done');
  } finally {
    env.cleanup();
  }
});

test('같은 채널에는 최소 간격(60분)을 두고 올린다', async () => {
  const env = tempEnv({ channels: { youtube: { enabled: true, route: 'fake' } } });
  const fake = fakeAdapter();
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const a = await addVideo(env, adapters, { name: 'a.mp4' });
    const b = await addVideo(env, adapters, { name: 'b.mp4' });
    await tickAll(engine);
    await tickAll(engine);
    assert.equal(a.job('youtube').status, 'published');
    assert.equal(b.job('youtube').status, 'pending');
    assert.equal(b.job('youtube').nextTryAt, '2026-09-28T04:00:00.000Z');
    env.clock.advance(60);
    await tickAll(engine);
    assert.equal(b.job('youtube').status, 'published');
  } finally {
    env.cleanup();
  }
});

test('네이버 카페 문구의 {links} 는 먼저 올라간 채널 주소로 채워진다', async () => {
  const env = tempEnv({ channels: { youtube: { enabled: true, route: 'fake' }, naver_cafe: { enabled: true, route: 'fake' } } });
  const fake = fakeAdapter({ publish: (job) => ({ status: 'published', url: job.channel === 'youtube' ? 'https://www.youtube.com/shorts/abc' : 'https://cafe.naver.com/x/1' }) });
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job } = await addVideo(env, adapters);
    assert.equal(job('naver_cafe').options.caption, '전세금 돌려받는 법\n\n{links}');
    await tickAll(engine);
    env.clock.advance(30);
    await tickAll(engine);
    const cafeCall = fake.calls.find((c) => c[0] === 'publish' && c[1] === 'naver_cafe');
    assert.equal(cafeCall[2].options.caption, '전세금 돌려받는 법\n\nYouTube 쇼츠: https://www.youtube.com/shorts/abc');
  } finally {
    env.cleanup();
  }
});

test('예약 수정·지금 올리기·전체 취소', async () => {
  const env = tempEnv();
  const fake = fakeAdapter();
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job, plan } = await addVideo(env, adapters);
    engine.editJob(job('x').id, { caption: '고친 문구', runAt: 'now' });
    assert.equal(job('x').options.caption, '고친 문구');
    assert.equal(job('x').runAt, '2026-09-28T03:00:00.000Z');
    engine.editJob(job('instagram').id, { runAt: '2026-09-28 18:00' });
    assert.equal(job('instagram').runAt, '2026-09-28T09:00:00.000Z');
    await tickAll(engine);
    assert.equal(job('x').status, 'published');
    assert.equal(fake.calls.find((c) => c[1] === 'x')[2].options.caption, '고친 문구');

    const { skipped } = engine.cancelPost(plan.post.id);
    assert.equal(skipped.length, 0);
    assert.equal(job('instagram').status, 'canceled');
    assert.equal(env.store.getPost(plan.post.id).status, 'done', '올라간 채널이 있으면 완료로 마무리');
    assert.throws(() => engine.editJob(job('x').id, { caption: 'x' }), /예약 대기/);
  } finally {
    env.cleanup();
  }
});

test('등록 뒤 파일이 바뀌거나 사라지면 올리지 않는다', async () => {
  const env = tempEnv({ channels: { x: { enabled: true, route: 'fake' } } });
  const fake = fakeAdapter();
  const adapters = { fake };
  const engine = env.engine(adapters);
  try {
    const { job, path } = await addVideo(env, adapters);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, makeMp4({ filler: 'other' }));
    await tickAll(engine);
    assert.equal(job('x').status, 'failed');
    assert.match(job('x').lastError, /바뀌었습니다/);
    assert.equal(fake.calls.filter((c) => c[0] === 'publish').length, 0);
  } finally {
    env.cleanup();
  }
});
