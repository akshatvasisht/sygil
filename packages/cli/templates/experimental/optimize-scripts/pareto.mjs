// Pure Pareto-dominance primitives for the optimize template.
// Pure ESM with no deps — import from Node scripts AND from vitest.ts tests.
//
// Fitness objective (fixed for v0): maximize gatePassRate, minimize costUsd.
// See decisions.md 2026-04-20 "`sygil optimize` ships as a template".

/**
 * @typedef {Object} Candidate
 * @property {string} id // "candidate-0", "candidate-1",...
 * @property {number} gatePassRate // [0, 1]
 * @property {number} costUsd // >= 0
 * @property {number} [durationMs] // optional, recorded for observability
 * @property {string} [innerRunId] // optional pointer to the inner run
 */

const EPS = 1e-9;

/**
 * Does candidate `a` Pareto-dominate candidate `b`?
 * `a` dominates `b` iff `a` is no worse on every objective AND strictly better on at least one.
 * Objectives: gatePassRate (max), costUsd (min).
 *
 * @param {Candidate} a
 * @param {Candidate} b
 * @returns {boolean}
 */
export function dominates(a, b) {
 const aPassGE = a.gatePassRate >= b.gatePassRate - EPS;
 const aCostLE = a.costUsd <= b.costUsd + EPS;
 if (!(aPassGE && aCostLE)) return false;
 const aPassGT = a.gatePassRate > b.gatePassRate + EPS;
 const aCostLT = a.costUsd < b.costUsd - EPS;
 return aPassGT || aCostLT;
}

/**
 * Add a candidate to an archive and prune dominated entries.
 * Returns a new archive (does not mutate the input).
 *
 * Rules:
 * - if any existing entry dominates the new one, return the archive unchanged
 * - otherwise drop every existing entry the new one dominates, append new
 * - ties (equal on every objective) are kept — callers can dedupe by id if they care
 *
 * @param {Candidate[]} archive
 * @param {Candidate} entry
 * @returns {Candidate[]}
 */
export function updateFrontier(archive, entry) {
 for (const existing of archive) {
 if (dominates(existing, entry)) return [...archive];
 }
 const survivors = archive.filter((existing) => !dominates(entry, existing));
 survivors.push(entry);
 return survivors;
}

/**
 * Sum the costUsd field across an archive.
 * @param {Candidate[]} archive
 * @returns {number}
 */
export function totalCost(archive) {
 return archive.reduce((sum, c) => sum + (Number.isFinite(c.costUsd) ? c.costUsd : 0), 0);
}
