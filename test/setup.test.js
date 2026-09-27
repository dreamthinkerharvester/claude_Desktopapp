import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { runSetup, setChannel, setStringValue } from '../src/setup.js';
import { parseJsonc } from '../src/util/jsonc.js';
import { mockFetch } from './helpers.js';

const PROFILE = {
  username: 'myprofile',
  social_accounts: {
    youtube: { display_name: 'my-youtube' },
    instagram: { display_name: 'my-insta' },
    facebook: { display_name: 'my-page' },
    threads: { display_name: 'my-threads' },
    x: { display_name: 'my-x' },
    tiktok: '',
  },
};

function answers(list) {
  const queue = [...list];
  const asked = [];
  const ask = async (question) => {
    asked.push(question);
    return queue.length ? queue.shift() : '';
  };
  return { ask, asked };
}

function upFetch({ profile = PROFILE, pages = [{ page_id: '111', page_name: '페이지' }] } = {}) {
  return mockFetch([
    {
      match: '/uploadposts/users',
      reply: (call) => (call.headers.Authorization === 'Apikey GOODKEY' ? { json: { success: true, profiles: [profile] } } : { status: 401, json: { success: false, message: 'Invalid API key' } }),
    },
    { match: '/uploadposts/facebook/pages', reply: { json: { success: true, pages } } },
  ]);
}

const readConfig = (path) => normalizeConfig(parseJsonc(readFileSync(path, 'utf8')), '/tmp', path);

test('설정 값 바꾸기: 주석은 그대로 두고 값만 바꾼다', () => {
  const text = `{
  // 수신함 설명
  "inboxDir": "/old/path",
  "channels": {
    "tiktok":     { "enabled": true, "route": "uploadpost" },
  },
  "routes": { "uploadpost": { "tiktok": { "privacy": "PUBLIC_TO_EVERYONE" } } }
}`;
  let next = setStringValue(text, 'inboxDir', '/Volumes/새 폴더/"따옴표"');
  next = setChannel(next, 'tiktok', { enabled: true, route: 'manual' });
  assert.match(next, /\/\/ 수신함 설명/);
  const parsed = parseJsonc(next);
  assert.equal(parsed.inboxDir, '/Volumes/새 폴더/"따옴표"');
  assert.equal(parsed.channels.tiktok.route, 'manual');
  assert.equal(parsed.routes.uploadpost.tiktok.privacy, 'PUBLIC_TO_EVERYONE', '설정 안의 다른 tiktok 항목은 건드리지 않음');
  assert.throws(() => setStringValue(text, 'nothing', 'x'), /찾지 못했습니다/);
});

test('처음 설정(무료): 키 확인 → TikTok 은 업로드 도우미, 나머지는 Upload-Post', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snspub-setup-'));
  const configPath = join(dir, 'config.jsonc');
  try {
    const { ask } = answers(['WRONG', 'GOODKEY', '1', join(dir, 'inbox'), '']);
    const lines = [];
    const result = await runSetup({ configPath, ask, print: (l) => lines.push(l), fetchImpl: upFetch() });
    assert.equal(result.paid, false);
    assert.ok(lines.some((l) => l.includes('이 키로 확인하지 못했습니다')), '틀린 키는 다시 묻기');
    const config = readConfig(configPath);
    assert.equal(config.routes.uploadpost.apiKey, 'GOODKEY');
    assert.equal(config.routes.uploadpost.user, 'myprofile');
    assert.equal(config.routes.uploadpost.facebookPageId, '', '페이지가 하나면 비워 둠');
    assert.equal(config.channels.tiktok.route, 'manual');
    for (const ch of ['youtube', 'instagram', 'facebook', 'threads', 'x']) assert.equal(config.channels[ch].route, 'uploadpost', ch);
    assert.equal(config.channels.naver_cafe.route, 'manual', '카페 API 연결 전에는 업로드 도우미');
    assert.equal(config.channels.naver_clip.route, 'manual');
    assert.equal(config.inboxDir, join(dir, 'inbox'));
    assert.equal(config.archiveDir, '/Volumes/MacData/1. 최종콘텐츠/_업로드완료', 'Enter 는 기본값 유지');
    const text = readFileSync(configPath, 'utf8');
    assert.match(text, /\/\/ SNS 발행기 설정 파일/, '설명 주석 유지');
    assert.equal(statSync(configPath).mode & 0o777, 0o600, 'API 키가 있으니 본인만 읽기');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('다시 설정(유료 전환): 키는 Enter 로 유지, TikTok 이 연결돼 있으면 Upload-Post 로', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snspub-setup-'));
  const configPath = join(dir, 'config.jsonc');
  try {
    await runSetup({ configPath, ask: answers(['GOODKEY', '1', '', '']).ask, print: () => {}, fetchImpl: upFetch() });
    const withTiktok = { ...PROFILE, social_accounts: { ...PROFILE.social_accounts, tiktok: { display_name: 'my-tiktok' } } };
    const { ask, asked } = answers(['', '2', '', '-', '2']);
    const result = await runSetup({
      configPath,
      ask,
      print: () => {},
      fetchImpl: upFetch({ profile: withTiktok, pages: [{ page_id: '111', page_name: 'A' }, { page_id: '222', page_name: 'B' }] }),
    });
    assert.equal(result.paid, true);
    assert.match(asked[0], /API 키/);
    const config = readConfig(configPath);
    assert.equal(config.routes.uploadpost.apiKey, 'GOODKEY');
    assert.equal(config.channels.tiktok.route, 'uploadpost');
    assert.equal(config.archiveDir, '', '- 는 보관 안 함');
    assert.equal(config.routes.uploadpost.facebookPageId, '222', '페이지가 여럿이면 고른 페이지');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('계정이 연결되지 않은 채널은 업로드 도우미로, 프로필이 없으면 안내하고 멈춘다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snspub-setup-'));
  const configPath = join(dir, 'config.jsonc');
  try {
    const noThreads = { ...PROFILE, social_accounts: { ...PROFILE.social_accounts, threads: '' } };
    await runSetup({ configPath, ask: answers(['GOODKEY', '2', '', '']).ask, print: () => {}, fetchImpl: upFetch({ profile: noThreads }) });
    const config = readConfig(configPath);
    assert.equal(config.channels.threads.route, 'manual');
    assert.equal(config.channels.tiktok.route, 'manual', '유료여도 TikTok 계정이 없으면 도우미');

    const empty = mockFetch([{ match: '/uploadposts/users', reply: { json: { success: true, profiles: [] } } }]);
    await assert.rejects(runSetup({ configPath: join(dir, 'b.jsonc'), ask: answers(['GOODKEY']).ask, print: () => {}, fetchImpl: empty }), /프로필이 없습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
