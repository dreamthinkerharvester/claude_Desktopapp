// 반자동(업로드 도우미): API 가 없는 채널(네이버 클립 등)이나 자동 경로를 쓰지 않을 채널용.
// 예약 시각이 되면 "직접 올릴 차례"로 알려 주고, 화면의 [업로드 도우미] 버튼이
// ① 소개글을 클립보드에 복사 ② 업로드 페이지를 열고 ③ Finder 에서 파일을 보여 줍니다.
// 올린 뒤 [완료] 를 누르면 게시 완료로 기록됩니다. (보고서: "클립은 반자동")

export const DEFAULT_UPLOAD_URLS = {
  youtube: 'https://studio.youtube.com/',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://business.facebook.com/latest/home',
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
  threads: 'https://www.threads.com/',
  x: 'https://x.com/compose/post',
  naver_clip: 'https://clipcreators.naver.com/',
  naver_cafe: 'https://cafe.naver.com/',
};

export function uploadUrlFor(channel, config) {
  return config.routes?.manual?.urls?.[channel] ?? config.channels?.[channel]?.uploadUrl ?? DEFAULT_UPLOAD_URLS[channel];
}

export default {
  name: 'manual',
  label: '직접 올리기 (업로드 도우미)',
  supports: () => true,
  async check(channel, ctx) {
    return { ok: true, message: `직접 올리는 채널입니다 — 업로드 페이지: ${uploadUrlFor(channel, ctx.config)}` };
  },
  async publish() {
    return { status: 'manual' };
  },
  canResume: () => false,
};
