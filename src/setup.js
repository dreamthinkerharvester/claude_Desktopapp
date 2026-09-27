// 설정 마법사: 질문 몇 개로 config.jsonc 를 채웁니다 (Upload-Post 무료 시험 → 유료 전환까지).
// 설정 파일의 설명 주석을 지키려고, 파일 전체를 새로 쓰지 않고 필요한 값만 바꿉니다.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accountState, listFacebookPages, listProfiles, UPLOADPOST_CHANNELS } from './adapters/uploadpost.js';
import { APP_ROOT, CHANNELS, normalizeConfig } from './config.js';
import { request } from './http.js';
import { parseJsonc } from './util/jsonc.js';
import { pad } from './util/text.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "키": "값" 형태의 문자열 값 하나를 바꿉니다 (파일에 한 번만 있어야 함)
export function setStringValue(text, key, value) {
  const re = new RegExp(`("${escapeRe(key)}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'g');
  const count = (text.match(re) ?? []).length;
  if (count !== 1) throw new Error(`설정 파일에서 "${key}" 항목을 하나로 찾지 못했습니다 (${count}곳). config.jsonc 를 직접 고쳐 주세요`);
  return text.replace(re, (_m, head) => `${head}${JSON.stringify(value)}`);
}

// channels 의 한 줄: "채널": { "enabled": true, "route": "..." }
export function setChannel(text, channel, { enabled, route }) {
  const re = new RegExp(`("${escapeRe(channel)}"\\s*:\\s*\\{\\s*"enabled"\\s*:\\s*)(true|false)(\\s*,\\s*"route"\\s*:\\s*)"[^"]*"`, 'g');
  const count = (text.match(re) ?? []).length;
  if (count !== 1) throw new Error(`설정 파일의 channels 에서 "${channel}" 을(를) 찾지 못했습니다. config.jsonc 를 직접 고쳐 주세요`);
  return text.replace(re, (_m, head, _enabled, mid) => `${head}${enabled ? 'true' : 'false'}${mid}"${route}"`);
}

const mask = (key) => (key && key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key ? '****' : '');
const icon = (s) => (s.state === 'connected' ? `✓${s.name ? ` ${s.name}` : ''}` : s.state === 'missing' ? '✗ 연결 안 됨' : '?');

/**
 * @param {object} opts
 * @param {string} opts.configPath
 * @param {(question: string, hint?: string) => Promise<string>} opts.ask  입력한 글자(빈 줄이면 '')를 돌려줌
 * @param {(line: string) => void} opts.print
 */
export async function runSetup({ configPath, ask, print, fetchImpl = globalThis.fetch }) {
  const existed = existsSync(configPath);
  let text = readFileSync(existed ? configPath : join(APP_ROOT, 'config.example.jsonc'), 'utf8');
  const current = parseJsonc(text);
  const up = current.routes?.uploadpost ?? {};
  const req = (url, opts = {}) => request(url, { fetchImpl, ...opts });

  print('SNS 발행기 설정을 시작합니다. [ ] 안의 값은 Enter 만 누르면 그대로 씁니다.');
  print(existed ? `기존 설정을 고칩니다: ${configPath}` : `새 설정 파일을 만듭니다: ${configPath}`);

  // 1) API 키 확인
  let apiKey = '';
  let profiles = [];
  for (let attempt = 1; attempt <= 3 && !apiKey; attempt += 1) {
    const answer = await ask('\n1/4 Upload-Post API 키를 붙여 넣어 주세요 (app.upload-post.com → API Keys)', up.apiKey ? `지금 키 ${mask(up.apiKey)} 유지` : '');
    const candidate = answer || up.apiKey || '';
    if (!candidate) {
      print('  API 키가 필요합니다.');
      continue;
    }
    try {
      profiles = await listProfiles({ apiKey: candidate }, req);
      apiKey = candidate;
    } catch (err) {
      print(`  ✗ 이 키로 확인하지 못했습니다: ${err.message}`);
    }
  }
  if (!apiKey) throw new Error('Upload-Post API 키를 확인하지 못해 설정을 멈춥니다. 키를 다시 복사해 설치 명령을 다시 실행해 주세요');
  if (!profiles.length) {
    throw new Error('Upload-Post 에 프로필이 없습니다. 대시보드에서 프로필을 만들고 SNS 계정(YouTube·Instagram·Facebook·Threads·X)을 연결한 뒤 다시 실행해 주세요');
  }
  print(`  ✓ 키 확인 완료 (프로필 ${profiles.length}개)`);

  // 2) 프로필 고르기
  let profile = profiles.find((p) => p.username === up.user) ?? profiles[0];
  if (profiles.length > 1) {
    print(`  프로필: ${profiles.map((p, i) => `${i + 1}) ${p.username}`).join('   ')}`);
    const answer = await ask('2/4 사용할 프로필 번호', String(profiles.indexOf(profile) + 1));
    const picked = answer ? profiles[Number(answer) - 1] : undefined;
    if (answer && !picked) print('  번호가 올바르지 않아 기본 프로필을 씁니다.');
    profile = picked ?? profile;
  } else {
    print(`2/4 프로필: ${profile.username}`);
  }
  const states = Object.fromEntries(UPLOADPOST_CHANNELS.map((ch) => [ch, accountState(profile, ch)]));
  print(`  연결된 계정: ${UPLOADPOST_CHANNELS.map((ch) => `${CHANNELS[ch].label} ${icon(states[ch])}`).join(' · ')}`);

  // 3) 요금제
  const wasPaid = current.channels?.tiktok?.route === 'uploadpost' && existed;
  const planAnswer = await ask('3/4 요금제: 1) 무료 (월 10회, TikTok 제외)   2) 유료', wasPaid ? '2' : '1');
  const paid = (planAnswer || (wasPaid ? '2' : '1')) === '2';

  // 4) 폴더
  const inboxDir = (await ask('4/4 수신함 폴더 (올릴 영상·카드뉴스가 모이는 곳)', current.inboxDir)) || current.inboxDir || '';
  if (inboxDir && !existsSync(inboxDir)) print('  ! 지금은 없는 폴더입니다 (외장 디스크가 연결돼 있는지 확인해 주세요). 그대로 저장합니다.');
  const archiveAnswer = await ask('    보관 폴더 (모두 올린 원본을 옮길 곳, 옮기지 않으려면 - 입력)', current.archiveDir);
  const archiveDir = archiveAnswer === '-' ? '' : archiveAnswer || current.archiveDir || '';

  // Facebook 페이지가 여러 개면 고르기 (한 개면 Upload-Post 가 알아서 고름)
  let facebookPageId = up.facebookPageId ?? '';
  if (states.facebook.state !== 'missing') {
    try {
      const pages = await listFacebookPages({ apiKey }, req, profile.username);
      if (pages.length > 1) {
        print(`  Facebook 페이지: ${pages.map((p, i) => `${i + 1}) ${p.name || p.id}`).join('   ')}`);
        const idx = Math.max(0, pages.findIndex((p) => p.id === facebookPageId));
        const answer = await ask('    올릴 페이지 번호', String(idx + 1));
        facebookPageId = (pages[Number(answer || idx + 1) - 1] ?? pages[idx]).id;
      } else if (pages.length === 1) {
        facebookPageId = '';
      }
    } catch {
      // 페이지 목록은 부가 기능: 못 읽어도 계속
    }
  }

  // 채널별 경로 정하기
  const plan = {};
  for (const ch of UPLOADPOST_CHANNELS) {
    if (ch === 'tiktok' && !paid) plan[ch] = { route: 'manual', note: '무료 플랜은 TikTok 제외 — 유료로 바꾼 뒤 설치 명령을 다시 실행하면 자동으로 전환' };
    else if (states[ch].state === 'missing') plan[ch] = { route: 'manual', note: 'Upload-Post 에 계정 연결 안 됨 — 연결한 뒤 설치 명령을 다시 실행' };
    else plan[ch] = { route: 'uploadpost' };
  }
  const cafeReady = current.channels?.naver_cafe?.route === 'naver_cafe' && current.routes?.naver_cafe?.clubId;
  plan.naver_cafe = cafeReady ? { route: 'naver_cafe' } : { route: 'manual', note: '카페 API 는 나중에 연결 (docs/채널-연결-가이드.md 4절)' };
  plan.naver_clip = { route: 'manual', note: '공개 API 없음' };

  for (const [ch, { route }] of Object.entries(plan)) text = setChannel(text, ch, { enabled: true, route });
  text = setStringValue(text, 'apiKey', apiKey);
  text = setStringValue(text, 'user', profile.username);
  text = setStringValue(text, 'facebookPageId', facebookPageId);
  text = setStringValue(text, 'inboxDir', inboxDir);
  text = setStringValue(text, 'archiveDir', archiveDir);

  // 저장 전에 설정이 올바른지 확인
  normalizeConfig(parseJsonc(text), dirname(configPath), configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, text, { mode: 0o600 });
  chmodSync(configPath, 0o600); // API 키가 들어 있으므로 본인만 읽게

  print(`\n설정을 저장했습니다: ${configPath}`);
  for (const [ch, { route, note }] of Object.entries(plan)) {
    print(`  ${pad(CHANNELS[ch].label, 16)}→ ${pad(route === 'uploadpost' ? 'Upload-Post 자동' : route === 'naver_cafe' ? '네이버 카페 API 자동' : '업로드 도우미', 18)}${note ?? ''}`);
  }
  if (!paid) print('\n무료 시험: 채널 1곳에 1번 올릴 때마다 1회. 예) 영상 1개를 5개 채널에 올리면 5회 (월 10회)');
  return { paid, profile: profile.username, plan };
}
