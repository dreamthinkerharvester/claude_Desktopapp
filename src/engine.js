// 게시 실행기: 예약 시각이 된 작업을 채널별로 따로 실행하고, 결과에 따라 상태를 바꿉니다.
//
// 원칙 (보고서 + Postiz 분석에서 차용)
//  1. 한 작업 = 콘텐츠 1개 × 채널 1개. 한 채널이 실패해도 다른 채널은 계속 진행합니다.
//  2. "게시됐는지 모르는" 경우에는 절대 자동으로 다시 올리지 않습니다 (needs_check).
//  3. 요청이 서버에 닿지 않은 연결 오류·일시 장애만 자동 재시도합니다 (1→5→15→30→60분).
//  4. 되돌릴 수 없는 단계(게시 확정) 직전에 진행 상황을 DB에 먼저 기록합니다 (checkpoint).
//  5. 로그인 만료는 그 채널만 보류하고, 연결 확인이 통과하면 자동으로 이어갑니다.

import { CHANNELS } from './config.js';
import { resolveLinks } from './captions.js';
import { archivePost } from './archive.js';
import { asPublishError, invalid, transient } from './errors.js';
import { request } from './http.js';
import { filesForChannel } from './limits.js';
import { verifyFiles } from './media.js';
import { notify as macNotify } from './system.js';
import { addMinutes, addSeconds, formatLocal, parseDateTime } from './util/time.js';

const label = (channel) => CHANNELS[channel]?.label ?? channel;

export class Engine {
  constructor({ config, store, adapters, now = () => new Date(), notifier, fetchImpl = globalThis.fetch, maxConcurrent = 3 }) {
    this.config = config;
    this.store = store;
    this.adapters = adapters;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.maxConcurrent = maxConcurrent;
    this.notifier = notifier ?? ((title, message) => (config.notify ? macNotify(title, message) : undefined));
    this.active = new Map(); // channel → promise (채널마다 동시에 하나만)
    this.ticking = false;
    this.timer = undefined;
  }

  // ---------- 공통 ----------

  nowIso() {
    return this.now().toISOString();
  }

  event(job, level, message) {
    this.store.addEvent(level, message, { postId: job.postId, jobId: job.id });
  }

  alert(title, message) {
    try {
      this.notifier?.(title, message);
    } catch {
      // 알림 실패는 무시
    }
  }

  adapterFor(job) {
    return this.adapters[job.route];
  }

  context(job, view) {
    const fetchImpl = this.fetchImpl;
    return {
      config: this.config,
      route: this.config.routes?.[job.route] ?? {},
      channelConfig: this.config.channels?.[job.channel] ?? {},
      tokens: {
        get: (provider) => this.store.getToken(provider),
        set: (provider, data) => this.store.setToken(provider, data),
      },
      // 진행 기록을 DB 에 즉시 저장하고, 어댑터가 보는 job.remote 도 함께 갱신합니다
      checkpoint: (patch) => {
        const merged = this.store.checkpoint(job.id, patch);
        job.remote = merged;
        if (view) view.remote = merged;
        return merged;
      },
      log: (message, level = 'info') => this.event(job, level, message),
      fetch: fetchImpl,
      request: (url, opts = {}) => request(url, { fetchImpl, ...opts }),
      now: this.now,
    };
  }

  // 어댑터에 넘기는 작업 정보 ({links} 는 이 시점에 채웁니다)
  view(job, post) {
    const published = this.store.getJobs(job.postId).filter((j) => j.status === 'published' && j.id !== job.id);
    const options = { ...job.options, caption: resolveLinks(job.options.caption ?? '', published) };
    return {
      id: job.id,
      postId: job.postId,
      channel: job.channel,
      route: job.route,
      runAt: job.runAt,
      attempts: job.attempts,
      options,
      remote: job.remote ?? {},
      post: { id: post.id, title: post.title, kind: post.kind, files: filesForChannel(job.channel, post.kind, post.media), caption: post.caption, hashtags: post.hashtags },
    };
  }

  canResume(job) {
    try {
      return !!this.adapterFor(job)?.canResume?.(job);
    } catch {
      return false;
    }
  }

  // ---------- 시작 시 복구 ----------

