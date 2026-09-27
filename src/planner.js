// 발행 등록: 파일 확인 → 채널별 문구·시각 계산 → 검사. 저장은 하지 않습니다 (미리보기에도 씀).

import { randomBytes } from 'node:crypto';
import { basename, extname } from 'node:path';
import { CHANNELS, enabledChannels } from './config.js';
import { buildChannelText, checkText, normalizeHashtags, normalizeText } from './captions.js';
import { checkMedia, filesForChannel } from './limits.js';
import { inspectMedia } from './media.js';
import { addMinutes, formatLocal, parseDateTime } from './util/time.js';

export function newPostId(date, timeZone) {
  const day = formatLocal(date, timeZone).slice(0, 10).replaceAll('-', '');
  return `P${day}-${randomBytes(3).toString('hex')}`;
}

// 채널마다 영상/이미지 경로를 따로 둘 수 있습니다 (예: Instagram 영상은 meta, 카드뉴스는 uploadpost)
export function routeFor(chConfig, kind) {
  return kind === 'images' && chConfig?.imagesRoute ? chConfig.imagesRoute : chConfig?.route;
}

function randomGap([min, max], rng) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * @param {object} input  { media, title, caption, hashtags, channels, at, gapMinutes, times, overrides, allowDuplicate }
 * @returns {{ ok: boolean, errors: string[], warnings: string[], post?: object, jobs?: object[], channelNotes: object }}
 */
