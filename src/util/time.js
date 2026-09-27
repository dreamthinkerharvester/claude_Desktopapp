// 시간 처리: 저장은 항상 UTC ISO 문자열, 입력·표시는 설정의 시간대(기본 Asia/Seoul) 벽시계 기준.

const PARTS_CACHE = new Map();

function formatter(timeZone) {
  let f = PARTS_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PARTS_CACHE.set(timeZone, f);
  }
  return f;
}

function wallParts(ms, timeZone) {
  const parts = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// 해당 시각에 timeZone 의 (현지 - UTC) 차이(ms)
function zoneOffsetMs(ms, timeZone) {
  const p = wallParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export function zonedWallTimeToDate({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = zoneOffsetMs(guess, timeZone);
  let ms = guess - first;
  const second2 = zoneOffsetMs(ms, timeZone);
  if (second2 !== first) ms = guess - second2;
  return new Date(ms);
}

const WALL_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

// "2026-09-28 12:50" (설정 시간대 기준) 또는 오프셋이 있는 ISO("2026-09-28T12:50:00+09:00")를 Date 로.
export function parseDateTime(input, timeZone) {
  if (input instanceof Date) return new Date(input.getTime());
  const text = String(input ?? '').trim();
  if (!text) throw new Error('시각이 비어 있습니다');
  const wall = WALL_RE.exec(text);
  if (wall) {
    const [, y, mo, d, h, mi, s] = wall;
    const values = { year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: s ? +s : 0 };
    if (values.month < 1 || values.month > 12 || values.day < 1 || values.day > 31 || values.hour > 23 || values.minute > 59) {
      throw new Error(`시각 형식이 올바르지 않습니다: ${text}`);
    }
    const date = zonedWallTimeToDate(values, timeZone);
    // 2월 30일처럼 없는 날짜가 다음 달로 넘어가지 않게 확인
    const back = wallParts(date.getTime(), timeZone);
    if (back.year !== values.year || back.month !== values.month || back.day !== values.day) {
      throw new Error(`없는 날짜입니다: ${text}`);
    }
    return date;
  }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error(`시각 형식을 알 수 없습니다: "${text}" (예: 2026-09-28 12:50)`);
}

const pad = (n) => String(n).padStart(2, '0');

// 표시용: "2026-09-28 12:50"
export function formatLocal(value, timeZone) {
  if (!value) return '';
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) return String(value);
  const p = wallParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function monthFolder(value, timeZone) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  const p = wallParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}`;
}

export function toIso(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}
