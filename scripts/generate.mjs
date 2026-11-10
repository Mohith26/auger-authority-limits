// Seeded synthetic decision history for the demo (Jun 1 - Nov 10 2026).
// Usage: node scripts/generate.mjs [seed]
import { writeFileSync } from 'node:fs';
import { generate } from '../core/authority.js';

const seed = Number(process.argv[2] || 20261110);
const data = generate(seed);
delete data.cols.q; // latent disruption probability is simulator truth, not part of the record
writeFileSync(new URL('../data/decisions.json', import.meta.url), JSON.stringify(data));
const n = data.cols.type.length;
console.log(`wrote data/decisions.json: ${n} actions, seed ${seed}`);