export async function planPost(input, { config, store, adapters, now = new Date(), rng = Math.random }) {
  const errors = [];
  const warnings = [];
  const channelNotes = {};
  const tz = config.timezone;

  let media;
  try {
    media = await inspectMedia(input.media);
  } catch (err) {
    return { ok: false, errors: [err.message], warnings, channelNotes };
  }
  const first = media.files[0];
  const title = normalizeText(input.title ?? '').trim() || (media.sourceDir ? basename(media.sourceDir) : basename(first.path, extname(first.path)));
  const caption = normalizeText(input.caption ?? '').trim();
  const hashtags = normalizeHashtags(input.hashtags ?? []);

  // 채널 고르기
  const explicit = Array.isArray(input.channels) && input.channels.length > 0;
  const requested = explicit ? [...new Set(input.channels)] : enabledChannels(config);
  const order = config.schedule.order;
  requested.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));

  const channels = [];
  const routes = {};
  for (const ch of requested) {
    const meta = CHANNELS[ch];
    if (!meta) {
      errors.push(`모르는 채널입니다: ${ch}`);
      continue;
    }
    const chConfig = config.channels[ch];
    if (!chConfig?.enabled) {
      errors.push(`${meta.label}: 설정에서 꺼져 있는 채널입니다 (config.jsonc 의 channels.${ch}.enabled)`);
      continue;
    }
    const route = routeFor(chConfig, media.kind);
    const adapter = adapters[route];
    const what = media.kind === 'video' ? '영상' : '이미지';
    let reason;
    if (!meta.kinds.includes(media.kind)) reason = `${what} 게시가 없는 채널입니다`;
    else if (!adapter) reason = `게시 경로 "${route}" 을(를) 찾을 수 없습니다`;
    else if (!adapter.supports?.(ch, media.kind)) {
      const hint = media.kind === 'images' ? ` (channels.${ch}.imagesRoute 로 이미지용 경로를 따로 지정할 수 있습니다)` : '';
      reason = `현재 게시 경로(${route})로는 ${what}을(를) 올릴 수 없습니다${hint}`;
    }
    if (reason) {
      if (explicit) errors.push(`${meta.label}: ${reason}`);
      else warnings.push(`${meta.label}: ${reason} — 이번 발행에서 제외했습니다`);
      continue;
    }
    channels.push(ch);
    routes[ch] = route;
  }
  if (!channels.length && !errors.length) errors.push('올릴 채널이 없습니다');

  // 시각 계산: 시작 시각 + 채널 사이 간격(무작위)
  let start;
  try {
    start = input.at && !['now', '지금'].includes(String(input.at).trim()) ? parseDateTime(input.at, tz) : now;
  } catch (err) {
    errors.push(err.message);
    start = now;
  }
  if (start.getTime() < now.getTime() - 5 * 60_000) errors.push(`시작 시각이 이미 지났습니다: ${formatLocal(start, tz)}`);
  const gap = input.gapMinutes ?? config.schedule.gapMinutes;
  const times = {};
  let t = start;
  channels.forEach((ch, i) => {
    if (i > 0) t = addMinutes(t, randomGap(gap, rng));
    times[ch] = t;
  });
  for (const [ch, value] of Object.entries(input.times ?? {})) {
    if (!channels.includes(ch) || !value) continue;
    try {
      times[ch] = parseDateTime(value, tz);
    } catch (err) {
      errors.push(`${CHANNELS[ch].label} 시각: ${err.message}`);
    }
  }

  // 채널별 문구
  const jobs = [];
  const trimmedTags = [];
  const postId = newPostId(now, tz);
  for (const ch of channels) {
    const override = input.overrides?.[ch] ?? {};
    const text = buildChannelText(
      ch,
      {
        title: override.title ?? title,
        caption: override.caption ?? caption,
        hashtags: override.hashtags ?? hashtags,
      },
      config,
    );
    // 직접 고쳐 쓴 문구는 템플릿을 거치지 않고 그대로 씁니다
    if (override.text != null) text.caption = normalizeText(override.text).trim();
    const note = { errors: [], warnings: [] };
    const textCheck = checkText(ch, text);
    const mediaCheck = checkMedia(ch, media.kind, media.files);
    const adapter = adapters[routes[ch]];
    const sentFiles = filesForChannel(ch, media.kind, media.files);
    const routeCheck = adapter?.validate?.(ch, { kind: media.kind, files: sentFiles }) ?? { errors: [], warnings: [] };
    note.errors.push(...textCheck.errors, ...mediaCheck.errors, ...routeCheck.errors);
    note.warnings.push(...textCheck.warnings, ...mediaCheck.warnings, ...routeCheck.warnings, ...(adapter?.textWarnings?.(ch, text.caption) ?? []));
    if (text.droppedHashtags > 0) {
      note.warnings.push(`해시태그 ${text.droppedHashtags}개는 채널 권장 개수를 넘어 뺐습니다`);
      trimmedTags.push(`${CHANNELS[ch].label} ${text.hashtags.length}개`);
    }

    const dup = store?.findDuplicate(media.mediaHash, ch);
    if (dup && !input.allowDuplicate) {
      note.errors.push(`같은 파일이 이미 등록되어 있습니다 (${dup.id}, 상태: ${dup.status})`);
    }
    channelNotes[ch] = note;
    errors.push(...note.errors.map((e) => `${CHANNELS[ch].label}: ${e}`));
    warnings.push(...note.warnings.filter((w) => !w.startsWith('해시태그 ')).map((w) => `${CHANNELS[ch].label}: ${w}`));

    jobs.push({
      id: `${postId}.${ch}`,
      channel: ch,
      route: routes[ch],
      runAt: times[ch].toISOString(),
      runAtLocal: formatLocal(times[ch], tz),
      options: { title: text.title, caption: text.caption, hashtags: text.hashtags },
    });
  }

  if (trimmedTags.length) warnings.push(`해시태그는 채널별 권장 개수만 붙였습니다 (${trimmedTags.join(', ')})`);

  const post = {
    id: postId,
    title,
    kind: media.kind,
    media: media.files,
    mediaHash: media.mediaHash,
    caption,
    hashtags,
    sourceDir: media.sourceDir,
  };
  return { ok: errors.length === 0, errors, warnings, post, jobs, channelNotes };
}

export async function createPost(input, deps) {
  const plan = await planPost(input, deps);
  if (!plan.ok) {
    const err = new Error(`등록할 수 없습니다:\n- ${plan.errors.join('\n- ')}`);
    err.plan = plan;
    throw err;
  }
  deps.store.createPost(plan.post, plan.jobs);
  return plan;
}
