import { addState, emptyNFA, freshState, resetCounter } from '../builder';
import type { NFA } from '../../automaton/types';
import type { Pattern } from './index';

/**
 * Bounded-range pattern (placeholder for v1.1):
 *   { α^n | k1 >= n >= k2 } where both bounds are constants.
 *
 * Currently returns false so other patterns handle these. Will be promoted
 * once we add schematic ellipsis rendering for large ranges.
 */
export const boundedRangePattern: Pattern = {
  name: 'bounded-range',
  matches() {
    return false;
  },
  build(): NFA {
    resetCounter();
    const s = freshState(true);
    const nfa = emptyNFA(s);
    addState; // keep import live
    return nfa;
  },
};
