// 이 Mac 에서만 열리는 작은 웹 화면 (http://127.0.0.1:4310). 외부에서는 접속할 수 없습니다.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveLinks } from './captions.js';
import { APP_ROOT, CHANNELS, publicConfig, sortJobs } from './config.js';
import { ROUTE_LABELS } from './adapters/index.js';
import { uploadUrlFor } from './adapters/manual.js';
import { STATUS_LABELS } from './app.js';
import { googleAuthUrl, googleExchangeCode, pkcePair } from './oauth/google.js';
import { naverAuthUrl, naverExchangeCode } from './oauth/naver.js';
import { registerMetaToken } from './oauth/meta.js';
import { isInside, listInbox, MIME } from './media.js';
import { createPost, planPost } from './planner.js';
import { openUrl, revealInFinder } from './system.js';
import { formatLocal } from './util/time.js';

const UI_DIR = join(APP_ROOT, 'ui');
const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function page(res, status, title, message) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  send(
    res,
    status,
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:-apple-system,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.6"><h2>${esc(title)}</h2><p style="white-space:pre-wrap">${esc(message)}</p><p><a href="/">← 발행 화면으로</a></p></body>`,
    'text/html; charset=utf-8',
  );
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('요청이 너무 큽니다'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 형식이 아닙니다'), { status: 400 });
  }
}

function sendFile(req, res, path) {
  const st = statSync(path);
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    let start = range[1] === '' ? undefined : Number(range[1]);
    let end = range[2] === '' ? undefined : Number(range[2]);
    if (start === undefined) {
      start = Math.max(0, st.size - (end ?? 0));
      end = st.size - 1;
    }
    end = Math.min(end ?? st.size - 1, st.size - 1);
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
  createReadStream(path).pipe(res);
}

export function stateSnapshot({ config, store, engine }) {
  const tz = config.timezone;
  const posts = store.listPosts({ limit: 60 }).map((post) => {
    const jobs = sortJobs(store.getJobs(post.id), config);
    const published = jobs.filter((j) => j.status === 'published');
    return {
    ...post,
    media: post.media.map((f) => ({ path: f.path, name: f.name, size: f.size, duration: f.duration, width: f.width, height: f.height })),
    createdAtLocal: formatLocal(post.createdAt, tz),
    jobs: jobs.map((job) => ({
      ...job,
      // 업로드 도우미가 복사할 문구: {links} 를 지금까지 올라간 주소로 채움
      options: { ...job.options, caption: resolveLinks(job.options.caption ?? '', published.filter((p) => p.id !== job.id)) },
      label: CHANNELS[job.channel]?.label ?? job.channel,
      statusLabel: STATUS_LABELS[job.status] ?? job.status,
      runAtLocal: formatLocal(job.runAt, tz),
      nextTryAtLocal: job.nextTryAt ? formatLocal(job.nextTryAt, tz) : undefined,
      publishedAtLocal: job.publishedAt ? formatLocal(job.publishedAt, tz) : undefined,
      uploadUrl: job.route === 'manual' ? uploadUrlFor(job.channel, config) : undefined,
      canRecheck: engine.canResume(job),
      remote: undefined,
    })),
    };
  });
  const channels = Object.keys(CHANNELS).map((ch) => ({
    channel: ch,
    label: CHANNELS[ch].label,
    enabled: !!config.channels[ch]?.enabled,
    route: config.channels[ch]?.route,
    imagesRoute: config.channels[ch]?.imagesRoute,
    routeLabel: ROUTE_LABELS[config.channels[ch]?.route] ?? config.channels[ch]?.route,
    imagesRouteLabel: config.channels[ch]?.imagesRoute ? ROUTE_LABELS[config.channels[ch].imagesRoute] ?? config.channels[ch].imagesRoute : undefined,
    ...store.getChannelState(ch),
    checkedAtLocal: store.getChannelState(ch).checkedAt ? formatLocal(store.getChannelState(ch).checkedAt, tz) : undefined,
  }));
  return { now: new Date().toISOString(), nowLocal: formatLocal(new Date(), tz), config: publicConfig(config), channels, posts, statusLabels: STATUS_LABELS };
}

