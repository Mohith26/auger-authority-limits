import * as A from './core/authority.js';

const $ = (s) => document.querySelector(s);
const state = { data: null, res: null, sel: {}, decided: {}, open: {}, drill: {}, valToken: 0 };

const COLS = {
  transfer: ['INV-ID', 'Source facility', 'Destination facility', 'Units'],
  workorder: ['Work order', 'From facility', 'To facility', 'Units'],
  allocate: ['INV-ID', 'From facility', 'Channel', 'Units'],
  po: ['PO', 'Supplier', 'Facility', 'Change'],
  expedite: ['Shipment', 'From carrier', 'To carrier', 'Lane'],
};

// ---------- formatting ----------
const money = (v) => v >= 1e6 ? `$${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M` : `$${Math.round(v / 1000)}K`;
const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');
const pct = (v, d = 1) => v == null ? '—' : `${(v * 100).toFixed(d)}%`;
const num = (v) => Math.round(v).toLocaleString('en-US');
const dayDate = (d) => new Date(A.START + d * A.DAY_MS).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const band = (b) => `${money(b.lo)}–${money(b.hi)}`;
const icon = (n) => `<i data-lucide="${n}"></i>`;

function params() {
  return { alpha: +$('#alpha').value, delta: +$('#delta').value, tau: +$('#tau').value, rejections: $('#rej').value };
}
const confLabel = (p) => `${Math.round((1 - p.delta) * 100)}%`;

// ---------- load ----------
async function init() {
  const r = await fetch('data/decisions.json');
  state.data = await r.json();
  ['#alpha', '#delta', '#tau', '#rej'].forEach(s => $(s).addEventListener('change', () => { state.sel = {}; state.decided = {}; state.drill = {}; run(); }));
  const vb = $('#viewBtn'), vm = $('#viewMenu');
  vb.addEventListener('click', (e) => { e.stopPropagation(); vm.classList.toggle('open'); vb.setAttribute('aria-expanded', vm.classList.contains('open')); });
  vm.addEventListener('click', (e) => { const t = e.target.closest('span'); if (t && t.classList.contains('muted')) toast(`${t.textContent.trim()} is part of the real Loop app; this demo adds Authority`); vm.classList.remove('open'); });
  document.addEventListener('click', () => vm.classList.remove('open'));
  // deep links: #drill=<typeIndex>:<bucket>&alpha=0.05&delta=0.05&tau=0.25&rej=worst
  const h = new URLSearchParams(location.hash.slice(1));
  ['alpha', 'delta', 'tau', 'rej'].forEach(k => { if (h.get(k)) $('#' + k).value = h.get(k); });
  if (h.get('drill')) { const [ti, k] = h.get('drill').split(':').map(Number); state.drill[ti] = k; }
  run();

}

function run() {
  const p = params();
  state.p = p;
  state.res = A.analyze(state.data, p);
  state.res.forEach(r => { if (state.sel[r.ti] == null) state.sel[r.ti] = r.action === 'widen' ? r.cert.limit : r.type.L0; });
  // default: first two cards open, the rest open too but drill closed
  state.res.forEach((r, k) => { if (state.open[r.ti] == null) state.open[r.ti] = true; });
  render();
  runValidation(p);
}

// ---------- order and summary ----------
function ordered() {
  const rank = { widen: 0, rollback: 1, keep: 2 };
  return [...state.res].sort((a, b) => rank[a.action] - rank[b.action] || a.ti - b.ti);
}
function keepKind(r) { return r.stopBk && r.stopBk.rate != null && r.stopBk.rate > state.p.alpha ? 'risk' : 'evidence'; }

function summary() {
  const p = state.p, res = state.res;
  const widen = res.filter(r => r.action === 'widen');
  const removed = widen.reduce((s, r) => s + A.weeklyVolume(r.recs, r.type, r.type.L0, state.sel[r.ti], A.END_DAY), 0);
  const manual = res.reduce((s, r) => s + r.perWeekCurrentManual, 0);
  let maxUp = null;
  widen.forEach(r => r.cert.buckets.forEach(b => { if (b.certified && b.hi <= state.sel[r.ti]) maxUp = Math.max(maxUp ?? 0, b.upper); }));
  const win = { auto: 0, approved: 0, rejected: 0 };
  res.forEach(r => r.recs.forEach(x => { if (x.day < A.CERT_END_DAY) { if (x.status === 0) win.auto++; else if (x.status === 1) win.approved++; else win.rejected++; } }));
  return { widen, removed, manual, maxUp, win, rollback: res.filter(r => r.action === 'rollback'), keepRisk: res.filter(r => r.action === 'keep' && keepKind(r) === 'risk'), keepEv: res.filter(r => r.action === 'keep' && keepKind(r) === 'evidence') };
}

