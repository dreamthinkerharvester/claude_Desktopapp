import { join } from 'node:path';
import { adapters as builtinAdapters } from './adapters/index.js';
import { loadConfig } from './config.js';
import { Engine } from './engine.js';
import { Store } from './store.js';

export const STATUS_LABELS = {
  pending: '예약 대기',
  running: '올리는 중',
  processing: '처리 중',
  published: '게시 완료',
  failed: '실패',
  needs_check: '확인 필요',
  manual: '직접 올릴 차례',
  canceled: '취소',
};

// 설정·DB·실행기를 한 번에 엽니다.
export function openApp({ configPath, config, adapters = builtinAdapters, now, notifier, fetchImpl } = {}) {
  const cfg = config ?? loadConfig(configPath);
  const store = new Store(join(cfg.dataDir, 'snspub.db'), { now });
  const engine = new Engine({ config: cfg, store, adapters, now, notifier, fetchImpl });
  return { config: cfg, store, adapters, engine };
}
