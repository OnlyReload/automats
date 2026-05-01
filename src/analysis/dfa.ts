import type { NFA } from '../automaton/types';
import { EPSILON } from '../automaton/types';

/**
 * Total deterministic finite automaton. `delta[stateIndex][symbol]` is the
 * destination state index. State indices are 0..states-1; `dead` is the
 * implicit dead-state index used to totalise the transition table — it is
 * always present and equal to `delta.length - 1` after `totalise`.
 */
export interface DFA {
  states: number;
  start: number;
  accept: Set<number>;
  alphabet: string[];
  /** delta[s] is a Map symbol -> destination state. Total. */
  delta: Map<string, number>[];
}

export function alphabetOf(nfa: NFA): string[] {
  const set = new Set<string>();
  for (const t of nfa.transitions) {
    if (t.symbol !== EPSILON) set.add(t.symbol);
  }
  for (const s of nfa.alphabet ?? []) if (s !== EPSILON) set.add(s);
  return [...set].sort();
}

function epsClosure(nfa: NFA, ids: Iterable<string>): Set<string> {
  const out = new Set<string>(ids);
  const stack = [...out];
  while (stack.length) {
    const s = stack.pop()!;
    for (const t of nfa.transitions) {
      if (t.from === s && t.symbol === EPSILON && !out.has(t.to)) {
        out.add(t.to);
        stack.push(t.to);
      }
    }
  }
  return out;
}

function move(nfa: NFA, ids: Set<string>, sym: string): Set<string> {
  const out = new Set<string>();
  for (const t of nfa.transitions) {
    if (t.symbol === sym && ids.has(t.from)) out.add(t.to);
  }
  return out;
}

function setKey(s: Set<string>): string {
  return [...s].sort().join('');
}

/** Subset construction. Adds a dead sink so the DFA is total. */
export function nfaToDfa(nfa: NFA, alphabet?: string[]): DFA {
  const sigma = alphabet ?? alphabetOf(nfa);
  const accept = new Set(nfa.states.filter((s) => s.accept).map((s) => s.id));

  const startSet = epsClosure(nfa, [nfa.start]);
  const subsets: Set<string>[] = [startSet];
  const index = new Map<string, number>();
  index.set(setKey(startSet), 0);
  const delta: Map<string, number>[] = [];
  const acceptSet = new Set<number>();

  // Reserve dead state at the end after BFS.
  let i = 0;
  while (i < subsets.length) {
    const cur = subsets[i];
    const row = new Map<string, number>();
    for (const a of sigma) {
      const next = epsClosure(nfa, move(nfa, cur, a));
      const k = setKey(next);
      let idx = index.get(k);
      if (idx === undefined) {
        idx = subsets.length;
        index.set(k, idx);
        subsets.push(next);
      }
      row.set(a, idx);
    }
    delta.push(row);
    let isAccept = false;
    for (const id of cur) if (accept.has(id)) { isAccept = true; break; }
    if (isAccept) acceptSet.add(i);
    i++;
  }

  // Replace the empty-set state (if any) with an explicit dead state.
  // Subset construction may produce an empty subset for unreachable transitions;
  // it's already a self-trap because move(∅) = ∅.
  return {
    states: subsets.length,
    start: 0,
    accept: acceptSet,
    alphabet: sigma,
    delta,
  };
}

/** Hopcroft-style partition refinement. Returns minimal DFA over reachable states. */
export function minimizeDfa(dfa: DFA): DFA {
  // Drop unreachable states first.
  const reachable = new Set<number>([dfa.start]);
  const stack = [dfa.start];
  while (stack.length) {
    const s = stack.pop()!;
    for (const a of dfa.alphabet) {
      const t = dfa.delta[s].get(a)!;
      if (!reachable.has(t)) { reachable.add(t); stack.push(t); }
    }
  }
  const reachList = [...reachable].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  reachList.forEach((s, i) => remap.set(s, i));
  const r = (s: number) => remap.get(s)!;

  const n = reachList.length;
  const accept = new Set<number>();
  const delta: Map<string, number>[] = [];
  for (const s of reachList) {
    const row = new Map<string, number>();
    for (const a of dfa.alphabet) row.set(a, r(dfa.delta[s].get(a)!));
    delta.push(row);
    if (dfa.accept.has(s)) accept.add(r(s));
  }

  // Partition refinement.
  let partition: Set<number>[] = [];
  const accSet = new Set<number>(); const nonSet = new Set<number>();
  for (let s = 0; s < n; s++) (accept.has(s) ? accSet : nonSet).add(s);
  if (accSet.size) partition.push(accSet);
  if (nonSet.size) partition.push(nonSet);

  let changed = true;
  while (changed) {
    changed = false;
    const next: Set<number>[] = [];
    const classOf = new Map<number, number>();
    partition.forEach((cls, i) => cls.forEach((s) => classOf.set(s, i)));
    for (const cls of partition) {
      const groups = new Map<string, Set<number>>();
      for (const s of cls) {
        const sig = dfa.alphabet.map((a) => classOf.get(delta[s].get(a)!)).join(',');
        if (!groups.has(sig)) groups.set(sig, new Set());
        groups.get(sig)!.add(s);
      }
      if (groups.size > 1) changed = true;
      for (const g of groups.values()) next.push(g);
    }
    partition = next;
  }

  // Build minimal DFA. Make sure start's class is index 0.
  const classOf = new Map<number, number>();
  partition.forEach((cls, i) => cls.forEach((s) => classOf.set(s, i)));
  const startClass = classOf.get(0)!;
  const order = [startClass, ...partition.map((_, i) => i).filter((i) => i !== startClass)];
  const orderIndex = new Map<number, number>();
  order.forEach((c, i) => orderIndex.set(c, i));

  const newStates = partition.length;
  const newDelta: Map<string, number>[] = [];
  const newAccept = new Set<number>();
  for (let i = 0; i < newStates; i++) newDelta.push(new Map());
  for (let i = 0; i < newStates; i++) {
    const cls = partition[order[i]];
    const rep = cls.values().next().value as number;
    for (const a of dfa.alphabet) {
      const t = delta[rep].get(a)!;
      newDelta[i].set(a, orderIndex.get(classOf.get(t)!)!);
    }
    if (accept.has(rep)) newAccept.add(i);
  }
  return { states: newStates, start: 0, accept: newAccept, alphabet: dfa.alphabet, delta: newDelta };
}

