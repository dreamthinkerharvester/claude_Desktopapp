import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { openApp, STATUS_LABELS } from './app.js';
import { APP_ROOT, CHANNELS, defaultConfigPath, enabledChannels, sortJobs } from './config.js';
import { registerMetaToken } from './oauth/meta.js';
import { createPost, planPost } from './planner.js';
import { startServer } from './server.js';
import { acquireLock, openUrl } from './system.js';
import { parseJsonc } from './util/jsonc.js';
import { formatLocal } from './util/time.js';

const HELP = `SNS 발행기 (snspub) — 나만 쓰는 최소 기능 예약 발행

  snspub init                         설정 파일(config.jsonc) 만들기
  snspub start                        예약 실행기 + 웹 화면 켜기 → http://127.0.0.1:4310
  snspub check [채널...]              채널 연결 확인 (게시하지 않음)

  snspub add <영상|이미지폴더> [옵션]  새 발행 등록
      --title "제목"   --caption "소개글"   --caption-file 소개글.txt
      --tags "#태그1 #태그2"   --channels youtube,instagram,x
      --at "2026-09-28 12:50" | --now      --gap 25-40 (채널 사이 간격, 분)
      --dry-run (등록하지 않고 미리보기만)   --allow-duplicate
  snspub import <발행.json> [--dry-run]  JSON 으로 등록 (Claude Code 가 만든 채널별 소개글 사용)

  snspub list [--all]                 발행 현황
  snspub show <게시물ID>              상세 + 기록
  snspub retry <작업ID>               실패·확인 필요 작업 다시 올리기
  snspub recheck <작업ID>             플랫폼 처리 상태 다시 확인
  snspub done <작업ID> [--url 주소]   직접 올린 작업을 게시 완료로 표시
  snspub cancel <게시물ID|작업ID>     예약 취소
  snspub tick                         예약 시각이 된 작업을 한 번만 처리 (점검용)
  snspub log                          최근 기록

  snspub auth google                  YouTube 로그인 (직접 연결을 쓸 때)
  snspub auth naver                   네이버 로그인 (네이버 카페)
  snspub auth meta --token <토큰>     Instagram·Facebook 토큰 등록 (직접 연결을 쓸 때)

  snspub install-launchd              맥 로그인 때 자동 실행 등록 (Mac mini 상시 실행)
  snspub uninstall-launchd            자동 실행 해제

채널 이름: ${Object.keys(CHANNELS).join(', ')}
작업ID 예: P20260928-a1b2c3.youtube   (게시물ID + . + 채널)
`;

const BOOLEAN_FLAGS = new Set(['dry-run', 'now', 'allow-duplicate', 'all', 'help', 'no-open']);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { cmd: positional[0] ?? 'help', args: positional.slice(1), flags };
}

const out = (...lines) => console.log(lines.join('\n'));
const pad = (text, n) => {
  const s = String(text ?? '');
  const width = [...s].reduce((w, ch) => w + (/[ᄀ-ᇿ　-鿿가-힣＀-￯]/.test(ch) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(1, n - width));
};

function parseGap(text) {
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(text).trim());
  if (!m) throw new Error('--gap 은 "25-40" 처럼 적어 주세요 (분)');
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return [Math.min(a, b), Math.max(a, b)];
}

function printPlan(plan, { saved }) {
  if (plan.post) {
    out('', `${saved ? '등록 완료' : '미리보기'}: ${plan.post.title}  [${plan.post.kind === 'video' ? '영상' : `이미지 ${plan.post.media.length}장`}]  ${saved ? plan.post.id : ''}`);
    for (const job of plan.jobs ?? []) {
      const label = CHANNELS[job.channel]?.label ?? job.channel;
      out(`  ${pad(label, 18)}${job.runAtLocal}  (${job.route})`);
      const preview = String(job.options.caption).split('\n').filter(Boolean)[0] ?? '';
      if (preview) out(`  ${' '.repeat(18)}"${preview.slice(0, 60)}${preview.length > 60 ? '…' : ''}"`);
    }
  }
  if (plan.warnings?.length) out('', '참고:', ...plan.warnings.map((w) => `  - ${w}`));
  if (plan.errors?.length) out('', '등록할 수 없는 이유:', ...plan.errors.map((e) => `  - ${e}`));
}

