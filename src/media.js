import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';

export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v']);
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);

export const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export const naturalCompare = (a, b) => a.localeCompare(b, 'ko', { numeric: true, sensitivity: 'base' });

export function mimeOf(path) {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

// ---------- MP4/MOV 길이·크기 읽기 (ffprobe 없이) ----------

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

function* boxes(buf, start = 0, end = buf.length) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function parseMvhd(buf, box) {
  const version = buf[box.start];
  if (version === 1) {
    const timescale = buf.readUInt32BE(box.start + 20);
    const duration = Number(buf.readBigUInt64BE(box.start + 24));
    return timescale ? duration / timescale : undefined;
  }
  const timescale = buf.readUInt32BE(box.start + 12);
  const duration = buf.readUInt32BE(box.start + 16);
  return timescale ? duration / timescale : undefined;
}

function parseTkhd(buf, box) {
  const version = buf[box.start];
  const matrixStart = box.start + (version === 1 ? 52 : 40);
  const widthPos = matrixStart + 36;
  if (widthPos + 8 > box.end) return undefined;
  let width = buf.readUInt32BE(widthPos) / 65536;
  let height = buf.readUInt32BE(widthPos + 4) / 65536;
  const a = buf.readInt32BE(matrixStart) / 65536;
  const b = buf.readInt32BE(matrixStart + 4) / 65536;
  if (Math.abs(a) < 0.01 && Math.abs(b) > 0.99) [width, height] = [height, width]; // 90도 회전 영상
  return width && height ? { width: Math.round(width), height: Math.round(height) } : undefined;
}

export async function probeVideo(path) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    let pos = 0;
    while (pos + 8 <= size) {
      const head = await readAt(fh, pos, 16);
      if (head.length < 8) break;
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < 8) break;
      if (type === 'moov') {
        if (boxSize > 64 * 1024 * 1024) return {};
        const moov = await readAt(fh, pos, boxSize);
        const info = {};
        for (const child of boxes(moov, 8)) {
          if (child.type === 'mvhd') info.duration = parseMvhd(moov, child);
          if (child.type === 'trak' && !info.width) {
            for (const t of boxes(moov, child.start, child.end)) {
              if (t.type === 'tkhd') Object.assign(info, parseTkhd(moov, t) ?? {});
            }
          }
        }
        if (info.duration) info.duration = Math.round(info.duration * 100) / 100;
        return info;
      }
      pos += boxSize;
    }
    return {};
  } finally {
    await fh.close();
  }
}

// ---------- 이미지 크기 (PNG/JPEG) ----------

export async function probeImage(path) {
  const fh = await open(path, 'r');
  try {
    const head = await readAt(fh, 0, 64 * 1024);
    if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    if (head[0] === 0xff && head[1] === 0xd8) {
      let pos = 2;
      while (pos + 9 < head.length) {
        if (head[pos] !== 0xff) {
          pos += 1;
          continue;
        }
        const marker = head[pos + 1];
        const len = head.readUInt16BE(pos + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: head.readUInt16BE(pos + 5), width: head.readUInt16BE(pos + 7) };
        }
        pos += 2 + len;
      }
    }
    return {};
  } finally {
    await fh.close();
  }
}

// ---------- 등록할 파일 확인 ----------

/**
 * 영상 1개 또는 이미지 여러 장(폴더 포함)을 받아 종류·크기·해시를 확인합니다.
 * @returns {{kind: 'video'|'images', files: object[], mediaHash: string, sourceDir?: string}}
 */
