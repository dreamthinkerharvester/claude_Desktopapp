// macOS 알림·브라우저 열기·Finder 에서 파일 보기, 그리고 한 번만 실행되도록 하는 잠금.

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const isMac = process.platform === 'darwin';

const appleString = (text) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s*\n\s*/g, ' ')}"`;

export function notify(title, message) {
  if (!isMac) return;
  execFile('osascript', ['-e', `display notification ${appleString(message)} with title ${appleString(title)}`], () => {});
}

export function openUrl(url) {
  if (!isMac || !/^https?:\/\//.test(url)) return false;
  execFile('open', [url], () => {});
  return true;
}

export function revealInFinder(path) {
  if (!isMac) return false;
  execFile('open', ['-R', path], () => {});
  return true;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// 정전·강제 종료 뒤 재부팅하면 잠금 파일의 PID 를 다른 프로그램이 쓰고 있을 수 있어
// 실제로 snspub 인지 명령줄까지 확인합니다 (아니면 남은 잠금 파일로 보고 무시)
export function isSnspubProcess(pid) {
  if (!isAlive(pid)) return false;
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /snspub/.test(command);
  } catch {
    return false;
  }
}

// 게시 실행기는 한 번에 하나만 돌아야 합니다 (두 개가 돌면 중복 게시 위험)
export function acquireLock(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'snspub.lock');
  try {
    writeFileSync(file, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (pid && pid !== process.pid && isSnspubProcess(pid)) {
      const e = new Error(`게시 실행기가 이미 실행 중입니다 (PID ${pid}). 중복 게시를 막기 위해 하나만 실행합니다.`);
      e.code = 'LOCKED';
      throw e;
    }
    writeFileSync(file, String(process.pid));
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (Number(readFileSync(file, 'utf8').trim()) === process.pid) unlinkSync(file);
    } catch {
      // 이미 지워졌으면 무시
    }
  };
  process.once('exit', release);
  return release;
}
