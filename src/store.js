import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 작업 상태
//  pending     예약 대기 (시각이 되면 실행)
//  running     실행 중
//  processing  플랫폼이 처리 중 (상태만 조회하며 기다림)
//  published   게시 완료
//  failed      실패 (사람이 고친 뒤 재시도)
//  needs_check 게시 여부 확인 필요 (자동 재시도 안 함)
//  manual      직접 올릴 차례 (반자동 채널)
//  canceled    취소
export const JOB_STATUSES = ['pending', 'running', 'processing', 'published', 'failed', 'needs_check', 'manual', 'canceled'];
export const ACTIVE_STATUSES = ['pending', 'running', 'processing', 'manual', 'needs_check', 'failed'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    media_json TEXT NOT NULL,
    media_hash TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    hashtags_json TEXT NOT NULL DEFAULT '[]',
    source_dir TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    archived_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    route TEXT NOT NULL,
    run_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    options_json TEXT NOT NULL DEFAULT '{}',
    remote_json TEXT NOT NULL DEFAULT '{}',
    result_url TEXT,
    result_id TEXT,
    last_error TEXT,
    error_kind TEXT,
    started_at TEXT,
    processing_since TEXT,
    published_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (post_id, channel)
  )`,
  `CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, run_at)`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    level TEXT NOT NULL,
    post_id TEXT,
    job_id TEXT,
    message TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_post_idx ON events (post_id, id)`,
  `CREATE TABLE IF NOT EXISTS tokens (
    provider TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channel_state (
    channel TEXT PRIMARY KEY,
    blocked INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    account TEXT,
    check_ok INTEGER,
    checked_at TEXT,
    updated_at TEXT NOT NULL
  )`,
];

const parse = (text, fallback) => {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

// sqlite 는 undefined 를 받지 않으므로 null 로 바꿉니다.
const clean = (params) => Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === undefined ? null : v]));