// ---------- render ----------
function render() {
  const p = state.p, s = summary();
  renderImpact(s);
  renderNotifs(s);
  const changes = s.widen.length + s.rollback.length + s.keepRisk.length + s.keepEv.length;
  $('#actionsTitle').textContent = `You have ${changes} limit reviews for Tuesday, Nov 10`;
  const exec = s.win.auto + s.win.approved;
  $('#banner').innerHTML = `<svg class="bl" viewBox="0 0 40 40" width="26" height="26"><circle cx="20" cy="20" r="20" fill="#000"/><path d="M20 8.2c5.6 0 7.4 5.6 0 11.8s-5.6 11.8 0 11.8 7.4-5.6 0-11.8-5.6-11.8 0-11.8z" fill="none" stroke="#fff" stroke-width="3.3" stroke-linejoin="round"/></svg>
    <span>From Jun 1 to Sep 30, <b>${num(exec)}</b> Actions were executed with expected vs actual recorded (<b>${num(s.win.auto)}</b> auto-executed, <b>${num(s.win.approved)}</b> approved) and <b>${num(s.win.rejected)}</b> were rejected. <b>${s.widen.length}</b> limits are ready to widen${s.rollback.length ? `, <b>${s.rollback.length}</b> is held for drift` : ''}, and <b>${s.keepRisk.length + s.keepEv.length}</b> stay where they are.</span>`;
  $('#cardList').innerHTML = ordered().map((r, k) => cardHTML(r, k + 1)).join('');
  bindCards();
  lucide.createIcons();
}

