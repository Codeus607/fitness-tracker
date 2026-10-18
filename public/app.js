'use strict';

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => String(Math.round(n * 100) / 100);
const fmtInt = n => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
const fmtShort = n => n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : fmt(n);
const parseNum = v => parseFloat(String(v).trim().replace(',', '.'));
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());
const dayMs = d => Date.parse(d + 'T12:00:00');
const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 864e5);
const prettyDate = (d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', opts);
const monthName = m => new Date(m + '-15T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const shiftMonth = (m, n) => { const d = new Date(m + '-15T12:00:00'); d.setMonth(d.getMonth() + n); return iso(d).slice(0, 7); };
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const duration = w => {
  const end = w.finished_at ?? (w.date === today() ? Date.now() / 1000 : null);
  if (!end || end - w.started_at > 6 * 3600) return '';
  const min = Math.round((end - w.started_at) / 60);
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min} min`;
};
const sinceClass = d => d <= 3 ? 'good' : d <= 7 ? 'warn' : 'bad';
const sinceLabel = d => d === 0 ? 'today' : `${d}d`;

// Brzycki 1RM estimate (from the original fitness-tracker.py spec)
const brz = (w, r) => r <= 0 ? 0 : r === 1 ? w : r < 37 ? w * 36 / (37 - r) : w;
// bodyweight lifts rank by extra weight then reps (a 1RM of the extra weight alone means nothing)
const score = (s, i) => i.timed ? [s.reps, s.weight] : i.bw ? [s.weight, s.reps] : [brz(s.weight, s.reps), s.weight, s.reps];
const cmp = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k]; return 0; };
const working = sets => sets.filter(s => !s.warmup);
const bestOf = (sets, i) => working(sets).reduce((b, s) => !b || cmp(score(s, i), score(b, i)) > 0 ? s : b, null);
const loadOf = (sets, i) => i.timed ? 0 : sum(working(sets), s => s.reps * s.weight);

function setLabel(s, i, short = false) {
  const w = s.weight, r = fmt(s.reps);
  if (i.timed) return (w > 0 ? `+${fmt(w)}kg ` : '') + r + 's';
  if (i.bw) return (w > 0 ? `+${fmt(w)}` : short ? 'BW' : 'BW') + '×' + r;
  return `${fmt(w)}×${r}`;
}

// the headline number for an exercise, also what goals are set against
function mainMetric(i) {
  if (i.timed) return { key: 'sec', label: 'best hold', unit: 's' };
  if (i.bw) return { key: 'reps', label: 'max reps', unit: 'reps' };
  return { key: 'e1rm', label: 'est. 1RM', unit: 'kg' };
}
function chartMetrics(i) {
  if (i.timed) return [['sec', 'hold (s)'], ['weight', 'extra kg']];
  if (i.bw) return [['reps', 'max reps'], ['weight', 'extra kg'], ['volume', 'load']];
  return [['e1rm', 'est. 1RM'], ['weight', 'heaviest'], ['volume', 'load']];
}
function sessionValue(sets, key) {
  const ws = working(sets);
  if (!ws.length) return null;
  switch (key) {
    case 'e1rm': return Math.max(...ws.map(s => brz(s.weight, s.reps)));
    case 'weight': return Math.max(...ws.map(s => s.weight));
    case 'reps': case 'sec': return Math.max(...ws.map(s => s.reps));
    case 'volume': return sum(ws, s => s.reps * s.weight);
  }
}
const metricUnit = key => ({ e1rm: 'kg', weight: 'kg', volume: 'kg', reps: 'reps', sec: 's' }[key]);

// ---------- state ----------
const S = {
  groups: [], info: {}, workouts: [], goals: {}, hist: {}, parts: [], meas: [], sizeTargets: {},
  tab: 'log', view: null, month: today().slice(0, 7), showAll: false, metric: null,
  cards: null, cardsFor: null, restAt: null, busy: false,
};

const info = name => S.info[name] || { name, group: 'Other', timed: false, bw: false };
const active = () => S.workouts.find(w => w.finished_at == null);
const workoutById = id => S.workouts.find(w => w.id === id);

function ingest(d) {
  S.groups = d.exercises;
  S.goals = d.goals || {};
  S.parts = d.parts || [];
  S.meas = (d.measurements || []).map(m => ({ ...m, value: +m.value }));
  S.sizeTargets = Object.fromEntries(Object.entries(d.size_targets || {}).map(([k, v]) => [k, +v]));
  S.info = {};
  for (const g of S.groups) for (const e of g.exercises) S.info[e.name] = { ...e, group: g.name };
  S.workouts = d.workouts;
  reindex();
}

function reindex() {
  for (const w of S.workouts) {
    w.id = +w.id;
    w.started_at = +w.started_at;
    w.finished_at = w.finished_at == null ? null : +w.finished_at;
    for (const s of w.sets) for (const k of ['id', 'reps', 'weight', 'warmup', 'ex_order', 'set_order']) s[k] = +s[k];
  }
  S.workouts.sort((a, b) => a.date.localeCompare(b.date) || a.started_at - b.started_at);
  S.hist = {};
  for (const w of S.workouts) {
    for (const [ex, sets] of groupByExercise(w.sets)) (S.hist[ex] ||= []).push({ w, sets });
  }
}

function groupByExercise(sets) {
  const m = new Map();
  for (const s of sets) { if (!m.has(s.exercise)) m.set(s.exercise, []); m.get(s.exercise).push(s); }
  return m;
}

function replaceWorkout(w) {
  const i = S.workouts.findIndex(x => x.id === +w.id);
  if (i >= 0) S.workouts[i] = w; else S.workouts.push(w);
  reindex();
}

// sets in workout w that beat everything logged before them (ignores first-ever sessions)
function prSets(w) {
  const out = new Map();
  const idx = S.workouts.indexOf(w);
  for (const [ex, sets] of groupByExercise(w.sets)) {
    const i = info(ex);
    const prior = (S.hist[ex] || []).filter(h => S.workouts.indexOf(h.w) < idx).flatMap(h => working(h.sets));
    if (!prior.length) continue;
    let best = score(bestOf(prior, i), i);
    let maxW = Math.max(...prior.map(s => s.weight));
    for (const s of working(sets)) {
      const sc = score(s, i);
      if (cmp(sc, best) > 0) { out.set(s.id, i.timed ? 'longest hold' : i.bw ? `best set ${setLabel(s, i)}` : `est. 1RM ${fmt(brz(s.weight, s.reps).toFixed(1))} kg`); best = sc; }
      else if (!i.timed && s.weight > maxW) out.set(s.id, `heaviest ${fmt(s.weight)} kg`);
      maxW = Math.max(maxW, s.weight);
    }
  }
  return out;
}

// ---------- api ----------
async function api(action, body) {
  const opts = body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Fit': '1' }, body: JSON.stringify(body) };
  let res;
  try { res = await fetch('api.php?a=' + action, opts); }
  catch { throw new Error('No connection to the server'); }
  let data = {};
  try { data = await res.json(); } catch { }
  if (res.status === 401 && action !== 'login') { renderLogin(); throw new Error('Not logged in'); }
  if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
  return data;
}

async function run(fn) {
  if (S.busy) return;
  S.busy = true;
  try { await fn(); }
  catch (e) { if (e.message !== 'Not logged in') toast(e.message, true); }
  finally { S.busy = false; }
}

// ---------- draft of the active workout (unticked rows survive a reload) ----------
const draftKey = id => 'fit-draft-' + id;
function saveDraft() {
  if (!S.cards) return;
  try {
    localStorage.setItem(draftKey(S.cardsFor), JSON.stringify(S.cards.map(c => ({
      ex: c.ex, rows: c.rows.map(r => r.done ? { id: r.id } : { w: r.w, r: r.r, wu: r.wu }),
    }))));
  } catch { }
}
function loadDraft(id) {
  try { return JSON.parse(localStorage.getItem(draftKey(id)) || 'null'); } catch { return null; }
}
function clearDraft(id) { try { localStorage.removeItem(draftKey(id)); } catch { } }

function buildCards(w) {
  const byId = new Map(w.sets.map(s => [s.id, s]));
  const used = new Set();
  const toRow = s => ({ id: s.id, w: fmt(s.weight), r: fmt(s.reps), wu: !!s.warmup, done: true });
  const cards = [];
  for (const dc of loadDraft(w.id) || []) {
    const rows = [];
    for (const r of dc.rows) {
      if (r.id) {
        const s = byId.get(r.id);
        if (s && s.exercise === dc.ex) { rows.push(toRow(s)); used.add(s.id); }
      } else rows.push({ w: r.w ?? '', r: r.r ?? '', wu: !!r.wu, done: false });
    }
    cards.push({ ex: dc.ex, rows });
  }
  for (const s of w.sets) {
    if (used.has(s.id)) continue;
    let c = cards.find(c => c.ex === s.exercise);
    if (!c) cards.push(c = { ex: s.exercise, rows: [] });
    c.rows.push(toRow(s));
  }
  return cards;
}

// the last session of an exercise before workout w
function previousSession(ex, w) {
  const h = (S.hist[ex] || []).filter(h => h.w !== w && (h.w.date < w.date || (h.w.date === w.date && h.w.started_at < w.started_at)));
  return h.length ? h[h.length - 1] : null;
}

// ---------- rendering ----------
function render() {
  hideTip();
  $('#tabs').hidden = false;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === S.tab && !S.view);
  const focus = document.activeElement?.dataset?.k;
  const v = S.view;
  $('#app').innerHTML = v?.type === 'workout' ? viewWorkout(v.id)
    : v?.type === 'exercise' ? viewExercise(v.name)
    : v?.type === 'measure' ? viewMeasure()
    : S.tab === 'log' ? viewLog()
    : S.tab === 'history' ? viewHistory()
    : viewStats();
  if (focus) {
    const el = document.querySelector(`[data-k="${focus}"]`);
    if (el) { el.focus(); if (el.select && el.tagName === 'INPUT') el.select(); }
  }
  tick();
}

function renderLogin() {
  $('#tabs').hidden = true;
  $('#rest').hidden = true;
  $('#app').innerHTML = `
    <div class="login">
      <h1>login</h1>
      <p>// private area — enter your password</p>
      <form id="loginForm">
        <input type="password" id="pw" autocomplete="current-password" placeholder="password" required>
        <div style="height:10px"></div>
        <button class="btn primary block">enter</button>
      </form>
    </div>`;
  $('#pw').focus();
}

function workoutCard(w) {
  const groups = [...new Set(w.sets.map(s => info(s.exercise).group))];
  const exs = groupByExercise(w.sets);
  const load = sum([...exs], ([ex, sets]) => loadOf(sets, info(ex)));
  const dur = duration(w);
  return `
    <button class="card link" data-act="openW" data-id="${w.id}">
      <div class="row between">
        <h3>${esc(prettyDate(w.date))}${w.finished_at == null ? ' <span class="good">· in progress</span>' : ''}</h3>
        <span class="meta">${dur}</span>
      </div>
      <div class="muted" style="font-size:.85rem;margin:2px 0 4px">${groups.length ? groups.map(esc).join(', ') : 'empty'}</div>
      <div class="meta">${exs.size} exercises · ${working(w.sets).length} sets · ${fmtInt(load)} kg</div>
    </button>`;
}

// ----- log tab -----
function viewLog() {
  const w = active();
  if (!w) {
    S.cards = null;
    const recent = S.workouts.slice(-3).reverse();
    return `
      <h1>new workout</h1>
      <div class="card">
        <label class="field" for="startDate">date</label>
        <input type="date" id="startDate" value="${today()}" max="${today()}">
        <div style="height:12px"></div>
        <button class="btn primary block" data-act="start">start workout</button>
      </div>
      ${recent.length ? `<h2>recent</h2>${recent.map(workoutCard).join('')}` : `<p class="meta">no workouts yet — start your first one above</p>`}`;
  }
  if (!S.cards || S.cardsFor !== w.id) { S.cards = buildCards(w); S.cardsFor = w.id; }
  const prs = prSets(w);
  const total = sum(S.cards, c => loadOf(w.sets.filter(s => s.exercise === c.ex), info(c.ex)));
  return `
    <div class="row between">
      <h1>${w.date === today() ? 'workout' : 'workout · ' + esc(prettyDate(w.date))}</h1>
      <span class="timer" data-tick="elapsed"></span>
    </div>
    <div class="meta" style="margin:-8px 0 14px">${working(w.sets).length} sets · ${fmtInt(total)} kg</div>
    ${S.cards.map((c, ci) => exerciseCard(w, c, ci, prs)).join('')}
    <button class="btn block" data-act="pick">+ add exercise</button>
    <h2>notes</h2>
    <textarea data-k="note" rows="2" placeholder="how did it feel? sleep, energy, pain…">${esc(w.note)}</textarea>
    <div class="row" style="margin-top:10px">
      <label class="field" for="wdate" style="margin:0">date</label>
      <input type="date" id="wdate" data-k="wdate" value="${w.date}" max="${today()}" style="width:auto">
    </div>
    <div class="row" style="margin-top:22px">
      <button class="btn danger" data-act="discard">discard</button>
      <button class="btn primary grow" data-act="finish">finish workout</button>
    </div>`;
}

function exerciseCard(w, c, ci, prs) {
  const i = info(c.ex);
  const prev = previousSession(c.ex, w);
  const prevSets = prev ? prev.sets : [];
  const saved = w.sets.filter(s => s.exercise === c.ex);
  const best = bestOf(saved, i);
  let n = 0;
  const rows = c.rows.map((r, ri) => {
    const p = prevSets[ri];
    const label = r.wu ? 'W' : String(++n);
    const pr = r.done && prs.get(r.id);
    return `
      <tr class="${r.done ? 'done' : ''}">
        <td class="n"><button class="setno ${r.wu ? 'wu' : ''}" data-act="setMenu" data-c="${ci}" data-r="${ri}" aria-label="set options">${label}</button></td>
        <td class="prev">${p ? `<button data-act="usePrev" data-c="${ci}" data-r="${ri}">${esc(setLabel(p, i, true))}</button>` : '<span class="dim">—</span>'}</td>
        <td class="w"><input type="text" inputmode="decimal" data-k="${ci}-${ri}-w" value="${esc(r.w)}" placeholder="${p ? fmt(p.weight) : i.bw || i.timed ? '0' : ''}" aria-label="${i.bw || i.timed ? 'extra kg' : 'kg'}"></td>
        <td class="r"><input type="text" inputmode="decimal" data-k="${ci}-${ri}-r" value="${esc(r.r)}" placeholder="${p ? fmt(p.reps) : ''}" aria-label="${i.timed ? 'seconds' : 'reps'}"></td>
        <td class="ok"><button class="tick" data-act="tick" data-c="${ci}" data-r="${ri}" aria-label="${r.done ? 'untick' : 'save set'}">✓</button></td>
      </tr>
      ${pr ? `<tr><td></td><td colspan="4" style="text-align:left"><span class="pr">🏆 PR · ${esc(pr)}</span></td></tr>` : ''}`;
  }).join('');
  return `
    <div class="card ex-card">
      <div class="row between">
        <h3 class="grow"><a href="#" data-act="openEx" data-ex="${esc(c.ex)}">${esc(c.ex)}</a><span class="group">${esc(i.group)}</span></h3>
        <button class="xbtn" data-act="removeCard" data-c="${ci}" aria-label="remove exercise">×</button>
      </div>
      <table class="sets">
        <thead><tr><th>set</th><th>prev</th><th>${i.bw || i.timed ? '+kg' : 'kg'}</th><th>${i.timed ? 'sec' : 'reps'}</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="ex-foot">
        <button class="btn small" data-act="addRow" data-c="${ci}">+ set</button>
        <span class="meta">${i.timed ? '' : fmtInt(loadOf(saved, i)) + ' kg'}${best && !i.timed && !i.bw && best.weight ? ` · 1RM ${fmt(brz(best.weight, best.reps).toFixed(1))}` : ''}${prev ? ` · last ${sinceLabel(daysBetween(prev.w.date, w.date))}` : ''}</span>
      </div>
    </div>`;
}

// ----- exercise picker -----
function openPicker() {
  S.pickGroup = S.pickGroup ?? null;
  $('#sheet').innerHTML = `
    <div class="sheet-body" role="dialog" aria-label="add exercise">
      <div class="row">
        <input type="search" id="pickq" placeholder="search exercises…" autocomplete="off">
        <button class="btn ghost" data-act="closeSheet">close</button>
      </div>
      <div class="chips">
        <button class="chip ${S.pickGroup == null ? 'on' : ''}" data-act="pickGroup" data-g="">all</button>
        ${S.groups.map(g => `<button class="chip ${S.pickGroup === g.name ? 'on' : ''}" data-act="pickGroup" data-g="${esc(g.name)}">${esc(g.name.toLowerCase())}</button>`).join('')}
      </div>
      <div class="sheet-scroll" id="picklist"></div>
    </div>`;
  $('#sheet').hidden = false;
  renderPickList();
}

function renderPickList() {
  const q = ($('#pickq')?.value || '').trim().toLowerCase();
  const added = new Set((S.cards || []).map(c => c.ex));
  const t = today();
  const html = S.groups
    .filter(g => S.pickGroup == null || g.name === S.pickGroup)
    .map(g => {
      const items = g.exercises.filter(e => !q || e.name.toLowerCase().includes(q));
      if (!items.length) return '';
      return `<div class="group-label">${esc(g.name)}</div>` + items.map(e => {
        const h = S.hist[e.name];
        const d = h ? daysBetween(h[h.length - 1].w.date, t) : null;
        return `<button class="pick ${added.has(e.name) ? 'added' : ''}" data-act="addEx" data-ex="${esc(e.name)}">
          <span>${esc(e.name)}</span>
          <span class="meta ${d == null ? 'dim' : sinceClass(d)}">${added.has(e.name) ? 'added' : d == null ? 'new' : sinceLabel(d) + ' ago'}</span>
        </button>`;
      }).join('');
    }).join('');
  $('#picklist').innerHTML = html || '<p class="meta">no match — add it to Fitness Exercises.md</p>';
}

function closeSheet() { $('#sheet').hidden = true; $('#sheet').innerHTML = ''; }

function addExercise(ex) {
  closeSheet();
  const existing = S.cards.findIndex(c => c.ex === ex);
  if (existing < 0) {
    const prev = previousSession(ex, active());
    // pre-create as many rows as last time; values come from the "prev" placeholders
    const rows = (prev ? prev.sets : [null]).map(s => ({ w: '', r: '', wu: !!s?.warmup, done: false }));
    S.cards.push({ ex, rows });
    saveDraft();
  }
  render();
  const idx = existing < 0 ? S.cards.length - 1 : existing;
  document.querySelectorAll('.ex-card')[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveRow(ci, ri) {
  const w = active();
  const c = S.cards[ci], row = c.rows[ri], i = info(c.ex);
  const p = previousSession(c.ex, w)?.sets[ri];
  // an empty field takes the "previous" value shown as placeholder, like Strong/Hevy
  const reps = parseNum(row.r !== '' ? row.r : p ? p.reps : '');
  const weight = row.w !== '' ? parseNum(row.w) : p ? p.weight : 0;
  if (!(reps > 0)) throw new Error(i.timed ? 'Enter the seconds' : 'Enter the reps');
  if (!(weight >= 0)) throw new Error('Invalid weight');
  const res = await api('set_save', { id: row.id, workout_id: w.id, exercise: c.ex, ex_order: ci, set_order: ri, reps, weight, warmup: row.wu });
  const wasNew = !row.id;
  Object.assign(row, { id: res.id, done: true, dirty: false, w: fmt(weight), r: fmt(reps) });
  replaceWorkout(res.workout);
  if (wasNew) S.restAt = Date.now();
  saveDraft();
  render();
  const pr = !row.wu && prSets(active()).get(res.id);
  if (pr) toast(`🏆 new PR · ${c.ex} · ${pr}`);
}

async function unsaveRow(ci, ri) {
  const w = active(), row = S.cards[ci].rows[ri];
  const res = await api('set_delete', { workout_id: w.id, ids: [row.id] });
  Object.assign(row, { id: undefined, done: false });
  replaceWorkout(res.workout);
  saveDraft();
  render();
}

function addRow(ci) {
  const c = S.cards[ci];
  const last = c.rows[c.rows.length - 1];
  c.rows.push({ w: last ? last.w : '', r: last ? last.r : '', wu: false, done: false });
  saveDraft();
  render();
  $(`[data-k="${ci}-${c.rows.length - 1}-r"]`)?.focus();
}

function setMenu(ci, ri) {
  const c = S.cards[ci], row = c.rows[ri];
  $('#sheet').innerHTML = `
    <div class="sheet-body" role="dialog" aria-label="set options">
      <h3>${esc(c.ex)} <span class="muted">· set ${ri + 1}</span></h3>
      <div style="height:12px"></div>
      <button class="btn block" data-act="toggleWu" data-c="${ci}" data-r="${ri}">${row.wu ? 'mark as working set' : 'mark as warm-up'}</button>
      <div style="height:8px"></div>
      <button class="btn block danger" data-act="delRow" data-c="${ci}" data-r="${ri}">delete set</button>
      <div style="height:8px"></div>
      <button class="btn block ghost" data-act="closeSheet">cancel</button>
    </div>`;
  $('#sheet').hidden = false;
}

// ----- history -----
function viewHistory() {
  if (!S.workouts.length) return '<h1>history</h1><p class="meta">nothing logged yet</p>';
  const byMonth = new Map();
  for (const w of [...S.workouts].reverse()) {
    const m = w.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(w);
  }
  return '<h1>history</h1>' + [...byMonth].map(([m, ws]) => {
    const load = sum(ws, w => sum([...groupByExercise(w.sets)], ([ex, sets]) => loadOf(sets, info(ex))));
    return `<h2>${esc(monthName(m).toLowerCase())}</h2>
      <div class="meta" style="margin:-6px 0 10px">${ws.length} workouts · ${fmtInt(load)} kg</div>
      ${ws.map(workoutCard).join('')}`;
  }).join('');
}

function viewWorkout(id) {
  const w = workoutById(id);
  if (!w) return '<button class="btn ghost small" data-act="back">← back</button><p class="meta">workout not found</p>';
  const exs = groupByExercise(w.sets);
  const prs = prSets(w);
  const load = sum([...exs], ([ex, sets]) => loadOf(sets, info(ex)));
  const dur = duration(w);
  return `
    <button class="btn ghost small" data-act="back">← back</button>
    <h1>${esc(prettyDate(w.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toLowerCase())}</h1>
    <div class="meta">${[dur, `${working(w.sets).length} sets`, `${fmtInt(load)} kg`].filter(Boolean).join(' · ')}</div>
    ${w.note ? `<div class="card" style="margin-top:12px;white-space:pre-wrap">${esc(w.note)}</div>` : ''}
    <div class="card" style="margin-top:12px">
      ${[...exs].map(([ex, sets]) => {
        const i = info(ex);
        return `<h3><a href="#" data-act="openEx" data-ex="${esc(ex)}">${esc(ex)}</a></h3>
          <div class="w-sets">${sets.map(s => `<span class="${s.warmup ? 'wu' : ''}">${s.warmup ? 'W ' : ''}${esc(setLabel(s, i))}${prs.has(s.id) ? ' 🏆' : ''}</span>`).join(' · ')}
          ${i.timed ? '' : `<span class="muted"> = ${fmtInt(loadOf(sets, i))} kg</span>`}</div>`;
      }).join('') || '<p class="meta">no sets</p>'}
    </div>
    <div class="row" style="margin-top:16px">
      <button class="btn danger" data-act="deleteW" data-id="${w.id}">delete</button>
      <span class="grow"></span>
      ${w.finished_at != null ? `<button class="btn" data-act="reopen" data-id="${w.id}">edit workout</button>` : `<button class="btn" data-act="goLog">continue</button>`}
    </div>`;
}

// ----- body maps -----
// Front and back views generated by tools/body_figure.py, origin at the top centre of the figure.
// sil is the whole body; each muscle is one path covering both sides. neck is never coloured.
const BODY = {
  front: {
    sil: 'M-97.4,236.5L-100.9,246.5L-101.9,251.4L-102.1,255.8L-101.5,258.1L-99.5,260.4L-97.7,261.5L-95.1,261.8L-92.2,260.9L-89.3,258.7L-87.8,256.6L-85.8,251.9L-84.0,245.5L-83.2,240.3L-82.6,239.4L-76.9,222.0L-70.2,200.2L-63.4,168.9L-54.4,137.2L-53.4,136.0L-51.7,135.9L-50.6,137.0L-48.4,144.3L-43.6,166.2L-40.8,185.2L-40.0,197.1L-40.4,205.7L-42.0,216.7L-43.6,224.7L-47.3,237.4L-48.2,244.9L-48.9,246.0L-51.0,285.7L-50.6,301.7L-46.7,329.6L-46.0,338.5L-46.2,347.5L-48.0,365.9L-47.7,375.6L-46.3,385.1L-43.1,400.1L-38.7,426.1L-40.5,431.8L-42.0,443.9L-45.0,452.0L-45.0,454.0L-44.0,455.7L-41.2,457.7L-37.0,459.0L-30.2,460.0L-24.9,460.3L-20.5,459.8L-19.0,459.0L-18.0,457.9L-17.5,456.4L-17.2,452.6L-18.7,431.6L-19.9,427.5L-21.3,425.6L-21.5,424.7L-16.0,372.3L-16.4,348.6L-15.8,336.3L-14.0,324.0L-9.6,300.5L-7.4,285.2L-6.5,284.0L-4.4,283.5L-1.6,278.7L0.1,277.9L1.6,278.7L4.4,283.5L6.5,284.0L7.4,285.2L9.6,300.5L14.0,324.0L15.8,336.3L16.4,348.6L16.0,372.3L21.5,424.7L21.3,425.6L19.9,427.5L18.7,431.6L17.2,452.6L17.5,456.4L18.0,457.9L19.0,459.0L20.5,459.8L24.9,460.3L30.3,460.0L37.0,459.0L40.0,458.2L42.4,457.1L44.6,454.9L45.2,453.1L45.1,452.1L42.0,444.1L40.5,431.8L38.7,426.1L43.1,400.1L46.3,385.1L47.7,375.6L48.0,365.9L46.2,347.5L46.0,338.5L46.7,329.6L50.2,304.9L51.0,295.4L51.0,288.9L50.5,273.4L48.9,246.0L48.2,244.9L47.3,237.4L43.6,224.7L42.0,216.7L40.4,205.7L40.0,197.1L40.8,185.2L43.6,166.2L48.4,144.3L50.6,137.0L51.7,135.9L53.4,136.0L54.4,137.2L63.4,168.9L70.2,200.2L76.9,222.0L82.6,239.4L83.2,240.3L84.4,246.9L87.1,255.2L88.6,257.8L91.2,260.3L93.3,261.4L96.0,261.9L98.7,261.0L101.0,259.0L101.9,257.0L102.1,253.0L100.5,245.0L97.4,236.7L95.2,209.0L93.7,195.3L92.0,186.1L87.2,166.3L86.0,157.5L83.8,132.1L81.7,120.5L77.1,100.4L75.9,100.5L75.1,100.0L71.4,94.4L68.9,92.2L66.5,90.7L63.4,89.6L60.6,89.1L53.5,89.5L48.3,86.7L39.6,83.1L31.4,80.6L20.8,78.1L14.4,70.5L13.9,69.4L12.4,54.9L16.9,48.3L19.4,42.1L20.8,34.5L20.8,26.7L19.2,19.2L15.9,12.1L11.7,6.9L6.6,3.5L3.1,2.3L-1.0,2.0L-4.6,2.7L-8.0,4.2L-11.7,6.9L-14.5,10.0L-16.9,13.7L-18.8,18.0L-20.1,22.6L-20.8,27.5L-21.0,32.4L-20.5,37.4L-19.4,42.1L-17.7,46.5L-15.6,50.5L-12.7,54.2L-12.4,55.3L-14.0,69.8L-20.0,77.5L-21.0,78.2L-31.4,80.6L-39.6,83.1L-48.3,86.7L-53.5,89.5L-60.1,89.0L-65.5,90.3L-68.4,91.9L-71.0,94.0L-73.1,96.5L-75.1,100.0L-75.9,100.5L-77.1,100.4L-81.7,120.5L-83.8,132.1L-86.0,157.5L-87.2,166.3L-92.0,186.1L-93.7,195.3L-95.2,209.0Z',
    neck: 'M10.5,74.7L10.9,73.4L10.1,63.8L9.8,62.7L8.9,61.9L0.0,60.1L-8.5,61.7L-9.8,62.7L-10.1,63.8L-10.8,74.1L-4.1,83.6L-2.7,84.0L3.0,84.0L4.1,83.6Z',
    traps: 'M-18.4,80.4L-30.7,83.3L-40.2,86.3L-41.6,87.6L-41.6,89.5L-40.7,90.6L-39.6,91.0L-19.0,90.8L-17.6,89.4L-16.1,82.7L-16.4,81.5L-17.3,80.7ZM19.1,80.5L17.1,80.9L16.1,82.7L17.6,89.4L19.0,90.8L39.6,91.0L40.7,90.6L41.6,89.5L41.6,87.6L40.2,86.3L30.7,83.3Z',
    chest: 'M-14.0,92.0L-16.3,93.7L-17.7,94.2L-39.8,94.3L-43.5,95.8L-46.2,98.4L-47.4,101.1L-48.1,105.8L-48.0,110.5L-47.4,115.5L-46.1,119.9L-45.0,122.0L-43.6,123.8L-40.3,126.8L-36.4,129.3L-32.2,131.2L-25.6,132.8L-20.6,132.9L-10.4,131.9L-6.4,132.0L-4.3,130.9L-3.0,127.8L-1.4,116.3L-1.1,106.3L-2.0,97.8L-3.0,95.0L-5.1,93.0L-7.0,92.2L-9.3,91.8ZM9.7,91.8L6.5,92.4L4.7,93.3L3.3,94.7L2.0,97.8L1.3,101.6L1.1,111.3L1.9,121.0L3.0,127.8L4.4,131.1L6.7,132.1L10.4,131.9L20.7,132.9L27.7,132.5L32.0,131.3L36.3,129.4L42.2,125.2L44.9,122.2L45.9,120.2L46.8,117.7L47.8,112.9L48.2,108.0L47.8,102.5L46.8,99.5L45.4,97.3L43.2,95.7L39.5,94.2L17.7,94.2L16.3,93.7L14.2,92.0Z',
    frontDelt: 'M-49.1,92.2L-50.7,91.6L-53.9,92.4L-60.0,91.8L-61.1,92.2L-61.9,93.0L-66.3,119.4L-66.1,120.7L-65.2,121.8L-61.3,122.8L-57.3,122.9L-53.0,121.9L-51.0,121.0L-50.2,120.2L-49.9,118.8L-51.0,113.3L-51.3,105.8L-50.4,99.9L-47.8,94.7L-48.0,93.3ZM48.4,92.8L47.9,93.8L47.9,95.0L50.4,99.8L51.3,105.6L51.0,113.3L49.9,118.8L50.2,120.2L51.0,121.0L53.0,121.9L57.3,122.9L61.3,122.8L65.2,121.8L66.1,120.7L66.3,119.4L61.9,93.0L61.1,92.2L60.0,91.8L53.9,92.4L50.7,91.6L49.5,91.9Z',
    sideDelt: 'M-66.4,99.6L-66.6,98.4L-67.4,97.5L-68.5,97.0L-69.9,97.3L-70.8,98.1L-72.7,101.5L-75.0,103.9L-75.9,107.7L-75.4,110.4L-73.4,114.9L-71.8,116.4L-69.9,116.2L-68.9,114.9ZM68.9,114.9L69.5,115.9L70.6,116.4L71.8,116.4L72.8,115.8L74.9,112.0L75.9,107.9L74.7,103.3L72.6,101.4L70.4,97.7L68.7,97.0L67.0,97.8L66.4,99.6Z',
    biceps: 'M-78.1,128.5L-79.8,129.0L-80.8,130.5L-81.8,139.4L-83.2,157.8L-84.7,169.0L-84.2,170.0L-83.1,170.8L-68.9,173.7L-67.8,173.3L-67.0,172.1L-63.7,159.1L-56.8,135.8L-56.8,134.6L-57.4,133.5L-58.4,132.9ZM58.2,132.9L57.0,134.0L56.8,135.8L67.3,172.8L68.2,173.5L69.6,173.8L83.7,170.5L84.5,169.7L84.7,168.3L83.2,157.8L81.4,134.9L80.3,129.5L79.4,128.7L78.1,128.5Z',
    forearms: 'M-84.3,174.8L-85.6,175.2L-86.6,176.4L-89.2,186.8L-90.9,195.6L-92.9,214.2L-92.3,215.7L-90.9,216.5L-89.1,216.2L-88.2,214.9L-80.2,177.9L-80.5,176.5L-81.2,175.6ZM81.4,175.5L80.5,176.5L80.2,177.9L88.1,214.6L89.1,216.2L90.9,216.5L92.3,215.7L92.9,214.0L91.2,197.9L89.2,186.7L86.3,175.8L84.5,174.8ZM-74.7,176.9L-76.3,177.4L-77.1,178.8L-88.3,231.7L-88.0,233.5L-86.4,234.5L-84.6,234.3L-83.5,232.9L-74.1,203.7L-69.9,186.5L-68.7,180.4L-69.0,179.0L-70.4,177.9ZM69.9,178.1L68.9,179.2L68.7,180.6L71.8,195.2L74.8,205.9L83.6,233.2L84.9,234.4L86.7,234.5L88.0,233.5L88.3,231.7L77.1,178.6L76.3,177.4L75.0,176.9Z',
    abs: 'M-4.0,153.6L-2.6,152.8L-2.0,151.5L-2.0,140.1L-2.5,138.6L-3.9,137.8L-15.3,136.3L-17.1,136.9L-18.0,138.7L-18.0,149.9L-17.5,151.4L-15.9,152.3ZM16.8,152.0L17.7,151.0L18.0,149.9L18.0,138.5L17.3,137.0L15.3,136.3L4.1,137.7L2.7,138.5L2.0,139.9L2.0,151.3L2.7,153.0L4.5,153.7ZM-3.9,173.8L-2.7,173.1L-2.0,171.7L-2.0,160.3L-2.6,158.7L-4.3,157.9L-16.7,157.2L-18.2,157.7L-19.0,159.6L-19.0,170.7L-18.4,172.3L-16.7,173.1ZM17.7,172.9L18.7,171.9L19.0,170.7L19.0,159.3L18.3,157.9L16.4,157.2L4.3,157.9L2.7,158.5L2.0,160.3L2.0,171.7L2.7,173.1L4.6,173.8ZM-3.7,193.9L-2.6,193.1L-2.0,191.8L-2.0,180.2L-2.7,178.7L-4.4,178.0L-16.8,178.0L-18.3,178.7L-19.0,180.4L-19.0,191.8L-18.3,193.3L-16.6,194.0ZM17.5,193.8L18.4,193.1L19.0,191.8L19.0,180.2L18.3,178.7L16.6,178.0L4.2,178.0L2.7,178.7L2.0,180.2L2.0,191.6L2.7,193.3L4.4,194.0ZM-4.5,257.1L-2.7,256.4L-2.0,254.7L-2.1,199.9L-2.9,198.6L-4.2,198.0L-17.0,198.1L-18.4,198.9L-18.9,200.5L-17.0,239.9L-8.3,255.4L-7.3,256.2ZM7.9,255.9L17.0,239.7L18.9,200.5L18.4,198.9L17.0,198.1L4.2,198.0L2.9,198.6L2.1,199.9L2.0,254.9L2.7,256.4L4.0,257.0L5.2,256.9Z',
    obliques: 'M-25.2,136.2L-33.1,134.3L-37.6,132.3L-42.6,130.9L-43.8,130.9L-44.8,131.4L-45.5,132.3L-45.6,133.5L-44.2,148.4L-43.5,149.9L-42.5,150.5L-26.9,155.1L-25.7,155.1L-24.7,154.5L-24.0,152.8L-24.1,137.9ZM25.2,136.2L24.3,137.2L24.0,138.3L24.0,153.0L25.1,154.8L27.1,155.1L42.5,150.5L43.8,149.5L44.2,148.4L45.7,133.3L45.4,132.1L44.6,131.3L42.6,130.9L37.6,132.3L31.0,135.0ZM-24.1,161.3L-24.7,160.3L-25.7,159.7L-39.4,156.9L-41.2,157.5L-42.0,159.1L-38.8,178.7L-37.1,195.9L-35.6,197.4L-26.5,199.4L-24.9,198.9L-24.0,197.2ZM24.1,197.7L25.1,199.0L26.7,199.4L35.6,197.4L37.1,195.9L38.8,178.7L42.0,159.6L41.6,158.0L40.6,157.1L39.2,157.0L25.9,159.6L24.9,160.1L24.2,161.1ZM-24.1,205.2L-24.7,204.3L-25.7,203.7L-34.5,201.7L-35.9,201.8L-37.0,202.7L-40.3,222.6L-43.9,235.9L-43.7,237.2L-42.7,238.2L-26.6,244.8L-24.9,244.2L-24.0,242.6ZM24.2,243.3L25.3,244.5L27.1,244.7L42.5,238.3L43.8,236.8L43.8,235.4L40.2,222.5L38.3,211.7L37.4,203.6L36.8,202.5L35.7,201.7L34.5,201.7L25.7,203.7L24.7,204.3L24.1,205.2Z',
    quads: 'M-36.2,254.7L-36.6,253.4L-37.7,252.5L-44.0,251.9L-45.7,252.4L-46.6,254.1L-48.1,282.7L-48.0,298.2L-47.1,307.7L-43.7,331.4L-42.9,332.7L-41.6,333.3L-38.8,333.0L-37.8,332.1L-37.5,331.0L-38.6,309.9L-38.8,296.3L-38.1,279.3ZM36.3,254.0L38.8,299.7L37.5,331.0L37.8,332.1L38.6,332.9L41.4,333.3L42.9,332.7L43.7,331.4L47.1,307.7L48.1,295.3L48.0,279.6L46.6,254.1L46.1,252.8L44.9,252.0L38.2,252.4L37.1,252.9ZM-22.3,261.3L-22.8,260.0L-24.0,259.2L-30.9,258.5L-32.4,259.0L-33.4,260.5L-35.2,286.2L-35.6,303.0L-34.2,331.4L-33.5,332.8L-32.1,333.4L-29.0,333.3L-28.0,332.7L-27.4,331.4L-25.4,296.3ZM22.3,261.8L25.8,302.5L27.4,331.4L28.0,332.7L29.0,333.3L32.1,333.4L33.5,332.8L34.2,331.4L35.6,299.7L35.1,282.9L33.5,260.7L33.1,259.6L32.2,258.8L31.1,258.5L24.2,259.2L22.5,260.4ZM-20.7,299.4L-21.9,300.1L-22.5,301.4L-23.9,324.2L-23.3,326.0L-21.6,326.7L-20.0,326.2L-19.1,324.9L-16.0,301.9L-16.4,300.6L-17.4,299.7ZM17.4,299.7L16.4,300.6L16.0,301.9L19.1,324.6L20.0,326.2L21.8,326.7L23.3,326.0L23.9,324.4L22.5,301.4L22.1,300.3L21.0,299.5Z',
    adductors: 'M-5.6,260.3L-10.3,258.3L-12.0,255.5L-13.2,254.7L-17.5,254.4L-18.6,254.9L-19.4,256.0L-18.8,259.7L-22.0,293.8L-21.4,295.4L-20.2,296.1L-13.7,296.7L-12.1,295.9L-11.5,294.6L-10.0,284.2L-9.1,282.6L-6.8,280.2L-4.6,262.1ZM5.8,260.2L5.0,261.0L4.6,262.3L6.7,279.8L7.1,280.9L9.1,282.6L10.0,284.3L11.6,295.1L12.4,296.2L13.7,296.7L20.4,296.0L21.5,295.2L22.0,293.8L18.8,259.7L19.5,256.9L19.3,255.8L18.6,254.9L17.5,254.4L13.2,254.7L12.0,255.5L9.8,258.6Z',
    calves: 'M-27.6,344.6L-29.0,345.4L-29.6,346.9L-30.4,369.5L-29.7,387.7L-29.1,388.9L-28.0,389.7L-22.4,389.5L-21.1,388.9L-20.4,387.6L-19.0,374.9L-18.7,366.7L-19.2,346.9L-19.7,345.7L-21.1,344.8ZM20.9,344.9L19.7,345.7L19.2,346.9L18.7,366.7L19.0,374.9L20.4,387.4L20.8,388.5L22.0,389.4L27.7,389.7L29.0,389.1L29.7,387.9L30.2,378.9L30.3,366.3L29.6,346.6L28.8,345.2L27.6,344.6ZM-32.6,343.1L-33.1,341.6L-34.7,340.7L-41.2,340.5L-42.9,341.7L-45.1,366.1L-44.9,375.3L-43.5,384.6L-40.3,399.5L-37.6,415.6L-36.9,416.8L-35.4,417.4L-32.7,417.0L-31.9,416.2L-31.5,415.1L-33.6,372.7ZM32.7,342.9L33.5,375.8L31.5,415.1L31.9,416.2L32.7,417.0L35.4,417.4L36.9,416.8L37.6,415.6L40.3,399.5L44.1,381.5L44.9,375.3L45.2,369.1L44.9,363.0L43.2,342.6L42.6,341.3L40.7,340.5L34.7,340.7L33.5,341.2Z',
  },
  back: {
    sil: 'M-97.4,236.5L-100.9,246.5L-101.9,251.4L-102.1,255.8L-101.5,258.1L-99.5,260.4L-97.7,261.5L-95.1,261.8L-92.2,260.9L-89.3,258.7L-87.8,256.6L-85.8,251.9L-84.0,245.5L-83.2,240.3L-82.6,239.4L-76.9,222.0L-70.2,200.2L-63.4,168.9L-54.4,137.2L-53.4,136.0L-51.7,135.9L-50.6,137.0L-48.4,144.3L-43.6,166.2L-40.8,185.2L-40.0,197.1L-40.4,205.7L-42.0,216.7L-43.6,224.7L-47.3,237.4L-48.2,244.9L-48.9,246.0L-51.0,285.7L-50.6,301.7L-46.7,329.6L-46.0,338.5L-46.2,347.5L-48.0,365.9L-47.7,375.6L-46.3,385.1L-43.1,400.1L-38.7,426.1L-40.5,431.8L-42.0,443.9L-45.0,452.0L-45.0,454.0L-44.0,455.7L-41.2,457.7L-37.0,459.0L-30.2,460.0L-24.9,460.3L-20.5,459.8L-19.0,459.0L-18.0,457.9L-17.5,456.4L-17.2,452.6L-18.7,431.6L-19.9,427.5L-21.3,425.6L-21.5,424.7L-16.0,372.3L-16.4,348.6L-15.8,336.3L-14.0,324.0L-9.6,300.5L-7.4,285.2L-6.5,284.0L-4.4,283.5L-1.6,278.7L0.1,277.9L1.6,278.7L4.4,283.5L6.5,284.0L7.4,285.2L9.6,300.5L14.0,324.0L15.8,336.3L16.4,348.6L16.0,372.3L21.5,424.7L21.3,425.6L19.9,427.5L18.7,431.6L17.2,452.6L17.5,456.4L18.0,457.9L19.0,459.0L20.5,459.8L24.9,460.3L30.3,460.0L37.0,459.0L40.0,458.2L42.4,457.1L44.6,454.9L45.2,453.1L45.1,452.1L42.0,444.1L40.5,431.8L38.7,426.1L43.1,400.1L46.3,385.1L47.7,375.6L48.0,365.9L46.2,347.5L46.0,338.5L46.7,329.6L50.2,304.9L51.0,295.4L51.0,288.9L50.5,273.4L48.9,246.0L48.2,244.9L47.3,237.4L43.6,224.7L42.0,216.7L40.4,205.7L40.0,197.1L40.8,185.2L43.6,166.2L48.4,144.3L50.6,137.0L51.7,135.9L53.4,136.0L54.4,137.2L63.4,168.9L70.2,200.2L76.9,222.0L82.6,239.4L83.2,240.3L84.4,246.9L87.1,255.2L88.6,257.8L91.2,260.3L93.3,261.4L96.0,261.9L98.7,261.0L101.0,259.0L101.9,257.0L102.1,253.0L100.5,245.0L97.4,236.7L95.2,209.0L93.7,195.3L92.0,186.1L87.2,166.3L86.0,157.5L83.8,132.1L81.7,120.5L77.1,100.4L75.9,100.5L75.1,100.0L71.4,94.4L68.9,92.2L66.5,90.7L63.4,89.6L60.6,89.1L53.5,89.5L48.3,86.7L39.6,83.1L31.4,80.6L20.8,78.1L14.4,70.5L13.9,69.4L12.4,54.9L16.9,48.3L19.4,42.1L20.8,34.5L20.8,26.7L19.2,19.2L15.9,12.1L11.7,6.9L6.6,3.5L3.1,2.3L-1.0,2.0L-4.6,2.7L-8.0,4.2L-11.7,6.9L-14.5,10.0L-16.9,13.7L-18.8,18.0L-20.1,22.6L-20.8,27.5L-21.0,32.4L-20.5,37.4L-19.4,42.1L-17.7,46.5L-15.6,50.5L-12.7,54.2L-12.4,55.3L-14.0,69.8L-20.0,77.5L-21.0,78.2L-31.4,80.6L-39.6,83.1L-48.3,86.7L-53.5,89.5L-60.1,89.0L-65.5,90.3L-68.4,91.9L-71.0,94.0L-73.1,96.5L-75.1,100.0L-75.9,100.5L-77.1,100.4L-81.7,120.5L-83.8,132.1L-86.0,157.5L-87.2,166.3L-92.0,186.1L-93.7,195.3L-95.2,209.0Z',
    traps: 'M-1.8,157.2L-1.3,112.2L-1.6,67.0L-2.5,54.1L-3.4,52.7L-5.0,52.2L-6.1,52.6L-6.9,53.4L-10.0,60.0L-11.2,71.9L-12.3,74.1L-14.0,76.0L-16.3,77.4L-18.2,79.7L-19.6,80.7L-30.6,83.3L-38.7,85.8L-42.4,87.3L-43.1,88.2L-43.3,89.3L-42.9,90.4L-42.1,91.2L-33.0,95.7L-30.2,97.6L-28.0,100.0L-26.1,102.9L-20.5,113.9L-14.0,130.0L-11.5,138.1L-6.4,158.6L-5.3,159.8L-3.5,160.0L-2.2,159.0ZM1.8,158.2L2.7,159.5L4.0,160.1L5.3,159.8L6.4,158.6L11.5,138.1L14.0,130.0L20.5,113.9L26.1,102.9L28.0,100.0L30.2,97.6L33.0,95.7L42.1,91.2L42.9,90.4L43.3,89.3L43.1,88.2L42.4,87.3L38.7,85.8L30.6,83.3L19.6,80.7L18.2,79.7L16.3,77.4L14.0,76.0L12.3,74.1L11.2,71.9L10.0,60.0L6.9,53.4L6.1,52.6L5.0,52.2L3.4,52.7L2.5,54.1L1.6,67.0L1.3,112.2Z',
    rearDelt: 'M-51.6,92.8L-60.4,91.9L-63.1,92.4L-65.7,93.5L-69.6,96.6L-72.6,101.4L-74.9,103.7L-75.9,108.1L-75.2,111.0L-74.0,114.0L-70.6,118.4L-68.0,120.4L-65.5,121.7L-61.7,122.8L-57.8,123.0L-53.2,122.0L-51.8,120.7L-50.6,94.6ZM52.9,92.4L51.4,93.0L50.6,94.6L51.8,120.7L53.2,122.0L57.9,123.0L62.3,122.7L66.0,121.5L70.6,118.4L72.5,116.3L74.2,113.5L75.3,110.9L75.9,107.9L74.9,103.7L72.6,101.4L69.6,96.6L65.7,93.5L63.1,92.4L60.4,91.9Z',
    upperBack: 'M-24.6,112.8L-30.4,102.2L-32.8,99.9L-34.0,99.8L-38.1,100.7L-42.5,102.2L-46.1,104.1L-47.4,105.1L-47.8,106.2L-48.5,121.7L-49.8,124.9L-49.2,126.7L-48.1,127.9L-46.7,128.6L-43.2,128.9L-37.6,127.7L-34.1,126.1L-30.8,123.2L-26.4,117.5L-24.6,113.9ZM24.6,112.8L24.6,113.9L25.2,115.5L27.8,119.7L32.4,124.7L35.5,126.9L39.5,128.3L44.9,128.9L47.9,128.0L49.6,126.1L49.8,124.5L48.5,121.7L47.8,106.0L47.1,104.8L44.5,103.2L37.9,100.6L34.0,99.8L32.6,100.0L30.5,102.0L28.9,104.5Z',
    lats: 'M-30.2,127.8L-34.4,129.9L-38.7,131.5L-43.0,132.1L-46.8,132.2L-48.1,133.2L-48.4,134.6L-45.0,146.4L-40.8,165.7L-38.0,184.9L-37.1,197.7L-35.3,200.9L-32.2,204.7L-30.3,206.2L-27.8,206.8L-25.9,205.8L-22.9,201.5L-19.9,194.3L-17.4,185.5L-16.0,175.9L-16.3,158.7L-17.7,146.1L-18.8,140.5L-20.3,135.6L-21.8,132.4L-24.3,129.7L-27.1,128.3ZM31.3,128.0L30.0,127.8L27.3,128.3L24.3,129.7L22.0,132.1L20.3,135.6L17.7,146.1L16.9,152.3L16.0,165.0L16.0,175.9L16.5,180.6L18.5,190.0L19.9,194.4L23.1,201.7L25.9,205.8L27.8,206.8L30.3,206.2L32.2,204.7L35.3,200.9L37.1,197.7L38.0,184.9L40.8,165.7L45.0,146.4L48.4,134.6L48.1,133.2L46.8,132.2L43.0,132.1L38.4,131.4L34.4,129.9Z',
    lowerBack: 'M-2.6,177.0L-5.7,175.4L-7.2,175.5L-13.0,179.7L-14.2,186.2L-16.8,195.3L-20.1,203.0L-22.4,206.8L-23.9,211.8L-22.1,242.2L-21.5,243.5L-20.2,244.2L-4.4,245.7L-2.9,245.2L-2.1,243.8L-2.0,178.6ZM3.4,176.4L2.3,177.4L2.0,178.6L2.1,243.8L2.9,245.2L4.4,245.7L20.2,244.2L21.5,243.5L22.1,242.2L23.9,211.8L22.4,206.8L20.1,203.0L16.8,195.3L14.2,186.2L13.0,179.7L12.2,178.8L6.9,175.4L5.5,175.4Z',
    obliques: 'M-31.0,209.8L-34.2,207.3L-35.3,206.9L-36.7,207.2L-37.7,208.3L-40.8,225.2L-43.6,234.8L-43.4,236.2L-42.4,237.1L-36.3,239.2L-34.6,238.7L-33.7,237.1L-30.6,211.1ZM31.5,209.2L30.8,210.2L30.6,211.4L33.7,237.1L34.6,238.7L36.3,239.2L42.6,237.0L43.5,235.9L43.6,234.6L40.8,225.2L37.7,208.3L36.5,207.1L35.1,206.9Z',
    triceps: 'M-70.8,127.7L-70.6,125.6L-72.1,124.2L-77.6,123.0L-78.9,123.5L-79.7,124.7L-81.4,134.9L-83.2,157.8L-85.0,169.6L-84.7,171.2L-83.4,172.2L-81.3,172.2L-79.9,170.7L-72.5,131.6L-72.0,129.2ZM70.7,127.4L72.1,129.6L73.3,135.2L79.9,170.7L81.3,172.2L83.4,172.2L84.7,171.2L85.0,169.6L83.2,157.8L81.4,134.9L79.5,124.3L78.5,123.3L77.3,123.0L71.7,124.4L70.8,125.2L70.5,126.3ZM-67.1,131.0L-68.7,131.5L-69.5,132.9L-76.7,171.7L-76.4,173.0L-75.3,173.9L-69.6,175.1L-68.3,174.7L-67.3,173.4L-64.3,161.3L-56.8,135.3L-57.2,133.8L-58.2,132.9ZM58.0,133.0L56.9,134.2L56.8,135.8L64.3,161.3L67.4,173.7L68.3,174.7L69.6,175.1L75.3,173.9L76.4,173.0L76.7,171.4L69.4,132.4L68.5,131.4L67.1,131.0Z',
    forearms: 'M-84.4,175.3L-85.8,175.6L-86.8,176.9L-89.2,186.8L-90.9,195.6L-92.9,214.2L-92.3,215.7L-90.9,216.5L-89.1,216.2L-88.2,214.9L-80.3,178.4L-80.6,177.0L-81.4,176.1ZM81.6,176.0L80.6,177.0L80.3,178.4L88.1,214.6L89.1,216.2L90.9,216.5L92.3,215.7L92.9,214.0L91.2,197.9L89.2,186.7L86.4,176.3L84.7,175.3ZM-74.9,177.4L-76.4,177.9L-77.2,179.2L-88.3,231.7L-88.0,233.5L-86.4,234.5L-84.6,234.3L-83.5,232.9L-74.1,203.7L-69.9,186.5L-68.8,180.8L-69.1,179.5L-70.5,178.3ZM70.0,178.5L69.0,179.7L68.8,181.0L71.8,195.2L74.8,205.9L83.6,233.2L84.9,234.4L86.7,234.5L88.0,233.5L88.3,231.7L77.2,179.0L76.4,177.9L75.1,177.4Z',
    glutes: 'M-0.3,272.9L-1.0,260.8L-1.8,255.9L-3.1,251.9L-5.4,249.1L-19.1,247.5L-29.4,248.5L-37.4,250.4L-40.1,251.5L-43.8,253.9L-45.6,255.7L-46.8,257.6L-47.9,276.5L-48.1,288.8L-46.1,291.8L-44.2,293.5L-42.0,294.8L-37.2,296.5L-28.8,297.8L-16.7,298.9L-13.4,298.8L-12.4,298.2L-11.9,297.1L-9.7,283.5L-8.5,281.9L-5.9,280.4L-3.6,276.7L-0.7,274.5ZM0.3,273.7L1.0,274.9L3.7,276.8L5.9,280.4L8.5,281.9L9.7,283.4L10.2,284.9L11.9,297.1L12.4,298.2L13.6,298.9L28.8,297.8L37.2,296.5L42.0,294.8L44.2,293.5L46.1,291.8L48.1,288.8L47.9,276.5L46.8,257.6L45.6,255.7L43.8,253.9L40.1,251.5L37.4,250.4L29.4,248.5L19.1,247.5L6.4,248.8L5.2,249.2L3.1,251.9L1.8,255.9L0.5,266.6Z',
    hamstrings: 'M-31.9,300.9L-40.7,298.8L-45.2,296.8L-47.0,297.3L-47.9,298.7L-47.1,307.7L-43.5,333.1L-42.9,334.3L-41.7,335.0L-33.2,335.2L-31.9,334.5L-31.3,333.3L-30.7,302.8L-31.1,301.7ZM32.1,300.8L31.1,301.7L30.7,302.8L31.3,333.6L32.1,334.7L33.2,335.2L41.9,334.9L42.9,334.3L43.5,333.1L47.1,307.7L47.8,298.5L46.8,297.2L45.2,296.8L38.1,299.6ZM-23.4,301.4L-26.3,301.6L-27.1,302.3L-27.5,303.6L-28.0,333.2L-27.3,334.7L-25.7,335.4L-22.4,335.4L-21.4,334.8L-20.8,333.8L-17.1,304.3L-17.5,302.9L-18.6,302.0ZM18.6,302.0L17.5,302.9L17.1,304.3L20.7,333.5L21.4,334.8L22.4,335.4L26.1,335.3L27.3,334.7L28.0,333.2L27.5,303.2L26.7,301.8L25.4,301.3Z',
    adductors: '',
    calves: 'M-19.6,380.5L-18.7,366.7L-19.4,344.5L-20.2,343.4L-21.3,342.9L-29.7,342.8L-30.8,343.7L-31.2,345.0L-32.0,369.3L-31.6,381.1L-30.7,382.2L-29.6,382.5L-20.9,382.0ZM19.8,381.0L20.5,381.8L21.6,382.2L29.6,382.5L30.9,382.1L31.8,380.7L32.0,367.6L31.2,345.0L30.8,343.7L29.4,342.7L21.1,343.0L20.0,343.5L19.3,344.7L18.7,369.4ZM-41.5,342.4L-42.6,343.1L-43.2,344.3L-45.1,366.0L-44.9,375.4L-44.1,381.2L-43.4,382.4L-42.0,383.0L-37.1,382.8L-35.7,382.1L-35.1,380.6L-35.2,367.6L-34.4,344.7L-34.9,343.3L-36.0,342.5ZM36.0,342.5L34.9,343.3L34.4,344.7L35.1,365.9L35.1,380.8L35.5,381.9L36.7,382.7L42.2,383.0L43.4,382.4L44.1,381.2L45.2,372.2L44.9,363.0L43.2,344.3L42.6,343.1L41.5,342.4ZM-38.9,386.8L-40.0,387.6L-40.5,389.2L-36.8,415.9L-36.1,416.9L-34.7,417.4L-25.4,416.9L-24.5,416.2L-24.0,414.8L-22.5,388.5L-22.7,387.4L-23.5,386.5L-24.8,386.0ZM24.1,386.1L23.0,387.0L22.5,388.3L24.2,415.5L25.0,416.7L26.1,417.1L35.4,417.2L36.4,416.5L36.9,415.5L40.4,388.2L39.5,387.1L38.5,386.6Z',
  },
};

const mixHex = (a, b, t) => '#' + [1, 3, 5].map(k => Math.round(parseInt(a.substr(k, 2), 16) * (1 - t) + parseInt(b.substr(k, 2), 16) * t).toString(16).padStart(2, '0')).join('');

// ready-made SVG for one map; vals: muscle → { v: 0..1 or null, tip }
function bodyMap(vals, ramp, label) {
  const view = (k, dx) => {
    const { sil, ...muscles } = BODY[k];
    const mus = Object.entries(muscles).map(([m, d]) => {
      const x = vals[m] || {};
      const style = x.v == null ? '' : ` style="fill:${mixHex(ramp[0], ramp[1], x.v)}"`;
      return `<path class="m ${x.v == null ? 'off' : 'on'}" d="${d}"${style}${x.tip ? ` data-tip="${esc(x.tip)}"` : ''}/>`;
    }).join('');
    return `<g transform="translate(${dx},10)"><path class="sil" d="${sil}"/>${mus}</g>`;
  };
  return `<svg class="body" viewBox="0 4 464 470" role="img" aria-label="${esc(label)}">${view('front', 112)}${view('back', 352)}</svg>`;
}
// muscles each exercise works: 'primary … / secondary …' (secondary counts half)
const MUSCLE_NAMES = {
  traps: 'traps', frontDelt: 'front delts', sideDelt: 'side delts', rearDelt: 'rear delts', chest: 'chest',
  biceps: 'biceps', triceps: 'triceps', forearms: 'forearms', abs: 'abs', obliques: 'obliques',
  upperBack: 'upper back', lats: 'lats', lowerBack: 'lower back', glutes: 'glutes', quads: 'quads',
  hamstrings: 'hamstrings', adductors: 'adductors', calves: 'calves',
};
const EX_MUSCLES = {
  'BB Bench Press': 'chest / frontDelt triceps',
  'BB Incline Bench Press': 'chest frontDelt / triceps',
  'BB Close Grip Bench Press': 'triceps chest / frontDelt',
  'DB Bench Press': 'chest / frontDelt triceps',
  'DB Incline Bench Press': 'chest frontDelt / triceps',
  'DB Fly': 'chest / frontDelt',
  'BB Reverse Grip Bench Press': 'chest / frontDelt triceps',
  'Machine Fly': 'chest / frontDelt',
  'Cable Fly': 'chest / frontDelt',
  'Pull-ups': 'lats / biceps upperBack forearms',
  'BB Row': 'upperBack lats / rearDelt biceps lowerBack',
  'BB (Kelso) Shrug': 'traps upperBack',
  'Pulldown (Any Grip)': 'lats / biceps upperBack',
  '1 Arm Pulldown': 'lats / biceps',
  'Back Extension': 'lowerBack / glutes hamstrings',
  'BB Deadlift': 'lowerBack glutes hamstrings / traps quads forearms',
  'Machine Row': 'upperBack lats / rearDelt biceps',
  'Machine High Row': 'lats upperBack / rearDelt biceps',
  'BB Meadows Row': 'lats upperBack / rearDelt biceps',
  'DB Incline Row': 'upperBack lats / rearDelt biceps',
  'BB Squat': 'quads glutes / adductors lowerBack',
  'BB Squat Heels Elevated': 'quads / glutes',
  'BB Romanian DeadLift': 'hamstrings glutes / lowerBack',
  'Standing Calf Raise': 'calves',
  'BB Hip Thrust': 'glutes / hamstrings',
  'Glute-Focused Back Extension': 'glutes / hamstrings lowerBack',
  'Step-Ups Box': 'quads glutes',
  'Machine Leg Extension': 'quads',
  'Machine Leg Curl': 'hamstrings',
  'Machine Leg Press': 'quads glutes / adductors',
  'Nordic Curl': 'hamstrings',
  'DB Bulgarian Split Squat': 'quads glutes / adductors',
  'BB Overhead Press': 'frontDelt / sideDelt triceps',
  'DB Press': 'frontDelt / sideDelt triceps',
  'DB Lateral Raise': 'sideDelt',
  'DB Rear Fly': 'rearDelt / upperBack',
  'DB Lying On Bench Rear Fly': 'rearDelt / upperBack',
  'DB Incline Bench Y Raise': 'sideDelt traps / rearDelt',
  'Y-T Face Down': 'rearDelt traps / upperBack',
  'Cable Face Pull': 'rearDelt / upperBack traps',
  'DB Curl (Seated or Standing)': 'biceps / forearms',
  'DB Hammer Curl (Seated or Standing)': 'biceps forearms',
  'DB Preacher Curl (Long Stretch)': 'biceps',
  'DB Incline Curl': 'biceps',
  'Drag Curl ZB': 'biceps',
  'EZ-Bar Skull Crusher': 'triceps',
  'EZ-Bar Curl (also with ArmBlaster)': 'biceps / forearms',
  'EZ-Bar Reverse Curl (also with ArmBlaster)': 'forearms / biceps',
  'EZ-Bar Reverse Curl ("Broken Wrists"+ArmBlaster)': 'forearms / biceps',
  'DB Wrist Curl (Palm Up)': 'forearms',
  'DB Wrist Extension (Palm Down)': 'forearms',
  'DB Zottman Curl': 'biceps forearms',
  'Dips': 'triceps chest / frontDelt',
  'DB Over Head Triceps': 'triceps',
  'Cable Triceps Push Down (Any grip)': 'triceps',
  'Cable Biceps': 'biceps',
  'Dead Hang': 'forearms / lats',
  'Dragon Fly': 'abs',
  'Crunch': 'abs',
  'Ab-Wheel': 'abs / lats',
  'Sides On Back Extension Bench': 'obliques',
  'DB Sides': 'obliques',
  'Reverse Crunch': 'abs',
};
// guesses for exercises added to the list later, checked in order
const MUSCLE_RULES = [
  [/calf|calve/i, 'calves'], [/leg curl|nordic/i, 'hamstrings'], [/leg ext/i, 'quads'],
  [/romanian|rdl|good ?morning/i, 'hamstrings glutes / lowerBack'], [/deadlift/i, 'lowerBack glutes hamstrings / traps quads forearms'],
  [/squat|lunge|leg press|step/i, 'quads glutes / adductors'], [/hip thrust|glute|kickback/i, 'glutes / hamstrings'],
  [/adduct/i, 'adductors'], [/abduct/i, 'glutes'], [/back ext|hyperext/i, 'lowerBack / glutes hamstrings'],
  [/shrug/i, 'traps'], [/face pull|rear/i, 'rearDelt / upperBack'], [/lateral/i, 'sideDelt'],
  [/pull-?up|chin|pulldown|pullover|straight-arm/i, 'lats / biceps'], [/row/i, 'upperBack lats / rearDelt biceps'],
  [/overhead press|shoulder press|military|arnold/i, 'frontDelt / sideDelt triceps'],
  [/tricep|skull|push ?down|dip|kick/i, 'triceps'], [/bench|chest|push-?up|fly/i, 'chest / frontDelt triceps'],
  [/wrist|reverse curl|hang|farmer|grip/i, 'forearms'], [/curl/i, 'biceps / forearms'],
  [/side|oblique|pallof|twist/i, 'obliques'], [/crunch|\bab\b|plank|leg raise|sit-?up/i, 'abs'],
];
const GROUP_MUSCLES = { Chest: 'chest', Back: 'lats upperBack', Legs: 'quads glutes', Shoulders: 'frontDelt sideDelt', Arms: 'biceps triceps', Core: 'abs' };

const musclesCache = {};
function musclesOf(ex) {
  if (musclesCache[ex]) return musclesCache[ex];
  const i = info(ex);
  const spec = EX_MUSCLES[ex] ?? MUSCLE_RULES.find(([re]) => re.test(ex))?.[1] ?? GROUP_MUSCLES[i.group] ?? '';
  const [p = '', s = ''] = spec.split('/');
  return musclesCache[ex] = { primary: p.split(/\s+/).filter(Boolean), secondary: s.split(/\s+/).filter(Boolean) };
}

// last 7 days: working sets per muscle, recent ones weigh more (today ×1 … 6 days ago ×1/7)
function trainedMap() {
  const t = today(), acc = {};
  for (const w of S.workouts) {
    const d = daysBetween(w.date, t);
    if (d < 0 || d > 6) continue;
    for (const s of working(w.sets)) {
      const m = musclesOf(s.exercise);
      for (const [list, k] of [[m.primary, 1], [m.secondary, 0.5]]) for (const mu of list) {
        const a = acc[mu] ||= { score: 0, sets: 0, last: d };
        a.score += k * (7 - d) / 7;
        a.sets += k;
        a.last = Math.min(a.last, d);
      }
    }
  }
  const out = {};
  for (const [mu, a] of Object.entries(acc)) out[mu] = {
    v: Math.min(1, a.score / 6),
    tip: `<b>${MUSCLE_NAMES[mu]}</b><br>${fmt(a.sets)} sets in 7 days · last ${a.last ? a.last + 'd ago' : 'today'}`,
  };
  return out;
}

const RED = ['#f0c9cc', '#a3192a'], GREEN = ['#dcecd0', '#3c8a36'];

function viewBodyMaps() {
  const legend = (ramp, lo, hi) => `<div class="body-legend"><span>${lo}</span><i style="background:linear-gradient(90deg,${ramp[0]},${ramp[1]})"></i><span>${hi}</span></div>`;
  const sizes = sizeMap();
  return `<div class="maps">
    <div><h2>trained · last 7 days</h2><div class="card">${bodyMap(trainedMap(), RED, 'muscles trained in the last 7 days')}${legend(RED, 'a little / days ago', 'a lot / today')}</div></div>
    <div><div class="row between"><h2>size vs goals</h2><button class="btn small" data-act="openMeas">measurements</button></div>
      <div class="card">${bodyMap(sizes, GREEN, 'body measurements compared to targets, per muscle')}${legend(GREEN, '≤75% of target', 'at target')}
      ${Object.keys(sizes).length ? '' : '<p class="meta" style="margin:8px 0 0">no measurements with targets yet</p>'}</div></div>
  </div>
  <h2>measurements vs targets</h2>
  <div class="card">${sizeRadar()}</div>`;
}

// ----- body size vs goals -----
// muscles each tape measurement colours on the body map
const PART_MUSCLES = {
  shoulders: ['frontDelt', 'sideDelt', 'rearDelt', 'traps', 'upperBack', 'lats'],
  chest: ['chest'], biceps: ['biceps', 'triceps'], waist: ['abs', 'obliques'],
  thighs: ['quads', 'hamstrings', 'adductors'], forearms: ['forearms'], calves: ['calves'],
};

// latest value of each part, from the newest measurement that has it
function latestSizes() {
  const out = {};
  for (const m of S.meas) out[m.part] = { value: m.value, date: m.date };
  return out;
}

// 0..1: muscles go from ≤75% of target (palest) to 100%; waist goes from 10 cm above target to at/under it
function sizeScore(part, cur, target) {
  const v = part === 'waist' ? 1 - (cur - target) / 10 : (cur / target - 0.75) / 0.25;
  return Math.max(0, Math.min(1, v));
}
const sizeLine = (part, x, t) => `${part}: ${fmt(x.value)} / ${fmt(t)} cm (${Math.round(x.value / t * 100)}%)`;

function sizeMap() {
  const cur = latestSizes(), out = {};
  for (const [part, muscles] of Object.entries(PART_MUSCLES)) {
    const x = cur[part], t = S.sizeTargets[part];
    if (!x || !t) continue;
    for (const mu of muscles) out[mu] = { v: sizeScore(part, x.value, t), tip: `<b>${MUSCLE_NAMES[mu]}</b><br>${sizeLine(part, x, t)}` };
  }
  return out;
}

// spiderweb: each axis is current / target, centre = 50%, outer ring = 110%
function sizeRadar() {
  const cur = latestSizes();
  const parts = S.parts.filter(p => cur[p] && S.sizeTargets[p]);
  if (parts.length < 3) return '<p class="meta">add at least 3 measurements with targets to see the web</p>';
  const W = 340, H = 300, cx = W / 2, cy = H / 2 + 4, R = 100, lo = 0.5, hi = 1.1;
  const ratio = p => p === 'waist' ? S.sizeTargets[p] / cur[p].value : cur[p].value / S.sizeTargets[p];
  const pt = (k, r) => {
    const a = -Math.PI / 2 + k * 2 * Math.PI / parts.length, d = R * Math.max(0, Math.min(1, (r - lo) / (hi - lo)));
    return [cx + d * Math.cos(a), cy + d * Math.sin(a)];
  };
  const poly = r => parts.map((p, k) => pt(k, typeof r === 'function' ? r(p) : r).map(n => n.toFixed(1)).join(',')).join(' ');
  const rings = [0.6, 0.7, 0.8, 0.9, 1.1].map(r => `<polygon class="ring" points="${poly(r)}"/>`).join('')
    + `<text x="${cx + 3}" y="${pt(0, 0.8)[1] + 3}">80%</text>`;
  const spokes = parts.map((p, k) => { const [x, y] = pt(k, hi); return `<line class="ring" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join('');
  const labels = parts.map((p, k) => {
    const [x, y] = pt(k, hi + 0.1), anchor = Math.abs(x - cx) < 4 ? 'middle' : x < cx ? 'end' : 'start';
    return `<text class="lab" x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${anchor}">${p}</text>
      <text class="val" x="${x.toFixed(1)}" y="${(y + 15).toFixed(1)}" text-anchor="${anchor}">${fmt(cur[p].value)} / ${fmt(S.sizeTargets[p])}</text>`;
  }).join('');
  const dots = parts.map((p, k) => { const [x, y] = pt(k, ratio(p)); return `<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/><circle class="hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" data-tip="${esc(`<b>${p}</b><br>${sizeLine(p, cur[p], S.sizeTargets[p])}<br>measured ${prettyDate(cur[p].date, { day: 'numeric', month: 'short', year: 'numeric' })}`)}"/>`; }).join('');
  return `<svg class="radar" viewBox="0 0 ${W} ${H}" role="img" aria-label="body measurements compared to targets">
    ${rings}${spokes}<polygon class="target" points="${poly(1)}"/><polygon class="now" points="${poly(ratio)}"/>${dots}${labels}</svg>
    <p class="meta" style="margin:6px 0 0">cm, latest / target · dashed line = target${S.parts.includes('waist') ? ' · waist: smaller is better' : ''}</p>`;
}

// ----- measurements page -----
function viewMeasure() {
  const last = latestSizes();
  const dates = [...new Set(S.meas.map(m => m.date))].reverse();
  const at = d => Object.fromEntries(S.meas.filter(m => m.date === d).map(m => [m.part, m.value]));
  const inputs = (pre, vals, ph = {}) => `<div class="meas-grid">${S.parts.map(p => `
    <label class="field" for="${pre}-${p}">${p}</label>
    <input type="text" inputmode="decimal" id="${pre}-${p}" value="${vals[p] != null ? fmt(vals[p]) : ''}" placeholder="${ph[p] != null ? fmt(ph[p]) : 'cm'}">`).join('')}</div>`;
  return `
    <button class="btn ghost small" data-act="back">← back</button>
    <h1>body measurements</h1>
    <h2>new measurement</h2>
    <div class="card">
      <label class="field" for="mDate">date</label>
      <input type="date" id="mDate" value="${today()}" max="${today()}" style="width:auto;margin-bottom:12px">
      ${inputs('m', {}, Object.fromEntries(Object.entries(last).map(([p, x]) => [p, x.value])))}
      <p class="meta" style="margin:8px 0 12px">cm · empty fields are skipped · saving a date again replaces it</p>
      <button class="btn primary" data-act="saveMeas">save</button>
    </div>
    <h2>targets</h2>
    <div class="card">
      ${inputs('t', S.sizeTargets)}
      <div style="height:12px"></div>
      <button class="btn" data-act="saveTargets">save targets</button>
    </div>
    <h2>history</h2>
    <div class="card">
      ${dates.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>date</th>${S.parts.map(p => `<th class="num">${p}</th>`).join('')}<th></th></tr></thead>
        <tbody>${dates.map(d => { const v = at(d); return `<tr class="click" data-act="editMeas" data-d="${d}">
          <td>${esc(d)}</td>${S.parts.map(p => `<td class="num">${v[p] != null ? fmt(v[p]) : '<span class="dim">—</span>'}</td>`).join('')}
          <td><button class="btn danger small" data-act="delMeas" data-d="${d}" aria-label="delete ${d}">✕</button></td></tr>`; }).join('')}</tbody>
      </table></div><p class="meta" style="margin:10px 0 0">tap a row to edit it</p>` : '<p class="meta">no measurements yet</p>'}
    </div>`;
}

const readParts = pre => {
  const out = {};
  for (const p of S.parts) {
    const raw = $(`#${pre}-${p}`).value.trim();
    if (raw === '') continue;
    const v = parseNum(raw);
    if (!(v > 0)) throw new Error(`Invalid ${p}`);
    out[p] = v;
  }
  return out;
};

