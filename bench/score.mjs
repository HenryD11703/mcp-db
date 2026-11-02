import { spec } from './spec-select.mjs';

const { truth } = spec;

const norm = (s) => s.toLowerCase();
export const edgeKey = (child, parent) => `${norm(child)}->${norm(parent)}`;

/** `found`: array of { child: 'TABLE.col', parent: 'TABLE.col' } (any case). */
export function score(found) {
  const expected = new Map(truth.map((e) => [edgeKey(e.child, e.parent), e]));
  const got = new Set(found.map((e) => edgeKey(e.child, e.parent)));
  const tp = [...got].filter((k) => expected.has(k));
  const fp = [...got].filter((k) => !expected.has(k));
  const fn = [...expected.keys()].filter((k) => !got.has(k));
  const hardAll = truth.filter((e) => e.hard).map((e) => edgeKey(e.child, e.parent));
  const precision = got.size ? tp.length / got.size : 0;
  const recall = tp.length / expected.size;
  return {
    truthEdges: expected.size,
    found: got.size,
    truePositives: tp.length,
    falsePositives: fp,
    missed: fn,
    precision: +precision.toFixed(3),
    recall: +recall.toFixed(3),
    f1: precision + recall ? +((2 * precision * recall) / (precision + recall)).toFixed(3) : 0,
    hardRecall: `${hardAll.filter((k) => got.has(k)).length}/${hardAll.length}`
  };
}
