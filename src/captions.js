// 채널별 소개글 만들기와 길이 검사 (Buffer의 "채널마다 문구 다르게" 기능의 최소판)

import { CHANNELS } from './config.js';
import { LIMITS } from './limits.js';

const URL_RE = /https?:\/\/[^\s<>"']+/g;

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC');
}

export function normalizeHashtags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw ?? '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, '');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(`#${tag}`);
  }
  return out;
}

// X(트위터) 글자 수 규칙: 한글·한자·이모지는 2, 영문·숫자는 1, 링크는 23 (twitter-text v3 기준)
const X_LIGHT_RANGES = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function xWeightedLength(text) {
  let weight = 0;
  const rest = normalizeText(text).replace(URL_RE, () => {
    weight += 23;
    return '';
  });
  for (const { segment } of segmenter.segment(rest)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) {
      weight += 2;
      continue;
    }
    for (const ch of segment) {
      const cp = ch.codePointAt(0);
      weight += X_LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
    }
  }
  return weight;
}

export const charLength = (text) => [...normalizeText(text)].length;
export const byteLength = (text) => Buffer.byteLength(normalizeText(text), 'utf8');

function fill(template, values) {
  return template.replace(/\{(title|caption|hashtags|links)\}/g, (m, key) => (key === 'links' ? m : values[key] ?? ''));
}

function tidy(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 채널 하나의 최종 제목·소개글을 만듭니다. {links} 는 게시 직전에 채워지므로 그대로 둡니다.
 */
export function buildChannelText(channel, { title, caption, hashtags }, config) {
  const templates = config.captions?.templates ?? {};
  const template = templates[channel] ?? templates.default ?? '{caption}\n\n{hashtags}';
  const max = config.captions?.maxHashtags?.[channel];
  const tags = normalizeHashtags(hashtags);
  const usedTags = Number.isFinite(max) ? tags.slice(0, max) : tags;
  const text = tidy(fill(template, { title: title ?? '', caption: normalizeText(caption), hashtags: usedTags.join(' ') }));
  return { title: normalizeText(title).trim(), caption: text, hashtags: usedTags, droppedHashtags: tags.length - usedTags.length };
}

// 게시 직전: {links} 를 같은 게시물의 이미 올라간 채널 주소로 바꿉니다 (예: 네이버 카페 글에 유튜브 쇼츠 링크)
export function resolveLinks(text, publishedJobs) {
  if (!String(text).includes('{links}')) return text;
  const lines = publishedJobs
    .filter((j) => j.resultUrl)
    .map((j) => `${CHANNELS[j.channel]?.label ?? j.channel}: ${j.resultUrl}`);
  return tidy(String(text).replaceAll('{links}', lines.join('\n')));
}

/**
 * 길이·형식 검사. errors 는 등록을 막고, warnings 는 알려주기만 합니다.
 */
export function checkText(channel, { title, caption, hashtags }) {
  const errors = [];
  const warnings = [];
  const limits = LIMITS[channel] ?? {};
  const bodyForCount = String(caption ?? '').replaceAll('{links}', '');
  const label = CHANNELS[channel]?.label ?? channel;

  if (limits.captionWeighted && xWeightedLength(bodyForCount) > limits.captionWeighted) {
    errors.push(`${label} 소개글이 너무 깁니다: ${xWeightedLength(bodyForCount)}/${limits.captionWeighted} (한글은 2자로 셉니다)`);
  }
  if (limits.captionChars && charLength(bodyForCount) > limits.captionChars) {
    errors.push(`${label} 소개글이 너무 깁니다: ${charLength(bodyForCount)}/${limits.captionChars}자`);
  }
  if (limits.captionBytes && byteLength(bodyForCount) > limits.captionBytes) {
    errors.push(`${label} 설명이 너무 깁니다: ${byteLength(bodyForCount)}/${limits.captionBytes}바이트`);
  }
  if (limits.titleChars) {
    if (!String(title ?? '').trim()) errors.push(`${label} 제목이 비어 있습니다`);
    else if (charLength(title) > limits.titleChars) errors.push(`${label} 제목이 너무 깁니다: ${charLength(title)}/${limits.titleChars}자`);
  }
  if (limits.noAngleBrackets && /[<>]/.test(`${title ?? ''}${caption ?? ''}`)) {
    errors.push(`${label} 제목·설명에는 < > 기호를 쓸 수 없습니다`);
  }
  if (limits.hashtagsMax && (hashtags?.length ?? 0) > limits.hashtagsMax) {
    errors.push(`${label} 해시태그는 ${limits.hashtagsMax}개까지입니다`);
  }
  if (!String(caption ?? '').trim() && limits.captionRequired) {
    errors.push(`${label} 소개글이 비어 있습니다`);
  }
  return { errors, warnings };
}
