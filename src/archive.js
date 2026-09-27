// 모든 채널 게시가 끝난 원본을 보관 폴더(archiveDir/YYYY-MM/)로 옮깁니다.
// 수신함(inboxDir) 안에 있는 파일만 옮기고, 다른 곳의 파일은 건드리지 않습니다.

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { isInside } from './media.js';
import { monthFolder } from './util/time.js';

function freePath(target) {
  if (!existsSync(target)) return target;
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`보관 폴더에 같은 이름이 너무 많습니다: ${target}`);
}

function sizeOf(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

function move(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // 다른 디스크로 옮길 때: 복사 → 크기 확인 → 원본 삭제
    cpSync(from, to, { recursive: true, errorOnExist: true, preserveTimestamps: true });
    if (sizeOf(from) !== sizeOf(to)) throw new Error(`복사 확인 실패: ${to}`);
    rmSync(from, { recursive: true, force: false });
  }
}

/**
 * @returns {{ moved: boolean, archivedPath?: string, media: object[], note?: string }}
 */
export function archivePost(post, config, now = new Date()) {
  const { archiveDir, inboxDir } = config;
  if (!archiveDir) return { moved: false, media: post.media, note: '보관 폴더(archiveDir)가 설정되지 않아 옮기지 않았습니다' };
  const roots = [inboxDir].filter(Boolean);
  const destDir = join(archiveDir, monthFolder(now, config.timezone));

  // 폴더째 등록한 카드뉴스 → 폴더를 통째로
  if (post.sourceDir && roots.some((r) => isInside(post.sourceDir, r) && post.sourceDir !== r)) {
    if (!existsSync(post.sourceDir)) return { moved: false, media: post.media, note: `원본 폴더가 이미 없습니다: ${post.sourceDir}` };
    const target = freePath(join(destDir, basename(post.sourceDir)));
    move(post.sourceDir, target);
    const media = post.media.map((f) => ({ ...f, path: join(target, relative(post.sourceDir, f.path)) }));
    return { moved: true, archivedPath: target, media };
  }

  const movable = post.media.filter((f) => roots.some((r) => isInside(f.path, r)));
  if (!movable.length) return { moved: false, media: post.media, note: '원본이 수신함 밖에 있어 옮기지 않았습니다' };
  const media = [];
  for (const f of post.media) {
    if (!movable.includes(f) || !existsSync(f.path)) {
      media.push(f);
      continue;
    }
    const target = freePath(join(destDir, basename(f.path)));
    move(f.path, target);
    media.push({ ...f, path: target });
  }
  return { moved: true, archivedPath: destDir, media };
}
