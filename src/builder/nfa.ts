import type { NFA, State, Transition } from '../automaton/types';

export type Tool = 'addState' | 'addTransition' | 'toggleAccept' | 'setStart' | 'delete' | 'pan';

/** Position cache: map state-id → {x,y}. Lives outside the NFA so the
 * NFA itself stays a clean logical model. */
export type PositionMap = Record<string, { x: number; y: number }>;

export interface BuilderState {
  nfa: NFA;
  positions: PositionMap;
  /** Counter for fresh state ids. */
  nextId: number;
}

export function emptyBuilder(): BuilderState {
  return {
    nfa: { states: [], start: '', transitions: [], alphabet: [] },
    positions: {},
    nextId: 0,
  };
}

export function addState(b: BuilderState, x: number, y: number): BuilderState {
  const id = `q${b.nextId}`;
  const state: State = { id, accept: false, label: id };
  const nfa: NFA = {
    ...b.nfa,
    states: [...b.nfa.states, state],
    start: b.nfa.start || id,
  };
  return {
    nfa,
    positions: { ...b.positions, [id]: { x, y } },
    nextId: b.nextId + 1,
  };
}

export function deleteState(b: BuilderState, id: string): BuilderState {
  const states = b.nfa.states.filter((s) => s.id !== id);
  const transitions = b.nfa.transitions.filter((t) => t.from !== id && t.to !== id);
  const start = b.nfa.start === id ? states[0]?.id ?? '' : b.nfa.start;
  const positions = { ...b.positions };
  delete positions[id];
  return { ...b, nfa: { ...b.nfa, states, transitions, start }, positions };
}

export function deleteTransition(b: BuilderState, idx: number): BuilderState {
  const transitions = b.nfa.transitions.filter((_, i) => i !== idx);
  return { ...b, nfa: { ...b.nfa, transitions, alphabet: rebuildAlphabet(transitions) } };
}

/** Delete every transition between a specific (from, to) pair. Useful when
 * the user clicks an edge in the rendered graph — edges are bundled by pair
 * so a single visual click should remove the bundle. */
export function deleteEdgePair(b: BuilderState, from: string, to: string): BuilderState {
  const transitions = b.nfa.transitions.filter((t) => !(t.from === from && t.to === to));
  return { ...b, nfa: { ...b.nfa, transitions, alphabet: rebuildAlphabet(transitions) } };
}

export function toggleAccept(b: BuilderState, id: string): BuilderState {
  const states = b.nfa.states.map((s) =>
    s.id === id ? { ...s, accept: !s.accept } : s
  );
  return { ...b, nfa: { ...b.nfa, states } };
}

export function setStart(b: BuilderState, id: string): BuilderState {
  return { ...b, nfa: { ...b.nfa, start: id } };
}

export function addTransition(b: BuilderState, from: string, to: string, symbols: string[]): BuilderState {
  const existing = new Set(
    b.nfa.transitions.filter((t) => t.from === from && t.to === to).map((t) => t.symbol)
  );
  const fresh: Transition[] = [];
  for (const sym of symbols) {
    const s = sym.trim();
    if (!s) continue;
    if (existing.has(s)) continue;
    fresh.push({ from, to, symbol: s });
    existing.add(s);
  }
  if (!fresh.length) return b;
  const transitions = [...b.nfa.transitions, ...fresh];
  return { ...b, nfa: { ...b.nfa, transitions, alphabet: rebuildAlphabet(transitions) } };
}

export function setPosition(b: BuilderState, id: string, x: number, y: number): BuilderState {
  return { ...b, positions: { ...b.positions, [id]: { x, y } } };
}

function rebuildAlphabet(transitions: Transition[]): string[] {
  const set = new Set<string>();
  for (const t of transitions) if (t.symbol !== 'ε') set.add(t.symbol);
  return [...set].sort();
}
