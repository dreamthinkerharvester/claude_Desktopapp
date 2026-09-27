import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChannelText, checkText, normalizeHashtags, resolveLinks, xWeightedLength } from '../src/captions.js';
import { normalizeConfig } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { redact } from '../src/http.js';
import { parseJsonc } from '../src/util/jsonc.js';
import { formatLocal, parseDateTime } from '../src/util/time.js';

test('jsonc: 주석과 끝 쉼표를 허용하고 문자열 안의 // 는 그대로 둔다', () => {
  const text = `{
    // 설명
    "url": "https://example.com/a//b", /* 블록 주석 */
    "list": [1, 2, 3,],
    "quote": "따옴표 \\" 안의 // 주석 아님",
  }`;
  assert.deepEqual(parseJsonc(text), { url: 'https://example.com/a//b', list: [1, 2, 3], quote: '따옴표 " 안의 // 주석 아님' });
});

test('config.example.jsonc 가 올바르게 읽힌다', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = parseJsonc(readFileSync(new URL('../config.example.jsonc', import.meta.url), 'utf8'));
  const config = normalizeConfig(raw, '/tmp/snspub');
  assert.equal(config.channels.naver_clip.route, 'manual');
  assert.equal(config.routes.youtube.audited, false);
  assert.equal(config.dataDir, '/tmp/snspub/data');
});

test('가져오기 예시(examples/post.example.jsonc)의 채널별 문구가 제한을 넘지 않는다', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = parseJsonc(readFileSync(new URL('../examples/post.example.jsonc', import.meta.url), 'utf8'));
  const post = raw.posts[0];
  assert.equal(checkText('x', { caption: post.overrides.x.text }).errors.length, 0);
  assert.equal(checkText('threads', { caption: post.overrides.threads.text }).errors.length, 0);
  assert.equal(checkText('naver_cafe', { title: post.overrides.naver_cafe.title, caption: post.overrides.naver_cafe.text }).errors.length, 0);
  assert.equal(checkText('youtube', { title: post.title, caption: post.caption }).errors.length, 0);
});

test('config: 없는 게시 경로를 쓰면 알려 준다', () => {
  assert.throws(() => normalizeConfig({ channels: { x: { enabled: true, route: 'uplodpost' } } }), /없는 게시 경로/);
  assert.throws(() => normalizeConfig({ channels: { tiktokk: { enabled: true, route: 'manual' } } }), /모르는 채널/);
});

test('시각: 서울 벽시계 시각을 UTC 로 바꾸고 다시 표시한다', () => {
  const d = parseDateTime('2026-09-28 12:50', 'Asia/Seoul');
  assert.equal(d.toISOString(), '2026-09-28T03:50:00.000Z');
  assert.equal(formatLocal(d, 'Asia/Seoul'), '2026-09-28 12:50');
  assert.equal(parseDateTime('2026-09-28T12:50', 'Asia/Seoul').toISOString(), '2026-09-28T03:50:00.000Z');
  assert.equal(parseDateTime('2026-09-28T12:50:00+09:00', 'UTC').toISOString(), '2026-09-28T03:50:00.000Z');
  assert.throws(() => parseDateTime('내일 오후', 'Asia/Seoul'), /형식/);
  // 서머타임이 있는 시간대도 맞게 계산
  assert.equal(parseDateTime('2026-07-01 09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
});

test('X 글자 수: 한글 2, 영문 1, 링크 23, 이모지 2', () => {
  assert.equal(xWeightedLength('abc'), 3);
  assert.equal(xWeightedLength('전세금'), 6);
  assert.equal(xWeightedLength('보기 https://example.com/very/long/path?x=1'), 5 + 23);
  assert.equal(xWeightedLength('👍🏽'), 2);
  assert.equal(xWeightedLength('가'.repeat(140)), 280);
});

test('해시태그 정리: # 붙이기, 공백 제거, 중복 제거', () => {
  assert.deepEqual(normalizeHashtags('#전세금 임차권 등기, #전세금'), ['#전세금', '#임차권', '#등기']);
  assert.deepEqual(normalizeHashtags(['법률 상식', '#법률상식']), ['#법률상식']);
});

test('채널별 문구: 템플릿·해시태그 개수 제한·링크 자리', () => {
  const config = normalizeConfig({});
  const x = buildChannelText('x', { title: 't', caption: '본문', hashtags: ['a', 'b', 'c'] }, config);
  assert.equal(x.caption, '본문\n#a #b');
  assert.equal(x.droppedHashtags, 1);
  const cafe = buildChannelText('naver_cafe', { title: 't', caption: '본문', hashtags: [] }, config);
  assert.equal(cafe.caption, '본문\n\n{links}');
  const resolved = resolveLinks(cafe.caption, [{ channel: 'youtube', resultUrl: 'https://youtu.be/1' }, { channel: 'x', resultUrl: undefined }]);
  assert.equal(resolved, '본문\n\nYouTube 쇼츠: https://youtu.be/1');
  assert.equal(resolveLinks(cafe.caption, []), '본문');
});

test('문구 검사: X 길이 초과·유튜브 제목·꺾쇠 기호', () => {
  assert.match(checkText('x', { caption: '가'.repeat(141) }).errors[0], /너무 깁니다/);
  assert.equal(checkText('x', { caption: '가'.repeat(140) }).errors.length, 0);
  assert.match(checkText('youtube', { title: '', caption: '설명' }).errors[0], /제목이 비어/);
  assert.match(checkText('youtube', { title: 'a<b>', caption: '설명' }).errors[0], /< >/);
  assert.equal(checkText('youtube', { title: '정상 제목', caption: '설명 {links}' }).errors.length, 0);
});

test('로그에서 토큰을 가린다', () => {
  const text = redact('GET /me?access_token=EAAB123&x=1 Authorization: Bearer abc.def {"refresh_token":"zzz"}');
  assert.ok(!text.includes('EAAB123'));
  assert.ok(!text.includes('abc.def'));
  assert.ok(!text.includes('zzz'));
});

test('명령줄 옵션 해석', () => {
  const { cmd, args, flags } = parseArgs(['add', '--dry-run', 'a.mp4', '--channels', 'x,youtube', '--at=2026-09-28 12:50']);
  assert.equal(cmd, 'add');
  assert.deepEqual(args, ['a.mp4']);
  assert.equal(flags['dry-run'], true);
  assert.equal(flags.channels, 'x,youtube');
  assert.equal(flags.at, '2026-09-28 12:50');
});
