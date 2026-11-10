// Re-simulation check: how often does each rule delegate a size bucket whose TRUE miss
// rate is above the target? Usage: node scripts/validate.mjs [reps]
import * as A from '../core/authority.js';

const reps = Number(process.argv[2] || 1000);
for (const p of [
  { alpha: 0.05, delta: 0.05, tau: 0.25, rejections: 'worst' },
  { alpha: 0.03, delta: 0.05, tau: 0.25, rejections: 'worst' },
  { alpha: 0.05, delta: 0.10, tau: 0.15, rejections: 'worst' },
]) {
  const v = A.validate(p, reps, 1000);
  const f = (s) => `${(100 * s.viol / s.total).toFixed(1)}% (${s.viol}/${s.total})`;
  console.log(`alpha=${p.alpha} delta=${p.delta} tau=${p.tau}`);
  console.log(`  certified, rejections as misses : ${f(v.cert)}  widened ${(100 * v.certWiden / v.cert.total).toFixed(0)}%`);
  console.log(`  certified, rejections excluded  : ${f(v.optimistic)}`);
  console.log(`  point-estimate rule             : ${f(v.naive)}  widened ${(100 * v.naiveWiden / v.naive.total).toFixed(0)}%`);
}
// e-process false alarms at p = alpha over 400 actions, and detection delay at 4x alpha
const T = { ...A.TYPES[0], L0: 1 };
const seq = (p, seed) => { const R = A.rng(seed); return Array.from({ length: 400 }, (_, i) => ({ i, type: 0, day: A.CERT_END_DAY + Math.floor(i / 10), hour: i % 10, size: 2, status: 1, ratio: R() < p ? 0.2 : 1 })); };
let fa = 0, det = 0, lag = 0;
for (let s = 0; s < 2000; s++) if (A.monitor(seq(0.05, s), T, 1, 10, { alpha: 0.05, tau: 0.25, toDay: 1e4 }).alarm) fa++;
for (let s = 0; s < 1000; s++) { const m = A.monitor(seq(0.2, 9000 + s), T, 1, 10, { alpha: 0.05, tau: 0.25, toDay: 1e4 }); if (m.alarm) { det++; lag += m.alarm.n; } }
console.log(`e-process: false alarms at p = alpha over 400 actions ${(100 * fa / 2000).toFixed(1)}% (bound 5%); detection at p = 4 alpha ${(100 * det / 1000).toFixed(1)}%, mean ${(lag / det).toFixed(0)} actions`);