/**
 * Decide whether two DFAs accept the same language. The DFAs must share an
 * alphabet (we union them first if not). Uses product construction + BFS.
 */
export function equivalent(a: DFA, b: DFA): boolean {
  const sigma = [...new Set([...a.alphabet, ...b.alphabet])].sort();
  const A = liftAlphabet(a, sigma);
  const B = liftAlphabet(b, sigma);
  const seen = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;
  const stack: [number, number][] = [[A.start, B.start]];
  seen.add(key(A.start, B.start));
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (A.accept.has(x) !== B.accept.has(y)) return false;
    for (const c of sigma) {
      const nx = A.delta[x].get(c)!;
      const ny = B.delta[y].get(c)!;
      const k = key(nx, ny);
      if (!seen.has(k)) { seen.add(k); stack.push([nx, ny]); }
    }
  }
  return true;
}

/** Re-express DFA over a (super)alphabet by routing missing symbols to a fresh dead state. */
function liftAlphabet(d: DFA, sigma: string[]): DFA {
  const same = d.alphabet.length === sigma.length && d.alphabet.every((s, i) => s === sigma[i]);
  if (same) return d;
  const dead = d.states;
  const delta: Map<string, number>[] = [];
  for (let s = 0; s < d.states; s++) {
    const row = new Map<string, number>();
    for (const c of sigma) {
      const v = d.delta[s].get(c);
      row.set(c, v === undefined ? dead : v);
    }
    delta.push(row);
  }
  const deadRow = new Map<string, number>();
  for (const c of sigma) deadRow.set(c, dead);
  delta.push(deadRow);
  return { states: d.states + 1, start: d.start, accept: new Set(d.accept), alphabet: sigma, delta };
}

// ── DFA combinators (intersection, union, complement) ──────────────────────

export function complementDfa(d: DFA): DFA {
  const accept = new Set<number>();
  for (let s = 0; s < d.states; s++) if (!d.accept.has(s)) accept.add(s);
  return { ...d, accept };
}

export function productDfa(a: DFA, b: DFA, op: 'and' | 'or'): DFA {
  const sigma = [...new Set([...a.alphabet, ...b.alphabet])].sort();
  const A = liftAlphabet(a, sigma);
  const B = liftAlphabet(b, sigma);
  const states: [number, number][] = [];
  const idx = new Map<string, number>();
  const queue: [number, number][] = [];
  const start: [number, number] = [A.start, B.start];
  idx.set(`${start[0]},${start[1]}`, 0);
  states.push(start); queue.push(start);
  const delta: Map<string, number>[] = [new Map()];
  const accept = new Set<number>();
  while (queue.length) {
    const cur = queue.shift()!;
    const ci = idx.get(`${cur[0]},${cur[1]}`)!;
    const isAcc = op === 'and'
      ? A.accept.has(cur[0]) && B.accept.has(cur[1])
      : A.accept.has(cur[0]) || B.accept.has(cur[1]);
    if (isAcc) accept.add(ci);
    for (const c of sigma) {
      const nx: [number, number] = [A.delta[cur[0]].get(c)!, B.delta[cur[1]].get(c)!];
      const k = `${nx[0]},${nx[1]}`;
      let ni = idx.get(k);
      if (ni === undefined) {
        ni = states.length;
        idx.set(k, ni);
        states.push(nx);
        delta.push(new Map());
        queue.push(nx);
      }
      delta[ci].set(c, ni);
    }
  }
  return { states: states.length, start: 0, accept, alphabet: sigma, delta };
}

export function isEmpty(d: DFA): boolean {
  if (!d.accept.size) return true;
  const seen = new Set<number>([d.start]);
  const stack = [d.start];
  while (stack.length) {
    const s = stack.pop()!;
    if (d.accept.has(s)) return false;
    for (const a of d.alphabet) {
      const t = d.delta[s].get(a)!;
      if (!seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  return true;
}