function printPost(store, post, config) {
  const tz = config.timezone;
  const jobs = sortJobs(store.getJobs(post.id), config);
  const status = { active: '진행 중', done: '완료', canceled: '취소' }[post.status] ?? post.status;
  out(`${post.id}  ${post.title}  [${post.kind === 'video' ? '영상' : `이미지 ${post.media.length}장`} · ${status}]`);
  for (const job of jobs) {
    const label = CHANNELS[job.channel]?.label ?? job.channel;
    let tail = job.resultUrl ?? '';
    if (['failed', 'needs_check'].includes(job.status) || (job.status === 'pending' && job.lastError)) tail = job.lastError ?? '';
    if (job.status === 'pending' && job.nextTryAt) tail = `재시도 ${formatLocal(job.nextTryAt, tz)} · ${tail}`;
    out(`  ${pad(label, 18)}${formatLocal(job.runAt, tz)}  ${pad(STATUS_LABELS[job.status] ?? job.status, 14)}${tail}`);
  }
}

async function ping(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function resolveMedia(media, baseDir) {
  const list = Array.isArray(media) ? media : [media];
  return list.map((p) => (isAbsolute(String(p)) ? String(p) : resolve(baseDir, String(p))));
}

const LAUNCHD_LABEL = 'com.snspub.agent';

// Homebrew 의 node 는 버전 폴더(/Cellar/...)에 있어 업그레이드하면 경로가 사라집니다 → 고정 경로를 씁니다
function stableNodePath() {
  if (!process.execPath.includes('/Cellar/')) return process.execPath;
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p)) ?? process.execPath;
}

