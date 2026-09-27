// 채널별 제한값. 등록 단계에서 미리 걸러 업로드 실패를 줄입니다.
// 플랫폼 정책이 바뀌면 이 표만 고치면 됩니다. (근거와 확인 날짜는 docs/채널별-제한.md)
//
// captionChars   : 소개글 최대 글자 수
// captionWeighted: X 방식 가중치 글자 수 (한글 2자)
// captionBytes   : 바이트 기준 최대 길이
// titleChars     : 제목 최대 글자 수 (있으면 제목 필수)
// video.minSec/maxSec : 영상 길이
// images.min/max : 이미지 장수 (0 이면 이미지 게시 불가)

export const LIMITS = {
  youtube: {
    titleChars: 100,
    captionBytes: 5000,
    noAngleBrackets: true,
    video: { maxSec: 180 },
    images: { max: 0 },
  },
  instagram: {
    captionChars: 2200,
    hashtagsMax: 30,
    video: { minSec: 3, maxSec: 900 },
    images: { min: 1, max: 10 },
    imageAspect: { min: 0.8, max: 1.91 },
  },
  facebook: {
    captionChars: 60000,
    video: { minSec: 3, maxSec: 90 },
    images: { min: 1, max: 10 },
  },
  tiktok: {
    captionChars: 2200,
    video: { minSec: 3, maxSec: 600 },
    images: { min: 1, max: 35 },
  },
  threads: {
    captionChars: 500,
    video: { maxSec: 300 },
    images: { min: 1, max: 20 },
  },
  x: {
    captionWeighted: 280,
    video: { minSec: 0.5, maxSec: 140 },
    images: { min: 1, max: 4 },
  },
  naver_clip: {
    video: { maxSec: 600 },
    images: { max: 0 },
  },
  naver_cafe: {
    titleChars: 100,
    images: { min: 0, max: 10 },
  },
};

// 채널이 한 게시물에 받는 만큼만 이미지를 넘깁니다 (예: X 는 앞 4장)
export function filesForChannel(channel, kind, files) {
  const max = kind === 'images' ? LIMITS[channel]?.images?.max : undefined;
  return max ? files.slice(0, max) : files;
}

export function checkMedia(channel, kind, files) {
  const errors = [];
  const warnings = [];
  const limits = LIMITS[channel] ?? {};
  if (kind === 'video') {
    const v = files[0] ?? {};
    const { minSec, maxSec } = limits.video ?? {};
    if (v.duration == null) {
      warnings.push('영상 길이를 읽지 못해 길이 검사를 건너뜁니다');
    } else {
      if (maxSec && v.duration > maxSec) errors.push(`영상이 ${Math.round(v.duration)}초로 최대 ${maxSec}초를 넘습니다`);
      if (minSec && v.duration < minSec) errors.push(`영상이 ${v.duration}초로 최소 ${minSec}초보다 짧습니다`);
    }
    if (v.width && v.height && v.width > v.height) warnings.push('가로 영상입니다 (쇼츠·릴스는 세로 9:16 권장)');
  } else {
    const { min = 1, max } = limits.images ?? {};
    if (max === 0) errors.push('이미지 게시를 지원하지 않습니다');
    else {
      if (max && files.length > max) warnings.push(`한 게시물에 ${max}장까지라 앞 ${max}장만 올립니다 (전체 ${files.length}장)`);
      if (files.length < min) errors.push(`이미지가 최소 ${min}장 필요합니다`);
    }
    const aspect = limits.imageAspect;
    if (aspect) {
      const bad = files.filter((f) => f.width && f.height && (f.width / f.height < aspect.min - 0.005 || f.width / f.height > aspect.max + 0.005));
      if (bad.length) errors.push(`이미지 비율이 허용 범위(4:5 ~ 1.91:1)를 벗어납니다: ${bad.map((f) => f.name).join(', ')}`);
    }
  }
  return { errors, warnings };
}
