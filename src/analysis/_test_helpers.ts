// Re-export private template builders for unit tests.
import type { DFA } from './dfa';
import { complementDfa } from './dfa';

function dfa(states: number, start: number, accept: number[], alphabet: string[], rows: Array<Record<string, number>>): DFA {
  const delta: Map<string, number>[] = rows.map((r) => {
    const m = new Map<string, number>();
    for (const a of alphabet) m.set(a, r[a] ?? states - 1);
    return m;
  });
  return { states, start, accept: new Set(accept), alphabet, delta };
}

export function dfaCountMod(c: string, k: number, r: number, alphabet: string[]): DFA {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < k; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) row[a] = a === c ? (i + 1) % k : i;
    rows.push(row);
  }
  return dfa(k, 0, [r], alphabet, rows);
}

export function dfaContains(w: string, alphabet: string[]): DFA {
  const m = w.length;
  const rows: Record<string, number>[] = [];
  for (let i = 0; i <= m; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) {
      if (i === m) { row[a] = m; continue; }
      const candidate = w.slice(0, i) + a;
      let next = 0;
      for (let len = Math.min(m, candidate.length); len > 0; len--) {
        if (w.startsWith(candidate.slice(candidate.length - len))) { next = len; break; }
      }
      row[a] = next;
    }
    rows.push(row);
  }
  return dfa(m + 1, 0, [m], alphabet, rows);
}

export function dfaAvoids(w: string, alphabet: string[]): DFA {
  return complementDfa(dfaContains(w, alphabet));
}