function renderImpact(s) {
  const p = state.p;
  const share = s.manual ? s.removed / s.manual : 0;
  const tiles = [
    { lab: 'Approvals removed', val: `${num(s.removed)}/wk`, cap: 'Actions that would skip manual approval' },
    { lab: 'Manual queue', val: `−${(share * 100).toFixed(0)}%`, cap: `of ${num(s.manual)} approvals per week` },
    { lab: 'Worst certified bound', val: s.maxUp == null ? '—' : pct(s.maxUp), cap: `${confLabel(p)} upper bound, any delegated bucket` },
    { lab: 'Target miss rate', val: pct(p.alpha, 0), cap: `Miss = actual below ${Math.round((1 - p.tau) * 100)}% of expected` },
  ];
  const kpis = ordered().map(r => kpiHTML(r)).join('');
  $('#impact').innerHTML = `
    <div>
      <p class="blk-title">Impact of limit changes</p>
      <p class="blk-sub">${s.widen.length} limits can widen at ${confLabel(p)} confidence; every newly delegated size bucket stays under ${pct(p.alpha, 0)} misses</p>
      <div class="tiles">${tiles.map(t => `<div class="tile"><div class="lab">${t.lab}</div><div class="val">${t.val}</div><div class="cap">${t.cap}</div></div>`).join('')}</div>
    </div>
    <div class="vsep"></div>
    <div class="kpis-wrap">
      <p class="blk-title">Decision types</p>
      <p class="blk-sub gray">Upper bound on miss rate by size bucket, Jun 1 – Sep 30</p>
      <div class="kpis" id="kpis">${kpis}</div>
      <button class="kpi-next" type="button" id="kpiNext" title="More">${icon('chevron-right')}</button>
    </div>`;
  $('#kpiNext').onclick = () => { const k = $('#kpis'); k.scrollBy({ left: 182, behavior: 'smooth' }); };
  document.querySelectorAll('.kpi').forEach(el => el.onclick = () => document.getElementById('card-' + el.dataset.ti)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function kpiHTML(r) {
  const p = state.p, L0 = r.type.L0;
  const sub = r.action === 'widen' ? `Auto limit ${money(L0)} → ${money(state.sel[r.ti])}` : r.action === 'rollback' ? `Hold at ${money(L0)} · drift` : `Keep ${money(L0)}`;
  const execd = r.recs.filter(x => x.day < A.CERT_END_DAY && x.status !== 2);
  const miss = execd.filter(x => x.ratio < 1 - p.tau).length / Math.max(1, execd.length);
  const change = state.sel[r.ti] / L0 - 1;
  const delta = r.action === 'widen' ? `<small>+${(change * 100).toFixed(0)}% limit</small>` : r.action === 'rollback' ? `<small class="red">rollback</small>` : `<small class="red">no change</small>`;
  // mini bars: upper bound per bucket, olive if certified, orange if not
  const bk = r.cert.buckets, W = 150, H = 40, bw = 12, gap = (W - bk.length * bw) / (bk.length - 1);
  const top = Math.max(p.alpha * 2.2, 0.12);
  const bars = bk.map((b, i) => {
    const h = Math.max(3, Math.min(1, b.upper / top) * (H - 4));
    const c = b.certified && b.hi <= state.sel[r.ti] ? 'var(--olive)' : 'var(--orange)';
    return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="1" fill="${c}"/>`;
  }).join('');
  const ay = H - Math.min(1, p.alpha / top) * (H - 4);
  let chart = `${bars}<line x1="0" x2="${W}" y1="${ay}" y2="${ay}" stroke="#fff700" stroke-width="1" stroke-dasharray="3 3" opacity=".8"/>`;
  if (r.action === 'rollback') {
    const d = r.mon.daily, lo = Math.log10(0.2), hi = Math.log10(Math.max(r.mon.threshold * 2, r.mon.maxE));
    const yy = (v) => H - 3 - (Math.log10(Math.max(0.2, v)) - lo) / (hi - lo) * (H - 8);
    const path = d.map((q, i) => `${i ? 'L' : 'M'}${(i / (d.length - 1) * W).toFixed(1)},${yy(q.e).toFixed(1)}`).join('');
    chart = `<defs><linearGradient id="kg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#c75a85" stop-opacity=".35"/><stop offset="1" stop-color="#c75a85" stop-opacity="0"/></linearGradient></defs><path d="${path}L${W},${H}L0,${H}Z" fill="url(#kg)"/><path d="${path}" fill="none" stroke="#c75a85" stroke-width="1.6"/><line x1="0" x2="${W}" y1="${yy(r.mon.threshold)}" y2="${yy(r.mon.threshold)}" stroke="#fff700" stroke-width="1" stroke-dasharray="3 3" opacity=".8"/>`;
  }
  return `<div class="kpi" data-ti="${r.ti}"><div class="t">${r.type.label}</div><div class="s">${sub}</div>
    <div class="v">${pct(miss)}${delta}</div>
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${chart}</svg></div>`;
}

function renderNotifs(s) {
  const items = [];
  if (s.widen.length) items.push(['circle-check', `Ready to widen (${s.widen.length})`]);
  if (s.rollback.length) items.push(['triangle-alert', `Drift detected (${s.rollback.length})`]);
  if (s.keepRisk.length) items.push(['triangle-alert', `Riskier than target (${s.keepRisk.length})`]);
  if (s.keepEv.length) items.push(['triangle-alert', `More evidence needed (${s.keepEv.length})`]);
  items.push(['triangle-alert', `Rejected actions counted as misses (${s.win.rejected})`]);
  if (state.p.rejections !== 'worst') items[items.length - 1] = ['triangle-alert', `Rejections excluded: not certified (${s.win.rejected})`];
  $('#notifs').innerHTML = items.map(([ic, t]) => `<div class="notif">${icon(ic)}<span>${t}</span></div>`).join('');
}

// ---------- cards ----------
function cardHTML(r, idx) {
  const p = state.p, L0 = r.type.L0, ti = r.ti, sel = state.sel[ti];
  const dec = state.decided[ti];
  let title, tag, why;
  const top = r.cert.buckets.filter(b => b.certified).slice(-1)[0];
  const certN = r.cert.buckets.filter(b => b.certified).reduce((s, b) => s + b.n, 0);
  const certX = r.cert.buckets.filter(b => b.certified).reduce((s, b) => s + b.x, 0);
  const stop = r.stopBk;
  const holdout = r.mon ? `Holdout Oct 1 – Nov 10: <b>${num(r.mon.n)}</b> actions in the new band, <b>${r.mon.x}</b> misses, peak e-value <b>${r.mon.maxE.toFixed(1)}</b> (rollback at ${r.mon.threshold.toFixed(0)}).` : '';
  if (r.action === 'widen') {
    title = `${idx}. Raise auto-execute limit for ${r.type.label} from ${money(L0)} to ${money(sel)}`;
    tag = `<span class="tag widen">Certified</span>`;
    why = `Every bucket from ${money(L0)} to ${money(r.cert.limit)} has a ${confLabel(p)} upper bound under ${pct(p.alpha, 0)} misses (<b>${num(certN)}</b> actions, <b>${certX}</b> misses${p.rejections === 'worst' ? ' counting rejections' : ''}). ${stop ? `The ${band(stop)} bucket stops the sequence at ${pct(stop.rate)} observed, bound ${pct(stop.upper)}${r.need != null ? `; it needs <b>${num(r.need)}</b> more clean actions` : ''}. ` : ''}A point-estimate rule would go to <b>${money(r.naive)}</b>. ${holdout}`;
  } else if (r.action === 'rollback') {
    const a = r.mon.alarm;
    const certRate = r.cert.buckets.filter(b => b.certified).reduce((s, b) => s + b.x, 0) / Math.max(1, r.cert.buckets.filter(b => b.certified).reduce((s, b) => s + b.n, 0));
    title = `${idx}. Hold ${r.type.label} at ${money(L0)}: drift detected ${dayDate(a.day)}`;
    tag = `<span class="tag hold">Rollback trigger</span>`;
    why = `Jun – Sep certified up to <b>${money(r.cert.limit)}</b> at <b>${pct(certRate)}</b> misses. In the holdout, <b>${a.x}</b> of the first <b>${a.n}</b> actions in that band missed (<b>${pct(a.x / a.n)}</b>), and the e-process crossed ${r.mon.threshold.toFixed(0)} on <b>${dayDate(a.day)}</b>, so the widening is held. Had ${money(r.cert.limit)} been live, authority would have reverted to ${money(L0)} that day, with no fixed review date needed.`;
  } else if (keepKind(r) === 'risk') {
    title = `${idx}. Keep ${r.type.label} at ${money(L0)}`;
    tag = `<span class="tag keep">Riskier than target</span>`;
    why = `The first bucket above the limit (${band(stop)}) already misses <b>${pct(stop.rate)}</b> with a ${confLabel(p)} bound of <b>${pct(stop.upper)}</b>, above the ${pct(p.alpha, 0)} target. A point-estimate rule would have widened to <b>${money(r.naive)}</b>; excluding rejections would allow <b>${money(r.optimistic)}</b>.`;
  } else {
    const wk = A.weeklyVolume(r.recs, r.type, stop.lo, stop.hi, A.END_DAY);
    title = `${idx}. Keep ${r.type.label} at ${money(L0)} until more evidence lands`;
    tag = `<span class="tag keep">More evidence needed</span>`;
    why = `Misses are rare (<b>${stop.x}</b> in <b>${stop.n}</b> actions in ${band(stop)}), but that is too few to rule out a rate above ${pct(p.alpha, 0)}: the bound is <b>${pct(stop.upper)}</b>. <b>${num(r.need)}</b> more clean actions would certify it, about <b>${Math.max(1, Math.ceil(r.need / Math.max(wk, 0.1)))} weeks</b> at ${wk.toFixed(1)} per week. A point-estimate rule would go to <b>${money(r.naive)}</b> on this evidence.`;
  }
  let btns;
  if (dec === 'approved') btns = `<button class="btn done" type="button">${r.action === 'widen' ? `Approved · ${money(sel)} from Nov 11` : 'Approved'}</button>`;
  else if (dec === 'rejected') btns = `<button class="btn declined" type="button">Rejected</button>`;
  else btns = `<button class="btn ghost" type="button" data-act="reject" data-ti="${ti}">Reject</button><button class="btn yellow" type="button" data-act="approve" data-ti="${ti}">${r.action === 'widen' ? 'Approve limit' : 'Acknowledge'}</button>`;
  const open = state.open[ti];
  return `<article class="card ${open ? '' : 'collapsed'}" id="card-${ti}">
    <div class="card-h"><h3>${title}${tag}</h3><div class="btns">${btns}<button class="chev" type="button" data-tog="${ti}" title="${open ? 'Collapse' : 'Expand'}">${icon(open ? 'chevron-up' : 'chevron-down')}</button></div></div>
    <p class="card-why">${why}</p>
    <div class="card-body">${tableHTML(r)}${r.action === 'rollback' ? eChartHTML(r) : bucketChartHTML(r)}</div>
    ${footHTML(r)}
    ${drillHTML(r)}
  </article>`;
}

function tableHTML(r) {
  const p = state.p, ti = r.ti, sel = state.sel[ti];
  const rows = r.cert.buckets.map((b, k) => {
    const on = b.certified && b.hi <= sel;
    const cb = b.certified ? `<span class="cb ${on ? 'on' : 'off'}" data-cb="${ti}" data-k="${k}"></span>` : `<span class="cb off" style="opacity:.35"></span>`;
    let res;
    if (b.certified) res = `<span class="res ok">Certified</span>`;
    else if (k === r.cert.stopIdx) res = b.rate != null && b.rate > p.alpha ? `<span class="res no">Over target</span>` : `<span class="res no">Stop · +${num(A.evidenceNeeded(b, p.alpha, p.delta) ?? 0)} needed</span>`;
    else res = `<span class="res na">Not tested</span>`;
    const isSel = state.drill[ti] === k ? ' sel' : '';
    return `<tr class="row${isSel}" data-row="${ti}" data-k="${k}"><td class="sans">${cb}</td><td>${band(b)}</td><td class="r">${num(b.n)}</td><td class="r">${b.misses}</td><td class="r">${b.rejected}</td><td class="r">${b.n ? pct(b.rate) : '—'}</td><td class="r">${b.n ? pct(b.upper) : '—'}</td><td class="r">${b.n ? b.pValue.toFixed(3) : '—'}</td><td>${res}</td></tr>`;
  }).join('');
  const tot = r.cert.buckets.reduce((a, b) => ({ n: a.n + b.n, m: a.m + b.misses, j: a.j + b.rejected }), { n: 0, m: 0, j: 0 });
  return `<div><table class="t"><thead><tr><th style="width:22px"><span class="cb on"></span></th><th>Size band (expected impact)</th><th class="r">Actions</th><th class="r">Misses</th><th class="r">Rejected</th><th class="r">Observed</th><th class="r">Upper bound (${confLabel(p)})</th><th class="r">p-value</th><th>Result</th></tr></thead>
    <tbody>${rows}<tr class="tot"><td></td><td></td><td class="r">${num(tot.n)}</td><td class="r">${tot.m}</td><td class="r">${tot.j}</td><td></td><td></td><td></td><td></td></tr></tbody></table></div>`;
}

function bucketChartHTML(r) {
  const p = state.p, bk = r.cert.buckets, sel = state.sel[r.ti];
  const W = 396, H = 168, L = 34, R = 8, T = 14, B = 30;
  const iw = W - L - R, ih = H - T - B, n = bk.length, slot = iw / n, bw = Math.min(26, slot * 0.55);
  const ymax = Math.max(p.alpha * 2.4, Math.min(p.alpha * 3.6, Math.max(...bk.filter(b => b.n).map(b => b.upper)) * 1.05));
  const y = (v) => T + ih - Math.min(1, v / ymax) * ih;
  const ticks = [0, ymax / 3, (2 * ymax) / 3, ymax];
  let g = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#2a2a2a" stroke-dasharray="2 3"/><text x="${L - 6}" y="${y(t) + 3}" fill="#8a8a8a" font-size="9" text-anchor="end">${(t * 100).toFixed(0)}%</text>`).join('');
  bk.forEach((b, i) => {
    const cx = L + slot * i + slot / 2;
    if (b.n) {
      const on = b.certified && b.hi <= sel;
      g += `<rect x="${cx - bw / 2}" y="${y(b.upper)}" width="${bw}" height="${T + ih - y(b.upper)}" rx="1.5" fill="${on ? 'var(--olive)' : 'var(--orange)'}" opacity="${b.certified || i === r.cert.stopIdx ? 1 : 0.55}"><title>${band(b)}: bound ${pct(b.upper)}, observed ${pct(b.rate)} (${b.x}/${b.n})</title></rect>`;
      if (b.upper > ymax) g += `<text x="${cx}" y="${y(b.upper) + 10}" fill="#fff" font-size="8.5" text-anchor="middle">${(b.upper * 100).toFixed(0)}%</text>`;
      if (b.rate <= ymax) g += `<circle cx="${cx}" cy="${y(b.rate)}" r="2.6" fill="#fff"/>`;
    }
    g += `<text x="${cx}" y="${H - B + 13}" fill="#bdbdbd" font-size="9" text-anchor="middle">${money(b.hi)}</text>`;
  });
  g += `<line x1="${L}" x2="${W - R}" y1="${y(p.alpha)}" y2="${y(p.alpha)}" stroke="#fff700" stroke-width="1.2" stroke-dasharray="4 3"/>`;
  const ci = bk.findIndex(b => b.hi === sel);
  if (ci >= 0) { const x = L + slot * (ci + 1); g += `<line x1="${x}" x2="${x}" y1="${T - 4}" y2="${T + ih}" stroke="#fff" stroke-width="1"/><text x="${x + 4}" y="${T + 4}" fill="#fff" font-size="9" font-weight="700">Certified ${money(sel)}</text>`; }
  const ni = bk.findIndex(b => b.hi === r.naive);
  if (ni >= 0 && ni !== ci) { const x = L + slot * (ni + 1); g += `<line x1="${x}" x2="${x}" y1="${T + 10}" y2="${T + ih}" stroke="#9a9a9a" stroke-width="1.2" stroke-dasharray="3 3"/>`; }
  g += `<text x="${L}" y="${H - 3}" fill="#8a8a8a" font-size="9">Bucket upper edge (from ${money(r.type.L0)})</text>`;
  return `<div class="chart-box"><div class="t">Miss rate by size bucket</div><div class="s">${confLabel(p)} upper bound per bucket, Jun 1 – Sep 30, tested in order of size</div>
    <div class="legend"><span><i style="background:var(--olive)"></i>Certified</span><span><i style="background:var(--orange)"></i>Not certified</span><span><i class="dot"></i>Observed</span><span><i class="ln"></i>Target ${pct(p.alpha, 0)}</span>${r.naive !== sel ? `<span><i class="ln gray"></i>Point estimate ${money(r.naive)}</span>` : ''}</div>
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg></div>`;
}

function eChartHTML(r) {
  const m = r.mon, W = 396, H = 168, L = 34, R = 8, T = 14, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const pts = m.daily;
  const lo = 0.1, hi = Math.max(m.threshold * 3, Math.min(1e4, m.maxE * 1.5));
  const ly = (v) => T + ih - (Math.log10(Math.max(lo, Math.min(hi, v))) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * ih;
  const x = (d) => L + (d - pts[0].day) / (pts[pts.length - 1].day - pts[0].day) * iw;
  let g = '';
  [0.1, 1, 10, 100, 1000].filter(v => v <= hi).forEach(v => { g += `<line x1="${L}" x2="${W - R}" y1="${ly(v)}" y2="${ly(v)}" stroke="#2a2a2a" stroke-dasharray="2 3"/><text x="${L - 6}" y="${ly(v) + 3}" fill="#8a8a8a" font-size="9" text-anchor="end">${v}</text>`; });
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${ly(p.e).toFixed(1)}`).join('');
  g += `<defs><linearGradient id="eg${r.ti}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8d7fd1" stop-opacity=".35"/><stop offset="1" stop-color="#8d7fd1" stop-opacity="0"/></linearGradient></defs>`;
  g += `<path d="${path}L${x(pts[pts.length - 1].day)},${T + ih}L${x(pts[0].day)},${T + ih}Z" fill="url(#eg${r.ti})"/><path d="${path}" fill="none" stroke="#8d7fd1" stroke-width="2"/>`;
  g += `<line x1="${L}" x2="${W - R}" y1="${ly(m.threshold)}" y2="${ly(m.threshold)}" stroke="#fff700" stroke-width="1.2" stroke-dasharray="4 3"/><text x="${W - R}" y="${ly(m.threshold) - 4}" fill="#fff700" font-size="9" text-anchor="end">Rollback at ${m.threshold.toFixed(0)}</text>`;
  if (r.type.drift) { const dx = x(r.type.drift.day); g += `<line x1="${dx}" x2="${dx}" y1="${T}" y2="${T + ih}" stroke="#777" stroke-dasharray="2 2"/><text x="${dx - 4}" y="${T + 8}" fill="#9a9a9a" font-size="9" text-anchor="end">Sim. onset ${dayDate(r.type.drift.day)}</text>`; }
  if (m.alarm) { const ax = x(m.alarm.day), ay = ly(m.alarm.e); g += `<circle cx="${ax}" cy="${ay}" r="4" fill="#fff700"/><text x="${ax + 7}" y="${ay + 14}" fill="#fff" font-size="9" font-weight="700">${dayDate(m.alarm.day)} · e = ${m.alarm.e.toFixed(1)}</text>`; }
  [0, Math.floor(pts.length / 2), pts.length - 1].forEach(i => { g += `<text x="${x(pts[i].day)}" y="${H - B + 13}" fill="#bdbdbd" font-size="9" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}">${dayDate(pts[i].day)}</text>`; });
  g += `<text x="${L}" y="${H - 3}" fill="#8a8a8a" font-size="9">Evidence against "miss rate ≤ ${pct(state.p.alpha, 0)}" (log scale)</text>`;
  return `<div class="chart-box"><div class="t">Holdout monitor · ${money(r.type.L0)}–${money(r.cert.limit)} band</div><div class="s">Anytime-valid e-process; false alarm probability ≤ ${pct(1 / m.threshold, 0)} over any horizon</div>
    <div class="legend"><span><i style="background:#8d7fd1"></i>E-value</span><span><i class="ln"></i>Rollback threshold</span></div>
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg></div>`;
}

function footHTML(r) {
  const p = state.p, sel = state.sel[r.ti];
  const inBand = (x) => x.day < A.CERT_END_DAY && x.size > r.type.L0 && x.size <= Math.max(sel, r.cert.limit);
  const band = r.recs.filter(inBand);
  const appr = band.filter(x => x.status === 1).length, rej = band.filter(x => x.status === 2).length;
  const moves = r.action === 'widen' ? A.weeklyVolume(r.recs, r.type, r.type.L0, sel, A.END_DAY) : 0;
  const e = r.mon ? `${r.mon.maxE.toFixed(1)}<small>/ ${r.mon.threshold.toFixed(0)}</small>` : '—<small>no band to watch</small>';
  return `<div class="card-foot">
    <div class="mini"><div class="k">Moves to auto-execute</div><div class="n">${moves.toFixed(1)}<small>actions / week</small></div></div>
    <div class="mini"><div class="k">Manual approvals now (above ${money(r.type.L0)})</div><div class="n">${r.perWeekCurrentManual.toFixed(1)}<small>/ week</small></div></div>
    <div class="mini"><div class="k">Approved / rejected in certified band</div><div class="n">${num(appr)}<small>/ ${rej}</small></div></div>
    <div class="mini"><div class="k">Peak holdout e-value</div><div class="n">${e}</div></div>
  </div>`;
}

function drillHTML(r) {
  const k = state.drill[r.ti];
  if (k == null) return '';
  const b = r.cert.buckets[k], tau = state.p.tau;
  const list = r.recs.filter(x => x.day < A.CERT_END_DAY && x.size > b.lo && x.size <= b.hi)
    .sort((a, c) => (c.status === 2) - (a.status === 2) || ((c.ratio != null && c.ratio < 1 - tau) - (a.ratio != null && a.ratio < 1 - tau)) || c.day - a.day).slice(0, 8);
  const cols = COLS[r.type.key];
  const rows = list.map(x => {
    const d = x.detail.split('|');
    const res = x.status === 2 ? `<span class="res na">Rejected</span>` : x.ratio < 1 - tau ? `<span class="res no">Miss</span>` : `<span class="res ok">Hit</span>`;
    const id = `ACT-${String(100000 + x.i).slice(-6)}`;
    return `<tr><td>${id}</td><td>${d[0]}</td><td>${d[1]}</td><td>${d[2]}</td><td class="r">${d[3]}</td><td class="r">${usd(x.size)}</td><td class="r">${x.status === 2 ? '—' : usd(x.size * x.ratio)}</td><td>${x.status === 0 ? 'Auto' : x.status === 1 ? 'Approved' : 'Rejected'}</td><td>${res}</td><td>${dayDate(x.day)}</td></tr>`;
  }).join('');
  return `<div class="drill"><h4><span>Actions in ${band(b)} · misses and rejections first (${b.misses + b.rejected} of ${num(b.n)})</span><a data-close="${r.ti}">Close</a></h4>
    <table class="t"><thead><tr><th>Action</th><th>${cols[0]}</th><th>${cols[1]}</th><th>${cols[2]}</th><th class="r">${cols[3]}</th><th class="r">Expected</th><th class="r">Actual</th><th>Path</th><th>Result</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function bindCards() {
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const ti = +b.dataset.ti, r = state.res.find(x => x.ti === ti);
    state.decided[ti] = b.dataset.act === 'approve' ? 'approved' : 'rejected';
    if (b.dataset.act === 'approve' && r.action === 'widen') toast(`${r.type.label}: auto-execute limit set to ${money(state.sel[ti])} from Nov 11, monitored for rollback`);
    else toast(`${r.type.label}: ${state.decided[ti]}`);
    render();
  });
  document.querySelectorAll('[data-tog]').forEach(b => b.onclick = () => { const ti = +b.dataset.tog; state.open[ti] = !state.open[ti]; render(); });
  document.querySelectorAll('[data-cb]').forEach(c => c.onclick = (e) => {
    e.stopPropagation();
    const ti = +c.dataset.cb, k = +c.dataset.k, r = state.res.find(x => x.ti === ti);
    const b = r.cert.buckets[k];
    if (state.decided[ti]) return;
    state.sel[ti] = state.sel[ti] >= b.hi ? (k ? r.cert.buckets[k - 1].hi : r.type.L0) : b.hi;
    render();
  });
  document.querySelectorAll('tr.row').forEach(tr => tr.onclick = () => { const ti = +tr.dataset.row, k = +tr.dataset.k; state.drill[ti] = state.drill[ti] === k ? null : k; render(); });
  document.querySelectorAll('[data-close]').forEach(a => a.onclick = () => { state.drill[+a.dataset.close] = null; render(); });
}

// ---------- method check (validation by re-simulation) ----------
function runValidation(p) {
  const token = ++state.valToken, total = 200, chunk = 20;
  const agg = { reps: 0, cert: { viol: 0, total: 0 }, naive: { viol: 0, total: 0 }, optimistic: { viol: 0, total: 0 }, certWiden: 0, naiveWiden: 0 };
  renderMethod(null, p);
  const step = (k) => {
    if (token !== state.valToken) return;
    const v = A.validate(p, chunk, 1000 + k);
    agg.reps += v.reps;
    ['cert', 'naive', 'optimistic'].forEach(key => { agg[key].viol += v[key].viol; agg[key].total += v[key].total; });
    agg.certWiden += v.certWiden; agg.naiveWiden += v.naiveWiden;
    if (agg.reps < total) setTimeout(() => step(k + chunk), 0);
    else renderMethod(agg, p);
  };
  setTimeout(() => step(0), 30);
}

function renderMethod(v, p) {
  const truthRows = state.res.map(r => {
    const top = (lim) => { const k = r.cert.buckets.findIndex(b => b.hi === lim); return k < 0 ? null : A.trueBucketRisk(r.type, r.cert.buckets[k].lo, r.cert.buckets[k].hi, p.tau); };
    const ct = top(r.cert.limit), nt = top(r.naive);
    return `<tr><td class="sans">${r.type.label}</td><td class="r">${money(r.cert.limit)}</td><td class="r">${ct == null ? '—' : pct(ct)}</td><td class="r">${money(r.naive)}</td><td class="r" style="color:${nt != null && nt > p.alpha ? '#ff7a4a' : 'inherit'}">${nt == null ? '—' : pct(nt)}</td></tr>`;
  }).join('');
  let left;
  if (!v) left = `<p class="blk-title">Re-simulating the record 200 times…</p><p class="running">Each rerun redraws Jun 1 – Sep 30 for all five decision types and applies each rule.</p>`;
  else {
    const rows = [
      ['Certified, rejections as misses', v.cert, 'var(--olive)'],
      ['Certified, rejections excluded', v.optimistic, '#8d7fd1'],
      ['Point-estimate rule', v.naive, 'var(--orange)'],
    ];
    const scale = Math.max(0.4, ...rows.map(r => r[1].viol / r[1].total)) * 1.1;
    left = `<p class="blk-title">How often a rule delegates a bucket that truly misses more than ${pct(p.alpha, 0)}</p>
      <p class="blk-sub gray">${v.reps} reruns × 5 decision types = ${v.cert.total} limit decisions. Dashed line: the ${pct(p.delta, 0)} error budget.</p>
      ${rows.map(([n, s, c]) => `<div class="mrow"><span>${n}</span><div class="bar"><span style="width:${(s.viol / s.total / scale * 100).toFixed(1)}%;background:${c}"></span><i class="cap" style="left:${(p.delta / scale * 100).toFixed(1)}%"></i></div><b>${pct(s.viol / s.total)}</b></div>`).join('')}
      <p class="mnote">The certified rule widened a limit in <b>${pct(v.certWiden / v.cert.total, 0)}</b> of decisions, the point-estimate rule in <b>${pct(v.naiveWiden / v.naive.total, 0)}</b>. Counting rejected actions as misses is a worst-case bound: approvers reject the riskiest actions, so dropping them makes the record look safer than auto-execution would be.</p>`;
  }
  $('#method').innerHTML = `<div>${left}</div>
    <div><p class="blk-title">This dataset against the simulator's truth</p><p class="blk-sub gray">True miss rate of the top delegated bucket (unknowable in production)</p>
    <table class="t"><thead><tr><th>Decision type</th><th class="r">Certified</th><th class="r">True miss</th><th class="r">Point estimate</th><th class="r">True miss</th></tr></thead><tbody>${truthRows}</tbody></table></div>`;
}

let tt;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2600); }

init().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f66">${e}</pre>`); });
