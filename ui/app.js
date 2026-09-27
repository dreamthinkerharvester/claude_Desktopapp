// SNS 발행기 화면 (프레임워크 없이 동작하는 단일 스크립트)

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fileUrl = (path) => `/file?path=${encodeURIComponent(path)}`;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // 본문 없음
  }
  if (!res.ok && !('errors' in data)) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, ms = 4000) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

const fmtSize = (n) => (n == null ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1e3))}KB`);
const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const toInputTime = (local) => String(local ?? '').replace(' ', 'T');

// ---------- 글자 수 (서버 규칙과 같음) ----------
const LIGHT = [[0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037]];
const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
function xLength(text) {
  let w = 0;
  const rest = String(text).replace(/https?:\/\/[^\s<>"']+/g, () => {
    w += 23;
    return '';
  });
  for (const { segment } of seg.segment(rest)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) {
      w += 2;
      continue;
    }
    for (const ch of segment) {
      const cp = ch.codePointAt(0);
      w += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
    }
  }
  return w;
}
const COUNTERS = {
  x: { max: 280, count: xLength, unit: '(한글 2자)' },
  threads: { max: 500, count: (t) => [...t].length },
  instagram: { max: 2200, count: (t) => [...t].length },
  tiktok: { max: 2200, count: (t) => [...t].length },
  youtube: { max: 5000, count: (t) => new TextEncoder().encode(t).length, unit: '바이트' },
};
function counterHtml(channel, text) {
  const rule = COUNTERS[channel];
  const body = String(text ?? '').replaceAll('{links}', '');
  if (!rule) return `${[...body].length}자`;
  const n = rule.count(body);
  return `<span class="${n > rule.max ? 'over' : ''}">${n} / ${rule.max} ${rule.unit ?? ''}</span>`;
}

// ---------- 상태 ----------
let state = null;
let lastSignature = '';
let currentTab = 'board';

async function refresh(force = false) {
  try {
    state = await api('/api/state');
  } catch {
    $('#clock').textContent = '실행기와 연결이 끊겼습니다 — snspub start 가 켜져 있는지 확인하세요';
    return;
  }
  $('#clock').textContent = `지금 ${state.nowLocal}`;
  const signature = JSON.stringify([state.posts, state.channels]);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  render();
}

function render() {
  if (!state) return;
  renderAttention();
  if (currentTab === 'board') renderBoard();
  if (currentTab === 'channels') renderChannels();
  if (currentTab === 'compose') setupCompose();
}

function showTab(tab) {
  currentTab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  for (const t of ['board', 'compose', 'channels', 'log']) $(`#tab-${t}`).hidden = t !== tab;
  if (tab === 'compose') loadInbox();
  if (tab === 'log') renderLog();
  render();
}
$$('.tab').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

function renderAttention() {
  const jobs = state.posts.flatMap((p) => p.jobs);
  const n = { manual: 0, needs_check: 0, failed: 0 };
  for (const j of jobs) if (j.status in n) n[j.status] += 1;
  const blocked = state.channels.filter((c) => c.blocked);
  const parts = [];
  if (n.manual) parts.push(`직접 올릴 차례 ${n.manual}건`);
  if (n.needs_check) parts.push(`확인 필요 ${n.needs_check}건`);
  if (n.failed) parts.push(`실패 ${n.failed}건`);
  if (blocked.length) parts.push(`재연결 필요: ${blocked.map((c) => c.label).join(', ')}`);
  const el = $('#attention');
  el.hidden = !parts.length;
  el.textContent = parts.length ? `⚠︎ ${parts.join(' · ')}` : '';
  const count = n.manual + n.needs_check + n.failed;
  $('.tab[data-tab="board"]').innerHTML = `발행 현황${count ? `<span class="count">${count}</span>` : ''}`;
  $('.tab[data-tab="channels"]').innerHTML = `채널${blocked.length ? `<span class="count">${blocked.length}</span>` : ''}`;
}

