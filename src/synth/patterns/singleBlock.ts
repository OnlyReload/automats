import type { NFA } from '../../automaton/types';
import { addLoopBlock, addState, addFixedChain, emptyNFA, freshState, resetCounter } from '../builder';
import type { Pattern } from './index';

/**
 * Single-block pattern: { α^n | n >= 0 } or { α^k } for constant k or
 * { α^n | bounded n }.
 *
 * Examples it handles:
 *   - { a^n | n >= 0 }              → one self-looping accept state
 *   - { a^n | n >= 1 }              → start + accept loop
 *   - { (xy)^n | n >= 0 }           → multi-state loop, q0 accept
 *   - { a^3 }                       → fixed 3-step chain
 */
export const singleBlockPattern: Pattern = {
  name: 'single-block',

  matches(ctx) {
    if (ctx.litBlocks.length !== 1) return false;
    const block = ctx.litBlocks[0];
    // Only handle bare-bound constraints — defer modular/arithmetic to
    // generalSequential so we don't silently ignore them.
    for (const c of ctx.bounds.rawRels) {
      if (c.kind !== 'rel') continue;
      if (!c.operands.every((op) => op.kind === 'var' || op.kind === 'int')) {
        return false;
      }
    }
    // Variable exponent must be coeff=1, offset=0 here (other forms hit
    // generalSequential's broader machinery — or were collapsed earlier).
    if (block.exponent.kind === 'var') {
      if (block.exponent.coeff !== 1 || block.exponent.offset !== 0) return false;
    }
    return true;
  },

  build(ctx) {
    resetCounter();
    const block = ctx.litBlocks[0];
    const start = freshState(false);
    const nfa = emptyNFA(start);

    if (block.exponent.kind === 'const') {
      // Fixed power: chain of (literal repeated value times).
      const tail = addFixedChain(nfa, start.id, block.literal, block.exponent.value);
      // start and tail accept iff value satisfies; with exponent value k, only k repetitions
      // means only the tail state accepts.
      if (block.exponent.value === 0) {
        start.accept = true;
      } else {
        const tailState = nfa.states.find((s) => s.id === tail);
        if (tailState) tailState.accept = true;
      }
      return nfa;
    }

    // Variable exponent: handle the n >= min form.
    const min = ctx.bounds.ranges.get(block.exponent.name)?.min ?? 0;
    const max = ctx.bounds.ranges.get(block.exponent.name)?.max ?? Infinity;
    const coeff = block.exponent.coeff;
    const offset = block.exponent.offset;

    // Effective minimum and maximum repetitions of the literal:
    //   reps = coeff * n + offset, where n in [min, max]
    const repsMin = coeff * min + offset;
    const repsMax = max === Infinity ? Infinity : coeff * max + offset;

    if (repsMax === Infinity) {
      // Build a fixed prefix of length repsMin, then a loop on the literal.
      const prefixEnd = addFixedChain(nfa, start.id, block.literal, Math.max(0, repsMin));
      addLoopBlock(nfa, prefixEnd, block.literal, true);
      const tail = nfa.states.find((s) => s.id === prefixEnd);
      if (tail) tail.accept = true;
      return nfa;
    }

    // Bounded above: linear chain of accept states at each valid count.
    let cur = start.id;
    if (repsMin === 0) start.accept = true;
    for (let r = 1; r <= repsMax; r++) {
      for (const ch of block.literal) {
        const next = freshState(false);
        addState(nfa, next);
        // We use a literal-step so each char advances one state.
        nfa.transitions.push({ from: cur, to: next.id, symbol: ch });
        if (!nfa.alphabet.includes(ch)) nfa.alphabet.push(ch);
        cur = next.id;
      }
      if (r >= repsMin) {
        const tail = nfa.states.find((s) => s.id === cur);
        if (tail) tail.accept = true;
      }
    }
    return nfa;
  },
};

// Helper used by other patterns: build a "literal^var, var in [min, max]" segment.
// Returns the start state id and the set of accept-eligible state ids.
export function buildLoopSegment(
  nfa: NFA,
  fromId: string,
  literal: string,
  repsMin: number,
  repsMax: number
): { acceptables: string[] } {
  const acceptables: string[] = [];
  if (repsMax === Infinity) {
    let cur = fromId;
    for (let r = 0; r < repsMin; r++) {
      for (const ch of literal) {
        const next = freshState(false);
        addState(nfa, next);
        nfa.transitions.push({ from: cur, to: next.id, symbol: ch });
        if (!nfa.alphabet.includes(ch)) nfa.alphabet.push(ch);
        cur = next.id;
      }
    }
    addLoopBlock(nfa, cur, literal, true);
    acceptables.push(cur);
    return { acceptables };
  }
  // Bounded above: chain.
  let cur = fromId;
  if (repsMin === 0) acceptables.push(cur);
  for (let r = 1; r <= repsMax; r++) {
    for (const ch of literal) {
      const next = freshState(false);
      addState(nfa, next);
      nfa.transitions.push({ from: cur, to: next.id, symbol: ch });
      if (!nfa.alphabet.includes(ch)) nfa.alphabet.push(ch);
      cur = next.id;
    }
    if (r >= repsMin) acceptables.push(cur);
  }
  return { acceptables };
}
