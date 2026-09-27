import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import naverCafe, { cafeText, toCafeHtml } from '../src/adapters/naver-cafe.js';
import { createPost } from '../src/planner.js';
import { formFields, makeJpeg, makeMp4, mockFetch, tempEnv, tickAll } from './helpers.js';

const API = 'https://openapi.naver.com/v1/cafe/12345/menu/7/articles';
const OK = { json: { message: { '@type': 'response', status: '200', result: { msg: 'Success', cafeUrl: 'aifunlab', articleId: 42, articleUrl: 'https://cafe.naver.com/aifunlab/42' } } } };

function setup() {
  const env = tempEnv({
    channels: { naver_cafe: { enabled: true, route: 'naver_cafe' } },
    routes: { naver_cafe: { clientId: 'id', clientSecret: 'sec', clubId: '12345', menuId: '7' } },
  });
  env.store.setToken('naver', { accessToken: 'NAT', refreshToken: 'NRT', expiresAt: Date.now() + 3600_000 });
  return env;
}

const add = (env, media, input = {}) =>
  createPost({ media: [media], title: '전세금 "3단계"', caption: '첫 줄\n둘째 줄 https://youtu.be/x 👍', ...input }, { config: env.config, store: env.store, adapters: { naver_cafe: naverCafe }, now: env.clock.now() });

test('글만 올릴 때: URL 인코딩을 두 번 해서 보낸다 (한글 깨짐 방지)', async () => {
  const env = setup();
  const fetch = mockFetch([{ method: 'POST', match: API, reply: OK }]);
  const engine = env.engine({ naver_cafe: naverCafe }, { fetchImpl: fetch });
  try {
    const plan = await add(env, env.write('v.mp4', makeMp4()));
    await tickAll(engine);
    const call = fetch.calls[0];
    assert.equal(call.headers.Authorization, 'Bearer NAT');
    assert.ok(call.body instanceof URLSearchParams);
    const raw = call.body.toString();
    // "전" = %EC%A0%84 → 두 번 인코딩하면 %25EC%25A0%2584
    assert.ok(raw.includes('subject=%25EC%25A0%2584'), raw.slice(0, 80));
    assert.ok(raw.includes('openyn=true'));
    // 서버가 한 번 풀면 보이는 값 = encodeURIComponent 한 번 한 값
    const once = call.body.get('content');
    const html = decodeURIComponent(once);
    assert.equal(html, "첫 줄<br>둘째 줄 <a href='https://youtu.be/x'>https://youtu.be/x</a>");
    assert.equal(decodeURIComponent(call.body.get('subject')), "전세금 '3단계'");

    const job = env.store.getJob(`${plan.post.id}.naver_cafe`);
    assert.equal(job.status, 'published');
    assert.equal(job.resultUrl, 'https://cafe.naver.com/aifunlab/42');
    assert.equal(job.resultId, '42');
  } finally {
    env.cleanup();
  }
});

test('카드뉴스: multipart 로 이미지를 붙이고 인코딩은 한 번만 한다', async () => {
  const env = setup();
  const fetch = mockFetch([{ method: 'POST', match: API, reply: OK }]);
  const engine = env.engine({ naver_cafe: naverCafe }, { fetchImpl: fetch });
  try {
    env.write('card/1.jpg', makeJpeg());
    env.write('card/2.jpg', makeJpeg(1080, 1080));
    await add(env, join(env.inbox, 'card'), { caption: '카드뉴스' });
    await tickAll(engine);
    const f = await formFields(fetch.calls[0].body);
    assert.equal(f.image.length, 2);
    assert.deepEqual(f.image.map((i) => i.name), ['card0.jpg', 'card1.jpg']);
    assert.equal(decodeURIComponent(f.content[0]), "<img src='#0' /><br><img src='#1' /><br><br>카드뉴스");
    assert.equal(f.subject[0], encodeURIComponent("전세금 '3단계'"));
    assert.deepEqual(f.openyn, ['true']);
  } finally {
    env.cleanup();
  }
});

test('카페 오류 코드: 등급 제한은 실패, 로그인 만료는 채널 보류, 서버 오류는 확인 필요', async () => {
  for (const [reply, status, kind] of [
    [{ status: 403, json: { message: { status: '500', error: { code: 'AP003', msg: 'grade' } } } }, 'failed', 'invalid'],
    [{ status: 401, json: { errorMessage: 'Authentication failed', errorCode: '024' } }, 'pending', 'auth'],
    [{ status: 500, json: { message: { status: '500', error: { code: '999', msg: 'unknown' } } } }, 'needs_check', 'uncertain'],
  ]) {
    const env = setup();
    const engine = env.engine({ naver_cafe: naverCafe }, { fetchImpl: mockFetch([{ method: 'POST', match: API, reply }]) });
    try {
      const plan = await add(env, env.write('v.mp4', makeMp4()));
      await tickAll(engine);
      const job = env.store.getJob(`${plan.post.id}.naver_cafe`);
      assert.equal(job.status, status, `${reply.status} → ${status}`);
      assert.equal(job.errorKind, kind);
    } finally {
      env.cleanup();
    }
  }
});

test('카페용 글 정리: 큰따옴표·이모지 제거, 줄바꿈과 링크 변환', () => {
  assert.equal(cafeText('a "b" 😀 c'), "a 'b'  c");
  assert.equal(toCafeHtml('<b>굵게</b>\nhttps://a.com/x?y=1&z=2'), "&lt;b&gt;굵게&lt;/b&gt;<br><a href='https://a.com/x?y=1&amp;z=2'>https://a.com/x?y=1&amp;z=2</a>");
});
