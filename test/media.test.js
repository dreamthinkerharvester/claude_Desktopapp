import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectMedia, listInbox, probeImage, probeVideo, verifyFiles } from '../src/media.js';
import { makeJpeg, makeMp4, makePng, tempEnv } from './helpers.js';

test('MP4 길이·해상도를 ffprobe 없이 읽는다 (moov 가 뒤에 있어도)', async () => {
  const env = tempEnv();
  try {
    const path = env.write('a.mp4', makeMp4({ durationMs: 45_500, width: 1080, height: 1920 }));
    assert.deepEqual(await probeVideo(path), { duration: 45.5, width: 1080, height: 1920 });
    const rotated = env.write('b.mp4', makeMp4({ width: 1920, height: 1080, rotate: true }));
    const info = await probeVideo(rotated);
    assert.equal(info.width, 1080);
    assert.equal(info.height, 1920);
  } finally {
    env.cleanup();
  }
});

test('PNG·JPEG 크기를 읽는다', async () => {
  const env = tempEnv();
  try {
    assert.deepEqual(await probeImage(env.write('a.png', makePng(1080, 1350))), { width: 1080, height: 1350 });
    assert.deepEqual(await probeImage(env.write('b.jpg', makeJpeg(1080, 1080))), { width: 1080, height: 1080 });
  } finally {
    env.cleanup();
  }
});

test('등록 파일 확인: 영상 1개 / 이미지 폴더 / 섞임 금지', async () => {
  const env = tempEnv();
  try {
    const video = env.write('v.mp4', makeMp4());
    const v = await inspectMedia([video]);
    assert.equal(v.kind, 'video');
    assert.equal(v.files[0].duration, 45.5);

    env.write('card/10.png', makePng(1080, 1350, 'c'));
    env.write('card/2.png', makePng(1080, 1350, 'b'));
    env.write('card/1.png', makePng(1080, 1350, 'a'));
    const cards = await inspectMedia([join(env.inbox, 'card')]);
    assert.equal(cards.kind, 'images');
    assert.deepEqual(cards.files.map((f) => f.name), ['1.png', '2.png', '10.png']);
    assert.equal(cards.sourceDir, join(env.inbox, 'card'));

    await assert.rejects(inspectMedia([video, join(env.inbox, 'card', '1.png')]), /섞어/);
    await assert.rejects(inspectMedia([join(env.inbox, 'none.mp4')]), /없습니다/);
    const txt = env.write('memo.txt', 'hi');
    await assert.rejects(inspectMedia([txt]), /지원하지 않는/);
  } finally {
    env.cleanup();
  }
});

test('등록 뒤 파일이 바뀌면 올리지 않는다', async () => {
  const env = tempEnv();
  try {
    const video = env.write('v.mp4', makeMp4());
    const { files } = await inspectMedia([video]);
    assert.equal((await verifyFiles(files)).ok, true);
    writeFileSync(video, makeMp4({ filler: 'changed!' }));
    const changed = await verifyFiles(files);
    assert.equal(changed.ok, false);
    assert.match(changed.message, /바뀌었습니다/);
  } finally {
    env.cleanup();
  }
});

test('수신함 목록: 영상과 카드뉴스 폴더, 보관 폴더는 제외', () => {
  const env = tempEnv();
  try {
    env.write('a.mp4', makeMp4());
    env.write('cards/1.jpg', makeJpeg());
    env.write('_done/old.mp4', makeMp4());
    env.write('.hidden.mp4', makeMp4());
    const items = listInbox(env.inbox, { exclude: [join(env.inbox, '_done')] });
    const names = items.map((i) => `${i.type}:${i.name}`).sort();
    assert.deepEqual(names, ['images:cards', 'video:a.mp4']);
  } finally {
    env.cleanup();
  }
});