// ---------- 발행 현황 ----------
function jobMessage(job) {
  switch (job.status) {
    case 'published': {
      const link = job.resultUrl ? `<a href="${esc(job.resultUrl)}" target="_blank" rel="noopener">${esc(job.resultUrl)}</a>` : '<span class="muted">주소 없음</span>';
      return `${link}${job.lastError ? `<div class="warn small">${esc(job.lastError)}</div>` : ''}<div class="muted small">${esc(job.publishedAtLocal ?? '')}</div>`;
    }
    case 'pending': {
      const parts = [];
      if (job.nextTryAtLocal) parts.push(`<span class="muted">다음 시도 ${esc(job.nextTryAtLocal)}</span>`);
      if (job.lastError) parts.push(`<span class="warn">${esc(job.lastError)}</span>`);
      return parts.join(' ');
    }
    case 'failed':
      return `<span class="err">${esc(job.lastError)}</span>`;
    case 'needs_check':
      return `<span class="warn">${esc(job.lastError)}</span>${job.resultUrl ? `<div><a href="${esc(job.resultUrl)}" target="_blank" rel="noopener">${esc(job.resultUrl)}</a></div>` : ''}`;
    case 'manual':
      return '<span class="muted">[업로드 도우미]로 올린 뒤 [완료]를 눌러 주세요</span>';
    case 'processing':
      return `<span class="muted">플랫폼에서 처리 중입니다${job.lastError ? ` · ${esc(job.lastError)}` : ''}</span>`;
    case 'running':
      return '<span class="muted">올리는 중…</span>';
    default:
      return '';
  }
}

function jobActions(job) {
  const b = (action, text, cls = '') => `<button class="btn small ${cls}" data-action="${action}" data-job="${esc(job.id)}">${text}</button>`;
  switch (job.status) {
    case 'pending':
      return b('run-now', '지금 올리기') + b('edit', '수정') + b('cancel', '취소', 'danger');
    case 'manual':
      return b('assist', '업로드 도우미') + b('done', '완료') + b('cancel', '취소', 'danger');
    case 'needs_check':
      return b('done', '게시됨으로 표시') + (job.canRecheck ? b('recheck', '상태 다시 확인') : '') + b('retry', '다시 올리기') + b('cancel', '취소', 'danger');
    case 'failed':
      return b('retry', '다시 올리기') + b('done', '게시됨으로 표시') + b('cancel', '취소', 'danger');
    case 'published':
      return job.resultUrl ? `<a class="btn small" href="${esc(job.resultUrl)}" target="_blank" rel="noopener">열기</a>` : '';
    default:
      return '';
  }
}

function renderBoard() {
  const root = $('#tab-board');
  if (!state.posts.length) {
    root.innerHTML = '<div class="card empty">아직 등록된 발행이 없습니다.<br><br><button class="btn primary" data-goto="compose">새 발행 만들기</button></div>';
    return;
  }
  root.innerHTML = state.posts
    .map((post) => {
      const statusText = { active: '진행 중', done: '완료', canceled: '취소' }[post.status] ?? post.status;
      const kind = post.kind === 'video' ? `영상${post.media[0]?.duration ? ` ${Math.round(post.media[0].duration)}초` : ''}` : `이미지 ${post.media.length}장`;
      return `<div class="card post ${esc(post.status)}">
        <div class="post-head">
          <span class="kind">${esc(kind)}</span>
          <span class="title" title="${esc(post.media.map((f) => f.path).join('\n'))}">${esc(post.title)}</span>
          <span class="muted small">${esc(post.id)} · 등록 ${esc(post.createdAtLocal)}</span>
          <span class="post-status">${esc(statusText)}</span>
          ${post.status === 'active' ? `<button class="btn small danger" data-action="cancel-post" data-post="${esc(post.id)}">남은 예약 취소</button>` : ''}
        </div>
        <table class="jobs">${post.jobs
          .map(
            (job) => `<tr>
              <td class="ch">${esc(job.label)}<div class="muted small">${esc(job.route)}</div></td>
              <td class="time">${esc(job.runAtLocal)}</td>
              <td class="st"><span class="badge ${esc(job.status)}">${esc(job.statusLabel)}</span></td>
              <td class="msg">${jobMessage(job)}</td>
              <td class="acts">${jobActions(job)}</td>
            </tr>`,
          )
          .join('')}</table>
      </div>`;
    })
    .join('');
}

// ---------- 채널 ----------
function loginButton(c) {
  if (!c.enabled) return '';
  if (c.route === 'youtube') return '<a class="btn small" href="/oauth/google/start">Google 로그인</a>';
  if (c.route === 'naver_cafe') return '<a class="btn small" href="/oauth/naver/start">네이버 로그인</a>';
  if (c.route === 'meta') return '<button class="btn small" data-action="meta-token">Meta 토큰 등록</button>';
  return '';
}

