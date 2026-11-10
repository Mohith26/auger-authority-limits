import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as A from '../core/authority.js';

const P = { alpha: 0.05, delta: 0.05, tau: 0.25, rejections: 'worst' };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('exact binomial CDF matches hand-computed values', () => {
  close(A.binomCdf(2, 10, 0.5), 56 / 1024, 1e-12, 'Bin(10,.5)<=2');
  close(A.binomCdf(0, 100, 0.03), Math.pow(0.97, 100), 1e-12, 'Bin(100,.03)<=0');
  close(A.binomCdf(1, 5, 0.2), Math.pow(0.8, 5) + 5 * 0.2 * Math.pow(0.8, 4), 1e-12, 'Bin(5,.2)<=1');
  assert.equal(A.binomCdf(5, 5, 0.3), 1);
  assert.equal(A.binomCdf(-1, 5, 0.3), 0);
});

test('Clopper-Pearson upper bound is dual to the one-sided binomial test', () => {
  for (const [x, n] of [[0, 59], [0, 100], [3, 120], [12, 822], [7, 281], [1, 51]]) {
    const u = A.cpUpper(x, n, 0.95);
    close(A.binomCdf(x, n, u), 0.05, 1e-6, `tail at bound for ${x}/${n}`);
    // p <= delta  <=>  upper bound <= alpha
    for (const alpha of [0.02, 0.05, 0.08]) assert.equal(A.binomCdf(x, n, alpha) <= 0.05, u <= alpha + 1e-9, `${x}/${n} alpha ${alpha}`);
  }
  // rule of three: 0 misses in n gives about 3/n
  close(A.cpUpper(0, 300, 0.95), 3 / 300, 0.0005, 'rule of three');
});

function rec(size, status, ratio, day = 10) { return { i: 0, type: 0, day, hour: 0, size, status, ratio }; }
const T0 = { ...A.TYPES[0] }; // L0 25K, grid 37.5K? -> niceRound
const G = A.gridFor(T0);

test('fixed-sequence certification stops at the first failing bucket', () => {
  const recs = [];
  // bucket 0: 200 clean actions -> certifies (0.95^200 tiny)
  for (let i = 0; i < 200; i++) recs.push(rec(G[0] - 100, 1, 1.0));
  // bucket 1: 40 actions with 6 misses -> fails
  for (let i = 0; i < 40; i++) recs.push(rec(G[1] - 100, 1, i < 6 ? 0.3 : 1.0));
  // bucket 2: 300 clean -> would pass on its own but must not be certified
  for (let i = 0; i < 300; i++) recs.push(rec(G[2] - 100, 1, 1.0));
  const c = A.certifyType(recs, T0, P);
  assert.equal(c.limit, G[0]);
  assert.equal(c.buckets[0].certified, true);
  assert.equal(c.buckets[1].certified, false);
  assert.equal(c.buckets[2].certified, false);
  assert.equal(c.stopIdx, 1);
  assert.ok(c.buckets[2].pValue < 0.05, 'bucket 2 alone would pass');
});

test('rejected actions count as misses in the worst case and are excluded otherwise', () => {
  const recs = [];
  for (let i = 0; i < 120; i++) recs.push(rec(G[0] - 100, 1, 1.0));
  for (let i = 0; i < 4; i++) recs.push(rec(G[0] - 100, 2, null));
  const worst = A.certifyType(recs, T0, P).buckets[0];
  const ign = A.certifyType(recs, T0, { ...P, rejections: 'ignore' }).buckets[0];
  assert.deepEqual([worst.n, worst.x, worst.rejected], [124, 4, 4]);
  assert.deepEqual([ign.n, ign.x], [120, 0]);
  assert.ok(worst.upper > ign.upper);
  // the miss definition follows tau
  const r = rec(G[0] - 100, 1, 0.8);
  assert.equal(A.outcome(r, 0.25, 'worst'), 0);
  assert.equal(A.outcome(r, 0.15, 'worst'), 1);
});

