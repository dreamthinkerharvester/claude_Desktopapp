import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './util/jsonc.js';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 채널 목록. kinds: 이 채널에 올릴 수 있는 콘텐츠 종류 (video = 쇼츠 영상, images = 카드뉴스 이미지)
export const CHANNELS = {
  youtube: { label: 'YouTube 쇼츠', kinds: ['video'] },
  instagram: { label: 'Instagram', kinds: ['video', 'images'] },
  facebook: { label: 'Facebook 페이지', kinds: ['video', 'images'] },
  tiktok: { label: 'TikTok', kinds: ['video', 'images'] },
  threads: { label: 'Threads', kinds: ['video', 'images'] },
  x: { label: 'X', kinds: ['video', 'images'] },
  naver_clip: { label: '네이버 클립', kinds: ['video'] },
  naver_cafe: { label: '네이버 카페', kinds: ['video', 'images'] },
};

export const DEFAULT_CONFIG = {
  timezone: 'Asia/Seoul',
  port: 4310,
  inboxDir: '',
  archiveDir: '',
  dataDir: './data',
  notify: true,
  aiGenerated: false,
  schedule: {
    order: ['youtube', 'instagram', 'facebook', 'tiktok', 'threads', 'x', 'naver_clip', 'naver_cafe'],
    gapMinutes: [25, 40],
    minGapSameChannelMinutes: 60,
  },
  retry: {
    maxAttempts: 5,
    backoffMinutes: [1, 5, 15, 30, 60],
  },
  processing: {
    pollSeconds: 20,
    timeoutMinutes: 120,
  },
  captions: {
    templates: {
      default: '{caption}\n\n{hashtags}',
      x: '{caption}\n{hashtags}',
      naver_cafe: '{caption}\n\n{links}',
    },
    maxHashtags: { x: 2, threads: 1, instagram: 5, tiktok: 5, youtube: 3, facebook: 3, naver_clip: 5, naver_cafe: 10 },
  },
  channels: Object.fromEntries(Object.keys(CHANNELS).map((ch) => [ch, { enabled: false, route: 'manual' }])),
  routes: {
    uploadpost: {},
    meta: {},
    youtube: {},
    naver_cafe: {},
    manual: {},
  },
};

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function defaultConfigPath() {
  return process.env.SNSPUB_CONFIG || join(APP_ROOT, 'config.jsonc');
}

export function loadConfig(configPath = defaultConfigPath()) {
  const file = resolve(configPath);
  if (!existsSync(file)) {
    const err = new Error(`설정 파일이 없습니다: ${file}\n먼저 "snspub init" 으로 만든 뒤 내용을 채워 주세요.`);
    err.code = 'NO_CONFIG';
    throw err;
  }
  let raw;
  try {
    raw = parseJsonc(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`설정 파일을 읽을 수 없습니다 (${file}): ${err.message}`);
  }
  return normalizeConfig(raw, dirname(file), file);
}

export function normalizeConfig(raw, baseDir = APP_ROOT, file = '') {
  const config = deepMerge(DEFAULT_CONFIG, raw ?? {});
  config.file = file;
  config.baseDir = baseDir;
  config.dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(baseDir, config.dataDir);
  for (const key of ['inboxDir', 'archiveDir']) {
    if (config[key]) config[key] = isAbsolute(config[key]) ? config[key] : resolve(baseDir, config[key]);
  }
  const problems = validateConfig(config);
  if (problems.length) {
    throw new Error(`설정 파일에 문제가 있습니다:\n- ${problems.join('\n- ')}`);
  }
  return config;
}

export function validateConfig(config) {
  const problems = [];
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timezone });
  } catch {
    problems.push(`timezone "${config.timezone}" 을(를) 알 수 없습니다`);
  }
  const gap = config.schedule?.gapMinutes;
  if (!Array.isArray(gap) || gap.length !== 2 || gap.some((n) => !Number.isFinite(n) || n < 0) || gap[0] > gap[1]) {
    problems.push('schedule.gapMinutes 는 [최소, 최대] 분 형태여야 합니다 (예: [25, 40])');
  }
  const routeNames = Object.keys(config.routes ?? {});
  for (const [channel, value] of Object.entries(config.channels ?? {})) {
    if (!CHANNELS[channel]) problems.push(`channels.${channel}: 모르는 채널입니다 (${Object.keys(CHANNELS).join(', ')})`);
    if (!value?.enabled) continue;
    for (const key of ['route', 'imagesRoute']) {
      if (value[key] && !routeNames.includes(value[key])) {
        problems.push(`channels.${channel}.${key} "${value[key]}" 은(는) 없는 게시 경로입니다 (${routeNames.join(', ')} 중 하나)`);
      }
    }
  }
  return problems;
}

// 같은 시각의 작업은 설정한 채널 순서대로 보여 줍니다
export function sortJobs(jobs, config) {
  const order = config.schedule?.order ?? [];
  const rank = (ch) => {
    const i = order.indexOf(ch);
    return i === -1 ? 99 : i;
  };
  return [...jobs].sort((a, b) => (a.runAt === b.runAt ? rank(a.channel) - rank(b.channel) : a.runAt < b.runAt ? -1 : 1));
}

export function enabledChannels(config) {
  const order = config.schedule.order.filter((ch) => CHANNELS[ch]);
  const rest = Object.keys(CHANNELS).filter((ch) => !order.includes(ch));
  return [...order, ...rest].filter((ch) => config.channels[ch]?.enabled);
}

// 화면에 보낼 설정 요약 (비밀값 제외)
export function publicConfig(config) {
  return {
    timezone: config.timezone,
    inboxDir: config.inboxDir,
    archiveDir: config.archiveDir,
    schedule: config.schedule,
    captions: config.captions,
    channels: Object.fromEntries(
      Object.entries(CHANNELS).map(([ch, meta]) => [
        ch,
        {
          label: meta.label,
          kinds: meta.kinds,
          enabled: !!config.channels[ch]?.enabled,
          route: config.channels[ch]?.route ?? 'manual',
          imagesRoute: config.channels[ch]?.imagesRoute,
        },
      ]),
    ),
  };
}
