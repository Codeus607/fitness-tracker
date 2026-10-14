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
// Front and back views in the same 228×452 box, traced from a reference figure.
// OUTLINE is the whole body; each muscle is drawn for the figure's right side and mirrored.
const BODY_OUTLINE = 'M167.2,37L161.2,38.5L153.8,44.5L150.2,51.2L149.5,61.2L145,65.5L145,67.8L147.5,73.5L151,76.8L152.2,79.2L152.8,85.5L155.2,88.8L153,92.5L152.5,100L141,104.8L134.5,108.8L131.5,107.2L129.5,109L123.8,109.5L118,112L111.5,117.5L107.2,123.5L105.8,127.8L106,133.5L107.5,137.8L107.5,144L102.2,152.5L99.2,161.8L99.2,169L102.2,175.8L98,179.5L92.2,191.8L87,221.2L81.8,232.8L82,236.8L74,242.2L65.8,251L61.8,253L60.8,255.8L63,257.5L68.8,257.2L70.2,258.2L70,261L68.2,264L66,265.5L64.2,271.5L64.5,273.5L66.5,276.2L66.8,279.8L74.8,281L78.2,277L81,276.5L83.5,274.5L93.8,258.8L94.8,251.8L93.5,244.8L96.2,241.8L104.5,225.5L114,200.5L114.5,194.2L118.2,185.5L118.2,181.2L116.2,178.5L119.5,178L128,162.2L127.5,159.8L129.5,159L132.2,188L136,191.2L136.5,193.8L133.5,200.8L133.5,216.5L136.2,223.5L134.8,224.5L133.2,224L132.2,219.5L129.5,218.5L125.5,228.8L125.5,231.5L120.5,248L119.5,260.8L117.8,269.5L117.5,281.5L117.8,293.2L119.2,299L119.5,308.8L120.8,313.5L119.8,317.2L122.2,320.8L123.8,333.8L131.8,349.5L127.5,364.5L126.5,378.8L126.5,405.2L129,419.2L132.8,428.2L133,431L131.8,433.2L130,445.8L128.5,449.5L118.2,460L109.5,465.8L108,470.8L109.2,473.5L115.2,476.2L124.5,476.8L128.5,475L135.2,470L140.8,467.8L142.8,465.2L144.5,459.8L145.5,451L145,444.8L146,442L144.2,426.5L145.8,424.5L144.8,421.5L145,416.5L148.5,407.2L151,405.2L150.8,402L154,391.8L153.8,376.2L148.8,359.8L146.2,356.5L147.8,354L150,353.5L151.8,351.2L154,345.2L155.2,336.8L157,334.5L158,330.5L156.8,324.8L157,305.5L155,300.8L157.5,296.2L161.5,275.8L162.8,263.8L162.8,252.5L159,247.5L154.2,245.5L153.2,243.8L154,242.8L158.8,242.5L163.2,246.8L165.8,247L167.2,245.5L166.5,212.5L164.8,208.5L164.8,206.5L166.8,203L166.8,187L165.2,183.2L167,179.8L167,174L164.8,167L166.5,163.8L167.2,154.2L168.5,153.2L171.2,154.2L170.8,164.2L174,168L170.8,171.2L171,180.8L174,184.2L171,187L171,204.2L172.5,208.2L171.2,210.8L170.5,245.2L171,246.5L172.8,247L179.5,242.8L184.8,242.2L185.8,243.2L184.8,245L177.8,249L175.5,251.8L175.2,264.8L178.2,287.5L180,291.5L180.5,296.8L182.5,299.5L182.5,305L181,308.2L180.5,316.8L182.5,339.5L186.8,353L190,354.2L191.2,355.8L191,358L188.8,360.2L188.5,365.2L184.2,378.2L184,391L187,402.2L191.8,411.8L191.8,415.5L193,417.2L194.5,423.8L194.5,427.8L191.8,438.5L193.2,460L195.2,466L197.8,468.2L202,469.8L212,476.5L220,476.8L228.8,473.5L229.5,469.8L225,463.2L220,460.2L217.8,456.8L213.8,454.8L209,449.2L207.8,445.8L207.2,438.5L204.8,430.2L210.2,414.5L211.8,397.8L210.5,364L206.2,349.5L214.2,333.8L215.2,322.8L218.2,314.5L217.2,311L218.2,304L219.5,301.5L220.2,281.2L220,267L218,258.2L217.8,247.2L215.2,243.2L215.5,237.2L212.2,231.5L211,224.5L209,219.8L207.8,218.5L204.8,219L203.8,217.8L204.2,200.5L201.2,194.2L202,191L205.5,188.2L206,178.8L207.2,174.8L207.5,161L208.2,159.8L210.5,160.8L213.5,169.5L216.8,175.2L222.5,178.5L222.5,180L220,182L219.5,183.8L220.5,188.5L223.2,194.2L223.2,198L225.5,206L237.2,233.2L239.2,235.8L242,242.5L244.2,244.5L243,255.5L250,267L250.8,270L256.2,276.5L259.5,276.8L262.5,280.8L270.8,280L273.8,271.8L267.8,261L267.5,259L269.2,257.2L275.2,257.5L277.2,254.8L276,253L272.5,251.2L261.5,240.2L256.8,237.5L256.8,234.2L253.2,227.2L249.2,215.5L247.8,199.5L245.8,191.5L241.2,182.5L238.8,179L235.8,177L238.8,167.8L238.8,162.5L234.8,150L230.5,144L230,138.2L232,133.2L230.8,124L225.8,117.5L217.5,109.5L202.8,108.5L197.5,105L190,102.5L185.2,99.8L184.2,87.8L186.2,80.8L188.5,78.5L192.8,69L193,65.5L188.5,60.2L187.8,51.2L186.2,47L183.8,44L176.2,38.2Z';
const BODY = {
  front: {
      traps: 'M158,95 C152,103 140,108 126,111 C140,114 152,115 163,114 L162,104 Z',
      sideDelt: 'M130,110 C117,112 107,121 104,137 C106,142 109,142 111,139 C113,127 119,118 131,113 Z',
      frontDelt: 'M132,113 C121,118 113,127 111,140 C113,147 117,150 122,150 C125,138 131,128 141,121 C139,117 136,114 132,113 Z',
      chest: 'M166,115 L142,120 C133,126 127,135 124,147 C134,154 152,156 167,151 Z',
      biceps: 'M124,149 C114,150 105,155 100,165 C96,177 93,188 92,197 C99,200 106,200 111,198 C116,190 121,178 124,166 C126,160 126,154 124,149 Z',
      forearms: 'M91,201 C89,212 86,222 84,232 C89,235 94,235 98,233 C102,224 106,215 109,203 C103,201 97,201 91,201 Z',
      abs: 'M168.75,153 L157,154 C155,180 155,215 158,250 C161,257 165,261 168.75,262 Z',
      obliques: 'M151,154 C150,170 149,190 147,203 C141,207 133,212 129,220 C131,232 138,242 147,250 C150,251 153,251 155,251 C153,215 153,180 155,154 Z',
      quads: 'M129,222 C121,240 117,266 118,295 C119,316 123,334 129,346 C135,351 143,350 148,343 C152,326 153,312 152,300 C153,280 151,262 147,250 C141,240 135,230 129,222 Z',
      adductors: 'M149,251 C155,259 161,264 167,268 C166,284 160,298 153,312 C155,292 154,270 149,251 Z',
      calves: 'M146,358 C140,368 138,385 139,400 C140,415 143,425 146,432 C150,422 153,405 153,390 C153,375 151,364 146,358 Z',
  },
  back: {
      upperBack: 'M131,120 C127,130 125,142 127,152 C135,160 146,162 152,156 C150,142 144,130 135,121 Z',
      traps: 'M168.75,92 L160,95 C154,103 142,108 129,112 C138,120 146,134 152,150 C157,164 163,176 168.75,186 Z',
      sideDelt: 'M130,110 C117,112 107,121 104,137 C106,142 109,142 111,139 C113,127 119,118 131,113 Z',
      rearDelt: 'M127,114 C119,119 113,128 111,140 C113,147 117,150 122,150 C125,138 130,129 137,121 C134,117 131,115 127,114 Z',
      lats: 'M126,156 C125,178 129,200 138,220 C148,226 158,228 168.75,229 L168.75,190 C162,180 157,170 153,160 C145,165 134,164 126,156 Z',
      lowerBack: 'M168.75,231 C158,230 149,228 141,222 C144,232 148,244 151,254 L168.75,256 Z',
      triceps: 'M124,149 C114,150 105,155 100,165 C96,177 93,188 92,197 C99,200 106,200 111,198 C116,190 121,178 124,166 C126,160 126,154 124,149 Z',
      forearms: 'M91,201 C89,212 86,222 84,232 C89,235 94,235 98,233 C102,224 106,215 109,203 C103,201 97,201 91,201 Z',
      glutes: 'M151,256 C138,256 127,262 122,276 C120,290 127,300 139,302 C151,304 161,300 168.75,295 L168.75,258 Z',
      hamstrings: 'M121,298 C119,318 122,336 128,346 L150,346 C153,330 155,316 157,302 C148,306 134,306 121,298 Z',
      calves: 'M138,354 C126,358 120,372 121,388 C122,400 128,408 136,410 C144,405 151,395 152,380 C152,366 147,356 138,354 Z',
  },
};

const mixHex = (a, b, t) => '#' + [1, 3, 5].map(k => Math.round(parseInt(a.substr(k, 2), 16) * (1 - t) + parseInt(b.substr(k, 2), 16) * t).toString(16).padStart(2, '0')).join('');

// ready-made SVG for one map; vals: muscle → { v: 0..1 or null, tip }
function bodyMap(vals, ramp, label) {
  const view = (k, dx) => {
    const mus = Object.entries(BODY[k]).map(([m, d]) => {
      const x = vals[m] || {};
      const style = x.v == null ? '' : ` style="fill:${mixHex(ramp[0], ramp[1], x.v)}"`;
      return `<g class="m ${x.v == null ? 'off' : 'on'}"${style}${x.tip ? ` data-tip="${esc(x.tip)}"` : ''}><path d="${d}"/><path d="${d}" transform="matrix(-1,0,0,1,337.5,0)"/></g>`;
    }).join('');
    return `<g transform="translate(${dx},0)"><path class="sil" d="${BODY_OUTLINE}"/>${mus}</g>`;
  };
  return `<svg class="body" viewBox="55 30 476 452" role="img" aria-label="${esc(label)}">${view('front', 0)}${view('back', 248)}</svg>`;
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
