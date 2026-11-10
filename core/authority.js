// Certified authority limits for autonomous supply chain actions.
//
// Given the expected-vs-actual record of executed actions, find the largest
// auto-execution limit for each decision type such that every newly delegated
// size bucket has a miss rate <= alpha, with family-wise error <= delta
// (Learn-then-Test with fixed-sequence testing over increasing limits).
// Actions that approvers rejected have no observed outcome; by default they are
// counted as misses (a worst-case bound), because approvers tend to reject the
// risky ones and ignoring them makes the record look better than auto-execution
// would be. After a limit is widened, an anytime-valid betting e-process watches
// the delegated bucket and recommends a rollback when the miss rate drifts.
//
// Pure functions, no DOM. Works in the browser (ES module) and in Node.

export const DAY_MS = 86400000;
export const START = Date.UTC(2026, 5, 1); // Jun 1 2026
export const CERT_END_DAY = 122;           // Jun 1 .. Sep 30 (days 0..121)
export const END_DAY = 163;                // through Nov 10 2026 (day 162)

export const FACILITIES = ['Louisville-1', 'Charlotte-1', 'Dallas-2', 'Phoenix-1', 'Seattle-1', 'Reno-1'];
const TEAMS = ['NYY', 'LAD', 'KC', 'BOS', 'DAL', 'CHI', 'GB', 'PHI', 'SF', 'ATL', 'NYG', 'LAL'];
const PRODUCTS = ['JERSEY', 'CAP', 'HOODIE', 'TEE', 'POLO', 'FLEECE'];
const CARRIERS = ['UPS Ground', 'FedEx Express', 'XPO LTL', 'Estes', 'OnTrac', 'Saia'];
const SUPPLIERS = ['Gildan', 'Bella+Canvas', 'Hanesbrands', 'Nike Blanks', 'New Era', 'Delta Apparel'];

// Decision types. L0 = current auto-execution limit (expected impact, USD).
// q0/beta: probability that the action is disruption-bound, q = q0 (size/L0)^beta.
// A disruption-bound action realizes r = actual/expected ~ U(0.10, 1.00);
// otherwise r ~ Normal(1, sigma). hCatch = share of disruption-bound actions an
// approver would spot and reject; rBase = rejection rate for unrelated reasons.
export const TYPES = [
  { key: 'transfer', label: 'Transfer blank inventory', L0: 25000, med: 21000, sl: 0.85, vol: 34, q0: 0.016, beta: 1.05, sigma: 0.075, hCatch: 0.35, rBase: 0.002 },
  { key: 'workorder', label: 'Reassign work orders', L0: 40000, med: 31000, sl: 0.8, vol: 24, q0: 0.012, beta: 1.0, sigma: 0.08, hCatch: 0.35, rBase: 0.002 },
  { key: 'allocate', label: 'Reallocate scarce inventory', L0: 15000, med: 13000, sl: 0.85, vol: 28, q0: 0.045, beta: 0.95, sigma: 0.08, hCatch: 0.4, rBase: 0.003 },
  { key: 'po', label: 'Pull in purchase orders', L0: 50000, med: 36000, sl: 0.85, vol: 3, q0: 0.012, beta: 0.8, sigma: 0.06, hCatch: 0.35, rBase: 0.002 },
  { key: 'expedite', label: 'Switch carrier and expedite', L0: 10000, med: 8200, sl: 0.8, vol: 22, q0: 0.014, beta: 1.0, sigma: 0.08, hCatch: 0.35, rBase: 0.002,
    drift: { day: 136, mult: 7 } }, // Oct 15 2026: peak-season carrier capacity crunch
];

export const GRID_MULT = [1.5, 2, 3, 4, 6, 8, 12];

export function niceRound(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.round(x / p / 5) * 5 * p;
}
export function gridFor(type) { return GRID_MULT.map(m => niceRound(type.L0 * m)); }

// ---------- RNG ----------
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  next.normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = next();
    v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  next.poisson = (lam) => {
    if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * next.normal()));
    const L = Math.exp(-lam); let k = 0, p = 1;
    do { k++; p *= next(); } while (p > L);
    return k - 1;
  };
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

export function qOf(type, size, day) {
  let q = type.q0 * Math.pow(size / type.L0, type.beta);
  if (type.drift && day >= type.drift.day && size > type.L0) q *= type.drift.mult;
  return Math.min(q, 0.9);
}

// Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf).
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// True probability that an action of this size misses (actual < (1 - tau) * expected)
// if it were auto-executed (no approver filter).
export function trueMissProb(type, size, tau, day = 0) {
  const q = qOf(type, size, day);
  const cut = 1 - tau;
  const pU = Math.min(1, Math.max(0, (cut - 0.10) / 0.90));
  const pN = normCdf((cut - 1) / type.sigma);
  return q * pU + (1 - q) * pN;
}