function renderChannels() {
  $('#tab-channels').innerHTML = `<div class="card">
    <div class="row between"><h3>채널 연결</h3><button class="btn" data-action="check-all">켜진 채널 모두 확인</button></div>
    <p class="muted small">채널 켜기/끄기와 게시 경로는 config.jsonc 에서 바꿉니다. "연결 확인"은 게시하지 않고 계정·권한만 확인합니다.
    로그인 문제가 생긴 채널은 자동으로 보류되고, 확인이 통과하면 밀린 예약이 이어서 올라갑니다.</p>
    <table class="list"><tr><th>채널</th><th>게시 경로</th><th>상태</th><th></th></tr>
    ${state.channels
      .map((c) => {
        const status =
          c.checkOk === undefined
            ? '<span class="dot"></span><span class="muted">확인 전</span>'
            : c.checkOk
              ? `<span class="dot ok"></span>정상 ${esc(c.account ?? '')}`
              : `<span class="dot bad"></span>${esc(c.reason ?? '문제 있음')}`;
        return `<tr>
          <td><b>${esc(c.label)}</b>${c.enabled ? '' : ' <span class="muted small">(꺼짐)</span>'}</td>
          <td>${esc(c.routeLabel ?? c.route)}${c.imagesRouteLabel ? `<div class="muted small">카드뉴스: ${esc(c.imagesRouteLabel)}</div>` : ''}</td>
          <td>${status}${c.blocked ? '<div class="small err">보류 중 — 이 채널만 멈췄고 다른 채널은 계속 올라갑니다</div>' : ''}${c.checkedAtLocal ? `<div class="muted small">확인 ${esc(c.checkedAtLocal)}</div>` : ''}</td>
          <td class="acts">${c.enabled ? `<button class="btn small" data-action="check" data-channel="${esc(c.channel)}">연결 확인</button>` : ''} ${loginButton(c)} ${c.blocked ? `<button class="btn small" data-action="unblock" data-channel="${esc(c.channel)}">보류 해제</button>` : ''}</td>
        </tr>`;
      })
      .join('')}</table></div>`;
}

async function renderLog() {
  const { events } = await api('/api/events?limit=300');
  $('#tab-log').innerHTML = `<div class="card"><h3>최근 기록</h3>${
    events.map((e) => `<div class="log-line ${esc(e.level)}">${esc(e.atLocal)}  ${e.postId ? `[${esc(e.postId)}] ` : ''}${esc(e.message)}</div>`).join('') || '<div class="muted">기록이 없습니다</div>'
  }</div>`;
}

// ---------- 새 발행 ----------
const compose = { media: null, item: null, channels: null, overrides: {}, times: {}, plan: null, seq: 0, inbox: [] };

function setupCompose() {
  const box = $('#f-channels');
  if (box.dataset.ready) return;
  const enabled = state.channels.filter((c) => c.enabled);
  compose.channels = new Set(enabled.map((c) => c.channel));
  box.innerHTML =
    enabled
      .map((c) => `<label data-ch="${esc(c.channel)}"><input type="checkbox" value="${esc(c.channel)}" checked> ${esc(c.label)} <span class="route">${esc(c.imagesRoute ? `${c.route} / 이미지: ${c.imagesRoute}` : c.route)}</span></label>`)
      .join('') || '<span class="muted small">켜진 채널이 없습니다 (config.jsonc 의 channels)</span>';
  $('#f-gap-min').value = state.config.schedule.gapMinutes[0];
  $('#f-gap-max').value = state.config.schedule.gapMinutes[1];
  box.dataset.ready = '1';
}

// 고른 콘텐츠 종류(영상/이미지)를 못 올리는 채널은 끄고 흐리게 표시
function mediaKind() {
  if (compose.item) return compose.item.type;
  if (compose.plan?.post?.kind) return compose.plan.post.kind;
  if (!compose.media) return undefined;
  return /\.(mp4|mov|m4v)$/i.test(compose.media) ? 'video' : 'images';
}
const canTake = (channel, kind) => !kind || (state.config.channels[channel]?.kinds ?? []).includes(kind);