  // 프로그램이 게시 도중 꺼졌던 작업을 정리합니다.
  recover() {
    const nowIso = this.nowIso();
    for (const job of this.store.jobsByStatus(['running'])) {
      if (this.canResume(job)) {
        this.store.transition(job.id, ['running'], { status: 'processing', nextTryAt: nowIso, processingSince: job.processingSince ?? nowIso });
        this.event(job, 'warn', `${label(job.channel)}: 프로그램 재시작 — 진행 기록이 있어 상태를 확인하며 이어갑니다`);
      } else {
        this.store.transition(job.id, ['running'], {
          status: 'needs_check',
          errorKind: 'uncertain',
          lastError: '올리는 도중 프로그램이 꺼져 게시 여부를 알 수 없습니다. 채널에서 확인한 뒤 "게시됨으로 표시" 또는 "다시 올리기"를 눌러 주세요.',
        });
        this.event(job, 'error', `${label(job.channel)}: 올리는 도중 프로그램이 꺼짐 → 확인 필요`);
        this.alert('SNS 발행: 확인 필요', `${label(job.channel)} 게시 여부를 확인해 주세요`);
      }
    }
  }

  // ---------- 예약 실행 ----------

  async tick() {
    if (this.ticking) return { started: 0, promises: [] };
    this.ticking = true;
    const promises = [];
    try {
      const now = this.now();
      const nowIso = now.toISOString();
      const candidates = [
        ...this.store.dueProcessing(nowIso).map((job) => ['resume', job]),
        ...this.store.duePending(nowIso).map((job) => ['publish', job]),
      ];
      for (const [mode, job] of candidates) {
        if (this.active.size >= this.maxConcurrent) break;
        if (this.active.has(job.channel)) continue;
        if (this.store.getChannelState(job.channel).blocked) continue;
        if (mode === 'publish' && this.deferForGap(job, now)) continue;
        const run = mode === 'publish' ? this.runJob(job) : this.resumeJob(job);
        const promise = run
          .catch((err) => this.event(job, 'error', `실행기 오류: ${err?.message ?? err}`))
          .finally(() => this.active.delete(job.channel));
        this.active.set(job.channel, promise);
        promises.push(promise);
      }
    } finally {
      this.ticking = false;
    }
    return { started: promises.length, promises };
  }

  // 같은 채널에 너무 붙여서 올리지 않도록 (밀린 예약이 한꺼번에 올라가는 것 방지)
  deferForGap(job, now) {
    const gap = this.config.schedule?.minGapSameChannelMinutes ?? 0;
    if (!gap) return false;
    const last = this.store.lastPublishedAt(job.channel, job.id);
    if (!last) return false;
    const earliest = addMinutes(new Date(last), gap);
    if (earliest <= now) return false;
    this.store.transition(job.id, ['pending'], { nextTryAt: earliest.toISOString() });
    this.event(job, 'info', `${label(job.channel)}: 같은 채널 최소 간격(${gap}분)을 지키려고 ${formatLocal(earliest, this.config.timezone)}로 미룹니다`);
    return true;
  }

  async runJob(pending) {
    if (!this.store.transition(pending.id, ['pending'], { status: 'running', startedAt: this.nowIso(), nextTryAt: null })) return;
    const job = this.store.getJob(pending.id);
    const post = this.store.getPost(job.postId);
    const adapter = this.adapterFor(job);
    this.event(job, 'info', `${label(job.channel)}: 올리기 시작 (${job.route})`);
    try {
      if (!adapter) throw invalid(`게시 경로 "${job.route}" 을(를) 찾을 수 없습니다. 설정을 확인해 주세요`);
      const files = await verifyFiles(post.media);
      if (!files.ok) throw files.transient ? transient(files.message) : invalid(files.message);
      const view = this.view(job, post);
      const result = await adapter.publish(view, this.context(job, view));
      this.applyResult(job, result);
    } catch (err) {
      this.applyError(job, err);
    }
  }

  async resumeJob(processing) {
    if (!this.store.transition(processing.id, ['processing'], { status: 'running' })) return;
    const job = this.store.getJob(processing.id);
    const post = this.store.getPost(job.postId);
    const adapter = this.adapterFor(job);
    try {
      if (!adapter?.resume) throw invalid(`게시 경로 "${job.route}" 은(는) 이어서 확인할 수 없습니다`);
      const view = this.view(job, post);
      const result = await adapter.resume(view, this.context(job, view));
      this.applyResult(job, result);
    } catch (err) {
      this.applyError(job, err);
    }
  }

