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
  groups: [], info: {}, workouts: [], goals: {}, hist: {}, parts: [], meas: [], sizeTargets: {}, bw: [], programs: [],
  tab: 'log', view: null, month: today().slice(0, 7), showAll: false, metric: null,
  cards: null, cardsFor: null, restAt: null, busy: false,
};

const info = name => S.info[name] || { name, group: 'Other', timed: false, bw: false };
const active = () => S.workouts.find(w => w.finished_at == null);
const workoutById = id => S.workouts.find(w => w.id === id);

function ingest(d) {
  S.groups = d.exercises;
  S.programs = d.programs || [];
  S.goals = d.goals || {};
  S.parts = d.parts || [];
  S.meas = (d.measurements || []).map(m => ({ ...m, value: +m.value }));
  S.sizeTargets = Object.fromEntries(Object.entries(d.size_targets || {}).map(([k, v]) => [k, +v]));
  S.info = {};
  for (const g of S.groups) for (const e of g.exercises) S.info[e.name] = { ...e, group: g.name };
  S.bw = (d.bodyweight || []).map(b => ({ date: b.date, kg: +b.kg }));
  S.workouts = d.workouts;
  reindex();
  // the server finishes forgotten workouts, so drop their leftover unticked rows
  const open = active();
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('fit-draft-') && (!open || k !== draftKey(open.id))) localStorage.removeItem(k);
  } catch { }
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
    : v?.type === 'weight' ? viewWeight()
    : S.tab === 'log' ? viewLog()
    : S.tab === 'history' ? viewHistory()
    : S.tab === 'program' ? viewPrograms()
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
      <div class="muted" style="font-size:.85rem;margin:2px 0 4px">${planOf(w) ? `<span class="good">${esc(planOf(w).day.name)}</span> · ` : ''}${groups.length ? groups.map(esc).join(', ') : 'empty'}</div>
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
        <input type="date" id="startDate" value="${today()}" max="${today()}" style="width:auto">
        <div style="height:12px"></div>
        <button class="btn primary block" data-act="start">start empty workout</button>
        ${nextDays().map(({ p, pi, di }) => `<div style="height:8px"></div>
        <button class="btn block" data-act="startDay" data-p="${pi}" data-d="${di}">start next: ${esc(p.days[di].name)}</button>`).join('')}
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
  const target = planOf(w)?.day.items.find(it => it.exercise === c.ex);
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
      ${target?.sets ? `<div class="meta">target ${esc(targetLabel(target))}</div>` : ''}
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

// ----- programs -----
const planName = (p, d) => `${p.name} / ${d.name}`;
const targetLabel = it => `${it.sets}×${it.reps}`;
// the program day a workout was started from, if it still exists in programs.md
function planOf(w) {
  if (!w?.plan) return null;
  for (const p of S.programs) for (const day of p.days) if (planName(p, day) === w.plan) return { p, day };
  return null;
}
// last workout of each day of program p
function lastDone(p) {
  const out = new Map();
  for (const w of S.workouts) {
    const di = p.days.findIndex(d => planName(p, d) === w.plan);
    if (di >= 0) out.set(di, w);
  }
  return out;
}
// per program, the day after the most recently done one (the first day if none done yet)
function nextDays() {
  return S.programs.map((p, pi) => {
    const last = [...lastDone(p)].sort((a, b) => a[1].date.localeCompare(b[1].date) || a[1].started_at - b[1].started_at).at(-1);
    return { p, pi, di: last ? (last[0] + 1) % p.days.length : 0 };
  });
}

