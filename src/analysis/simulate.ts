import type { DFA } from './dfa';

export function dfaAccepts(d: DFA, w: string): boolean {
  let s = d.start;
  for (const c of w) {
    const t = d.delta[s].get(c);
    if (t === undefined) return false;
    s = t;
  }
  return d.accept.has(s);
}

/**
 * Enumerate accepted and rejected words (over `alphabet`) up to length
 * `maxLen`. Returns at most `cap` of each.
 */
export function enumerateSamples(
  d: DFA,
  alphabet: string[],
  maxLen = 5,
  cap = 12,
): { accepted: string[]; rejected: string[] } {
  const accepted: string[] = [];
  const rejected: string[] = [];
  const stack: string[] = [''];
  // BFS by length so we hit short strings first.
  const queue: string[] = [''];
  while (queue.length) {
    const w = queue.shift()!;
    if (w.length > maxLen) break;
    if (dfaAccepts(d, w)) {
      if (accepted.length < cap) accepted.push(w);
    } else if (rejected.length < cap) rejected.push(w);
    if (accepted.length >= cap && rejected.length >= cap) break;
    if (w.length === maxLen) continue;
    for (const a of alphabet) queue.push(w + a);
  }
  void stack;
  return { accepted, rejected };
}