  applyResult(job, result) {
    const now = this.now();
    const nowIso = now.toISOString();
    switch (result?.status) {
      case 'published': {
        this.store.transition(job.id, ['running'], {
          status: 'published',
          resultUrl: result.url ?? null,
          resultId: result.id ?? null,
          publishedAt: nowIso,
          lastError: result.warning ?? null,
          errorKind: null,
          nextTryAt: null,
        });
        this.event(job, 'info', `${label(job.channel)}: 게시 완료${result.url ? ` ${result.url}` : ''}${result.warning ? ` (참고: ${result.warning})` : ''}`);
        this.finishPostIfDone(job.postId);
        return;
      }
      case 'processing': {
        const since = job.processingSince ?? nowIso;
        const limitMin = this.config.processing?.timeoutMinutes ?? 120;
        if (now.getTime() - Date.parse(since) > limitMin * 60_000) {
          this.toNeedsCheck(job, `플랫폼 처리가 ${limitMin}분 넘게 끝나지 않았습니다. 채널에서 직접 확인해 주세요.`);
          return;
        }
        const wait = result.pollAfterSec ?? this.config.processing?.pollSeconds ?? 20;
        this.store.transition(job.id, ['running'], { status: 'processing', processingSince: since, nextTryAt: addSeconds(now, wait).toISOString() });
        return;
      }
      case 'manual': {
        this.store.transition(job.id, ['running'], { status: 'manual', lastError: result.message ?? null, errorKind: null });
        this.event(job, 'info', `${label(job.channel)}: 직접 올릴 차례입니다 (업로드 도우미 사용)`);
        this.alert('SNS 발행: 직접 올릴 차례', `${label(job.channel)} — 업로드 도우미를 열어 주세요`);
        return;
      }
      case 'needs_check': {
        this.toNeedsCheck(job, result.message ?? '게시 결과를 확인해 주세요', { resultUrl: result.url ?? null, resultId: result.id ?? null });
        return;
      }
      default:
        this.toNeedsCheck(job, '게시 경로가 알 수 없는 결과를 돌려줬습니다. 채널에서 확인해 주세요.');
    }
  }

  toNeedsCheck(job, message, extra = {}) {
    this.store.transition(job.id, ['running'], { status: 'needs_check', lastError: message, errorKind: 'uncertain', nextTryAt: null, ...extra });
    this.event(job, 'error', `${label(job.channel)}: 확인 필요 — ${message}`);
    this.alert('SNS 발행: 확인 필요', `${label(job.channel)}: ${message}`);
  }

  applyError(job, err) {
    const e = asPublishError(err);
    const now = this.now();
    const latest = this.store.getJob(job.id) ?? job;
    const resumable = this.canResume(latest);
    const back = resumable ? 'processing' : 'pending';
    const processingSince = resumable ? latest.processingSince ?? now.toISOString() : null;

    if (e.kind === 'transient' || e.kind === 'rate_limit') {
      const attempts = (latest.attempts ?? 0) + 1;
      const max = this.config.retry?.maxAttempts ?? 5;
      if (attempts >= max) {
        const status = resumable ? 'needs_check' : 'failed';
        this.store.transition(job.id, ['running'], { status, attempts, lastError: `${e.message} (자동 재시도 ${attempts}회 모두 실패)`, errorKind: e.kind, nextTryAt: null });
        this.event(job, 'error', `${label(job.channel)}: 재시도 한도 초과 — ${e.message}`);
        this.alert('SNS 발행 실패', `${label(job.channel)}: ${e.message}`);
        return;
      }
      const backoff = this.config.retry?.backoffMinutes ?? [1, 5, 15, 30, 60];
      const minutes = e.retryAfterSec ? Math.max(1, Math.ceil(e.retryAfterSec / 60)) : backoff[Math.min(attempts - 1, backoff.length - 1)];
      const nextTryAt = addMinutes(now, minutes).toISOString();
      this.store.transition(job.id, ['running'], { status: back, attempts, nextTryAt, lastError: e.message, errorKind: e.kind, processingSince });
      this.event(job, 'warn', `${label(job.channel)}: 일시적 문제 — ${minutes}분 뒤 자동 재시도 (${attempts}/${max - 1}) · ${e.message}`);
      return;
    }

    if (e.kind === 'auth') {
      this.store.transition(job.id, ['running'], { status: back, lastError: e.message, errorKind: 'auth', nextTryAt: null, processingSince });
      this.store.setChannelState(job.channel, { blocked: true, reason: e.message, checkOk: false, checkedAt: now.toISOString() });
      this.event(job, 'error', `${label(job.channel)}: 로그인/권한 문제로 이 채널만 멈춥니다 — ${e.message}`);
      this.alert('SNS 발행: 재연결 필요', `${label(job.channel)} 로그인/권한을 확인한 뒤 "연결 확인"을 눌러 주세요`);
      return;
    }

    if (e.kind === 'invalid') {
      this.store.transition(job.id, ['running'], { status: 'failed', lastError: e.message, errorKind: 'invalid', nextTryAt: null });
      this.event(job, 'error', `${label(job.channel)}: 실패 — ${e.message}`);
      this.alert('SNS 발행 실패', `${label(job.channel)}: ${e.message}`);
      return;
    }

    this.toNeedsCheck(job, e.message);
  }

