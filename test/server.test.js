import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import manual from '../src/adapters/manual.js';
import { startServer } from '../src/server.js';
import { fakeAdapter, makeMp4, tempEnv, tickAll } from './helpers.js';

// fetch 는 Host·Origin 헤더를 바꿀 수 없어 node:http 로 직접 보냅니다
function call(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { Host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(fn, envOptions) {
  const env = tempEnv(envOptions ?? { channels: { youtube: { enabled: true, route: 'fake' }, naver_clip: { enabled: true, route: 'manual' } } });
  const adapters = { fake: fakeAdapter(), manual };
  const engine = env.engine(adapters);
  const port = 43000 + Math.floor(Math.random() * 2000);
  const server = await startServer({ config: { ...env.config, port }, store: env.store, engine, adapters }, { port });
  try {
    await fn({ env, engine, port });
  } finally {
    server.close();
    env.cleanup();
  }
}

test('화면·상태 조회, 수신함 목록', async () => {
  await withServer(async ({ env, port }) => {
    env.write('v.mp4', makeMp4());
    const page = await call(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /SNS 발행기/);
    const state = await call(port, 'GET', '/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.json.channels.find((c) => c.channel === 'youtube').enabled, true);
    const inbox = await call(port, 'GET', '/api/inbox');
    assert.deepEqual(inbox.json.items.map((i) => i.name), ['v.mp4']);
  });
});

test('미리보기 → 등록 → 실행 → 업로드 도우미 → 완료 표시', async () => {
  await withServer(async ({ env, engine, port }) => {
    const video = env.write('v.mp4', makeMp4());
    const body = { media: [video], caption: '소개글', hashtags: '#법률', at: 'now', gapMinutes: [0, 0] };
    const preview = await call(port, 'POST', '/api/preview', { body });
    assert.equal(preview.json.ok, true, JSON.stringify(preview.json.errors));
    assert.equal(preview.json.jobs.length, 2);
    assert.equal(env.store.listPosts().length, 0, '미리보기는 저장하지 않음');

    const created = await call(port, 'POST', '/api/posts', { body });
    assert.equal(created.status, 200);
    const postId = created.json.post.id;
    await tickAll(engine);
    const clip = `${postId}.naver_clip`;
    assert.equal(env.store.getJob(clip).status, 'manual');
    const state = await call(port, 'GET', '/api/state');
    const job = state.json.posts[0].jobs.find((j) => j.id === clip);
    assert.equal(job.uploadUrl, 'https://clipcreators.naver.com/');
    assert.equal(job.statusLabel, '직접 올릴 차례');

    const done = await call(port, 'POST', `/api/jobs/${encodeURIComponent(clip)}/done`, { body: { url: 'https://clip.naver.com/1' } });
    assert.equal(done.status, 200);
    assert.equal(env.store.getJob(clip).status, 'published');
    assert.equal(env.store.getPost(postId).status, 'done');

    // 원본은 보관 폴더로 옮겨졌고, 그 파일을 다시 등록하려 해도 내용 해시로 중복을 막습니다
    const archived = env.store.getPost(postId).media[0].path;
    assert.ok(archived.startsWith(env.archive));
    const dup = await call(port, 'POST', '/api/posts', { body: { ...body, media: [archived] } });
    assert.equal(dup.status, 400);
    assert.match(dup.json.errors.join(), /이미 등록/);
  });
});

test('보안: 다른 주소(Host)·다른 사이트(Origin)·JSON 이 아닌 요청은 거부', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await call(port, 'GET', '/api/state', { headers: { Host: 'evil.example.com' } })).status, 403);
    const cross = await call(port, 'POST', '/api/preview', { body: {}, headers: { Origin: 'https://evil.example.com' } });
    assert.equal(cross.status, 403);
    const form = await call(port, 'POST', '/api/preview', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
  });
});

test('파일 보기는 수신함·보관함·등록된 콘텐츠만 허용', async () => {
  await withServer(async ({ env, port }) => {
    env.write('v.mp4', makeMp4());
    const ok = await call(port, 'GET', `/file?path=${encodeURIComponent(`${env.inbox}/v.mp4`)}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'video/mp4');
    const ranged = await call(port, 'GET', `/file?path=${encodeURIComponent(`${env.inbox}/v.mp4`)}`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers['content-length'], '10');
    const outside = await call(port, 'GET', `/file?path=${encodeURIComponent('/etc/passwd')}`);
    assert.equal(outside.status, 404);
    const traversal = await call(port, 'GET', `/file?path=${encodeURIComponent(`${env.inbox}/../../../etc/passwd`)}`);
    assert.equal(traversal.status, 404);
  });
});

test('로그인 설정이 없으면 안내 화면을 보여 준다', async () => {
  await withServer(async ({ port }) => {
    const res = await call(port, 'GET', '/oauth/google/start');
    assert.equal(res.status, 400);
    assert.match(res.text, /clientId/);
    const bad = await call(port, 'GET', '/oauth/naver/callback?state=nope&code=x');
    assert.equal(bad.status, 400);
    assert.match(bad.text, /만료되었거나/);
  });
});