// ----- stats -----
function monthStats(m) {
  const ws = S.workouts.filter(w => w.date.startsWith(m));
  const days = new Map();
  let load = 0, sets = 0;
  const groups = new Map(S.groups.map(g => [g.name, { sets: 0, load: 0 }]));
  for (const w of ws) {
    const dayEx = days.get(w.date) || new Set();
    for (const s of w.sets) {
      if (s.warmup) continue;
      const i = info(s.exercise);
      const l = i.timed ? 0 : s.reps * s.weight;
      sets++;
      load += l;
      dayEx.add(s.exercise);
      if (!groups.has(i.group)) groups.set(i.group, { sets: 0, load: 0 });
      const g = groups.get(i.group);
      g.sets++;
      g.load += l;
    }
    days.set(w.date, dayEx);
  }
  const exPerDay = days.size ? sum([...days.values()], s => s.size) / days.size : 0;
  return { workouts: ws.length, days: days.size, load, sets, exPerDay, groups };
}

function viewStats() {
  const m = S.month;
  const st = monthStats(m);
  const months = Array.from({ length: 12 }, (_, k) => shiftMonth(m, k - 11));
  const bars = months.map(mm => {
    const s = mm === m ? st : monthStats(mm);
    return {
      label: new Date(mm + '-15T12:00:00').toLocaleDateString('en-GB', { month: 'short' }).toLowerCase().slice(0, 3),
      value: s.load, hi: mm === m, month: mm,
      tip: `<b>${esc(monthName(mm))}</b><br>${fmtInt(s.load)} kg · ${s.workouts} workouts · ${s.sets} sets`,
    };
  });
  const gmax = Math.max(1, ...[...st.groups.values()].map(g => g.sets));
  const t = today();
  const canNext = m < t.slice(0, 7);

  // best performance summary
  const groupsList = [...S.groups];
  const known = new Set(Object.keys(S.info));
  const others = Object.keys(S.hist).filter(ex => !known.has(ex));
  if (others.length) groupsList.push({ name: 'Other', exercises: others.map(name => ({ name })) });
  const rows = groupsList.map(g => {
    const lines = g.exercises.map(e => {
      const h = S.hist[e.name];
      if (!h && !S.showAll) return '';
      const i = info(e.name);
      if (!h) return `<tr class="click" data-act="openEx" data-ex="${esc(e.name)}"><td class="name">${esc(e.name)}</td><td colspan="5" class="dim">—</td></tr>`;
      const all = h.flatMap(x => x.sets);
      const best = bestOf(all, i);
      const lastH = h[h.length - 1];
      const lastSet = working(lastH.sets).at(-1) || lastH.sets.at(-1);
      const d = daysBetween(lastH.w.date, t);
      const mm = mainMetric(i);
      const goal = S.goals[e.name];
      const cur = Math.max(...h.map(x => sessionValue(x.sets, mm.key) ?? 0));
      const e1 = best && best.weight > 0 && !i.timed && !i.bw ? fmt(brz(best.weight, best.reps).toFixed(1)) : '<span class="dim">—</span>';
      return `<tr class="click" data-act="openEx" data-ex="${esc(e.name)}">
        <td class="name">${esc(e.name)}</td>
        <td>${best ? esc(setLabel(best, i)) : '—'}</td>
        <td class="num">${e1}</td>
        <td>${lastSet ? esc(setLabel(lastSet, i)) : '—'}</td>
        <td><span class="since ${sinceClass(d)}">${sinceLabel(d)}</span></td>
        <td class="num">${goal ? `${Math.min(999, Math.round(cur / goal * 100))}%` : '<span class="dim">—</span>'}</td>
      </tr>`;
    }).join('');
    return lines ? `<tr class="grp"><td colspan="6">${esc(g.name)}</td></tr>${lines}` : '';
  }).join('');

  return `
    <h1>stats</h1>
    ${viewBodyMaps()}
    <div class="month-nav">
      <button class="btn ghost" data-act="month" data-n="-1" aria-label="previous month">‹</button>
      <span>${esc(monthName(m).toLowerCase())}</span>
      <button class="btn ghost" data-act="month" data-n="1" aria-label="next month" ${canNext ? '' : 'disabled'}>›</button>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">workouts</div><div class="v">${st.workouts}</div></div>
      <div class="tile"><div class="k">active days</div><div class="v">${st.days}</div></div>
      <div class="tile"><div class="k">total load</div><div class="v">${fmtInt(st.load)}<small>kg</small></div></div>
      <div class="tile"><div class="k">working sets</div><div class="v">${st.sets}</div></div>
      <div class="tile"><div class="k">exercises / day</div><div class="v">${st.exPerDay ? st.exPerDay.toFixed(1) : '0'}</div></div>
      <div class="tile"><div class="k">load / workout</div><div class="v">${st.workouts ? fmtInt(st.load / st.workouts) : 0}<small>kg</small></div></div>
    </div>

    <h2>load per month</h2>
    <div class="card">${barChart(bars)}</div>

    <h2>sets per muscle group</h2>
    <div class="card">
      ${st.sets ? `<div class="hbars">${[...st.groups].map(([name, g]) => `
        <span>${esc(name.toLowerCase())}</span>
        <div class="track"><div class="fill" style="width:${g.sets / gmax * 100}%"></div></div>
        <span class="val">${g.sets} <small>sets · ${fmtShort(g.load)} kg</small></span>`).join('')}</div>`
      : '<p class="meta">no sets this month</p>'}
    </div>

    <div class="row between" style="margin-top:26px">
      <h2 style="margin:0">best performance</h2>
      <div class="seg">
        <button class="${S.showAll ? '' : 'on'}" data-act="showAll" data-v="0">done</button>
        <button class="${S.showAll ? 'on' : ''}" data-act="showAll" data-v="1">all</button>
      </div>
    </div>
    <div class="card" style="margin-top:10px">
      ${rows ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>exercise</th><th>best</th><th class="num">1RM</th><th>last</th><th>since</th><th class="num">goal</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <p class="meta" style="margin:10px 0 0">since: <span class="good">≤3d</span> <span class="warn">≤7d</span> <span class="bad">&gt;7d</span> · 1RM = Brzycki estimate · tap a row for details</p>`
      : '<p class="meta">log a workout to see your records</p>'}
    </div>`;
}

// ----- exercise detail -----
function viewExercise(name) {
  const i = info(name);
  const h = S.hist[name] || [];
  const all = h.flatMap(x => x.sets);
  const best = bestOf(all, i);
  const mm = mainMetric(i);
  const metrics = chartMetrics(i);
  if (!metrics.some(([k]) => k === S.metric)) S.metric = metrics[0][0];
  const goal = S.goals[name];
  const cur = h.length ? Math.max(...h.map(x => sessionValue(x.sets, mm.key) ?? 0)) : 0;
  const heaviest = all.length ? Math.max(...working(all).map(s => s.weight), 0) : 0;
  const last = h[h.length - 1];
  const d = last ? daysBetween(last.w.date, today()) : null;

  const points = h.map(x => {
    const v = sessionValue(x.sets, S.metric);
    return v == null ? null : {
      x: dayMs(x.w.date), y: v,
      tip: `<b>${esc(prettyDate(x.w.date, { day: 'numeric', month: 'short', year: 'numeric' }))}</b><br>${fmt(v.toFixed(1))} ${metricUnit(S.metric)} · ${working(x.sets).map(s => esc(setLabel(s, i))).join(', ')}`,
    };
  }).filter(Boolean);

  // rep records: heaviest weight for each rep count
  const repRec = new Map();
  if (!i.timed) for (const x of h) for (const s of working(x.sets)) {
    const r = s.reps;
    if (r > 15 || r !== Math.round(r)) continue;
    const cur = repRec.get(r);
    if (!cur || s.weight > cur.s.weight) repRec.set(r, { s, date: x.w.date });
  }
  const recRows = [...repRec].sort((a, b) => a[0] - b[0]);

  return `
    <button class="btn ghost small" data-act="back">← back</button>
    <h1>${esc(name)}</h1>
    <div class="meta" style="margin:-8px 0 14px">${esc(i.group.toLowerCase())}${i.bw ? ' · bodyweight (+kg = extra)' : ''}${i.timed ? ' · timed' : ''}</div>
    <div class="tiles">
      <div class="tile"><div class="k">best set</div><div class="v">${best ? esc(setLabel(best, i)) : '—'}</div></div>
      <div class="tile"><div class="k">${mm.label}</div><div class="v">${h.length ? fmt(cur.toFixed(1)) : '—'}<small>${mm.unit}</small></div></div>
      ${i.timed ? '' : `<div class="tile"><div class="k">${i.bw ? 'max extra' : 'heaviest'}</div><div class="v">${h.length ? fmt(heaviest) : '—'}<small>kg</small></div></div>`}
      <div class="tile"><div class="k">sessions</div><div class="v">${h.length}</div></div>
      <div class="tile"><div class="k">last done</div><div class="v ${d == null ? '' : sinceClass(d)}">${d == null ? '—' : sinceLabel(d)}</div></div>
    </div>

    <h2>goal</h2>
    <div class="card">
      ${goal ? `<div class="row between mono" style="font-size:.85rem"><span>${fmt(cur.toFixed(1))} / ${fmt(goal)} ${mm.unit}</span><span class="good">${Math.round(cur / goal * 100)}%</span></div>
        <div class="progress"><div style="width:${Math.min(100, cur / goal * 100)}%"></div></div><div style="height:12px"></div>` : ''}
      <label class="field" for="goalIn">target ${mm.label} (${mm.unit})</label>
      <div class="row">
        <input type="text" inputmode="decimal" id="goalIn" value="${goal ? fmt(goal) : ''}" placeholder="e.g. ${mm.key === 'e1rm' ? '100' : mm.key === 'sec' ? '120' : '15'}">
        <button class="btn" data-act="saveGoal" data-ex="${esc(name)}">save</button>
      </div>
    </div>

    <div class="row between" style="margin-top:26px">
      <h2 style="margin:0">progress</h2>
      <div class="seg">${metrics.map(([k, l]) => `<button class="${k === S.metric ? 'on' : ''}" data-act="metric" data-m="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="card" style="margin-top:10px">
      ${points.length ? lineChart(points, S.metric === mm.key ? goal : null, metricUnit(S.metric)) : '<p class="meta">no data yet</p>'}
    </div>

    ${recRows.length ? `<h2>rep records</h2>
    <div class="card"><table class="tbl">
      <thead><tr><th>reps</th><th class="num">${i.bw ? '+kg' : 'kg'}</th>${i.bw ? '' : '<th class="num">est. 1RM</th>'}<th>date</th></tr></thead>
      <tbody>${recRows.map(([r, x]) => `<tr><td>${r}</td><td class="num">${fmt(x.s.weight)}</td>${i.bw ? '' : `<td class="num">${fmt(brz(x.s.weight, r).toFixed(1))}</td>`}<td class="muted">${esc(x.date)}</td></tr>`).join('')}</tbody>
    </table></div>` : ''}

    <h2>history</h2>
    ${h.length ? [...h].reverse().map(x => `
      <button class="card link" data-act="openW" data-id="${x.w.id}">
        <div class="row between"><h3>${esc(prettyDate(x.w.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</h3>
          <span class="meta">${i.timed ? '' : fmtInt(loadOf(x.sets, i)) + ' kg'}</span></div>
        <div class="w-sets" style="margin:4px 0 0">${x.sets.map(s => `<span class="${s.warmup ? 'wu' : ''}">${s.warmup ? 'W ' : ''}${esc(setLabel(s, i))}</span>`).join(' · ')}</div>
      </button>`).join('') : '<p class="meta">never logged</p>'}`;
}

// ---------- charts (hand-rolled SVG, single series in the accent colour) ----------
function niceTicks(min, max, n = 4) {
  if (max === min) { max = min + 1; min = Math.max(0, min - 1); }
  const raw = (max - min) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw);
  const lo = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = lo; v <= max + step * 0.999; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

// draw at the real pixel width so 11px labels stay 11px on a phone
const chartWidth = () => Math.max(280, Math.min(668, ($('#app').clientWidth || 360) - 62));

function barChart(bars) {
  const W = chartWidth(), H = 210, L = 40, R = 6, T = 10, B = 26;
  const max = Math.max(...bars.map(b => b.value), 1);
  const ticks = niceTicks(0, max, 3);
  const top = ticks[ticks.length - 1];
  const y = v => T + (H - T - B) * (1 - v / top);
  const slot = (W - L - R) / bars.length;
  const bw = Math.max(4, slot - 10);
  const grid = ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${fmtShort(t)}</text>`).join('');
  const marks = bars.map((b, k) => {
    const x = L + k * slot + (slot - bw) / 2;
    const h = (H - T - B) * (b.value / top);
    const r = Math.min(4, h, bw / 2);
    const yb = H - B;
    const path = h > 0 ? `M${x},${yb}V${yb - h + r}Q${x},${yb - h} ${x + r},${yb - h}H${x + bw - r}Q${x + bw},${yb - h} ${x + bw},${yb - h + r}V${yb}Z` : '';
    return `${path ? `<path class="bar ${b.hi ? 'hi' : ''}" d="${path}"/>` : ''}
      ${slot >= 30 || b.hi || (bars.length - 1 - k) % 2 === 0 ? `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" ${b.hi ? 'style="fill:var(--fg)"' : ''}>${esc(b.label)}</text>` : ''}
      <rect class="hit" x="${L + k * slot}" y="${T}" width="${slot}" height="${H - T - B}" data-tip="${esc(b.tip)}" data-act="month" data-to="${b.month}"/>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="total load per month, last 12 months">${grid}${marks}</svg>`;
}

function lineChart(points, goal, unit) {
  const W = chartWidth(), H = 220, L = 40, R = 14, T = 12, B = 26;
  const ys = points.map(p => p.y).concat(goal ? [goal] : []);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.15 || hi * 0.1 || 1;
  const ticks = niceTicks(Math.max(0, lo - pad), hi + pad, 4);
  lo = ticks[0]; hi = ticks[ticks.length - 1];
  const x0 = points[0].x, x1 = points[points.length - 1].x;
  const x = v => x1 === x0 ? (L + W - R) / 2 : L + (W - L - R) * (v - x0) / (x1 - x0);
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const grid = ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${fmtShort(t)}</text>`).join('');
  // x labels: first, middle, last date
  const lab = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(k => {
    const p = points[k];
    const d = new Date(p.x);
    return `<text x="${x(p.x)}" y="${H - 8}" text-anchor="${points.length === 1 ? 'middle' : k === 0 ? 'start' : k === points.length - 1 ? 'end' : 'middle'}">${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toLowerCase()}</text>`;
  }).join('');
  const line = points.length > 1 ? `<polyline class="line" points="${points.map(p => `${x(p.x)},${y(p.y)}`).join(' ')}"/>` : '';
  const goalLine = goal ? `<line class="goal" x1="${L}" x2="${W - R}" y1="${y(goal)}" y2="${y(goal)}"/><text x="${W - R}" y="${y(goal) - 5}" text-anchor="end" style="fill:var(--accent-2)">goal ${fmt(goal)} ${unit}</text>` : '';
  const dots = points.map(p => `<circle class="dot" cx="${x(p.x)}" cy="${y(p.y)}" r="${points.length > 40 ? 3 : 4.5}"/>`).join('');
  const hits = points.map(p => `<circle class="hit" cx="${x(p.x)}" cy="${y(p.y)}" r="16" data-tip="${esc(p.tip)}"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="progress chart">${grid}${goalLine}${line}${dots}${lab}${hits}</svg>`;
}

// ---------- tooltip, toast, ticking clocks ----------
function showTip(el) {
  const tip = $('#tip');
  tip.innerHTML = el.dataset.tip;
  const r = el.getBoundingClientRect();
  tip.hidden = false;
  const half = tip.offsetWidth / 2;
  tip.style.left = Math.min(window.innerWidth - half - 8, Math.max(half + 8, r.left + r.width / 2)) + 'px';
  tip.style.top = Math.max(tip.offsetHeight + 16, r.top + (el.tagName === 'rect' ? 30 : 0)) + 'px';
}
function hideTip() { const t = $('#tip'); if (t) t.hidden = true; }

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 4000 : 3000);
}

function tick() {
  const w = active();
  const el = $('[data-tick="elapsed"]');
  if (el && w) el.textContent = w.date === today() ? duration(w) || '' : '';
  const rest = $('#rest');
  const secs = S.restAt ? (Date.now() - S.restAt) / 1000 : 0;
  rest.hidden = !(w && S.restAt && secs < 15 * 60);
  if (!rest.hidden) rest.textContent = `rest ${mmss(secs)}`;
}
setInterval(tick, 1000);

// ---------- navigation ----------
function go(view) {
  S.view = view;
  history.pushState({ view, tab: S.tab }, '');
  render();
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', e => {
  closeSheet();
  S.view = e.state?.view || null;
  if (e.state?.tab) S.tab = e.state.tab;
  render();
});

// ---------- events ----------
const actions = {
  start: () => run(async () => {
    const res = await api('workout_start', { date: $('#startDate').value || today() });
    replaceWorkout(res.workout);
    S.restAt = null;
    render();
    openPicker();
  }),
  pick: () => openPicker(),
  closeSheet: () => closeSheet(),
  pickGroup: el => { S.pickGroup = el.dataset.g || null; openPicker(); },
  addEx: el => addExercise(el.dataset.ex),
  tick: el => run(() => {
    const ci = +el.dataset.c, ri = +el.dataset.r;
    return S.cards[ci].rows[ri].done ? unsaveRow(ci, ri) : saveRow(ci, ri);
  }),
  usePrev: el => {
    const ci = +el.dataset.c, ri = +el.dataset.r;
    const c = S.cards[ci], p = previousSession(c.ex, active())?.sets[ri];
    if (!p) return;
    Object.assign(c.rows[ri], { w: fmt(p.weight), r: fmt(p.reps), dirty: true });
    saveDraft();
    if (c.rows[ri].done) run(() => saveRow(ci, ri)); else render();
  },
  addRow: el => addRow(+el.dataset.c),
  setMenu: el => setMenu(+el.dataset.c, +el.dataset.r),
  toggleWu: el => {
    const ci = +el.dataset.c, ri = +el.dataset.r, row = S.cards[ci].rows[ri];
    closeSheet();
    row.wu = !row.wu;
    saveDraft();
    if (row.done) run(() => saveRow(ci, ri)); else render();
  },
  delRow: el => run(async () => {
    const ci = +el.dataset.c, ri = +el.dataset.r, row = S.cards[ci].rows[ri];
    closeSheet();
    if (row.id) replaceWorkout((await api('set_delete', { workout_id: active().id, ids: [row.id] })).workout);
    S.cards[ci].rows.splice(ri, 1);
    saveDraft();
    render();
  }),
  removeCard: el => run(async () => {
    const ci = +el.dataset.c, c = S.cards[ci];
    const ids = c.rows.filter(r => r.done).map(r => r.id);
    if (ids.length && !confirm(`Remove ${c.ex} and its ${ids.length} saved set(s)?`)) return;
    if (ids.length) replaceWorkout((await api('set_delete', { workout_id: active().id, ids })).workout);
    S.cards.splice(ci, 1);
    saveDraft();
    render();
  }),
  finish: () => run(async () => {
    const w = active();
    const pending = S.cards.reduce((n, c) => n + c.rows.filter(r => !r.done && (r.w !== '' || r.r !== '')).length, 0);
    if (!w.sets.length && !confirm('No sets saved. Finish (and keep) an empty workout?')) return;
    if (pending && !confirm(`${pending} set(s) not ticked will be dropped. Finish anyway?`)) return;
    const res = await api('workout_update', { id: w.id, finished: true });
    clearDraft(w.id);
    S.cards = null;
    S.restAt = null;
    replaceWorkout(res.workout);
    const prs = prSets(res.workout).size;
    toast(`workout saved · ${working(res.workout.sets).length} sets${prs ? ` · ${prs} PR${prs > 1 ? 's' : ''} 🏆` : ''}`);
    go({ type: 'workout', id: w.id });
  }),
  discard: () => run(async () => {
    const w = active();
    if (!confirm('Delete this workout and all its sets?')) return;
    await api('workout_delete', { id: w.id });
    clearDraft(w.id);
    S.workouts = S.workouts.filter(x => x.id !== w.id);
    reindex();
    S.cards = null;
    S.restAt = null;
    render();
  }),
  openW: el => go({ type: 'workout', id: +el.dataset.id }),
  openEx: el => { closeSheet(); go({ type: 'exercise', name: el.dataset.ex }); },
  back: () => history.back(),
  goLog: () => { S.tab = 'log'; go(null); },
  reopen: el => run(async () => {
    const res = await api('workout_update', { id: +el.dataset.id, finished: false });
    replaceWorkout(res.workout);
    S.tab = 'log';
    go(null);
  }),
  deleteW: el => run(async () => {
    if (!confirm('Delete this workout permanently?')) return;
    const id = +el.dataset.id;
    await api('workout_delete', { id });
    clearDraft(id);
    S.workouts = S.workouts.filter(x => x.id !== id);
    reindex();
    history.back();
  }),
  month: el => {
    const t = today().slice(0, 7);
    const m = el.dataset.to || shiftMonth(S.month, +el.dataset.n);
    S.month = m > t ? t : m;
    render();
  },
  showAll: el => { S.showAll = el.dataset.v === '1'; render(); },
  metric: el => { S.metric = el.dataset.m; render(); },
  openMeas: () => go({ type: 'measure' }),
  saveMeas: () => run(async () => {
    const values = readParts('m');
    const res = await api('measure_save', { date: $('#mDate').value || today(), values });
    S.meas = res.measurements.map(m => ({ ...m, value: +m.value }));
    toast('measurements saved');
    render();
  }),
  editMeas: el => {
    const d = el.dataset.d;
    $('#mDate').value = d;
    for (const p of S.parts) $(`#m-${p}`).value = S.meas.find(m => m.date === d && m.part === p)?.value ?? '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  delMeas: el => run(async () => {
    if (!confirm(`Delete the measurements of ${el.dataset.d}?`)) return;
    const res = await api('measure_delete', { date: el.dataset.d });
    S.meas = res.measurements.map(m => ({ ...m, value: +m.value }));
    render();
  }),
  saveTargets: () => run(async () => {
    const res = await api('size_targets_set', { values: readParts('t') });
    S.sizeTargets = Object.fromEntries(Object.entries(res.size_targets).map(([k, v]) => [k, +v]));
    toast('targets saved');
    render();
  }),
  saveGoal: el => run(async () => {
    const raw = $('#goalIn').value.trim();
    const target = raw === '' ? 0 : parseNum(raw);
    if (!(target >= 0)) throw new Error('Invalid target');
    await api('goal_set', { exercise: el.dataset.ex, target });
    if (target) S.goals[el.dataset.ex] = target; else delete S.goals[el.dataset.ex];
    toast(target ? 'goal saved' : 'goal cleared');
    render();
  }),
};