// True miss rate of a size bucket (lo, hi], averaging over the lognormal size distribution.
export function trueBucketRisk(type, lo, hi, tau, day = 0) {
  const mu = Math.log(type.med), s = type.sl;
  const z0 = (Math.log(lo) - mu) / s, z1 = (Math.log(hi) - mu) / s;
  const N = 400; let num = 0, den = 0;
  for (let i = 0; i < N; i++) {
    const z = z0 + (z1 - z0) * (i + 0.5) / N;
    const w = Math.exp(-z * z / 2);
    num += w * trueMissProb(type, Math.exp(mu + s * z), tau, day);
    den += w;
  }
  return num / den;
}

// ---------- synthetic decision history ----------
// Columnar output to keep the data file small.
export function generate(seed = 20261110, opts = {}) {
  const days = opts.days ?? END_DAY;
  const types = opts.types ?? TYPES;
  const R = rng(seed);
  const cols = { type: [], day: [], hour: [], size: [], status: [], ratio: [], q: [], detail: [] };
  const lite = !!opts.lite;
  for (let d = 0; d < days; d++) {
    const dow = new Date(START + d * DAY_MS).getUTCDay();
    const weekday = dow === 0 || dow === 6 ? 0.45 : 1.12;
    const season = 1 + 0.18 * Math.sin((d - 20) / 163 * Math.PI); // ramps into fall
    types.forEach((t, ti) => {
      const n = R.poisson(t.vol * weekday * season);
      for (let i = 0; i < n; i++) {
        const size = Math.round(Math.exp(Math.log(t.med) + t.sl * R.normal()) / 10) * 10;
        const q = qOf(t, size, d);
        const disrupted = R() < q;
        let status = 0; // 0 auto, 1 approved, 2 rejected
        if (size > t.L0) {
          const pr = t.rBase + (disrupted ? t.hCatch : 0);
          status = R() < pr ? 2 : 1;
        }
        let ratio = disrupted ? 0.10 + 0.90 * R() : 1 + t.sigma * R.normal();
        cols.type.push(ti); cols.day.push(d); cols.size.push(size); cols.status.push(status);
        cols.ratio.push(status === 2 ? null : Math.round(ratio * 1000) / 1000);
        cols.q.push(Math.round(q * 1e5) / 1e5);
        cols.hour.push(lite ? 0 : 6 + Math.floor(R() * 14));
        if (!lite) cols.detail.push(detailFor(t.key, size, R));
      }
    });
  }
  return { seed, start: '2026-06-01', certEndDay: CERT_END_DAY, days, types: types.map(t => ({ ...t, grid: gridFor(t) })), cols };
}

function detailFor(key, size, R) {
  const sku = `INV-${R.pick(TEAMS)}-${R.pick(PRODUCTS)}-${String(1 + Math.floor(R() * 120)).padStart(3, '0')}`;
  let a = R.pick(FACILITIES), b = R.pick(FACILITIES);
  while (b === a) b = R.pick(FACILITIES);
  const wk = 1 + Math.floor(R() * 6);
  if (key === 'transfer') return `${sku}|${a}|${b}|${Math.max(200, Math.round(size / 3.4 / 50) * 50).toLocaleString('en-US')} units|Week ${wk}`;
  if (key === 'workorder') return `WO-${100000 + Math.floor(R() * 899999)}|${a}|${b}|${Math.max(300, Math.round(size / 2.1 / 100) * 100).toLocaleString('en-US')} units|Week ${wk}`;
  if (key === 'allocate') return `${sku}|${a}|${R.pick(['Fanatics.com', 'Dick\'s Sporting Goods', 'Lids', 'Academy Sports', 'Team stores', 'Amazon'])}|${Math.max(100, Math.round(size / 18 / 10) * 10).toLocaleString('en-US')} units|Week ${wk}`;
  if (key === 'po') return `PO-${4500000 + Math.floor(R() * 99999)}|${R.pick(SUPPLIERS)}|${a}|pull in ${2 + Math.floor(R() * 12)} days|Week ${wk}`;
  return `SHP-${700000 + Math.floor(R() * 299999)}|${R.pick(CARRIERS)}|${R.pick(CARRIERS)}|${a} → ${b}|Week ${wk}`;
}

// Rows view over the columnar data.
export function rows(data) {
  const c = data.cols, out = new Array(c.type.length);
  for (let i = 0; i < c.type.length; i++) {
    out[i] = { i, type: c.type[i], day: c.day[i], hour: c.hour[i], size: c.size[i], status: c.status[i], ratio: c.ratio[i], q: c.q ? c.q[i] : null, detail: c.detail ? c.detail[i] : '' };
  }
  return out;
}

