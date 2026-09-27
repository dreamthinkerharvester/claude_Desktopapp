// 게시 경로(어댑터) 목록. 채널마다 config.jsonc 의 channels.<채널>.route 로 고릅니다.
//
// 어댑터 규약 (Postiz 의 provider 구조를 1인용으로 줄인 것)
//   supports(channel, kind)  → 이 경로로 해당 채널에 영상(video)/이미지(images)를 올릴 수 있는가
//   check(channel, ctx)      → { ok, account?, message? }   연결 확인 (읽기 전용, 게시하지 않음)
//   publish(job, ctx)        → Result                        올리기 시작
//   resume(job, ctx)         → Result                        처리 중 작업 이어가기 (상태 조회 → 필요하면 마무리)
//   canResume(job)           → boolean                       job.remote 기록만으로 안전하게 이어갈 수 있는가
//
//   Result = { status: 'published', url?, id?, warning? }
//          | { status: 'processing', pollAfterSec? }
//          | { status: 'manual' }
//          | { status: 'needs_check', message, url?, id? }
//   실패는 errors.js 의 PublishError(kind) 를 던집니다.
//   되돌릴 수 없는 요청(게시 확정) 직전에는 반드시 ctx.checkpoint({...}) 로 진행 상황을 남깁니다.

import manual from './manual.js';
import meta from './meta.js';
import naverCafe from './naver-cafe.js';
import uploadpost from './uploadpost.js';
import youtube from './youtube.js';

export const adapters = {
  uploadpost,
  meta,
  youtube,
  naver_cafe: naverCafe,
  manual,
};

export const ROUTE_LABELS = Object.fromEntries(Object.entries(adapters).map(([key, a]) => [key, a.label]));