function launchdPlist({ node, script, configFile, logDir }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${esc(script)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SNSPUB_CONFIG</key><string>${esc(configFile)}</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>${esc(dirname(script))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>75</integer>
  <key>StandardOutPath</key><string>${esc(join(logDir, 'snspub.out.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logDir, 'snspub.err.log'))}</string>
</dict>
</plist>
`;
}

async function run(cmd, args, flags) {
  const configPath = flags.config ? resolve(String(flags.config)) : defaultConfigPath();

  if (cmd === 'help' || flags.help) {
    out(HELP);
    return 0;
  }

  if (cmd === 'init') {
    if (existsSync(configPath)) {
      out(`이미 설정 파일이 있습니다: ${configPath}`);
      return 0;
    }
    mkdirSync(dirname(configPath), { recursive: true });
    copyFileSync(join(APP_ROOT, 'config.example.jsonc'), configPath);
    out(`설정 파일을 만들었습니다: ${configPath}`, '', '다음 순서:', '  1) config.jsonc 를 열어 폴더 경로와 채널별 게시 경로·키를 채웁니다', '  2) snspub check   (채널 연결 확인)', '  3) snspub start   (http://127.0.0.1:4310 에서 발행)');
    return 0;
  }

  if (cmd === 'install-launchd' || cmd === 'uninstall-launchd') {
    if (process.platform !== 'darwin') throw new Error('launchd 자동 실행은 macOS 에서만 쓸 수 있습니다');
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const domain = `gui/${process.getuid()}`;
    try {
      execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    } catch {
      // 등록돼 있지 않았으면 무시
    }
    if (cmd === 'uninstall-launchd') {
      rmSync(plistPath, { force: true });
      out('자동 실행을 해제했습니다.');
      return 0;
    }
    const { config } = openApp({ configPath });
    const logDir = join(config.dataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, launchdPlist({ node: stableNodePath(), script: join(APP_ROOT, 'bin', 'snspub.js'), configFile: config.file, logDir }));
    execFileSync('launchctl', ['bootstrap', domain, plistPath]);
    out(`자동 실행을 등록했습니다: ${plistPath}`, `로그: ${logDir}`, `화면: http://127.0.0.1:${config.port}`, '', '외장 디스크의 파일을 읽으려면 [시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한]에', `${process.execPath} 을(를) 추가해야 할 수 있습니다 (node 를 업그레이드하면 새 경로로 다시 추가).`);
    return 0;
  }

  const app = openApp({ configPath });
  const { config, store, engine, adapters } = app;
  const tz = config.timezone;
  const deps = { config, store, adapters };

  try {
    switch (cmd) {
      case 'start': {
        const release = acquireLock(config.dataDir);
        const port = flags.port ? Number(flags.port) : config.port;
        let server;
        try {
          server = await startServer(app, { port });
        } catch (err) {
          release();
          if (err.code === 'EADDRINUSE') throw new Error(`포트 ${port} 이(가) 이미 사용 중입니다. 다른 snspub 이 켜져 있는지 확인하거나 --port 로 바꿔 주세요`);
          throw err;
        }
        engine.start(15_000);
        out(`SNS 발행기 실행 중 → http://127.0.0.1:${port}   (끄려면 Ctrl+C)`);
        await new Promise((done) => {
          const shutdown = async () => {
            out('끄는 중... (올리는 중인 작업이 있으면 최대 1분 기다립니다)');
            server.close();
            await engine.stop();
            store.close();
            release();
            done();
          };
          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);
        });
        return 0;
      }

      case 'tick': {
        const release = acquireLock(config.dataDir);
        try {
          engine.recover();
          const { started, promises } = await engine.tick();
          await Promise.allSettled(promises);
          out(`처리한 작업: ${started}개`);
          for (const post of store.listPosts({ limit: 10, includeDone: false })) printPost(store, post, config);
        } finally {
          release();
        }
        return 0;
      }

      case 'check': {
        const channels = args.length ? args : enabledChannels(config);
        let bad = 0;
        if (!args.length) {
          const folders = [
            [!!config.inboxDir && existsSync(config.inboxDir), `수신함 폴더    ${config.inboxDir || '(config.jsonc 의 inboxDir 가 비어 있음)'}`],
            [!config.archiveDir || existsSync(config.archiveDir) || existsSync(dirname(config.archiveDir)), `보관 폴더      ${config.archiveDir || '(설정 안 함 — 원본을 옮기지 않음)'}`],
          ];
          for (const [ok, text] of folders) {
            if (!ok) bad += 1;
            out(`${ok ? '✓' : '✗'} ${text}`);
          }
          out('');
        }
        if (!channels.length) out('켜진 채널이 없습니다. config.jsonc 의 channels 를 확인해 주세요.');
        for (const ch of channels) {
          const r = await engine.checkChannel(ch);
          if (!r.ok) bad += 1;
          out(`${r.ok ? '✓' : '✗'} ${pad(CHANNELS[ch]?.label ?? ch, 18)}${r.account ? `${r.account}  ` : ''}${r.message ?? ''}`);
        }
        return bad ? 1 : 0;
      }

      case 'add': {
        if (!args.length) throw new Error('올릴 영상 파일이나 이미지 폴더 경로를 적어 주세요. 예) snspub add "/Volumes/MacData/1. 최종콘텐츠/업로드 예정/영상.mp4"');
        const input = {
          media: args.map((p) => resolve(p)),
          title: typeof flags.title === 'string' ? flags.title : undefined,
          caption: typeof flags['caption-file'] === 'string' ? readFileSync(resolve(flags['caption-file']), 'utf8') : typeof flags.caption === 'string' ? flags.caption : undefined,
          hashtags: typeof flags.tags === 'string' ? flags.tags : undefined,
          channels: typeof flags.channels === 'string' ? flags.channels.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          at: flags.now ? 'now' : typeof flags.at === 'string' ? flags.at : undefined,
          gapMinutes: typeof flags.gap === 'string' ? parseGap(flags.gap) : undefined,
          allowDuplicate: !!flags['allow-duplicate'],
        };
        if (flags['dry-run']) {
          const plan = await planPost(input, deps);
          printPlan(plan, { saved: false });
          return plan.ok ? 0 : 1;
        }
        try {
          const plan = await createPost(input, deps);
          printPlan(plan, { saved: true });
          return 0;
        } catch (err) {
          if (err.plan) {
            printPlan(err.plan, { saved: false });
            return 1;
          }
          throw err;
        }
      }

      case 'import': {
        const file = args[0] ? resolve(args[0]) : undefined;
        if (!file || !existsSync(file)) throw new Error('불러올 JSON 파일 경로를 적어 주세요');
        const raw = parseJsonc(readFileSync(file, 'utf8'));
        const items = Array.isArray(raw) ? raw : Array.isArray(raw.posts) ? raw.posts : [raw];
        let failed = 0;
        for (const item of items) {
          const input = { ...item, media: resolveMedia(item.media, dirname(file)), ...(flags['allow-duplicate'] ? { allowDuplicate: true } : {}) };
          try {
            if (flags['dry-run']) {
              const plan = await planPost(input, deps);
              printPlan(plan, { saved: false });
              if (!plan.ok) failed += 1;
            } else {
              printPlan(await createPost(input, deps), { saved: true });
            }
          } catch (err) {
            failed += 1;
            if (err.plan) printPlan(err.plan, { saved: false });
            else out(`✗ ${item.title ?? item.media}: ${err.message}`);
          }
        }
        out('', `${items.length}건 중 ${items.length - failed}건 ${flags['dry-run'] ? '확인' : '등록'}`);
        return failed ? 1 : 0;
      }

      case 'list': {
        const posts = store.listPosts({ limit: flags.all ? 200 : 15 });
        if (!posts.length) out('등록된 발행이 없습니다. "snspub add <파일>" 또는 웹 화면에서 등록해 주세요.');
        for (const post of posts) {
          printPost(store, post, config);
          out('');
        }
        return 0;
      }

      case 'show': {
        const post = store.getPost(args[0] ?? '');
        if (!post) throw new Error(`게시물을 찾을 수 없습니다: ${args[0] ?? ''}`);
        printPost(store, post, config);
        out('', '파일:', ...post.media.map((f) => `  ${f.path}${f.duration ? `  (${f.duration}초${f.width ? `, ${f.width}x${f.height}` : ''})` : ''}`));
        out('', '기록:');
        for (const e of store.listEvents({ postId: post.id, limit: 50 }).reverse()) out(`  ${formatLocal(e.at, tz)}  ${e.level === 'error' ? '✗' : e.level === 'warn' ? '!' : '·'} ${e.message}`);
        return 0;
      }

      case 'retry':
      case 'recheck':
      case 'done': {
        const id = args[0];
        if (!id) throw new Error('작업ID 를 적어 주세요 (예: P20260928-a1b2c3.youtube). "snspub list" 로 확인할 수 있습니다');
        const job = cmd === 'retry' ? engine.retry(id) : cmd === 'recheck' ? engine.recheck(id) : engine.markDone(id, typeof flags.url === 'string' ? flags.url : undefined);
        out(`${job.id}: ${STATUS_LABELS[job.status]}${cmd === 'retry' ? ' — 실행기가 켜져 있으면 곧 다시 올립니다' : ''}`);
        return 0;
      }

      case 'cancel': {
        const id = args[0];
        if (!id) throw new Error('게시물ID 또는 작업ID 를 적어 주세요');
        if (id.includes('.')) {
          engine.cancel(id);
          out(`${id}: 취소했습니다`);
        } else {
          const { skipped } = engine.cancelPost(id);
          out(`${id}: 취소했습니다${skipped.length ? ` (올리는 중이라 취소 못 한 작업: ${skipped.map((j) => j.channel).join(', ')})` : ''}`);
        }
        return 0;
      }

      case 'log': {
        for (const e of store.listEvents({ limit: Number(flags.limit) || 40 }).reverse()) {
          out(`${formatLocal(e.at, tz)}  ${e.level === 'error' ? '✗' : e.level === 'warn' ? '!' : '·'} ${e.postId ? `[${e.postId}] ` : ''}${e.message}`);
        }
        return 0;
      }

      case 'auth': {
        const provider = args[0];
        if (provider === 'meta') {
          if (typeof flags.token !== 'string') throw new Error('사용법: snspub auth meta --token <그래프 API 탐색기에서 받은 사용자 토큰> [--page <페이지ID>]');
          const r = await registerMetaToken({ route: config.routes?.meta ?? {}, userToken: flags.token, pageId: typeof flags.page === 'string' ? flags.page : undefined, store });
          out(`Meta 토큰 저장 완료: 페이지 ${r.pageName} (${r.pageId})${r.igUsername ? ` / Instagram @${r.igUsername}` : ' — 이 페이지에 연결된 Instagram 비즈니스 계정이 없습니다'}`);
          return 0;
        }
        if (!['google', 'naver'].includes(provider)) throw new Error('사용법: snspub auth google | naver | meta --token <토큰>');
        const port = config.port;
        const startUrl = `http://127.0.0.1:${port}/oauth/${provider}/start`;
        if (await ping(port)) {
          out(`브라우저에서 로그인해 주세요: ${startUrl}`);
          if (!flags['no-open']) openUrl(startUrl);
          return 0;
        }
        const before = JSON.stringify(store.getToken(provider) ?? null);
        const server = await startServer(app, { port });
        out(`브라우저에서 로그인해 주세요: ${startUrl}`, '(로그인이 끝나면 자동으로 종료됩니다. 10분 제한)');
        if (!flags['no-open']) openUrl(startUrl);
        const deadline = Date.now() + 10 * 60_000;
        let done = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          if (JSON.stringify(store.getToken(provider) ?? null) !== before) {
            done = true;
            break;
          }
        }
        server.close();
        out(done ? '로그인 정보를 저장했습니다. "snspub check" 로 확인해 보세요.' : '시간이 지나 종료합니다. 다시 시도해 주세요.');
        return done ? 0 : 1;
      }

      default:
        out(`모르는 명령입니다: ${cmd}`, '', HELP);
        return 1;
    }
  } finally {
    if (cmd !== 'start') store.close();
  }
}

export async function main(argv) {
  const { cmd, args, flags } = parseArgs(argv);
  try {
    return await run(cmd, args, flags);
  } catch (err) {
    console.error(`오류: ${err.message}`);
    return 1;
  }
}