function syncChannelChecks(reset = false) {
  const kind = mediaKind();
  if (reset) compose.channels = new Set(state.channels.filter((c) => c.enabled && canTake(c.channel, kind)).map((c) => c.channel));
  for (const label of $$('#f-channels label[data-ch]')) {
    const ch = label.dataset.ch;
    const input = $('input', label);
    const ok = canTake(ch, kind);
    input.disabled = !ok;
    input.checked = ok && compose.channels.has(ch);
    label.classList.toggle('off', !ok);
    label.title = ok ? '' : `${kind === 'images' ? '이미지' : '영상'}를 올릴 수 없는 채널`;
  }
}

async function loadInbox() {
  const { inboxDir, items } = await api('/api/inbox');
  compose.inbox = items;
  $('#inbox-path').textContent = inboxDir ? `수신함: ${inboxDir}` : '수신함(inboxDir)이 설정되지 않았습니다 — 아래에 경로를 직접 입력해 주세요';
  $('#inbox').innerHTML = items.length
    ? items
        .map(
          (it, i) => `<div class="inbox-item ${compose.media === it.path ? 'selected' : ''}" data-inbox="${i}">
            <div class="thumb" ${it.type === 'images' ? `style="background-image:url('${fileUrl(it.preview ?? it.path)}')"` : ''}>${it.type === 'video' ? '🎬' : ''}</div>
            <div><div class="name">${esc(it.name)}</div><div class="muted small">${it.type === 'video' ? '영상' : `이미지 ${it.count}장`} · ${fmtSize(it.size)} ${fmtDate(it.mtime)}</div></div>
          </div>`,
        )
        .join('')
    : '<div class="muted small" style="padding:10px">수신함에 올릴 파일이 없습니다</div>';
}

function selectMedia(path, item) {
  compose.media = path;
  compose.item = item;
  compose.times = {};
  compose.overrides = {};
  const isVideo = item ? item.type === 'video' : /\.(mp4|mov|m4v)$/i.test(path);
  const previewImage = item?.preview ?? (item?.type === 'images' ? item.path : undefined);
  $('#selected').innerHTML = `<div><b>${esc(item?.name ?? path)}</b></div>${
    isVideo ? `<video src="${fileUrl(path)}" controls muted playsinline preload="metadata"></video>` : previewImage ? `<img src="${fileUrl(previewImage)}" alt="">` : ''
  }`;
  $('#f-title').placeholder = (item?.name ?? path.split('/').pop()).replace(/\.[^.]+$/, '');
  $$('.inbox-item').forEach((el) => el.classList.toggle('selected', compose.inbox[Number(el.dataset.inbox)]?.path === path));
  compose.plan = null;
  syncChannelChecks(true);
  schedulePreview(0);
}

function composeBody() {
  const startMode = $('input[name=start]:checked')?.value ?? 'now';
  const gap = [Number($('#f-gap-min').value) || 0, Number($('#f-gap-max').value) || 0].sort((a, b) => a - b);
  return {
    media: compose.media ? [compose.media] : [],
    title: $('#f-title').value,
    caption: $('#f-caption').value,
    hashtags: $('#f-tags').value,
    channels: [...(compose.channels ?? [])].filter((ch) => canTake(ch, mediaKind())),
    at: startMode === 'at' && $('#f-at').value ? $('#f-at').value : 'now',
    gapMinutes: gap,
    times: compose.times,
    overrides: Object.fromEntries(Object.entries(compose.overrides).map(([ch, text]) => [ch, { text }])),
  };
}

let previewTimer;
function schedulePreview(delay = 400) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, delay);
}

async function runPreview() {
  if (!compose.media) {
    $('#preview').innerHTML = '콘텐츠를 고르면 채널별 미리보기가 나옵니다.';
    $('#submit').disabled = true;
    return;
  }
  const seq = ++compose.seq;
  let plan;
  try {
    plan = await api('/api/preview', composeBody());
  } catch (err) {
    $('#preview').innerHTML = `<div class="err">${esc(err.message)}</div>`;
    return;
  }
  if (seq !== compose.seq) return;
  const guessed = mediaKind();
  compose.plan = plan;
  if (!compose.item && plan.post?.kind && plan.post.kind !== guessed) {
    // 직접 입력한 경로의 종류가 짐작과 다르면 채널 선택을 다시 맞춤
    syncChannelChecks(true);
    compose.times = {};
    schedulePreview(0);
    return;
  }
  for (const job of plan.jobs ?? []) if (!compose.times[job.channel]) compose.times[job.channel] = job.runAtLocal;
  renderPreview(plan);
}

