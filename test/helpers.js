import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';

function box(type, ...payloads) {
  const body = Buffer.concat(payloads);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

const IDENTITY = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
function matrix(values = IDENTITY) {
  const b = Buffer.alloc(36);
  values.forEach((v, i) => b.writeInt32BE(v, i * 4));
  return b;
}

// 길이·해상도를 읽을 수 있는 최소 MP4 (ftyp + moov(mvhd, trak/tkhd) + mdat)
export function makeMp4({ durationMs = 45_500, width = 1080, height = 1920, rotate = false, filler = 'frames' } = {}) {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(durationMs, 16); // duration
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(1, 12);
  matrix(rotate ? [0, 0x00010000, 0, -0x00010000, 0, 0, 0, 0, 0x40000000] : IDENTITY).copy(tkhd, 40);
  tkhd.writeUInt32BE(width * 65536, 76);
  tkhd.writeUInt32BE(height * 65536, 80);
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isom', 'latin1'));
  const moov = box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd)));
  const mdat = box('mdat', Buffer.from(filler));
  return Buffer.concat([ftyp, mdat, moov]);
}

export function makePng(width = 1080, height = 1350, filler = '') {
  const b = Buffer.alloc(33 + filler.length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b.write(filler, 33, 'latin1');
  return b;
}

export function makeJpeg(width = 1080, height = 1350) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

export class FakeClock {
  constructor(iso = '2026-09-28T03:00:00.000Z') {
    this.t = Date.parse(iso);
    this.now = () => new Date(this.t);
  }

  advance(minutes) {
    this.t += minutes * 60_000;
  }
}

/**
 * 임시 폴더에 수신함·보관함·DB 를 만들고 설정을 돌려줍니다.
 */
export function tempEnv({ channels, routes = {}, clock = new FakeClock(), extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'snspub-test-'));
  const inbox = join(dir, 'inbox');
  const archive = join(dir, 'archive');
  mkdirSync(inbox, { recursive: true });
  const config = normalizeConfig(
    {
      inboxDir: inbox,
      archiveDir: archive,
      dataDir: join(dir, 'data'),
      notify: false,
      channels: channels ?? {
        youtube: { enabled: true, route: 'fake' },
        instagram: { enabled: true, route: 'fake' },
        x: { enabled: true, route: 'fake' },
      },
      routes: { fake: {}, other: {}, ...routes },
      ...extra,
    },
    dir,
  );
  const store = new Store(':memory:', { now: clock.now });
  return {
    dir,
    inbox,
    archive,
    config,
    store,
    clock,
    write(name, content) {
      const path = join(inbox, name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
      return path;
    },
    engine(adapters, opts = {}) {
      return new Engine({ config, store, adapters, now: clock.now, notifier: () => {}, ...opts });
    },
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 테스트용 어댑터. behavior 는 채널별로 publish/resume 에서 할 일을 정합니다.
 */
export function fakeAdapter({ publish, resume, canResume = () => false, supports = () => true, check } = {}) {
  const calls = [];
  return {
    name: 'fake',
    label: '테스트',
    calls,
    supports,
    async check(channel, ctx) {
      calls.push(['check', channel]);
      return check ? check(channel, ctx) : { ok: true, account: 'tester' };
    },
    async publish(job, ctx) {
      calls.push(['publish', job.channel, job]);
      return publish ? publish(job, ctx) : { status: 'published', url: `https://example.com/${job.channel}` };
    },
    async resume(job, ctx) {
      calls.push(['resume', job.channel, job]);
      return resume ? resume(job, ctx) : { status: 'published', url: `https://example.com/${job.channel}` };
    },
    canResume,
  };
}

// 등록한 뒤 실행 → 모든 작업이 끝날 때까지 기다림
export async function tickAll(engine) {
  const { promises } = await engine.tick();
  await Promise.all(promises);
  return promises.length;
}

// fetch 흉내: 순서대로 핸들러를 거쳐 응답을 돌려주고 요청을 기록합니다
export function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, redirect: init.redirect };
    calls.push(call);
    for (const route of routes) {
      if (route.used && route.once) continue;
      const methodOk = !route.method || route.method === call.method;
      const urlOk = typeof route.match === 'string' ? call.url.includes(route.match) : route.match.test(call.url);
      if (methodOk && urlOk) {
        route.used = true;
        const out = typeof route.reply === 'function' ? await route.reply(call) : route.reply;
        if (out instanceof Error) throw out;
        const { status = 200, json, text, headers = {} } = out;
        const body = json !== undefined ? JSON.stringify(json) : text ?? '';
        return new Response(status === 204 ? null : body, { status, headers: { 'content-type': json !== undefined ? 'application/json' : 'text/plain', ...headers } });
      }
    }
    throw new Error(`mockFetch: 예상하지 못한 요청 ${call.method} ${call.url}`);
  };
  fn.calls = calls;
  return fn;
}

export async function formFields(body) {
  // FormData → { name: [values] } (파일은 { name, size, type })
  const out = {};
  for (const [key, value] of body.entries()) {
    const v = typeof value === 'string' ? value : { name: value.name, size: value.size, type: value.type };
    (out[key] ??= []).push(v);
  }
  return out;
}