function viewPrograms() {
  if (!S.programs.length) return `<h1>programs</h1><p class="meta">no programs yet — add them to Fitness Programs.md</p>`;
  const t = today(), next = nextDays(), w = active();
  return '<h1>programs</h1>' + S.programs.map((p, pi) => {
    const done = lastDone(p);
    return `<h2>${esc(p.name.toLowerCase())}</h2>
      ${p.note ? `<p class="meta" style="margin:-6px 0 10px">${esc(p.note)}</p>` : ''}
      ${p.days.map((d, di) => {
        const last = done.get(di), since = last ? daysBetween(last.date, t) : null;
        return `<div class="card">
          <h3>${esc(d.name)}</h3>
          <div class="meta">${next[pi].di === di ? '<span class="good">next</span> · ' : ''}${since == null ? 'not done yet' : `last ${sinceLabel(since)}${since ? ' ago' : ''}`}</div>
          ${d.note ? `<p class="meta" style="margin:2px 0 6px">${esc(d.note)}</p>` : ''}
          <table class="tbl" style="margin:6px 0 10px"><tbody>${d.items.map(it => `
            <tr class="click" data-act="openEx" data-ex="${esc(it.exercise)}">
              <td class="name">${esc(it.exercise)}${S.info[it.exercise] ? '' : ' <span class="warn">· not in exercise list</span>'}</td>
              <td class="num">${it.sets ? esc(targetLabel(it)) : ''}</td></tr>`).join('')}</tbody></table>
          <button class="btn ${next[pi].di === di && !w ? 'primary' : ''} block" data-act="startDay" data-p="${pi}" data-d="${di}">${w ? 'add to current workout' : 'start this day'}</button>
        </div>`;
      }).join('')}`;
  }).join('');
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

// sets = the program's target set count; otherwise as many rows as last time
function newCard(ex, sets = 0) {
  const prev = previousSession(ex, active());
  const rows = sets ? Array.from({ length: sets }, () => ({ w: '', r: '', wu: false, done: false }))
    // values come from the "prev" placeholders
    : (prev ? prev.sets : [null]).map(s => ({ w: '', r: '', wu: !!s?.warmup, done: false }));
  return { ex, rows };
}

function addExercise(ex) {
  closeSheet();
  const existing = S.cards.findIndex(c => c.ex === ex);
  if (existing < 0) {
    S.cards.push(newCard(ex));
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
// Front and back views generated by tools/body_figure.py (anatomical, drawn from landmarks), origin at the top centre.
// sil is the whole body; each muscle is one path covering both sides. neck is never coloured.
const BODY = {
  front: {
    sil: 'M-70.3,232.4L-72.4,236.7L-74.3,243.4L-75.1,251.6L-74.9,259.4L-73.9,264.7L-72.0,270.0L-70.4,272.4L-69.1,273.7L-67.2,274.9L-66.0,275.0L-64.9,274.5L-63.8,273.4L-61.8,270.1L-60.7,266.9L-59.7,261.4L-59.0,254.0L-58.8,246.7L-59.0,240.0L-59.8,232.8L-57.5,218.9L-54.3,191.3L-53.9,186.4L-53.9,170.3L-50.3,136.9L-49.6,135.8L-48.5,135.5L-47.7,136.0L-47.3,136.7L-44.0,162.0L-41.4,176.6L-40.7,184.9L-40.6,191.1L-41.2,197.7L-42.3,203.0L-45.5,215.8L-49.6,230.1L-52.1,243.5L-52.8,249.8L-53.3,259.4L-53.0,278.0L-51.8,291.4L-50.0,304.0L-48.6,310.6L-45.4,322.2L-43.1,335.2L-43.2,341.7L-46.1,352.0L-47.0,358.0L-46.9,367.9L-45.8,378.8L-43.9,389.0L-34.2,419.4L-33.4,422.8L-33.0,426.1L-33.2,429.0L-34.0,432.0L-40.6,448.9L-41.0,451.0L-40.8,452.9L-39.3,455.5L-37.9,457.0L-36.1,458.1L-32.8,459.3L-28.0,460.1L-22.9,460.2L-20.1,459.6L-18.2,458.2L-16.7,454.8L-16.1,449.0L-16.2,441.1L-18.0,430.0L-18.5,428.4L-19.8,426.8L-20.0,425.2L-19.6,420.3L-14.5,390.3L-13.1,378.3L-13.0,369.1L-15.0,342.6L-14.9,336.5L-11.7,319.9L-6.3,274.4L-3.7,255.6L-3.3,254.8L-2.6,254.4L-1.7,254.4L-1.1,254.9L-0.0,254.6L1.1,254.9L2.3,254.3L3.1,254.6L3.6,255.2L4.2,258.6L11.4,317.7L15.0,338.0L15.0,342.6L13.1,366.8L13.1,378.3L14.5,390.3L19.6,420.3L20.0,425.2L19.8,427.0L18.2,429.1L16.4,439.3L16.0,444.5L16.4,453.5L17.1,456.2L18.2,458.2L19.0,459.0L21.3,459.9L24.5,460.3L28.0,460.1L31.3,459.7L35.1,458.6L37.9,457.0L39.4,455.5L40.8,453.0L41.0,451.0L40.2,447.7L33.9,431.9L33.0,427.6L33.1,424.5L34.3,419.4L43.2,391.5L44.5,386.5L45.8,378.8L46.9,367.9L47.0,358.0L46.1,352.0L43.2,341.7L43.1,335.2L45.4,322.2L49.1,308.5L50.4,301.6L52.4,286.0L53.3,270.0L53.1,254.4L51.8,241.5L49.6,230.1L43.1,206.7L41.0,196.0L40.6,188.0L41.2,178.3L44.0,162.0L47.3,136.7L48.0,135.8L49.1,135.5L49.9,135.9L50.3,136.9L53.9,170.3L53.9,186.4L54.3,191.3L57.5,218.9L59.8,232.8L59.0,240.0L58.8,246.7L59.0,254.0L59.7,261.4L60.7,266.9L62.7,271.9L64.9,274.5L66.0,275.0L67.1,274.9L69.8,273.1L71.5,270.9L72.4,269.1L74.2,263.4L75.1,256.6L74.9,248.2L74.0,242.0L72.4,236.7L70.0,231.6L71.0,227.5L74.5,208.1L75.0,202.0L74.8,196.3L73.0,184.0L69.5,172.8L68.9,168.5L70.0,156.0L70.0,144.0L73.6,119.1L74.0,112.0L73.1,105.9L71.3,100.4L68.4,95.7L64.6,91.6L62.3,90.1L60.0,89.0L57.2,88.3L52.1,88.0L48.2,86.2L39.4,83.5L29.2,79.1L25.2,76.9L22.9,75.1L20.0,72.1L17.0,68.0L15.7,64.9L16.0,58.3L15.6,57.6L14.1,56.2L13.8,55.2L17.9,47.4L19.2,43.6L20.7,38.2L21.9,29.0L22.0,22.9L21.6,18.1L20.5,12.2L18.2,7.6L16.6,5.7L14.0,3.3L9.9,1.1L6.2,0.3L0.0,0.0L-6.2,0.3L-9.9,1.1L-13.0,2.6L-15.8,4.8L-18.2,7.7L-20.0,11.0L-21.2,15.1L-21.9,21.3L-22.0,27.5L-21.4,33.7L-20.3,39.6L-18.8,45.0L-16.8,49.8L-13.8,55.2L-14.1,56.2L-15.6,57.6L-16.0,58.3L-16.1,59.9L-15.6,64.0L-16.0,65.9L-19.2,71.2L-21.9,74.1L-24.0,76.0L-27.7,78.4L-32.1,80.5L-39.5,83.6L-48.3,86.2L-52.1,88.0L-58.7,88.6L-62.4,90.1L-65.6,92.5L-68.4,95.7L-70.7,99.2L-72.3,103.0L-73.7,108.9L-74.0,115.4L-70.1,142.7L-70.0,156.0L-68.9,168.5L-69.5,172.8L-72.3,181.0L-73.3,185.6L-74.7,194.5L-75.0,202.0L-74.2,210.3L-71.0,227.5L-70.0,231.3Z',
    neck: 'M-3.5,81.7L-3.0,78.8L-4.0,72.0L-4.3,65.3L-4.7,63.5L-5.6,62.4L-7.6,61.4L-10.7,60.9L-12.9,61.3L-13.5,62.1L-13.4,64.3L-14.0,67.0L-13.9,67.8L-5.4,81.6L-4.8,82.0L-4.1,82.0ZM3.3,81.5L3.8,82.0L4.5,82.1L5.8,81.1L13.9,67.7L13.4,64.3L13.5,62.1L12.7,61.2L10.7,60.9L7.6,61.4L5.6,62.4L4.7,63.6L4.2,66.1L4.0,72.0L3.0,78.8Z',
    traps: 'M-17.7,72.8L-21.4,76.7L-24.0,78.7L-29.7,81.8L-39.9,86.1L-40.5,86.8L-40.4,87.7L-39.3,88.3L-28.6,87.4L-25.7,86.7L-22.3,85.0L-19.3,82.6L-17.0,78.9L-15.8,73.5L-16.3,72.9L-17.0,72.6ZM17.8,72.9L16.7,72.7L15.8,73.5L16.6,77.8L17.5,80.0L18.6,81.8L21.6,84.5L24.9,86.4L28.6,87.4L39.3,88.3L40.3,87.8L40.5,86.9L39.9,86.1L29.7,81.8L24.0,78.7L20.4,75.8Z',
    frontDelt: 'M-42.4,90.1L-46.7,89.6L-48.7,88.8L-51.6,90.2L-56.9,90.5L-57.9,91.3L-62.0,120.0L-61.6,131.7L-60.8,132.6L-59.9,132.6L-59.3,131.9L-56.3,118.9L-54.0,112.0L-51.8,108.2L-46.7,101.2L-42.9,93.9L-41.9,90.9ZM42.9,89.8L42.1,90.3L41.9,91.1L43.4,95.2L46.7,101.2L52.6,109.4L54.6,113.3L56.3,118.9L59.3,131.9L59.9,132.6L60.8,132.6L61.6,131.7L62.0,120.0L57.9,91.3L56.9,90.5L51.6,90.2L48.6,88.8L46.7,89.6Z',
    sideDelt: 'M-62.3,92.6L-65.9,96.1L-68.1,99.1L-69.3,101.3L-71.0,106.3L-71.8,112.2L-71.4,118.8L-69.2,133.6L-65.1,145.3L-64.6,146.1L-63.9,146.5L-62.8,145.9L-61.9,143.1L-62.7,141.1L-63.4,120.0L-59.6,93.2L-59.9,92.4L-60.6,92.0ZM61.3,92.0L60.2,92.1L59.6,93.2L63.4,120.0L62.7,141.1L61.9,143.1L62.8,145.9L63.9,146.5L64.6,146.1L65.1,145.3L69.2,133.6L71.4,118.8L71.8,112.2L71.0,106.3L68.7,100.2L65.0,95.1Z',
    chest: 'M-11.2,88.9L-22.0,88.6L-28.5,88.9L-35.3,89.7L-40.1,91.1L-40.5,91.6L-41.6,94.5L-44.8,100.7L-50.7,109.1L-50.7,110.3L-40.0,121.0L-34.8,124.9L-30.0,127.4L-24.5,129.2L-17.8,130.3L-13.1,130.4L-8.1,129.9L-5.5,130.1L-4.0,129.9L-3.0,128.9L-2.4,127.6L-1.4,120.6L-0.8,104.8L-1.5,94.2L-2.7,90.5L-3.5,89.4L-4.5,88.8L-6.9,88.4ZM12.6,89.0L5.6,88.5L3.4,89.5L2.0,92.0L1.1,97.3L0.8,108.9L1.4,120.6L2.4,127.6L3.0,128.9L4.0,129.9L5.5,130.1L8.1,129.9L13.1,130.4L17.8,130.3L24.5,129.2L30.0,127.4L34.8,124.9L40.0,121.0L50.7,110.3L50.7,109.1L44.8,100.7L41.6,94.5L40.5,91.6L40.1,91.1L35.3,89.7L28.6,88.9L20.3,88.6Z',
    lats: 'M-42.0,143.5L-43.2,130.8L-44.2,124.2L-45.0,122.1L-45.7,121.0L-47.1,120.0L-48.0,119.9L-48.9,120.6L-49.2,122.9L-48.4,132.7L-47.9,133.4L-46.2,134.4L-45.3,135.7L-44.3,143.5L-44.0,144.2L-43.1,144.5L-42.3,144.1ZM42.0,143.5L42.3,144.1L42.9,144.5L43.7,144.4L44.2,143.9L45.3,135.7L46.2,134.4L47.9,133.4L48.4,132.7L49.2,122.9L48.9,120.6L48.0,119.9L47.1,120.0L45.7,121.0L45.0,122.1L44.2,124.2L42.5,136.1Z',
    obliques: 'M-36.9,125.3L-38.7,123.8L-41.2,123.0L-41.9,123.0L-42.6,123.5L-42.8,124.3L-41.8,130.1L-41.3,130.9L-39.2,131.1L-37.9,129.7L-37.2,128.2L-36.8,126.2ZM37.0,125.2L36.8,126.1L36.9,127.4L38.3,130.3L39.5,131.1L41.4,130.8L41.8,130.2L42.8,124.3L42.5,123.5L41.7,123.0L40.3,123.3L38.6,123.9ZM-37.6,132.1L-40.6,132.6L-41.3,133.3L-40.9,138.0L-40.1,138.9L-37.2,139.1L-36.6,138.7L-35.9,137.6L-35.5,135.4L-35.7,133.6L-36.4,132.7ZM36.4,132.7L35.7,133.5L35.5,134.8L35.7,136.9L36.3,138.2L37.5,139.1L40.3,138.7L40.9,137.8L41.4,133.8L41.2,133.1L40.6,132.6L37.9,132.1ZM-36.7,140.6L-39.8,140.5L-40.6,141.4L-40.6,146.3L-40.3,146.9L-39.7,147.3L-38.1,147.3L-37.1,147.0L-36.4,146.2L-35.8,144.8L-35.6,142.7L-35.8,141.4ZM36.8,140.5L35.9,141.1L35.6,142.1L35.7,144.1L36.3,146.1L37.4,147.2L39.9,147.2L40.6,146.3L40.5,141.2L39.5,140.5ZM-30.1,135.4L-31.9,136.9L-34.3,140.2L-34.2,143.4L-34.7,146.0L-35.7,147.7L-37.7,149.1L-38.3,151.7L-38.5,157.6L-37.7,180.1L-37.8,188.1L-39.4,199.8L-42.8,214.5L-42.9,216.7L-42.4,218.9L-41.5,221.1L-38.9,224.3L-32.0,231.0L-20.8,242.5L-18.0,244.6L-16.4,245.0L-15.1,244.1L-14.4,242.1L-14.0,231.9L-18.1,177.5L-19.0,156.0L-18.9,142.4L-19.2,138.7L-20.1,135.9L-21.5,134.6L-22.7,134.1L-26.3,134.0ZM25.2,133.9L22.7,134.1L20.7,135.2L19.5,137.2L19.0,140.4L19.1,153.8L18.1,177.5L14.0,231.9L14.4,242.1L15.1,244.1L16.4,245.0L18.0,244.6L20.8,242.5L32.0,231.0L38.9,224.3L40.7,222.2L42.0,220.1L42.9,216.6L42.8,214.5L39.4,199.8L37.8,188.1L37.7,180.1L38.5,155.6L38.0,150.0L37.6,148.9L36.0,148.0L34.8,146.1L34.2,143.4L34.4,140.4L32.7,137.8L29.9,135.3L27.6,134.3Z',
    abs: 'M-2.6,131.1L-14.7,131.8L-15.5,132.3L-16.2,134.0L-16.1,139.5L-17.0,145.0L-16.8,146.3L-16.1,147.1L-14.0,147.8L-9.1,148.0L-4.3,148.8L-3.0,148.6L-2.2,148.0L-1.5,146.3L-1.1,143.3L-1.1,135.7L-1.8,131.7ZM3.0,131.0L2.2,131.2L1.7,131.9L1.0,137.5L1.2,144.9L2.2,148.0L3.0,148.6L4.3,148.8L9.1,148.0L14.0,147.8L16.2,147.1L16.8,146.3L17.0,145.0L16.1,139.5L16.2,134.0L15.5,132.3L14.7,131.8L8.1,131.3L4.7,131.5ZM-2.4,150.2L-7.2,149.8L-13.0,150.1L-15.3,150.6L-16.4,151.3L-17.1,153.6L-16.8,161.0L-16.4,163.2L-15.5,164.9L-13.2,165.8L-7.9,166.1L-4.7,166.7L-3.3,166.7L-2.2,166.0L-1.5,164.4L-1.1,161.6L-1.1,154.5L-1.8,150.7ZM2.6,150.1L1.9,150.5L1.5,151.5L1.0,156.2L1.2,163.1L2.2,166.0L3.3,166.7L4.7,166.7L7.9,166.1L13.2,165.8L15.6,164.8L16.3,163.8L16.6,162.4L17.1,155.0L17.0,152.8L16.3,151.2L15.2,150.5L13.0,150.1L7.2,149.8L4.3,150.2ZM-2.7,168.0L-6.8,167.8L-12.3,168.1L-14.4,168.6L-15.7,169.5L-16.2,172.3L-15.7,179.0L-14.9,181.7L-13.7,183.2L-11.9,183.8L-7.2,184.1L-3.9,184.7L-2.8,184.5L-2.1,184.0L-1.5,182.4L-1.1,179.5L-1.3,170.9L-2.0,168.4ZM2.6,168.1L1.9,168.5L1.5,169.5L1.0,174.2L1.3,181.1L2.1,184.0L3.1,184.7L4.3,184.7L7.2,184.1L11.9,183.8L13.8,183.1L15.1,181.2L15.8,178.2L16.2,172.2L16.0,170.3L15.5,169.3L14.4,168.6L12.3,168.1L6.8,167.8ZM-1.9,248.1L-1.3,209.3L-1.4,195.8L-1.8,187.1L-2.1,186.4L-2.7,186.1L-4.5,186.1L-6.8,185.6L-8.0,186.0L-12.3,185.5L-13.5,186.1L-14.2,187.4L-14.5,190.0L-14.5,193.5L-12.9,214.1L-11.1,227.8L-9.2,236.4L-7.6,242.0L-5.8,245.9L-4.5,247.9L-3.4,248.8L-2.5,248.8ZM1.9,248.2L2.8,248.9L3.9,248.5L5.8,245.9L7.2,243.1L9.2,236.4L11.4,226.0L13.1,212.0L14.6,191.7L14.2,187.3L13.4,186.0L12.2,185.5L8.6,186.0L6.8,185.6L4.5,186.1L2.7,186.1L2.1,186.4L1.8,187.1L1.4,195.8L1.3,209.3Z',
    adductors: 'M-4.4,251.2L-5.6,249.8L-8.1,248.5L-14.6,246.1L-17.4,246.3L-20.9,244.4L-23.2,244.0L-26.2,244.1L-27.4,244.5L-28.0,245.5L-28.0,247.0L-27.3,249.2L-21.0,262.0L-12.4,287.9L-11.5,288.8L-10.6,288.6L-10.1,287.9L-6.4,258.3L-5.7,254.6L-4.2,252.4ZM4.1,251.8L4.2,252.6L5.6,254.4L6.1,256.3L10.1,287.9L10.6,288.6L11.5,288.8L12.4,287.9L21.0,262.0L27.3,249.2L28.0,247.0L28.0,245.5L27.4,244.5L26.2,244.1L23.2,244.0L20.9,244.4L17.4,246.3L14.6,246.1L8.0,248.5L5.5,249.9Z',
    quads: 'M-37.3,329.6L-36.8,328.2L-36.5,325.4L-36.9,314.0L-37.7,305.8L-42.8,270.1L-43.1,263.8L-42.8,253.6L-43.0,248.0L-43.9,241.9L-45.1,235.9L-46.0,233.5L-47.1,232.9L-47.7,233.2L-48.1,233.7L-49.3,239.9L-50.4,247.8L-50.9,254.5L-51.0,272.6L-49.9,288.5L-47.4,305.8L-43.7,319.8L-42.2,326.5L-40.9,328.4L-39.3,329.8L-38.2,330.1ZM37.8,330.0L38.7,330.1L39.8,329.5L42.2,326.5L43.7,319.8L47.4,305.8L49.0,296.3L50.2,285.8L51.1,270.0L50.8,252.2L49.9,243.8L48.6,236.2L48.1,233.6L47.1,232.9L46.0,233.5L45.1,235.9L43.9,241.9L43.0,248.0L42.8,253.6L43.1,263.8L42.8,270.1L37.7,305.8L36.7,316.0L36.6,326.9L37.0,329.0ZM-27.9,322.9L-25.9,320.9L-24.2,317.8L-23.0,314.0L-22.7,311.0L-22.6,305.7L-23.1,294.1L-24.4,280.2L-27.7,262.1L-31.3,254.5L-36.3,245.4L-37.6,243.4L-38.6,243.0L-39.4,243.5L-39.8,244.6L-41.0,258.0L-41.0,267.4L-40.3,278.9L-36.5,304.1L-35.6,307.4L-33.0,315.6L-30.8,320.7L-29.3,322.8L-28.6,323.1ZM28.6,323.1L29.3,322.8L30.0,322.0L32.0,318.0L34.0,312.6L36.1,305.6L40.3,278.9L41.0,267.4L41.0,258.0L39.8,244.6L39.4,243.5L38.6,243.0L37.6,243.4L36.3,245.4L31.3,254.5L27.7,262.1L25.8,271.6L24.1,282.2L22.7,301.8L22.8,312.5L23.3,315.4L24.7,319.0L26.9,322.2ZM-14.9,318.8L-16.8,302.9L-18.6,290.6L-20.1,284.5L-20.6,283.8L-21.4,283.7L-22.1,284.1L-22.4,284.9L-21.2,305.7L-21.6,314.2L-22.4,317.1L-24.1,320.7L-26.0,323.3L-28.5,325.0L-28.6,325.8L-28.0,326.9L-26.1,329.1L-23.1,330.7L-20.4,330.9L-17.6,329.9L-15.9,328.0L-15.0,325.9L-14.5,321.4L-14.5,319.5ZM14.6,319.4L14.7,324.7L15.3,327.0L16.4,328.8L18.3,330.3L21.1,331.0L23.9,330.5L26.8,328.5L28.5,326.1L28.6,325.4L28.3,324.7L26.0,323.3L24.0,320.6L22.4,317.1L21.6,314.2L21.2,305.7L22.4,284.9L22.1,284.1L21.4,283.7L20.6,283.8L20.1,284.5L18.6,290.6L16.8,302.9L15.1,318.3Z',
    calves: 'M-20.2,340.5L-21.4,345.6L-22.1,351.5L-22.4,358.6L-22.1,366.2L-21.4,373.7L-19.7,382.9L-18.6,387.5L-18.1,388.0L-17.4,388.2L-16.8,388.0L-16.3,387.3L-15.5,380.5L-15.1,373.7L-15.3,366.9L-17.4,338.8L-18.2,338.3L-19.1,338.4ZM19.3,338.5L18.1,338.3L17.3,339.2L15.2,369.1L15.2,375.9L15.8,382.8L16.4,387.4L16.8,388.0L17.4,388.2L18.2,388.0L18.6,387.4L20.4,379.4L21.8,369.8L22.3,362.4L22.3,354.9L21.8,348.5L20.6,341.7ZM-40.2,385.2L-39.9,366.1L-40.6,356.7L-40.2,349.4L-40.4,347.8L-41.5,347.2L-42.5,347.9L-43.9,352.5L-44.6,356.2L-44.9,360.3L-44.7,367.8L-44.0,375.9L-42.5,385.2L-41.7,386.1L-40.8,386.0ZM40.2,385.3L40.7,385.9L41.5,386.1L42.1,385.9L42.5,385.2L44.0,375.8L44.8,365.2L44.8,358.2L44.3,354.3L42.5,347.9L41.5,347.2L40.4,347.8L40.2,349.4L40.6,355.0L39.9,366.1ZM-28.8,410.5L-27.8,396.0L-24.3,360.0L-24.0,354.0L-24.2,347.0L-25.1,341.7L-26.2,339.9L-27.3,339.3L-28.3,339.2L-30.3,339.5L-32.5,340.3L-34.9,342.0L-36.2,343.4L-37.6,346.0L-38.3,348.2L-39.0,352.0L-39.2,355.0L-38.9,362.1L-37.7,372.1L-34.0,392.0L-31.3,408.8L-30.9,410.2L-30.4,410.9L-29.5,411.0ZM28.7,410.4L29.5,411.0L30.4,410.9L30.9,410.2L31.3,408.8L34.0,392.0L37.7,372.0L38.9,362.1L39.2,355.0L39.0,352.0L38.3,348.2L37.6,346.0L36.2,343.4L34.9,342.0L32.5,340.3L30.3,339.5L28.3,339.2L27.3,339.3L26.2,339.9L25.1,341.7L24.2,347.0L24.0,354.0L24.3,360.0L27.8,396.0Z',
    forearms: 'M-66.8,171.5L-70.8,184.4L-72.3,192.9L-72.8,200.2L-72.3,207.9L-70.2,219.6L-68.7,223.6L-68.1,224.4L-67.4,224.7L-66.2,224.0L-65.9,221.8L-65.9,200.2L-65.0,186.0L-64.0,176.0L-64.3,171.0L-65.5,170.5ZM65.8,170.6L64.8,170.6L64.2,171.3L64.0,176.8L65.0,186.0L65.9,200.2L65.9,221.8L66.2,224.0L67.4,224.7L68.1,224.4L68.7,223.6L70.2,219.6L72.3,207.9L72.8,200.1L72.3,192.9L70.5,183.0L67.1,171.9ZM-56.7,174.8L-59.3,174.2L-60.3,174.5L-61.8,176.3L-62.8,179.1L-63.5,184.8L-64.2,194.7L-64.2,221.1L-63.6,225.9L-63.0,227.2L-62.1,227.6L-61.4,227.4L-60.9,226.6L-56.3,189.5L-56.1,184.7L-56.3,175.6ZM56.7,174.8L56.3,175.6L56.1,183.2L56.5,191.1L60.9,226.6L61.4,227.4L62.1,227.6L63.0,227.2L63.6,225.9L64.2,221.0L64.2,194.7L63.4,183.6L62.8,179.0L61.9,176.4L61.1,175.1L60.3,174.5L59.3,174.2Z',
    biceps: 'M-52.0,133.8L-52.1,126.1L-52.5,119.1L-52.9,118.2L-53.8,118.0L-54.5,118.3L-54.9,118.9L-59.3,139.2L-61.4,146.3L-62.3,147.7L-63.1,148.3L-64.4,148.4L-66.1,147.6L-66.8,147.9L-67.1,148.6L-66.9,155.5L-65.8,161.0L-62.9,168.3L-61.6,170.2L-60.5,170.9L-59.1,170.6L-57.6,168.8L-56.4,166.1L-55.3,162.3ZM52.1,135.2L52.5,136.6L55.3,162.4L56.4,166.1L57.6,168.8L59.1,170.6L60.5,170.9L61.6,170.2L62.9,168.3L65.8,161.0L66.9,155.5L67.1,148.6L66.8,147.9L66.1,147.6L64.4,148.4L63.1,148.3L62.3,147.7L61.4,146.3L59.3,139.2L54.9,118.9L54.5,118.3L53.8,118.0L52.9,118.2L52.5,119.1L52.0,128.0Z',
  },
  back: {
    sil: 'M-70.3,232.4L-72.4,236.7L-74.3,243.4L-75.1,251.6L-74.9,259.4L-73.9,264.7L-72.0,270.0L-70.4,272.4L-69.1,273.7L-67.2,274.9L-66.0,275.0L-64.9,274.5L-63.8,273.4L-61.8,270.1L-60.7,266.9L-59.7,261.4L-59.0,254.0L-58.8,246.7L-59.0,240.0L-59.8,232.8L-57.5,218.9L-54.3,191.3L-53.9,186.4L-53.9,170.3L-50.3,136.9L-49.6,135.8L-48.5,135.5L-47.7,136.0L-47.3,136.7L-44.0,162.0L-41.4,176.6L-40.7,184.9L-40.6,191.1L-41.2,197.7L-42.3,203.0L-45.5,215.8L-49.6,230.1L-52.1,243.5L-52.8,249.8L-53.3,259.4L-53.0,278.0L-51.8,291.4L-50.0,304.0L-48.6,310.6L-45.4,322.2L-43.1,335.2L-43.2,341.7L-46.1,352.0L-47.0,358.0L-46.9,367.9L-45.8,378.8L-43.9,389.0L-34.2,419.4L-33.4,422.8L-33.0,426.1L-33.2,429.0L-34.0,432.0L-40.6,448.9L-41.0,451.0L-40.8,452.9L-39.3,455.5L-37.9,457.0L-36.1,458.1L-32.8,459.3L-28.0,460.1L-22.9,460.2L-20.1,459.6L-18.2,458.2L-16.7,454.8L-16.1,449.0L-16.2,441.1L-18.0,430.0L-18.5,428.4L-19.8,426.8L-20.0,425.2L-19.6,420.3L-14.5,390.3L-13.1,378.3L-13.0,369.1L-15.0,342.6L-14.9,336.5L-11.7,319.9L-6.3,274.4L-3.7,255.6L-3.3,254.8L-2.6,254.4L-1.7,254.4L-1.1,254.9L-0.0,254.6L1.1,254.9L2.3,254.3L3.1,254.6L3.6,255.2L4.2,258.6L11.4,317.7L15.0,338.0L15.0,342.6L13.1,366.8L13.1,378.3L14.5,390.3L19.6,420.3L20.0,425.2L19.8,427.0L18.2,429.1L16.4,439.3L16.0,444.5L16.4,453.5L17.1,456.2L18.2,458.2L19.0,459.0L21.3,459.9L24.5,460.3L28.0,460.1L31.3,459.7L35.1,458.6L37.9,457.0L39.4,455.5L40.8,453.0L41.0,451.0L40.2,447.7L33.9,431.9L33.0,427.6L33.1,424.5L34.3,419.4L43.2,391.5L44.5,386.5L45.8,378.8L46.9,367.9L47.0,358.0L46.1,352.0L43.2,341.7L43.1,335.2L45.4,322.2L49.1,308.5L50.4,301.6L52.4,286.0L53.3,270.0L53.1,254.4L51.8,241.5L49.6,230.1L43.1,206.7L41.0,196.0L40.6,188.0L41.2,178.3L44.0,162.0L47.3,136.7L48.0,135.8L49.1,135.5L49.9,135.9L50.3,136.9L53.9,170.3L53.9,186.4L54.3,191.3L57.5,218.9L59.8,232.8L59.0,240.0L58.8,246.7L59.0,254.0L59.7,261.4L60.7,266.9L62.7,271.9L64.9,274.5L66.0,275.0L67.1,274.9L69.8,273.1L71.5,270.9L72.4,269.1L74.2,263.4L75.1,256.6L74.9,248.2L74.0,242.0L72.4,236.7L70.0,231.6L71.0,227.5L74.5,208.1L75.0,202.0L74.8,196.3L73.0,184.0L69.5,172.8L68.9,168.5L70.0,156.0L70.0,144.0L73.6,119.1L74.0,112.0L73.1,105.9L71.3,100.4L68.4,95.7L64.6,91.6L62.3,90.1L60.0,89.0L57.2,88.3L52.1,88.0L48.2,86.2L39.4,83.5L29.2,79.1L25.2,76.9L22.9,75.1L20.0,72.1L17.0,68.0L15.7,64.9L16.0,58.3L15.6,57.6L14.1,56.2L13.8,55.2L17.9,47.4L19.2,43.6L20.7,38.2L21.9,29.0L22.0,22.9L21.6,18.1L20.5,12.2L18.2,7.6L16.6,5.7L14.0,3.3L9.9,1.1L6.2,0.3L0.0,0.0L-6.2,0.3L-9.9,1.1L-13.0,2.6L-15.8,4.8L-18.2,7.7L-20.0,11.0L-21.2,15.1L-21.9,21.3L-22.0,27.5L-21.4,33.7L-20.3,39.6L-18.8,45.0L-16.8,49.8L-13.8,55.2L-14.1,56.2L-15.6,57.6L-16.0,58.3L-16.1,59.9L-15.6,64.0L-16.0,65.9L-19.2,71.2L-21.9,74.1L-24.0,76.0L-27.7,78.4L-32.1,80.5L-39.5,83.6L-48.3,86.2L-52.1,88.0L-58.7,88.6L-62.4,90.1L-65.6,92.5L-68.4,95.7L-70.7,99.2L-72.3,103.0L-73.7,108.9L-74.0,115.4L-70.1,142.7L-70.0,156.0L-68.9,168.5L-69.5,172.8L-72.3,181.0L-73.3,185.6L-74.7,194.5L-75.0,202.0L-74.2,210.3L-71.0,227.5L-70.0,231.3Z',
    traps: 'M-2.0,170.0L-1.4,153.2L-1.1,127.3L-1.4,71.7L-2.0,54.0L-2.5,49.5L-3.2,46.7L-4.3,46.1L-5.0,46.4L-5.7,47.3L-9.3,55.0L-11.6,57.8L-13.4,61.2L-13.5,65.3L-14.6,68.0L-17.4,72.4L-20.4,75.8L-23.9,78.6L-28.2,81.1L-38.6,85.6L-48.7,88.7L-50.3,89.6L-50.7,90.4L-50.5,91.1L-49.7,91.8L-45.0,94.4L-36.1,96.3L-33.2,97.3L-30.0,99.7L-27.6,102.9L-24.0,110.0L-21.9,115.8L-13.8,141.9L-8.2,158.4L-5.0,171.7L-4.5,173.2L-4.1,173.7L-3.1,173.8L-2.4,173.2ZM2.3,173.0L2.8,173.6L3.5,173.8L4.2,173.5L4.6,173.0L8.2,158.4L13.8,141.9L21.9,115.8L24.0,110.0L26.8,104.1L30.0,99.7L33.2,97.3L36.1,96.3L45.0,94.4L49.7,91.8L50.5,91.1L50.7,90.4L50.3,89.6L48.7,88.7L38.6,85.6L28.2,81.1L23.9,78.6L20.4,75.8L17.4,72.4L14.6,68.0L13.5,65.3L13.4,61.2L11.6,57.8L9.3,55.0L5.7,47.3L5.0,46.4L4.3,46.1L3.2,46.7L2.5,49.5L2.0,54.0L1.4,71.7L1.1,98.1L1.2,141.0L1.7,163.1Z',
    rearDelt: 'M-44.6,96.4L-50.5,93.0L-53.2,90.3L-57.0,90.5L-57.9,91.3L-62.0,120.0L-61.6,131.7L-60.8,132.6L-59.9,132.6L-59.3,131.9L-56.3,118.9L-54.6,113.3L-52.6,109.5L-47.4,102.3L-44.7,97.5ZM45.1,95.9L44.6,96.5L44.5,97.2L46.0,100.0L52.6,109.4L54.6,113.3L56.3,118.9L59.3,131.9L59.9,132.6L60.8,132.6L61.6,131.7L62.0,120.0L57.9,91.3L57.0,90.5L53.2,90.3L50.5,93.0Z',
    sideDelt: 'M-62.3,92.6L-65.9,96.1L-68.1,99.1L-69.3,101.3L-71.0,106.3L-71.8,112.2L-71.4,118.8L-69.2,133.6L-65.1,145.3L-64.6,146.1L-63.9,146.5L-62.8,145.9L-61.9,143.1L-62.7,141.1L-63.4,120.0L-59.6,93.2L-59.9,92.4L-60.6,92.0ZM61.3,92.0L60.2,92.1L59.6,93.2L63.4,120.0L62.7,141.1L61.9,143.1L62.8,145.9L63.9,146.5L64.6,146.1L65.1,145.3L69.2,133.6L71.4,118.8L71.8,112.2L71.0,106.3L68.7,100.2L65.0,95.1Z',
    upperBack: 'M-36.7,98.1L-40.5,98.1L-43.6,98.7L-46.2,103.1L-51.8,111.0L-50.3,115.3L-47.7,119.3L-44.4,121.7L-40.0,123.0L-37.9,123.1L-35.1,122.5L-32.1,121.1L-30.3,119.8L-28.0,116.9L-25.5,110.6L-27.4,106.0L-30.2,101.6L-31.9,99.9L-33.8,98.6ZM34.3,98.3L32.7,99.2L31.0,100.7L28.1,104.8L25.5,110.2L26.2,112.8L28.7,118.1L30.3,119.8L33.0,121.7L35.1,122.5L37.9,123.1L40.1,123.0L43.3,122.2L46.2,120.6L48.5,118.4L50.8,114.3L51.6,112.0L51.7,110.7L46.2,103.1L43.5,98.6L39.3,98.0ZM-37.7,124.6L-41.5,124.1L-45.1,123.0L-47.7,123.1L-49.2,123.7L-51.0,125.0L-51.9,126.4L-51.9,127.6L-50.3,130.4L-47.7,132.7L-45.4,133.2L-42.2,132.7L-38.1,131.1L-37.2,130.1L-36.5,128.8L-36.2,126.7L-36.6,125.5ZM37.8,124.5L36.7,125.4L36.3,126.5L36.3,127.9L36.8,129.4L37.5,130.5L38.5,131.4L42.3,132.8L45.4,133.2L47.7,132.7L50.3,130.4L51.9,127.6L51.9,126.4L51.0,125.0L49.2,123.7L47.7,123.1L45.1,123.0L41.4,124.2Z',
    lowerBack: 'M-1.7,178.1L-2.3,177.2L-4.0,177.0L-4.7,176.5L-6.8,170.8L-7.7,170.4L-8.5,170.8L-10.3,174.8L-12.3,183.6L-13.4,192.5L-14.2,203.7L-14.2,211.1L-13.9,219.6L-13.4,225.8L-12.4,230.9L-11.6,232.8L-10.4,234.4L-8.5,235.9L-5.5,237.3L-4.4,239.0L-3.6,239.4L-2.8,239.1L-2.3,238.4L-1.8,230.9L-1.4,203.5ZM1.4,188.3L1.4,211.3L1.8,230.9L2.3,238.4L2.8,239.1L3.6,239.4L4.3,239.1L6.0,237.0L7.8,236.3L9.7,235.0L11.6,232.8L13.0,228.6L13.9,219.6L14.2,211.1L14.2,203.7L13.0,188.8L12.0,182.0L10.6,176.1L9.4,172.3L8.7,170.9L8.1,170.5L7.3,170.5L6.7,171.0L5.6,174.7L4.6,176.6L3.9,177.0L2.3,177.2L1.7,177.9Z',
    lats: 'M-19.9,138.9L-23.1,136.3L-25.8,135.1L-37.5,132.7L-40.9,133.8L-44.6,134.6L-45.3,135.6L-42.1,159.6L-39.5,174.5L-38.7,181.5L-38.4,187.9L-38.5,192.8L-39.9,203.0L-38.1,206.3L-35.0,209.7L-31.4,212.2L-29.0,213.0L-26.9,212.7L-24.5,210.7L-22.1,207.1L-20.0,203.0L-18.2,198.5L-16.6,193.3L-15.0,186.0L-14.1,180.1L-13.3,171.8L-12.9,162.5L-12.9,157.5L-13.3,153.0L-14.0,150.0L-15.7,145.6L-18.0,141.4ZM18.1,141.4L16.4,144.2L14.5,148.5L13.1,154.5L12.8,159.2L13.1,167.9L14.4,182.1L16.6,193.4L18.2,198.5L20.0,203.0L22.1,207.1L24.5,210.7L26.9,212.7L29.0,213.0L31.4,212.2L35.0,209.7L38.1,206.3L39.9,203.0L38.5,192.8L38.4,187.9L38.7,181.5L39.5,174.5L42.1,159.6L45.3,135.5L44.6,134.6L40.8,133.8L37.7,132.6L28.7,134.3L25.8,135.1L23.1,136.3L20.9,138.0Z',
    obliques: 'M-41.4,209.2L-45.9,225.2L-45.8,226.1L-44.9,226.6L-42.0,226.3L-38.3,224.6L-34.5,221.2L-33.1,218.6L-33.1,217.2L-33.9,215.7L-39.8,209.0L-40.7,208.8ZM41.5,209.4L40.7,208.8L39.6,209.1L33.9,215.7L33.1,217.2L33.1,218.6L34.5,221.2L38.3,224.6L42.0,226.3L44.9,226.6L45.8,226.1L45.9,225.2Z',
    glutes: 'M-32.5,214.9L-31.6,218.0L-32.1,220.1L-33.4,222.1L-35.8,224.4L-38.3,226.2L-40.8,227.4L-43.5,228.1L-46.0,227.9L-46.8,228.3L-48.6,236.1L-48.0,237.4L-46.5,238.2L-43.9,238.5L-41.1,238.0L-39.1,237.1L-33.8,233.0L-28.3,226.5L-25.2,221.4L-24.8,220.0L-25.0,218.1L-26.7,216.1L-29.9,214.2L-31.1,213.8L-31.9,214.0ZM32.4,215.4L32.4,214.6L31.7,213.9L29.9,214.2L26.7,216.1L25.1,217.9L24.8,219.2L25.2,221.2L27.3,225.2L32.8,232.0L38.1,236.5L40.1,237.6L42.8,238.4L45.7,238.4L47.5,237.7L48.4,237.0L48.6,236.1L46.8,228.4L46.1,227.9L43.5,228.1L40.7,227.4L38.2,226.2L35.0,223.7L32.8,221.2L31.8,219.2L31.7,217.0ZM-3.1,241.9L-4.6,241.2L-6.6,238.3L-9.2,237.1L-11.5,235.3L-13.3,232.5L-14.6,227.7L-15.1,227.2L-16.0,227.0L-18.9,227.1L-22.0,227.6L-29.2,230.2L-32.8,234.0L-36.2,236.9L-39.4,238.9L-42.9,240.0L-45.5,243.7L-47.5,248.0L-48.7,252.5L-49.2,255.6L-49.1,260.6L-48.4,265.7L-47.0,270.0L-45.0,273.5L-42.4,276.3L-39.3,278.4L-36.6,279.5L-32.1,280.6L-25.3,281.1L-16.8,280.8L-13.2,280.4L-9.5,279.4L-9.0,278.6L-5.8,254.8L-4.7,253.1L-2.3,252.0L-1.7,251.2L-1.5,242.9L-2.0,242.1ZM3.5,241.9L1.8,242.2L1.5,242.9L1.7,251.2L2.3,252.0L4.7,253.1L5.8,254.8L9.0,278.6L9.5,279.4L13.2,280.4L16.8,280.8L25.3,281.1L32.1,280.6L36.6,279.5L39.3,278.4L42.4,276.3L45.0,273.5L47.0,270.0L48.4,265.7L49.1,260.6L49.2,255.6L48.7,252.5L47.5,248.0L45.5,243.7L42.9,240.0L39.4,238.9L36.2,236.9L32.8,234.0L29.2,230.2L22.0,227.6L18.9,227.1L16.0,227.0L15.1,227.2L14.6,227.7L13.3,232.5L11.5,235.3L9.2,237.1L6.5,238.4L4.4,241.4Z',
    adductors: '',
    hamstrings: 'M-31.7,282.3L-38.3,280.4L-39.7,280.5L-42.0,281.0L-43.9,282.2L-46.3,284.9L-47.7,287.4L-48.7,290.4L-49.2,293.8L-47.4,305.8L-43.3,321.6L-41.4,331.2L-37.9,337.5L-36.6,338.9L-35.7,339.2L-34.5,338.4L-33.6,336.3L-32.4,331.5L-31.0,324.0L-29.5,310.8L-28.7,293.8L-28.8,288.2L-29.5,285.1L-30.1,283.9ZM32.1,282.1L29.9,284.1L28.8,288.2L28.7,293.8L29.3,308.5L30.4,320.0L32.4,331.6L34.1,337.6L34.9,338.9L35.9,339.2L37.2,338.4L38.5,336.7L41.4,331.2L43.3,321.6L47.4,305.8L49.2,293.7L48.7,290.3L47.1,286.2L45.6,283.8L43.0,281.5L41.0,280.7L38.4,280.4ZM-12.2,296.0L-12.1,285.2L-13.1,282.9L-14.6,282.0L-22.1,282.4L-25.0,284.0L-26.3,285.9L-27.3,289.7L-27.7,304.1L-28.4,314.0L-28.2,318.0L-27.2,325.7L-25.0,333.8L-24.0,335.9L-22.9,337.5L-21.6,338.6L-20.5,339.0L-19.6,339.0L-18.5,338.5L-17.1,336.6L-14.8,325.3L-12.4,307.6L-11.9,296.8ZM11.9,296.5L12.4,307.7L14.8,325.3L17.1,336.6L18.5,338.5L19.6,339.0L20.5,339.0L21.6,338.6L22.9,337.5L24.0,335.9L25.0,333.8L27.2,325.7L28.2,318.0L28.4,314.0L27.7,304.1L27.3,289.7L26.3,285.9L25.0,284.0L22.1,282.4L14.6,282.0L13.1,282.9L12.1,285.0L12.3,295.3Z',
    calves: 'M-32.3,338.3L-34.2,340.1L-35.4,340.6L-36.6,340.5L-38.8,339.0L-39.5,339.1L-40.7,340.0L-41.4,344.0L-43.9,352.5L-44.8,358.1L-44.6,368.2L-42.8,375.3L-41.2,379.4L-39.6,382.3L-38.3,383.5L-36.6,384.1L-34.5,383.4L-33.0,381.1L-32.3,378.2L-31.6,372.2L-30.1,343.9L-30.5,340.3L-31.1,339.0L-31.6,338.4ZM32.9,338.6L31.8,338.4L31.0,339.1L30.5,340.3L30.1,343.9L31.6,372.3L32.3,378.2L33.0,381.1L34.5,383.4L36.6,384.1L38.3,383.5L39.6,382.3L41.2,379.4L42.8,375.3L44.6,368.2L44.8,358.1L43.9,352.5L41.4,344.0L40.7,340.0L39.5,339.1L38.8,339.0L36.6,340.5L35.2,340.6L34.1,340.0ZM-19.5,340.4L-21.6,340.1L-24.5,338.1L-26.1,338.4L-26.9,339.0L-27.6,339.9L-28.4,341.9L-28.9,347.9L-29.0,356.5L-28.8,364.2L-28.2,370.1L-27.1,378.0L-25.4,385.7L-24.0,390.0L-22.5,392.6L-21.5,393.5L-20.5,393.8L-19.5,393.5L-18.6,392.4L-16.7,387.5L-15.8,382.8L-15.1,373.7L-15.4,364.6L-17.3,341.2L-18.1,340.2ZM18.4,340.2L17.6,340.6L17.2,341.3L15.3,366.9L15.2,375.9L15.9,384.0L17.2,388.9L18.9,392.9L19.6,393.5L20.5,393.8L21.5,393.5L22.5,392.6L24.0,390.0L25.4,385.7L27.1,377.9L28.2,370.1L28.9,362.3L28.8,346.3L28.0,340.7L27.1,339.1L26.3,338.5L24.5,338.1L21.4,340.2L19.7,340.4ZM-18.6,395.2L-21.5,395.1L-22.9,394.1L-25.5,390.7L-30.1,388.6L-37.0,386.0L-40.5,383.8L-41.3,383.8L-41.9,384.3L-42.1,385.8L-41.8,388.5L-35.4,408.8L-33.4,411.7L-31.2,413.4L-28.3,414.1L-25.6,413.5L-22.5,411.3L-20.5,408.8L-19.3,406.3L-17.8,397.0L-18.0,396.0ZM19.1,395.0L18.2,395.6L17.8,397.0L19.3,406.3L20.5,408.8L22.5,411.3L25.6,413.5L28.3,414.1L30.6,413.7L33.3,411.8L35.4,408.8L41.8,388.5L42.0,384.4L41.3,383.8L40.5,383.8L37.0,386.0L28.0,389.5L25.2,390.9L23.7,393.4L22.3,394.7L20.6,395.2Z',
    triceps: 'M-48.9,120.3L-51.9,115.3L-52.8,114.9L-53.6,115.3L-55.3,120.6L-59.9,141.4L-58.5,160.3L-57.8,164.2L-56.8,165.0L-55.9,164.8L-55.4,164.0L-52.5,137.2L-53.3,135.5L-53.4,134.2L-52.1,130.6L-53.3,127.9L-53.3,126.3L-52.0,124.0L-49.2,122.0ZM48.9,121.6L49.3,122.2L52.0,124.0L53.3,126.3L53.3,127.9L52.1,130.6L53.4,134.2L53.3,135.5L52.5,137.2L55.4,164.0L55.9,164.8L56.8,165.0L57.8,164.2L58.5,160.3L59.9,141.5L55.3,120.6L54.2,116.4L53.5,115.2L52.6,115.0L51.8,115.4L49.0,120.0ZM-60.5,154.4L-61.0,148.9L-61.3,148.3L-62.1,147.9L-64.2,148.4L-66.1,147.1L-67.3,147.3L-67.7,148.2L-67.8,156.5L-66.3,160.2L-64.7,162.2L-63.2,162.1L-61.9,160.7L-61.0,158.0ZM60.5,154.4L61.3,159.2L62.4,161.4L63.7,162.3L65.0,162.0L66.3,160.1L67.8,156.5L67.7,148.0L67.1,147.2L66.0,147.1L64.3,148.4L63.4,148.4L62.1,147.9L61.1,148.5Z',
    forearms: 'M-65.3,172.0L-67.7,174.3L-70.5,183.0L-72.3,192.9L-72.8,200.1L-71.8,209.6L-70.3,218.1L-69.0,223.0L-68.3,224.4L-67.4,224.8L-66.8,224.6L-66.3,224.1L-65.9,221.9L-66.0,204.0L-64.1,187.6L-63.5,176.0L-63.6,173.4L-64.1,172.2ZM65.3,172.0L64.3,172.1L63.7,172.8L63.5,177.5L64.1,187.6L66.0,204.0L65.9,221.9L66.3,224.1L66.8,224.6L67.4,224.8L68.3,224.4L69.0,222.9L70.6,216.5L72.4,204.8L72.8,198.3L72.0,191.1L70.1,181.6L67.6,174.2ZM-56.4,175.0L-56.8,174.4L-58.0,173.7L-59.3,173.4L-60.3,173.5L-61.4,174.6L-62.1,177.0L-63.1,191.5L-63.2,219.2L-62.9,224.4L-62.6,225.0L-61.9,225.3L-61.0,225.1L-60.6,224.3L-56.6,192.8L-56.1,186.3ZM56.3,176.9L56.1,186.3L56.6,192.8L60.6,224.3L61.0,225.1L61.9,225.3L62.6,225.0L62.9,224.4L63.2,219.2L63.1,191.5L62.1,177.0L61.0,174.1L60.4,173.6L59.5,173.4L58.0,173.7L56.6,174.6Z',
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

// ----- body weight -----
const weightPoints = () => S.bw.map(b => ({
  x: dayMs(b.date), y: b.kg,
  tip: `<b>${esc(prettyDate(b.date, { day: 'numeric', month: 'short', year: 'numeric' }))}</b><br>${fmt(b.kg)} kg`,
}));

// latest weight compared to ~30 days earlier, or to the first entry if there's no older one
function weightChange() {
  if (S.bw.length < 2) return '';
  const last = S.bw[S.bw.length - 1];
  const ref = [...S.bw].reverse().find(b => daysBetween(b.date, last.date) >= 30) || S.bw[0];
  const d = last.kg - ref.kg, days = daysBetween(ref.date, last.date);
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d).toFixed(1))} kg in ${days} day${days === 1 ? '' : 's'}`;
}

function weightCard() {
  const last = S.bw[S.bw.length - 1];
  return `<div class="row between" style="margin-top:26px"><h2 style="margin:0">body weight</h2><button class="btn small" data-act="openWeight">all entries</button></div>
  <div class="card" style="margin-top:10px">
    ${last ? `<div class="row between mono" style="font-size:.85rem;margin-bottom:8px">
      <span><b>${fmt(last.kg)} kg</b> <span class="muted">· ${esc(prettyDate(last.date, { day: 'numeric', month: 'short' }))}</span></span>
      <span class="muted">${weightChange()}</span></div>
      ${S.bw.length > 1 ? lineChart(weightPoints(), null, 'kg') : ''}` : '<p class="meta" style="margin:0 0 10px">no weight logged yet</p>'}
    <div class="row" style="margin-top:10px">
      <input type="text" inputmode="decimal" id="wQuick" placeholder="${last ? fmt(last.kg) : 'kg'}" aria-label="today's weight in kg">
      <button class="btn" data-act="saveWeight" data-in="wQuick">add today</button>
    </div>
  </div>`;
}

function viewWeight() {
  const rows = [...S.bw].reverse();
  const last = S.bw[S.bw.length - 1];
  return `
    <button class="btn ghost small" data-act="back">← back</button>
    <h1>body weight</h1>
    <div class="card">
      <label class="field" for="wDate">date</label>
      <input type="date" id="wDate" value="${today()}" max="${today()}" style="width:auto;margin-bottom:12px">
      <label class="field" for="wKg">weight (kg)</label>
      <div class="row">
        <input type="text" inputmode="decimal" id="wKg" placeholder="${last ? fmt(last.kg) : 'kg'}">
        <button class="btn primary" data-act="saveWeight" data-in="wKg" data-date="wDate">save</button>
      </div>
      <p class="meta" style="margin:8px 0 0">saving a date again replaces it</p>
    </div>
    <h2>evolution</h2>
    <div class="card">
      ${S.bw.length > 1 ? `<p class="meta" style="margin:0 0 6px">${weightChange()}</p>${lineChart(weightPoints(), null, 'kg')}` : '<p class="meta">log at least two weights to see the graph</p>'}
    </div>
    <h2>history</h2>
    <div class="card">
      ${rows.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>date</th><th class="num">kg</th><th class="num">change</th><th></th></tr></thead>
        <tbody>${rows.map((b, k) => {
          const prev = rows[k + 1], d = prev ? b.kg - prev.kg : null;
          return `<tr class="click" data-act="editWeight" data-d="${b.date}">
            <td>${esc(b.date)}</td><td class="num">${fmt(b.kg)}</td>
            <td class="num muted">${d == null ? '' : (d > 0 ? '+' : d < 0 ? '−' : '±') + fmt(Math.abs(d).toFixed(1))}</td>
            <td><button class="btn danger small" data-act="delWeight" data-d="${b.date}" aria-label="delete ${b.date}">✕</button></td></tr>`;
        }).join('')}</tbody>
      </table></div><p class="meta" style="margin:10px 0 0">tap a row to edit it</p>` : '<p class="meta">no weight logged yet</p>'}
    </div>`;
}

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
    ${weightCard()}
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
  startDay: el => run(async () => {
    const p = S.programs[+el.dataset.p], d = p.days[+el.dataset.d];
    let w = active();
    if (w && !confirm(`Add the exercises of ${d.name} to the workout in progress?`)) return;
    if (!w) {
      // the log tab's date field, when started from there
      w = (await api('workout_start', { date: $('#startDate')?.value || today(), plan: planName(p, d) })).workout;
      replaceWorkout(w);
      w = active();
      S.restAt = null;
    }
    if (!S.cards || S.cardsFor !== w.id) { S.cards = buildCards(w); S.cardsFor = w.id; }
    for (const it of d.items) if (!S.cards.some(c => c.ex === it.exercise)) S.cards.push(newCard(it.exercise, it.sets));
    saveDraft();
    S.tab = 'log';
    S.view = null;
    history.replaceState({ view: null, tab: S.tab }, '');
    render();
    window.scrollTo(0, 0);
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
  openWeight: () => go({ type: 'weight' }),
  saveWeight: el => run(async () => {
    const kg = parseNum($('#' + el.dataset.in).value);
    if (!(kg > 0)) throw new Error('Enter your weight in kg');
    const date = (el.dataset.date && $('#' + el.dataset.date).value) || today();
    const res = await api('weight_save', { date, kg });
    S.bw = res.bodyweight.map(b => ({ date: b.date, kg: +b.kg }));
    toast('weight saved');
    render();
  }),
  editWeight: el => {
    $('#wDate').value = el.dataset.d;
    $('#wKg').value = fmt(S.bw.find(b => b.date === el.dataset.d).kg);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  delWeight: el => run(async () => {
    if (!confirm(`Delete the weight of ${el.dataset.d}?`)) return;
    const res = await api('weight_delete', { date: el.dataset.d });
    S.bw = res.bodyweight.map(b => ({ date: b.date, kg: +b.kg }));
    render();
  }),
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
  // Enter in a weight field saves it
  if (e.key === 'Enter' && (e.target.id === 'wQuick' || e.target.id === 'wKg')) {
    e.preventDefault();
    return $(`[data-in="${e.target.id}"]`).click();
  }
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