function notesHtml(note) {
  if (!note) return '';
  return [...note.errors.map((e) => `<div class="err">✗ ${esc(e)}</div>`), ...note.warnings.map((w) => `<div class="warn">! ${esc(w)}</div>`)].join('');
}

function renderPreview(plan) {
  const jobs = plan.jobs ?? [];
  const labels = jobs.map((j) => `${j.label}:`);
  const globalErrors = (plan.errors ?? []).filter((e) => !labels.some((l) => e.startsWith(l)));
  const globalWarnings = (plan.warnings ?? []).filter((w) => !labels.some((l) => w.startsWith(l)));
  const globalHtml = [...globalErrors.map((e) => `<div class="err">✗ ${esc(e)}</div>`), ...globalWarnings.map((w) => `<div class="warn">! ${esc(w)}</div>`)].join('');
  const root = $('#preview');
  const table = $('table', root);
  const sameRows = table && table.dataset.channels === jobs.map((j) => j.channel).join(',');

  if (sameRows) {
    $('.global-notes', root).innerHTML = globalHtml;
    for (const job of jobs) {
      const row = $(`tr[data-ch="${job.channel}"]`, root);
      const text = $('textarea', row);
      if (document.activeElement !== text) text.value = job.options.caption;
      const time = $('input[type=datetime-local]', row);
      if (document.activeElement !== time) time.value = toInputTime(job.runAtLocal);
      $('.notes', row).innerHTML = notesHtml(plan.channelNotes?.[job.channel]);
      $('.counter', row).innerHTML = counterHtml(job.channel, text.value);
      $('.edited', row).innerHTML = compose.overrides[job.channel] != null ? `직접 고침 · <a href="#" data-reset="${esc(job.channel)}">기본 문구로</a>` : '';
      const title = $('.job-title', row);
      if (title) title.textContent = job.options.title;
    }
  } else {
    root.classList.remove('muted');
    root.innerHTML = `<div class="global-notes">${globalHtml}</div>${
      jobs.length
        ? `<table data-channels="${esc(jobs.map((j) => j.channel).join(','))}">${jobs
            .map(
              (job) => `<tr data-ch="${esc(job.channel)}">
                <td class="ch"><b>${esc(job.label)}</b><div class="muted small">${esc(job.route)}</div></td>
                <td class="when"><input type="datetime-local" data-time="${esc(job.channel)}" value="${esc(toInputTime(job.runAtLocal))}"></td>
                <td>
                  ${['youtube', 'naver_cafe', 'naver_clip'].includes(job.channel) ? `<div class="small muted">제목: <span class="job-title">${esc(job.options.title)}</span></div>` : ''}
                  <textarea data-text="${esc(job.channel)}">${esc(job.options.caption)}</textarea>
                  <div class="row between"><span class="edited">${compose.overrides[job.channel] != null ? `직접 고침 · <a href="#" data-reset="${esc(job.channel)}">기본 문구로</a>` : ''}</span><span class="counter">${counterHtml(job.channel, job.options.caption)}</span></div>
                  ${String(job.options.caption).includes('{links}') ? '<div class="muted small">{links} 자리에는 먼저 올라간 채널 주소(예: 유튜브 쇼츠)가 올릴 때 자동으로 들어갑니다</div>' : ''}
                  <div class="notes">${notesHtml(plan.channelNotes?.[job.channel])}</div>
                </td>
              </tr>`,
            )
            .join('')}</table>`
        : ''
    }`;
  }
  $('#submit').disabled = !plan.ok;
}

function resetCompose() {
  compose.media = null;
  compose.item = null;
  compose.overrides = {};
  compose.times = {};
  compose.plan = null;
  $('#f-title').value = '';
  $('#f-caption').value = '';
  $('#f-tags').value = '';
  $('#selected').textContent = '선택한 콘텐츠가 없습니다';
  $('#preview').innerHTML = '콘텐츠를 고르면 채널별 미리보기가 나옵니다.';
  $('#preview').classList.add('muted');
  $('#submit').disabled = true;
}