export async function inspectMedia(inputs) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).filter(Boolean).map((p) => resolve(String(p)));
  if (!list.length) throw new Error('올릴 파일을 지정해 주세요');

  let sourceDir;
  const paths = [];
  for (const p of list) {
    if (!existsSync(p)) throw new Error(`파일이 없습니다: ${p}`);
    const st = statSync(p);
    if (st.isDirectory()) {
      const images = readdirSync(p)
        .filter((name) => !name.startsWith('.') && IMAGE_EXTS.has(extname(name).toLowerCase()))
        .sort(naturalCompare)
        .map((name) => join(p, name));
      if (!images.length) throw new Error(`폴더에 이미지(jpg/png)가 없습니다: ${p}`);
      if (list.length === 1) sourceDir = p;
      paths.push(...images);
    } else {
      paths.push(p);
    }
  }

  const exts = paths.map((p) => extname(p).toLowerCase());
  const videos = exts.filter((e) => VIDEO_EXTS.has(e)).length;
  const images = exts.filter((e) => IMAGE_EXTS.has(e)).length;
  if (videos + images !== paths.length) {
    const bad = paths.filter((p) => !VIDEO_EXTS.has(extname(p).toLowerCase()) && !IMAGE_EXTS.has(extname(p).toLowerCase()));
    throw new Error(`지원하지 않는 파일 형식입니다 (영상: mp4/mov, 이미지: jpg/png): ${bad.map((p) => basename(p)).join(', ')}`);
  }
  if (videos && images) throw new Error('영상과 이미지를 한 번에 섞어 올릴 수 없습니다');
  if (videos > 1) throw new Error('영상은 한 번에 1개만 등록할 수 있습니다');

  const kind = videos ? 'video' : 'images';
  const files = [];
  for (const path of paths) {
    const st = statSync(path);
    if (!st.size) throw new Error(`빈 파일입니다: ${path}`);
    const ext = extname(path).toLowerCase();
    const info = kind === 'video' ? await probeVideo(path).catch(() => ({})) : await probeImage(path).catch(() => ({}));
    files.push({ path, name: basename(path), ext, mime: mimeOf(path), size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: await hashFile(path), ...info });
  }
  const mediaHash = createHash('sha256')
    .update(files.map((f) => f.sha256).join(','))
    .digest('hex');
  return { kind, files, mediaHash, sourceDir };
}

// 실행 직전에 파일이 등록 때와 같은지 확인 (승인한 내용 그대로 올라가도록)
export async function verifyFiles(files) {
  for (const file of files) {
    if (!existsSync(file.path)) {
      const volume = file.path.startsWith('/Volumes/') ? file.path.split(sep).slice(0, 3).join(sep) : undefined;
      if (volume && !existsSync(volume)) return { ok: false, transient: true, message: `외장 디스크(${volume})가 연결되어 있지 않습니다` };
      return { ok: false, message: `파일이 없습니다 (옮겨졌거나 삭제됨): ${file.path}` };
    }
    const st = statSync(file.path);
    if (st.size !== file.size || (await hashFile(file.path)) !== file.sha256) {
      return { ok: false, message: `등록한 뒤 파일 내용이 바뀌었습니다. 다시 등록해 주세요: ${file.name}` };
    }
  }
  return { ok: true };
}

// ---------- 수신함 목록 (새 발행 화면용) ----------

export function listInbox(inboxDir, { exclude = [] } = {}) {
  if (!inboxDir || !existsSync(inboxDir)) return [];
  const skip = new Set(exclude.filter(Boolean).map((p) => resolve(p)));
  const items = [];
  for (const name of readdirSync(inboxDir)) {
    if (name.startsWith('.')) continue;
    const path = join(inboxDir, name);
    if (skip.has(resolve(path))) continue;
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const ext = extname(name).toLowerCase();
    if (st.isFile() && VIDEO_EXTS.has(ext)) {
      items.push({ type: 'video', path, name, size: st.size, mtime: st.mtime.toISOString() });
    } else if (st.isFile() && IMAGE_EXTS.has(ext)) {
      items.push({ type: 'images', path, name, count: 1, size: st.size, mtime: st.mtime.toISOString() });
    } else if (st.isDirectory()) {
      let children = [];
      try {
        children = readdirSync(path).filter((n) => !n.startsWith('.'));
      } catch {
        continue;
      }
      const images = children.filter((n) => IMAGE_EXTS.has(extname(n).toLowerCase())).sort(naturalCompare);
      const videos = children.filter((n) => VIDEO_EXTS.has(extname(n).toLowerCase())).sort(naturalCompare);
      if (images.length && !videos.length) {
        items.push({ type: 'images', path, name, count: images.length, preview: join(path, images[0]), mtime: st.mtime.toISOString() });
      }
      for (const v of videos) {
        const vp = join(path, v);
        const vs = statSync(vp);
        items.push({ type: 'video', path: vp, name: `${name}/${v}`, size: vs.size, mtime: vs.mtime.toISOString() });
      }
    }
  }
  return items.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

export function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