// ---------- exact binomial tools ----------
const LG = (() => { const a = [0]; for (let i = 1; i <= 20000; i++) a[i] = a[i - 1] + Math.log(i); return a; })();
function logFact(n) { return n <= 20000 ? LG[n] : n * Math.log(n) - n + 0.5 * Math.log(2 * Math.PI * n); }

// P(Bin(n, p) <= k)
export function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lp = Math.log(p), lq = Math.log(1 - p);
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(logFact(n) - logFact(i) - logFact(n - i) + i * lp + (n - i) * lq);
  return Math.min(1, s);
}

// One-sided Clopper-Pearson upper confidence bound on a binomial rate.
export function cpUpper(x, n, conf = 0.95) {
  if (n === 0) return 1;
  if (x >= n) return 1;
  let lo = x / n, hi = 1;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(x, n, mid) > 1 - conf) lo = mid; else hi = mid;
  }
  return hi;
}

// ---------- certification ----------
// Outcome of one record under the chosen miss definition.
//   returns 1 = miss, 0 = hit, null = excluded
export function outcome(r, tau, rejections) {
  if (r.status === 2) return rejections === 'worst' ? 1 : null;
  return r.ratio < 1 - tau ? 1 : 0;
}

export function bucketStats(recs, type, tau, rejections, fromDay, toDay) {
  const grid = gridFor(type);
  const edges = [type.L0, ...grid];
  const b = grid.map((hi, k) => ({ lo: edges[k], hi, n: 0, x: 0, misses: 0, rejected: 0, approved: 0 }));
  for (const r of recs) {
    if (r.day < fromDay || r.day >= toDay || r.size <= type.L0) continue;
    let k = -1;
    for (let j = 0; j < b.length; j++) if (r.size <= b[j].hi) { k = j; break; }
    if (k < 0) continue;
    const o = outcome(r, tau, rejections);
    if (r.status === 2) b[k].rejected++; else b[k].approved++;
    if (r.status !== 2 && r.ratio < 1 - tau) b[k].misses++;
    if (o === null) continue;
    b[k].n++; b[k].x += o;
  }
  return b;
}

// Learn-then-Test, fixed sequence: H_k: miss rate of bucket k > alpha.
// p_k = P(Bin(n_k, alpha) <= x_k). Walk buckets in increasing size; certify while p_k <= delta.
// FWER <= delta, so with prob >= 1 - delta every certified bucket has miss rate <= alpha.
export function certifyType(recs, type, p) {
  const { alpha, delta, tau, rejections = 'worst', fromDay = 0, toDay = CERT_END_DAY } = p;
  const buckets = bucketStats(recs, type, tau, rejections, fromDay, toDay);
  let limit = type.L0, stopped = false, stopIdx = -1;
  buckets.forEach((bk, k) => {
    bk.pValue = bk.n ? binomCdf(bk.x, bk.n, alpha) : 1;
    bk.upper = cpUpper(bk.x, bk.n, 1 - delta);
    bk.rate = bk.n ? bk.x / bk.n : null;
    if (!stopped && bk.pValue <= delta) { bk.certified = true; limit = bk.hi; }
    else { bk.certified = false; if (!stopped) { stopped = true; stopIdx = k; } }
  });
  return { type: type.key, L0: type.L0, limit, buckets, stopIdx };
}

// Point-estimate rule a dashboard would use: largest limit whose buckets all show an
// observed miss rate <= alpha, ignoring rejected actions (no outcome recorded).
export function naiveLimit(recs, type, p) {
  const { alpha, tau, fromDay = 0, toDay = CERT_END_DAY, minN = 20 } = p;
  const buckets = bucketStats(recs, type, tau, 'ignore', fromDay, toDay);
  let limit = type.L0;
  for (const bk of buckets) {
    if (bk.n >= minN && bk.x / bk.n <= alpha) limit = bk.hi; else break;
  }
  return limit;
}

// Additional clean (non-miss) actions needed in the stopping bucket before it would certify.
export function evidenceNeeded(bk, alpha, delta) {
  if (!bk) return null;
  for (let m = 0; m <= 5000; m++) if (binomCdf(bk.x, bk.n + m, alpha) <= delta) return m;
  return null;
}

// Actions per week in the newly delegated band over the last `weeks` weeks of the window.
export function weeklyVolume(recs, type, lo, hi, toDay, weeks = 8) {
  const from = toDay - weeks * 7;
  let n = 0;
  for (const r of recs) if (r.day >= from && r.day < toDay && r.size > lo && r.size <= hi) n++;
  return n / weeks;
}

