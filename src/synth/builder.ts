import type { NFA, State, Symbol, Transition } from '../automaton/types';
import { EPSILON } from '../automaton/types';

let stateCounter = 0;

export function freshState(accept = false): State {
  return { id: `q${stateCounter++}`, accept };
}

export function resetCounter(): void {
  stateCounter = 0;
}

export function emptyNFA(start: State): NFA {
  return { states: [start], start: start.id, transitions: [], alphabet: [] };
}

export function addState(nfa: NFA, s: State): void {
  nfa.states.push(s);
}

export function addTransition(nfa: NFA, t: Transition): void {
  nfa.transitions.push(t);
  if (t.symbol !== EPSILON && !nfa.alphabet.includes(t.symbol)) {
    nfa.alphabet.push(t.symbol);
  }
}

export function setAccept(nfa: NFA, id: string, accept = true): void {
  const s = nfa.states.find((x) => x.id === id);
  if (s) s.accept = accept;
}

/**
 * Append a literal-loop block: from state `from`, consuming `literal` repeatedly
 * (zero or more times) and ending at state `to`. Implemented as a chain of
 * fresh intermediate states for multi-char literals, with a back-edge from the
 * end of the chain to `from` (so the whole literal repeats).
 *
 * For single-char literals, this collapses to a self-loop on `from`.
 *
 * Caller decides accept-state semantics: this function just builds the loop.
 */
export function addLoopBlock(
  nfa: NFA,
  from: string,
  literal: string,
  loopBackToFrom = true
): { exit: string } {
  if (literal.length === 0) {
    return { exit: from };
  }
  if (literal.length === 1) {
    addTransition(nfa, { from, to: from, symbol: literal });
    return { exit: from };
  }
  // Multi-char loop: from -- l[0] --> s1 -- l[1] --> s2 ... -- l[n-1] --> from
  let prev = from;
  for (let i = 0; i < literal.length - 1; i++) {
    const next = freshState(false);
    addState(nfa, next);
    addTransition(nfa, { from: prev, to: next.id, symbol: literal[i] });
    prev = next.id;
  }
  const last = literal[literal.length - 1];
  const target = loopBackToFrom ? from : prev;
  addTransition(nfa, { from: prev, to: target, symbol: last });
  return { exit: target };
}

/**
 * Append a fixed-count chain (literal^k) from `from`, returning the new tail.
 * Each repetition is a sequence of states, ending at a fresh state.
 */
export function addFixedChain(nfa: NFA, from: string, literal: string, k: number): string {
  let cur = from;
  for (let i = 0; i < k; i++) {
    for (const ch of literal) {
      const next = freshState(false);
      addState(nfa, next);
      addTransition(nfa, { from: cur, to: next.id, symbol: ch });
      cur = next.id;
    }
  }
  return cur;
}

export function ensureAlphabet(nfa: NFA, syms: Symbol[]): void {
  for (const s of syms) {
    if (!nfa.alphabet.includes(s)) nfa.alphabet.push(s);
  }
}