  // 모든 채널이 끝나면(게시 완료 또는 취소) 원본을 보관 폴더로 옮깁니다.
  finishPostIfDone(postId) {
    const post = this.store.getPost(postId);
    if (!post || post.status !== 'active') return;
    const jobs = this.store.getJobs(postId);
    if (jobs.some((j) => !['published', 'canceled'].includes(j.status))) return;
    const published = jobs.filter((j) => j.status === 'published');
    if (!published.length) {
      this.store.updatePost(postId, { status: 'canceled' });
      return;
    }
    try {
      const result = archivePost(post, this.config, this.now());
      if (result.moved) {
        this.store.updatePost(postId, { media: result.media, archivedPath: result.archivedPath });
        this.store.addEvent('info', `원본을 보관 폴더로 옮겼습니다: ${result.archivedPath}`, { postId });
      } else if (result.note) {
        this.store.addEvent('info', result.note, { postId });
      }
    } catch (err) {
      this.store.addEvent('error', `보관 폴더로 옮기지 못했습니다: ${err.message}`, { postId });
    }
    this.store.updatePost(postId, { status: 'done' });
    this.store.addEvent('info', `모든 채널 완료 (${published.length}개 게시)`, { postId });
    this.alert('SNS 발행 완료', `${post.title}: ${published.length}개 채널 게시 완료`);
  }

  // ---------- 사람이 누르는 버튼 ----------

  retry(jobId) {
    const job = this.mustGetJob(jobId);
    const ok = this.store.transition(jobId, ['failed', 'needs_check', 'manual'], {
      status: 'pending',
      attempts: 0,
      nextTryAt: null,
      lastError: null,
      errorKind: null,
      remote: {},
      processingSince: null,
      resultUrl: null,
      resultId: null,
    });
    if (!ok) throw new Error(`지금 상태(${job.status})에서는 다시 올릴 수 없습니다`);
    this.event(job, 'info', `${label(job.channel)}: 다시 올리기 요청`);
    return this.store.getJob(jobId);
  }

  recheck(jobId) {
    const job = this.mustGetJob(jobId);
    if (!this.canResume(job)) throw new Error('이 작업은 상태를 다시 확인할 수 있는 기록이 없습니다');
    const ok = this.store.transition(jobId, ['needs_check', 'failed'], {
      status: 'processing',
      nextTryAt: this.nowIso(),
      processingSince: this.nowIso(),
      attempts: 0,
    });
    if (!ok) throw new Error(`지금 상태(${job.status})에서는 다시 확인할 수 없습니다`);
    this.event(job, 'info', `${label(job.channel)}: 상태 다시 확인 요청`);
    return this.store.getJob(jobId);
  }

  markDone(jobId, url) {
    const job = this.mustGetJob(jobId);
    const ok = this.store.transition(jobId, ['manual', 'needs_check', 'failed', 'pending'], {
      status: 'published',
      resultUrl: url || job.resultUrl || null,
      publishedAt: this.nowIso(),
      lastError: null,
      errorKind: null,
      nextTryAt: null,
    });
    if (!ok) throw new Error(`지금 상태(${job.status})에서는 완료로 표시할 수 없습니다`);
    this.event(job, 'info', `${label(job.channel)}: 게시 완료로 표시${url ? ` ${url}` : ''}`);
    this.finishPostIfDone(job.postId);
    return this.store.getJob(jobId);
  }