// ---------- anytime-valid monitoring ----------
// Mixture-of-bets e-process for H0: miss rate <= alpha.
// W_t(b) = prod (1 + b (Y_s - alpha)), b in [0, 1/alpha); under H0 each W(b) is a
// nonnegative supermartingale, so their average is too and, by Ville's inequality,
// P(sup_t E_t >= 1/deltaM) <= deltaM.
export function monitor(recs, type, lo, hi, p) {
  const { alpha, tau, deltaM = 0.05, rejections = 'worst', fromDay = CERT_END_DAY, toDay = END_DAY } = p;
  const bets = [0.1, 0.25, 0.5, 0.75, 0.9].map(f => f / alpha); // fractions of the max bet
  const w = bets.map(() => 1);
  const series = []; let alarm = null, n = 0, x = 0;
  const seq = recs.filter(r => r.day >= fromDay && r.day < toDay && r.size > lo && r.size <= hi)
    .sort((a, b) => a.day - b.day || a.hour - b.hour || a.i - b.i);
  for (const r of seq) {
    const y = outcome(r, tau, rejections);
    if (y === null) continue;
    n++; x += y;
    for (let j = 0; j < w.length; j++) w[j] *= 1 + bets[j] * (y - alpha);
    const e = w.reduce((s, v) => s + v, 0) / w.length;
    series.push({ day: r.day, e, n, x });
    if (alarm === null && e >= 1 / deltaM) alarm = { day: r.day, n, x, e };
  }
  const daily = [];
  for (let d = fromDay; d < toDay; d++) {
    const last = [...series].reverse().find(s => s.day <= d);
    daily.push({ day: d, e: last ? last.e : 1 });
  }
  return { series, daily, alarm, n, x, threshold: 1 / deltaM, maxE: series.reduce((m, s) => Math.max(m, s.e), 1) };
}

// ---------- end-to-end analysis used by the page ----------
export function analyze(data, p) {
  const recs = rows(data);
  const types = data.types;
  const out = types.map((type, ti) => {
    const tr = recs.filter(r => r.type === ti);
    const cert = certifyType(tr, type, p);
    const naive = naiveLimit(tr, type, p);
    const optimistic = certifyType(tr, type, { ...p, rejections: 'ignore' }).limit;
    const mon = cert.limit > type.L0 ? monitor(tr, type, type.L0, cert.limit, p) : null;
    const stopBk = cert.stopIdx >= 0 ? cert.buckets[cert.stopIdx] : null;
    const need = evidenceNeeded(stopBk, p.alpha, p.delta);
    const perWeekAll = weeklyVolume(tr, type, type.L0, cert.limit, END_DAY);
    const perWeekCurrentManual = weeklyVolume(tr, type, type.L0, Infinity, END_DAY);
    const totals = { n: tr.length, auto: 0, approved: 0, rejected: 0 };
    for (const r of tr) { if (r.status === 0) totals.auto++; else if (r.status === 1) totals.approved++; else totals.rejected++; }
    let action = 'keep';
    if (mon && mon.alarm) action = 'rollback';
    else if (cert.limit > type.L0) action = 'widen';
    return { type, ti, cert, naive, optimistic, mon, stopBk, need, perWeekAll, perWeekCurrentManual, totals, action, recs: tr };
  });
  return out;
}

// ---------- validation by re-simulation ----------
// For each rerun: regenerate the certification window with a new seed, run the certified
// and naive rules, and check the true miss rate of every delegated bucket against alpha.
export function validate(p, reps = 200, seed0 = 1000, types = TYPES) {
  const truthCache = types.map(t => {
    const grid = gridFor(t), edges = [t.L0, ...grid];
    return grid.map((hi, k) => trueBucketRisk(t, edges[k], hi, p.tau, 0));
  });
  const res = { reps, cert: { viol: 0, total: 0 }, naive: { viol: 0, total: 0 }, optimistic: { viol: 0, total: 0 }, certWiden: 0, naiveWiden: 0 };
  const exceeded = (t, ti, limit) => {
    const grid = gridFor(t);
    for (let k = 0; k < grid.length && grid[k] <= limit; k++) if (truthCache[ti][k] > p.alpha) return true;
    return false;
  };
  for (let s = 0; s < reps; s++) {
    const data = generate(seed0 + s, { days: CERT_END_DAY, lite: true, types });
    const recs = rows(data);
    types.forEach((t, ti) => {
      const tr = recs.filter(r => r.type === ti);
      const c = certifyType(tr, t, p).limit;
      const nv = naiveLimit(tr, t, p);
      const op = certifyType(tr, t, { ...p, rejections: 'ignore' }).limit;
      res.cert.total++; res.naive.total++; res.optimistic.total++;
      if (exceeded(t, ti, c)) res.cert.viol++;
      if (exceeded(t, ti, nv)) res.naive.viol++;
      if (exceeded(t, ti, op)) res.optimistic.viol++;
      if (c > t.L0) res.certWiden++;
      if (nv > t.L0) res.naiveWiden++;
    });
  }
  res.truth = truthCache;
  return res;
}
