import type { NFA, State, Transition } from './types';

/**
 * Add an explicit trap (sink) state to an NFA — מצב מלכודת.
 *
 * For every (state, symbol) pair where the original NFA has no transition,
 * add a transition into the trap. The trap state is non-accepting and has a
 * self-loop on every alphabet symbol, so once you fall in you can never leave
 * and you can never accept. This makes the NFA "complete" without changing
 * the language it accepts.
 *
 * Returns the original NFA unchanged when every (state, symbol) already has
 * a transition.
 */
export const TRAP_ID = '__trap__';
export const TRAP_LABEL = 'מלכודת';

export function addTrapState(nfa: NFA): NFA {
  if (nfa.alphabet.length === 0 || nfa.states.length === 0) return nfa;

  // Quick check: do we even need a trap?
  let needsTrap = false;
  outer: for (const state of nfa.states) {
    for (const symbol of nfa.alphabet) {
      const has = nfa.transitions.some((t) => t.from === state.id && t.symbol === symbol);
      if (!has) { needsTrap = true; break outer; }
    }
  }
  if (!needsTrap) return nfa;

  const states: State[] = [
    ...nfa.states,
    { id: TRAP_ID, accept: false, label: TRAP_LABEL },
  ];
  const transitions: Transition[] = [...nfa.transitions];

  for (const state of nfa.states) {
    for (const symbol of nfa.alphabet) {
      const has = nfa.transitions.some((t) => t.from === state.id && t.symbol === symbol);
      if (!has) {
        transitions.push({ from: state.id, to: TRAP_ID, symbol });
      }
    }
  }

  // Trap absorbs everything: self-loop on every symbol.
  for (const symbol of nfa.alphabet) {
    transitions.push({ from: TRAP_ID, to: TRAP_ID, symbol });
  }

  return {
    ...nfa,
    states,
    transitions,
  };
}
