import type { NFA } from '../../automaton/types';
import { determinize } from './operations';

/**
 * Try to enumerate every word accepted by the NFA, sorted by length then
 * lexicographically. Returns:
 *   - { kind: 'finite', words } — full list (always under `limit`)
 *   - { kind: 'infinite' }     — language has a reachable productive cycle
 *   - { kind: 'tooLarge' }     — finite but exceeds `limit`
 */
export type EnumResult =
  | { kind: 'finite'; words: string[] }
  | { kind: 'infinite' }
  | { kind: 'tooLarge' };

export function enumerateLanguage(nfa: NFA, limit = 64): EnumResult {
  const dfa = determinize(nfa, nfa.alphabet);
  const step = new Map<string, Map<string, string>>();
  const accept = new Set<string>();
  for (const s of dfa.states) {
    step.set(s.id, new Map());
    if (s.accept) accept.add(s.id);
  }
  for (const t of dfa.transitions) step.get(t.from)!.set(t.symbol, t.to);

  // States that can reach an accepting state (productive states).
  const rev = new Map<string, string[]>();
  for (const s of dfa.states) rev.set(s.id, []);
  for (const t of dfa.transitions) rev.get(t.to)!.push(t.from);
  const productive = new Set<string>(accept);
  const queue = [...accept];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const p of rev.get(cur) ?? []) {
      if (!productive.has(p)) {
        productive.add(p);
        queue.push(p);
      }
    }
  }
  if (!productive.has(dfa.start)) return { kind: 'finite', words: [] };

  // Cycle detection in the productive subgraph (3-color DFS).
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const s of productive) color.set(s, WHITE);
  const successors = (id: string): string[] => {
    const out: string[] = [];
    for (const to of step.get(id)!.values()) {
      if (productive.has(to)) out.push(to);
    }
    return out;
  };
  for (const s of productive) {
    if (color.get(s) !== WHITE) continue;
    const stack: { id: string; succ: string[]; i: number }[] = [];
    color.set(s, GRAY);
    stack.push({ id: s, succ: successors(s), i: 0 });
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i >= top.succ.length) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const v = top.succ[top.i++];
      const c = color.get(v) ?? BLACK;
      if (c === GRAY) return { kind: 'infinite' };
      if (c === WHITE) {
        color.set(v, GRAY);
        stack.push({ id: v, succ: successors(v), i: 0 });
      }
    }
  }

  // Finite — enumerate accepted words.
  const words: string[] = [];
  let overflow = false;
  const dfs = (id: string, word: string): void => {
    if (overflow) return;
    if (accept.has(id)) {
      if (words.length >= limit) {
        overflow = true;
        return;
      }
      words.push(word);
    }
    for (const [sym, to] of step.get(id)!) {
      if (!productive.has(to)) continue;
      dfs(to, word + sym);
      if (overflow) return;
    }
  };
  dfs(dfa.start, '');
  if (overflow) return { kind: 'tooLarge' };

  words.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return { kind: 'finite', words };
}

export function formatFinite(words: string[]): string {
  if (words.length === 0) return '∅';
  return `{${words.map((w) => (w === '' ? 'ε' : w)).join(', ')}}`;
}