export function createApp({ config, store, engine, adapters }) {
  const port = config.port;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const oauthStates = new Map();
  const deps = { config, store, adapters };

  const redirectUri = (req, provider) => {
    const host = allowedHosts.has(req.headers.host) ? req.headers.host : `127.0.0.1:${port}`;
    const fixed = config.routes?.[provider === 'naver' ? 'naver_cafe' : provider]?.redirectUri;
    return fixed || `http://${host}/oauth/${provider}/callback`;
  };

  // 브라우저에서 보여줘도 되는 파일인지 (수신함·보관함·등록된 콘텐츠만)
  const canServe = (path) => {
    const p = resolve(path);
    if ([config.inboxDir, config.archiveDir].some((dir) => dir && isInside(p, dir))) return true;
    return store.listPosts({ limit: 500 }).some((post) => post.media.some((f) => resolve(f.path) === p));
  };

  async function handle(req, res) {
    if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { error: '허용되지 않은 주소입니다' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'GET' && STATIC[path]) {
      const file = join(UI_DIR, STATIC[path]);
      return send(res, 200, readFileSync(file), STATIC_TYPES[extname(file)]);
    }

    if (req.method === 'GET') {
      if (path === '/api/ping') return send(res, 200, { ok: true, app: 'snspub' });
      if (path === '/api/state') return send(res, 200, stateSnapshot({ config, store, engine }));
      if (path === '/api/inbox') return send(res, 200, { inboxDir: config.inboxDir, items: listInbox(config.inboxDir, { exclude: [config.archiveDir] }) });
      if (path === '/api/events') return send(res, 200, { events: store.listEvents({ limit: Number(url.searchParams.get('limit')) || 100 }).map((e) => ({ ...e, atLocal: formatLocal(e.at, config.timezone) })) });
      if (path === '/file') {
        const file = url.searchParams.get('path') ?? '';
        if (!file || !existsSync(file) || !statSync(file).isFile() || !canServe(file)) return send(res, 404, { error: '파일을 열 수 없습니다' });
        return sendFile(req, res, file);
      }
      if (path === '/oauth/google/start') {
        const { clientId } = config.routes?.youtube ?? {};
        if (!clientId) return page(res, 400, 'YouTube 로그인 설정 필요', 'config.jsonc 의 routes.youtube.clientId / clientSecret 을 먼저 채워 주세요. (README 의 "YouTube 직접 연결" 참고)');
        const state = randomBytes(16).toString('hex');
        const { verifier, challenge } = pkcePair();
        const uri = redirectUri(req, 'google');
        oauthStates.set(state, { provider: 'google', verifier, redirectUri: uri, at: Date.now() });
        res.writeHead(302, { Location: googleAuthUrl({ clientId, redirectUri: uri, state, codeChallenge: challenge }) });
        return res.end();
      }
      if (path === '/oauth/naver/start') {
        const { clientId } = config.routes?.naver_cafe ?? {};
        if (!clientId) return page(res, 400, '네이버 로그인 설정 필요', 'config.jsonc 의 routes.naver_cafe.clientId / clientSecret 을 먼저 채워 주세요. (README 의 "네이버 카페 연결" 참고)');
        const state = randomBytes(16).toString('hex');
        const uri = redirectUri(req, 'naver');
        oauthStates.set(state, { provider: 'naver', redirectUri: uri, at: Date.now() });
        res.writeHead(302, { Location: naverAuthUrl({ clientId, redirectUri: uri, state }) });
        return res.end();
      }
      const callback = /^\/oauth\/(google|naver)\/callback$/.exec(path);
      if (callback) {
        const provider = callback[1];
        const state = url.searchParams.get('state') ?? '';
        const saved = oauthStates.get(state);
        oauthStates.delete(state);
        if (url.searchParams.get('error')) return page(res, 400, '로그인이 취소되었습니다', url.searchParams.get('error_description') ?? url.searchParams.get('error'));
        if (!saved || saved.provider !== provider || Date.now() - saved.at > 15 * 60_000) return page(res, 400, '로그인 확인 실패', '로그인 요청이 만료되었거나 올바르지 않습니다. 다시 시도해 주세요.');
        const code = url.searchParams.get('code') ?? '';
        try {
          if (provider === 'google') {
            const { clientId, clientSecret } = config.routes.youtube;
            const token = await googleExchangeCode({ clientId, clientSecret, code, redirectUri: saved.redirectUri, codeVerifier: saved.verifier });
            store.setToken('google', token);
          } else {
            const { clientId, clientSecret } = config.routes.naver_cafe;
            const token = await naverExchangeCode({ clientId, clientSecret, code, state });
            store.setToken('naver', token);
          }
          store.addEvent('info', `${provider === 'google' ? 'YouTube(Google)' : '네이버'} 로그인 완료`);
          return page(res, 200, '로그인 완료', '이 창을 닫고 발행 화면에서 "연결 확인"을 눌러 주세요.');
        } catch (err) {
          return page(res, 400, '로그인 실패', err.message);
        }
      }
      return send(res, 404, { error: '없는 주소입니다' });
    }

    if (req.method !== 'POST') return send(res, 405, { error: '허용되지 않은 요청입니다' });
    // 다른 웹사이트가 몰래 요청하지 못하게: JSON 요청 + 같은 출처만 허용
    if (!(req.headers['content-type'] ?? '').includes('application/json')) return send(res, 415, { error: 'JSON 요청만 받습니다' });
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return send(res, 403, { error: '허용되지 않은 출처입니다' });
    const body = await readJson(req);

    if (path === '/api/preview') {
      const plan = await planPost(body, deps);
      return send(res, 200, summarizePlan(plan, config));
    }
    if (path === '/api/posts') {
      try {
        const plan = await createPost(body, deps);
        return send(res, 200, summarizePlan(plan, config));
      } catch (err) {
        if (err.plan) return send(res, 400, summarizePlan(err.plan, config));
        throw err;
      }
    }
    if (path === '/api/auth/meta') {
      const result = await registerMetaToken({ route: config.routes?.meta ?? {}, userToken: body.userToken, pageId: body.pageId, store });
      return send(res, 200, result);
    }
    let m = /^\/api\/jobs\/([^/]+)\/(retry|recheck|done|cancel|edit|reveal|open)$/.exec(path);
    if (m) {
      const [, id, action] = m;
      const jobId = decodeURIComponent(id);
      if (action === 'retry') return send(res, 200, { job: engine.retry(jobId) });
      if (action === 'recheck') return send(res, 200, { job: engine.recheck(jobId) });
      if (action === 'done') return send(res, 200, { job: engine.markDone(jobId, body.url) });
      if (action === 'cancel') return send(res, 200, { job: engine.cancel(jobId) });
      if (action === 'edit') return send(res, 200, { job: engine.editJob(jobId, body) });
      const job = engine.mustGetJob(jobId);
      const post = store.getPost(job.postId);
      if (action === 'reveal') return send(res, 200, { ok: revealInFinder(post.media[0]?.path ?? '') });
      if (action === 'open') return send(res, 200, { ok: openUrl(job.resultUrl ?? '') });
    }
    m = /^\/api\/posts\/([^/]+)\/cancel$/.exec(path);
    if (m) return send(res, 200, engine.cancelPost(decodeURIComponent(m[1])));
    m = /^\/api\/channels\/([^/]+)\/(check|unblock)$/.exec(path);
    if (m) {
      const channel = decodeURIComponent(m[1]);
      if (m[2] === 'check') return send(res, 200, await engine.checkChannel(channel));
      store.setChannelState(channel, { blocked: false, reason: null });
      store.addEvent('info', `${CHANNELS[channel]?.label ?? channel}: 보류 해제 (수동)`);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: '없는 주소입니다' });
  }

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (!res.headersSent) send(res, err.status ?? 400, { error: err.message ?? String(err) });
      else res.end();
    }
  };
}

function summarizePlan(plan, config) {
  return {
    ok: plan.ok,
    errors: plan.errors,
    warnings: plan.warnings,
    channelNotes: plan.channelNotes,
    post: plan.post && {
      id: plan.post.id,
      title: plan.post.title,
      kind: plan.post.kind,
      files: plan.post.media.map((f) => ({ path: f.path, name: f.name, size: f.size, duration: f.duration, width: f.width, height: f.height })),
    },
    jobs: (plan.jobs ?? []).map((j) => ({ ...j, label: CHANNELS[j.channel]?.label ?? j.channel, runAtLocal: formatLocal(j.runAt, config.timezone) })),
  };
}

export function startServer(deps, { port = deps.config.port, host = '127.0.0.1' } = {}) {
  const server = createServer(createApp({ ...deps, config: { ...deps.config, port } }));
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}