// 입력 이벤트
$('#inbox').addEventListener('click', (e) => {
  const el = e.target.closest('[data-inbox]');
  if (!el) return;
  const item = compose.inbox[Number(el.dataset.inbox)];
  if (item) selectMedia(item.path, item);
});
$('#use-path').addEventListener('click', () => {
  const path = $('#manual-path').value.trim();
  if (path) selectMedia(path, null);
});
for (const id of ['#f-title', '#f-caption', '#f-tags']) $(id).addEventListener('input', () => schedulePreview());
$('#f-channels').addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  if (e.target.checked) compose.channels.add(e.target.value);
  else compose.channels.delete(e.target.value);
  compose.times = {};
  schedulePreview(0);
});
for (const el of [...$$('input[name=start]'), $('#f-at'), $('#f-gap-min'), $('#f-gap-max')]) {
  el.addEventListener('change', () => {
    if (el.id === 'f-at') $('input[name=start][value=at]').checked = true;
    compose.times = {};
    schedulePreview(0);
  });
}
$('#reroll').addEventListener('click', () => {
  compose.times = {};
  schedulePreview(0);
});
$('#preview').addEventListener('input', (e) => {
  const ch = e.target.dataset.text;
  if (ch) {
    compose.overrides[ch] = e.target.value;
    const row = e.target.closest('tr');
    $('.counter', row).innerHTML = counterHtml(ch, e.target.value);
    schedulePreview(600);
  }
});
$('#preview').addEventListener('change', (e) => {
  const ch = e.target.dataset.time;
  if (ch && e.target.value) {
    compose.times[ch] = e.target.value.replace('T', ' ');
    schedulePreview(0);
  }
});
$('#preview').addEventListener('click', (e) => {
  const ch = e.target.dataset?.reset;
  if (!ch) return;
  e.preventDefault();
  delete compose.overrides[ch];
  const row = e.target.closest('tr');
  if (row) $('textarea', row).blur();
  schedulePreview(0);
});
$('#submit').addEventListener('click', async () => {
  const body = composeBody();
  if (!confirm(`${body.channels.length}개 채널에 예약합니다. 예약 시각이 되면 자동으로 올라갑니다. 등록할까요?`)) return;
  $('#submit').disabled = true;
  try {
    const res = await api('/api/posts', body);
    if (!res.ok) {
      renderPreview(res);
      toast('등록할 수 없습니다 — 빨간 글씨를 확인해 주세요');
      return;
    }
    toast('등록했습니다. 예약 시각에 자동으로 올라갑니다.');
    resetCompose();
    await refresh(true);
    showTab('board');
  } catch (err) {
    toast(`등록 실패: ${err.message}`);
    $('#submit').disabled = false;
  }
});

// ---------- 모달 ----------
function openModal(title, bodyHtml, onOk) {
  const dialog = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  dialog.returnValue = '';
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'ok') return;
    try {
      await onOk(dialog);
    } catch (err) {
      toast(`실패: ${err.message}`);
    }
  };
  dialog.showModal();
}

function findJob(id) {
  for (const post of state?.posts ?? []) for (const job of post.jobs) if (job.id === id) return job;
  return undefined;
}