  cancel(jobId) {
    const job = this.mustGetJob(jobId);
    const ok = this.store.transition(jobId, ['pending', 'failed', 'needs_check', 'manual'], { status: 'canceled', nextTryAt: null });
    if (!ok) throw new Error(`지금 상태(${job.status})에서는 취소할 수 없습니다 (올리는 중이면 끝날 때까지 기다려 주세요)`);
    this.event(job, 'info', `${label(job.channel)}: 취소`);
    this.finishPostIfDone(job.postId);
    return this.store.getJob(jobId);
  }

  cancelPost(postId) {
    const jobs = this.store.getJobs(postId);
    if (!jobs.length) throw new Error(`게시물을 찾을 수 없습니다: ${postId}`);
    const skipped = [];
    for (const job of jobs) {
      if (['published', 'canceled'].includes(job.status)) continue;
      if (!this.store.transition(job.id, ['pending', 'failed', 'needs_check', 'manual'], { status: 'canceled', nextTryAt: null })) {
        skipped.push(job);
      } else {
        this.event(job, 'info', `${label(job.channel)}: 취소`);
      }
    }
    this.finishPostIfDone(postId);
    return { skipped };
  }

  editJob(jobId, { caption, title, runAt }) {
    const job = this.mustGetJob(jobId);
    if (job.status !== 'pending') throw new Error('예약 대기 중인 작업만 고칠 수 있습니다');
    const options = { ...job.options };
    if (caption != null) options.caption = String(caption);
    if (title != null) options.title = String(title);
    const patch = { options };
    if (runAt) {
      const when = runAt === 'now' ? this.now() : parseDateTime(runAt, this.config.timezone);
      patch.runAt = when.toISOString();
      patch.nextTryAt = null;
    }
    if (!this.store.transition(jobId, ['pending'], patch)) throw new Error('작업이 방금 시작되어 고칠 수 없습니다');
    this.event(job, 'info', `${label(job.channel)}: 예약 내용 수정`);
    return this.store.getJob(jobId);
  }

  async checkChannel(channel) {
    const chConfig = this.config.channels?.[channel];
    if (!chConfig) throw new Error(`모르는 채널입니다: ${channel}`);
    const routes = [...new Set([chConfig.route, chConfig.imagesRoute].filter(Boolean))];
    const results = [];
    for (const route of routes) {
      const adapter = this.adapters[route];
      const fakeJob = { id: `check.${channel}`, postId: null, channel, route, remote: {} };
      try {
        if (!adapter?.check) throw invalid(`게시 경로 "${route}" 을(를) 찾을 수 없습니다`);
        results.push(await adapter.check(channel, { ...this.context(fakeJob), checkpoint: () => ({}), log: () => {} }));
      } catch (err) {
        results.push({ ok: false, message: asPublishError(err).message });
      }
    }
    const result =
      results.length === 1
        ? results[0]
        : {
            ok: results.every((r) => r.ok),
            account: results.map((r) => r.account).filter(Boolean).join(' / ') || undefined,
            message: results.map((r, i) => (r.message ? `[${routes[i]}] ${r.message}` : '')).filter(Boolean).join(' / ') || undefined,
          };
    const state = this.store.getChannelState(channel);
    const next = this.store.setChannelState(channel, {
      checkOk: !!result.ok,
      account: result.account ?? state.account,
      checkedAt: this.nowIso(),
      blocked: result.ok ? false : state.blocked,
      reason: result.ok ? null : result.message ?? state.reason,
    });
    this.store.addEvent(result.ok ? 'info' : 'warn', `${label(channel)} 연결 확인: ${result.ok ? '정상' : '문제 있음'}${result.account ? ` (${result.account})` : ''}${result.message ? ` — ${result.message}` : ''}`);
    return { ...result, state: next };
  }

  mustGetJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`작업을 찾을 수 없습니다: ${jobId}`);
    return job;
  }

  // ---------- 상시 실행 ----------

  start(intervalMs = 15_000) {
    this.recover();
    const loop = () => this.tick().catch((err) => this.store.addEvent('error', `실행기 오류: ${err?.message ?? err}`));
    this.timer = setInterval(loop, intervalMs);
    loop();
  }

  async stop(waitMs = 60_000) {
    clearInterval(this.timer);
    this.timer = undefined;
    const running = [...this.active.values()];
    if (!running.length) return;
    await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, waitMs))]);
  }
}