test('evidenceNeeded returns the smallest number of clean actions that certifies', () => {
  const bk = { n: 51, x: 1 };
  const m = A.evidenceNeeded(bk, 0.05, 0.05);
  assert.ok(A.binomCdf(1, 51 + m, 0.05) <= 0.05);
  assert.ok(A.binomCdf(1, 51 + m - 1, 0.05) > 0.05);
});

test('trueBucketRisk agrees with a large simulated sample', () => {
  const t = A.TYPES[0];
  const big = A.generate(7, { days: 400, lite: true, types: [{ ...t, vol: 120 }] });
  const recs = A.rows(big);
  const lo = t.L0, hi = A.gridFor(t)[2];
  // auto-execution truth ignores the approver filter, so compare on q-level probabilities
  let s = 0, n = 0;
  for (const r of recs) if (r.size > lo && r.size <= hi) { s += A.trueMissProb(t, r.size, 0.25); n++; }
  close(A.trueBucketRisk(t, lo, hi, 0.25), s / n, 0.002, 'quadrature vs sample mean');
  // and miss probability rises with size
  assert.ok(A.trueMissProb(t, 200000, 0.25) > A.trueMissProb(t, 30000, 0.25));
});

test('re-simulation: certified rule keeps the error budget, point-estimate rule does not', () => {
  const v = A.validate(P, 80, 500);
  const certRate = v.cert.viol / v.cert.total, naiveRate = v.naive.viol / v.naive.total;
  assert.ok(certRate <= 0.05 + 0.03, `certified violation rate ${certRate}`);
  assert.ok(naiveRate > 0.15, `naive violation rate ${naiveRate}`);
  assert.ok(v.certWiden > 0.3 * v.cert.total, 'certified rule still widens limits');
});

test('e-process: rare false alarms under H0, fast detection under drift', () => {
  const T = { ...A.TYPES[0], L0: 1 };
  const seqs = (p, seed, n) => {
    const R = A.rng(seed), recs = [];
    for (let i = 0; i < n; i++) recs.push({ i, type: 0, day: A.CERT_END_DAY + Math.floor(i / 10), hour: i % 10, size: 2, status: 1, ratio: R() < p ? 0.2 : 1 });
    return recs;
  };
  let fa = 0;
  for (let s = 0; s < 300; s++) if (A.monitor(seqs(0.05, s, 400), T, 1, 10, { ...P, toDay: 10000 }).alarm) fa++;
  assert.ok(fa / 300 <= 0.05 + 0.02, `false alarm rate ${fa / 300} at p = alpha`);
  let det = 0, lag = 0;
  for (let s = 0; s < 100; s++) { const m = A.monitor(seqs(0.2, 1000 + s, 400), T, 1, 10, { ...P, toDay: 10000 }); if (m.alarm) { det++; lag += m.alarm.n; } }
  assert.ok(det >= 98, `detected ${det}/100 at 4x alpha`);
  assert.ok(lag / det < 120, `mean actions to alarm ${lag / det}`);
});

test('shipped data file is reproducible from the seeded generator', () => {
  const file = JSON.parse(readFileSync(new URL('../data/decisions.json', import.meta.url)));
  const g = A.generate(file.seed);
  for (const k of ['type', 'day', 'size', 'status', 'ratio', 'detail']) assert.deepEqual(file.cols[k], g.cols[k], k);
});

test('shipped analysis: numbers the page shows are internally consistent', () => {
  const file = JSON.parse(readFileSync(new URL('../data/decisions.json', import.meta.url)));
  const res = A.analyze(file, P);
  const byKey = Object.fromEntries(res.map(r => [r.type.key, r]));
  for (const r of res) {
    // certified buckets are a prefix, each with bound <= alpha
    let seenFail = false;
    for (const b of r.cert.buckets) { if (!b.certified) seenFail = true; else { assert.ok(!seenFail); assert.ok(b.upper <= P.alpha + 1e-9); } }
    assert.ok(r.naive >= r.cert.limit || r.cert.limit === r.type.L0);
  }
  assert.equal(byKey.transfer.action, 'widen');
  assert.equal(byKey.expedite.action, 'rollback');
  assert.ok(byKey.expedite.mon.alarm.day >= byKey.expedite.type.drift.day, 'no alarm before the simulated onset');
});