// ---------- 버튼 ----------
document.addEventListener('click', async (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    showTab(goto.dataset.goto);
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action } = btn.dataset;
  const jobId = btn.dataset.job;
  const job = jobId ? findJob(jobId) : undefined;
  const post = (path, body = {}) => api(path, body);
  const jobPath = (verb) => `/api/jobs/${encodeURIComponent(jobId)}/${verb}`;
  try {
    switch (action) {
      case 'assist': {
        // 사용자 클릭 직후에 해야 브라우저가 허용하는 동작부터: 복사 → 새 탭
        navigator.clipboard?.writeText(job?.options?.caption ?? '').catch(() => {});
        if (job?.uploadUrl) window.open(job.uploadUrl, '_blank', 'noopener');
        await post(jobPath('reveal'));
        toast('소개글을 복사하고 업로드 페이지와 파일 위치(Finder)를 열었습니다. 올린 뒤 [완료]를 눌러 주세요.', 7000);
        return;
      }
      case 'done': {
        const url = prompt('게시된 주소를 붙여 넣어 주세요 (모르면 비워 두고 확인)', job?.resultUrl ?? '');
        if (url === null) return;
        await post(jobPath('done'), { url: url.trim() || undefined });
        toast('게시 완료로 표시했습니다');
        break;
      }
      case 'retry': {
        const risky = job?.status === 'needs_check';
        const message = risky
          ? '채널에 실제로 올라가지 않은 것을 확인했나요?\n이미 올라가 있다면 다시 올릴 때 중복 게시가 됩니다.'
          : '다시 올릴까요? (실행기가 켜져 있으면 곧 올라갑니다)';
        if (!confirm(message)) return;
        await post(jobPath('retry'));
        toast('다시 올리도록 예약했습니다');
        break;
      }
      case 'recheck':
        await post(jobPath('recheck'));
        toast('플랫폼 상태를 다시 확인합니다');
        break;
      case 'cancel':
        if (!confirm('이 채널 예약을 취소할까요?')) return;
        await post(jobPath('cancel'));
        break;
      case 'cancel-post':
        if (!confirm('이 콘텐츠의 남은 예약을 모두 취소할까요? (이미 올라간 채널은 그대로 둡니다)')) return;
        await post(`/api/posts/${encodeURIComponent(btn.dataset.post)}/cancel`);
        break;
      case 'run-now':
        if (!confirm(`${job?.label ?? ''} 을(를) 지금 올릴까요?`)) return;
        await post(jobPath('edit'), { runAt: 'now' });
        toast('곧 올라갑니다 (최대 15초)');
        break;
      case 'edit':
        openModal(
          `${job.label} 예약 수정`,
          `<label>시각 <input type="datetime-local" id="m-time" value="${esc(toInputTime(job.runAtLocal))}"></label>
           <label>제목 <input type="text" id="m-title" value="${esc(job.options?.title ?? '')}"></label>
           <label>문구 <textarea id="m-caption" rows="8">${esc(job.options?.caption ?? '')}</textarea></label>`,
          async (dialog) => {
            await post(jobPath('edit'), { runAt: $('#m-time', dialog).value, title: $('#m-title', dialog).value, caption: $('#m-caption', dialog).value });
            toast('수정했습니다');
            await refresh(true);
          },
        );
        return;
      case 'check': {
        btn.disabled = true;
        const r = await post(`/api/channels/${encodeURIComponent(btn.dataset.channel)}/check`);
        toast(`${r.ok ? '✓ 정상' : '✗ 문제 있음'} ${r.account ?? ''} ${r.message ?? ''}`, 7000);
        break;
      }
      case 'check-all': {
        btn.disabled = true;
        const enabled = state.channels.filter((c) => c.enabled);
        let bad = 0;
        for (const c of enabled) {
          const r = await post(`/api/channels/${encodeURIComponent(c.channel)}/check`);
          if (!r.ok) bad += 1;
        }
        toast(bad ? `${bad}개 채널에 문제가 있습니다` : '모든 채널 정상');
        break;
      }
      case 'unblock':
        await post(`/api/channels/${encodeURIComponent(btn.dataset.channel)}/unblock`);
        break;
      case 'meta-token':
        openModal(
          'Meta(Instagram·Facebook) 토큰 등록',
          `<p class="small muted">그래프 API 탐색기에서 앱을 고르고 권한(instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement, pages_manage_posts, business_management)을 넣어 받은 "사용자 토큰"을 붙여 넣으세요. 만료 없는 페이지 토큰으로 바꿔 저장합니다.</p>
           <label>사용자 토큰 <textarea id="m-token" rows="4"></textarea></label>
           <label>페이지 ID <span class="muted small">(페이지가 여러 개일 때만)</span> <input type="text" id="m-page"></label>`,
          async (dialog) => {
            const r = await post('/api/auth/meta', { userToken: $('#m-token', dialog).value.trim(), pageId: $('#m-page', dialog).value.trim() || undefined });
            toast(`저장했습니다: ${r.pageName}${r.igUsername ? ` / @${r.igUsername}` : ''}`, 7000);
          },
        );
        return;
      default:
        return;
    }
  } catch (err) {
    toast(`실패: ${err.message}`, 7000);
  } finally {
    btn.disabled = false;
  }
  await refresh(true);
});

refresh(true);
setInterval(() => refresh(false), 5000);