document.addEventListener('click', e => {
  const tab = e.target.closest('#tabs button');
  if (tab) {
    S.tab = tab.dataset.tab;
    S.view = null;
    history.replaceState({ view: null, tab: S.tab }, '');
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (e.target.id === 'sheet') return closeSheet();
  if (e.target.id === 'rest') { S.restAt = null; return tick(); }
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  if (el.tagName === 'A') e.preventDefault();
  actions[el.dataset.act](el);
});

document.addEventListener('input', e => {
  if (e.target.id === 'pickq') return renderPickList();
  const m = (e.target.dataset.k || '').match(/^(\d+)-(\d+)-(w|r)$/);
  if (!m || !S.cards) return;
  const row = S.cards[+m[1]].rows[+m[2]];
  row[m[3]] = e.target.value;
  if (row.done) row.dirty = true;
  saveDraft();
});

document.addEventListener('change', e => {
  const k = e.target.dataset.k || '';
  const m = k.match(/^(\d+)-(\d+)-(w|r)$/);
  if (m && S.cards) {
    const row = S.cards[+m[1]].rows[+m[2]];
    if (row.done && row.dirty) run(() => saveRow(+m[1], +m[2]));
    return;
  }
  const w = active();
  if (!w) return;
  if (k === 'note') run(async () => replaceWorkout((await api('workout_update', { id: w.id, note: e.target.value })).workout));
  if (k === 'wdate' && e.target.value) run(async () => { replaceWorkout((await api('workout_update', { id: w.id, date: e.target.value })).workout); render(); });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
  // Enter in a set field ticks the set
  const m = e.key === 'Enter' && (e.target.dataset?.k || '').match(/^(\d+)-(\d+)-(w|r)$/);
  if (m) { e.preventDefault(); e.target.blur(); const row = S.cards[+m[1]].rows[+m[2]]; if (!row.done) run(() => saveRow(+m[1], +m[2])); }
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'loginForm') return;
  e.preventDefault();
  run(async () => {
    await api('login', { password: $('#pw').value });
    await boot();
  });
});

document.addEventListener('pointerover', e => { const el = e.target.closest?.('[data-tip]'); if (el) showTip(el); });
document.addEventListener('pointerout', e => { if (e.pointerType !== 'touch' && e.target.closest?.('[data-tip]')) hideTip(); });
window.addEventListener('scroll', hideTip, { passive: true });

async function boot() {
  try {
    ingest(await api('data'));
  } catch (e) {
    if (e.message !== 'Not logged in') $('#app').innerHTML = `<p class="bad mono center">${esc(e.message)}</p>`;
    return;
  }
  history.replaceState({ view: null, tab: S.tab }, '');
  render();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
boot();