function toPost(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    media: parse(row.media_json, []),
    mediaHash: row.media_hash,
    caption: row.caption,
    hashtags: parse(row.hashtags_json, []),
    sourceDir: row.source_dir ?? undefined,
    status: row.status,
    archivedPath: row.archived_path ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toJob(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    postId: row.post_id,
    channel: row.channel,
    route: row.route,
    runAt: row.run_at,
    status: row.status,
    attempts: row.attempts,
    nextTryAt: row.next_try_at ?? undefined,
    options: parse(row.options_json, {}),
    remote: parse(row.remote_json, {}),
    resultUrl: row.result_url ?? undefined,
    resultId: row.result_id ?? undefined,
    lastError: row.last_error ?? undefined,
    errorKind: row.error_kind ?? undefined,
    startedAt: row.started_at ?? undefined,
    processingSince: row.processing_since ?? undefined,
    publishedAt: row.published_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

const JOB_PATCH_COLUMNS = {
  runAt: 'run_at',
  status: 'status',
  attempts: 'attempts',
  nextTryAt: 'next_try_at',
  options: 'options_json',
  remote: 'remote_json',
  resultUrl: 'result_url',
  resultId: 'result_id',
  lastError: 'last_error',
  errorKind: 'error_kind',
  startedAt: 'started_at',
  processingSince: 'processing_since',
  publishedAt: 'published_at',
};

export class Store {
  constructor(file, { now = () => new Date() } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = now;
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    for (const sql of SCHEMA) this.db.exec(sql);
  }

  close() {
    this.db.close();
  }

  stamp() {
    return this.now().toISOString();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- posts ----------

  createPost(post, jobs) {
    const at = this.stamp();
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO posts (id, title, kind, media_json, media_hash, caption, hashtags_json, source_dir, status, created_at, updated_at)
           VALUES (:id, :title, :kind, :media, :mediaHash, :caption, :hashtags, :sourceDir, 'active', :at, :at)`,
        )
        .run(
          clean({
            id: post.id,
            title: post.title,
            kind: post.kind,
            media: JSON.stringify(post.media),
            mediaHash: post.mediaHash,
            caption: post.caption ?? '',
            hashtags: JSON.stringify(post.hashtags ?? []),
            sourceDir: post.sourceDir,
            at,
          }),
        );
      const insertJob = this.db.prepare(
        `INSERT INTO jobs (id, post_id, channel, route, run_at, status, options_json, remote_json, updated_at)
         VALUES (:id, :postId, :channel, :route, :runAt, 'pending', :options, '{}', :at)`,
      );
      for (const job of jobs) {
        insertJob.run(
          clean({
            id: job.id,
            postId: post.id,
            channel: job.channel,
            route: job.route,
            runAt: job.runAt,
            options: JSON.stringify(job.options ?? {}),
            at,
          }),
        );
      }
      this.addEvent('info', `발행 등록: ${post.title} (${jobs.map((j) => j.channel).join(', ')})`, { postId: post.id });
      return this.getPost(post.id);
    });
  }

  getPost(id) {
    return toPost(this.db.prepare('SELECT * FROM posts WHERE id = :id').get({ id }));
  }

  listPosts({ limit = 50, includeDone = true } = {}) {
    const sql = includeDone
      ? 'SELECT * FROM posts ORDER BY created_at DESC LIMIT :limit'
      : "SELECT * FROM posts WHERE status = 'active' ORDER BY created_at DESC LIMIT :limit";
    return this.db.prepare(sql).all({ limit }).map(toPost);
  }

  updatePost(id, patch) {
    const sets = [];
    const params = { id, at: this.stamp() };
    if (patch.status !== undefined) {
      sets.push('status = :status');
      params.status = patch.status;
    }
    if (patch.media !== undefined) {
      sets.push('media_json = :media');
      params.media = JSON.stringify(patch.media);
    }
    if (patch.archivedPath !== undefined) {
      sets.push('archived_path = :archivedPath');
      params.archivedPath = patch.archivedPath;
    }
    if (!sets.length) return this.getPost(id);
    this.db.prepare(`UPDATE posts SET ${sets.join(', ')}, updated_at = :at WHERE id = :id`).run(clean(params));
    return this.getPost(id);
  }

  // 같은 파일(내용 해시)을 같은 채널에 이미 올렸거나 올릴 예정인지
  findDuplicate(mediaHash, channel) {
    const row = this.db
      .prepare(
        `SELECT jobs.* FROM jobs JOIN posts ON posts.id = jobs.post_id
         WHERE posts.media_hash = :mediaHash AND jobs.channel = :channel AND jobs.status != 'canceled'
         ORDER BY jobs.updated_at DESC LIMIT 1`,
      )
      .get({ mediaHash, channel });
    return toJob(row);
  }

  // ---------- jobs ----------

  getJob(id) {
    return toJob(this.db.prepare('SELECT * FROM jobs WHERE id = :id').get({ id }));
  }

  getJobs(postId) {
    return this.db.prepare('SELECT * FROM jobs WHERE post_id = :postId ORDER BY run_at, channel').all({ postId }).map(toJob);
  }

  jobsByStatus(statuses) {
    const list = statuses.map((s) => `'${s.replace(/'/g, '')}'`).join(', ');
    return this.db.prepare(`SELECT * FROM jobs WHERE status IN (${list}) ORDER BY run_at`).all().map(toJob);
  }

  // 실행할 차례가 된 예약 작업
  duePending(nowIso) {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'pending' AND run_at <= :now
         AND (next_try_at IS NULL OR next_try_at <= :now) ORDER BY run_at`,
      )
      .all({ now: nowIso })
      .map(toJob);
  }

  // 상태를 다시 볼 차례가 된 처리 중 작업
  dueProcessing(nowIso) {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'processing' AND (next_try_at IS NULL OR next_try_at <= :now)
         ORDER BY next_try_at`,
      )
      .all({ now: nowIso })
      .map(toJob);
  }

  lastPublishedAt(channel, excludeJobId) {
    const row = this.db
      .prepare(
        `SELECT MAX(COALESCE(published_at, started_at)) AS at FROM jobs
         WHERE channel = :channel AND id != :exclude AND (status = 'published' OR status IN ('running', 'processing'))`,
      )
      .get({ channel, exclude: excludeJobId ?? '' });
    return row?.at ?? undefined;
  }

  /**
   * 상태 전이(compare-and-set). 현재 상태가 from 중 하나일 때만 바꿉니다.
   * 동시에 두 곳에서 같은 작업을 건드려도 한쪽만 성공하므로 중복 실행을 막습니다.
   */
  transition(jobId, from, patch) {
    const sets = [];
    const params = { id: jobId, at: this.stamp() };
    for (const [key, column] of Object.entries(JOB_PATCH_COLUMNS)) {
      if (!(key in patch)) continue;
      let value = patch[key];
      if (key === 'options' || key === 'remote') value = JSON.stringify(value ?? {});
      sets.push(`${column} = :${key}`);
      params[key] = value;
    }
    const fromList = from.map((s) => `'${s.replace(/'/g, '')}'`).join(', ');
    const res = this.db
      .prepare(`UPDATE jobs SET ${sets.join(', ')}${sets.length ? ',' : ''} updated_at = :at WHERE id = :id AND status IN (${fromList})`)
      .run(clean(params));
    return res.changes === 1;
  }

  // 어댑터가 위험한 단계 직전에 진행 상황을 즉시 기록 (프로그램이 죽어도 이어갈 수 있게)
  checkpoint(jobId, remotePatch) {
    const job = this.getJob(jobId);
    if (!job) return undefined;
    const remote = { ...job.remote, ...remotePatch };
    this.db
      .prepare('UPDATE jobs SET remote_json = :remote, updated_at = :at WHERE id = :id')
      .run({ id: jobId, remote: JSON.stringify(remote), at: this.stamp() });
    return remote;
  }

  // ---------- events ----------

  addEvent(level, message, { postId, jobId } = {}) {
    this.db
      .prepare('INSERT INTO events (at, level, post_id, job_id, message) VALUES (:at, :level, :postId, :jobId, :message)')
      .run(clean({ at: this.stamp(), level, postId, jobId, message: String(message) }));
  }

  listEvents({ postId, limit = 100 } = {}) {
    const rows = postId
      ? this.db.prepare('SELECT * FROM events WHERE post_id = :postId ORDER BY id DESC LIMIT :limit').all({ postId, limit })
      : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT :limit').all({ limit });
    return rows.map((r) => ({ id: r.id, at: r.at, level: r.level, postId: r.post_id ?? undefined, jobId: r.job_id ?? undefined, message: r.message }));
  }

  // ---------- tokens ----------

  getToken(provider) {
    const row = this.db.prepare('SELECT data_json FROM tokens WHERE provider = :provider').get({ provider });
    return row ? parse(row.data_json, undefined) : undefined;
  }

  setToken(provider, data) {
    this.db
      .prepare(
        `INSERT INTO tokens (provider, data_json, updated_at) VALUES (:provider, :data, :at)
         ON CONFLICT(provider) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .run({ provider, data: JSON.stringify(data), at: this.stamp() });
  }

  deleteToken(provider) {
    this.db.prepare('DELETE FROM tokens WHERE provider = :provider').run({ provider });
  }

  // ---------- channel state ----------

  getChannelState(channel) {
    const row = this.db.prepare('SELECT * FROM channel_state WHERE channel = :channel').get({ channel });
    if (!row) return { channel, blocked: false };
    return {
      channel,
      blocked: row.blocked === 1,
      reason: row.reason ?? undefined,
      account: row.account ?? undefined,
      checkOk: row.check_ok == null ? undefined : row.check_ok === 1,
      checkedAt: row.checked_at ?? undefined,
    };
  }

  allChannelStates() {
    return this.db.prepare('SELECT channel FROM channel_state').all().map((r) => this.getChannelState(r.channel));
  }

  setChannelState(channel, patch) {
    const current = this.getChannelState(channel);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `INSERT INTO channel_state (channel, blocked, reason, account, check_ok, checked_at, updated_at)
         VALUES (:channel, :blocked, :reason, :account, :checkOk, :checkedAt, :at)
         ON CONFLICT(channel) DO UPDATE SET blocked = excluded.blocked, reason = excluded.reason, account = excluded.account,
           check_ok = excluded.check_ok, checked_at = excluded.checked_at, updated_at = excluded.updated_at`,
      )
      .run(
        clean({
          channel,
          blocked: next.blocked ? 1 : 0,
          reason: next.reason,
          account: next.account,
          checkOk: next.checkOk == null ? null : next.checkOk ? 1 : 0,
          checkedAt: next.checkedAt,
          at: this.stamp(),
        }),
      );
    return this.getChannelState(channel);
  }
}
