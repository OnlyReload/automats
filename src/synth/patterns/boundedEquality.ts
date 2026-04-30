import type { Constraint } from '../../dsl/ast';
import type { NFA } from '../../automaton/types';
import { addState, addTransition, emptyNFA, freshState, resetCounter, setAccept } from '../builder';
import type { Block } from '../skeleton';
import type { Pattern, PatternContext } from './index';

interface EqInfo {
  varA: string;
  varB: string;
  constraint: Constraint;
}

interface Plan {
  eq: EqInfo;
  firstBlockIdx: number;  // which block holds the FIRST-occurring var
  secondBlockIdx: number; // which block holds the SECOND-occurring var
  H: number;              // shared upper bound (so both vars ∈ [0, H])
}

/**
 * Bounded-equality pattern:
 *   Two var-blocks A^n and B^m (in that order, single-char literals, coeff=1
 *   offset=0), linked by `n = m` (or `m = n`), with at least one of the vars
 *   bounded above by a constant. Constant-exponent blocks may appear anywhere.
 *
 * Without bounds this language ({ a^n b^n }) is the canonical non-CFL — the
 * classifier rejects that case. Here we only fire when bounds make it regular.
 *
 * Construction mirrors the modular pattern: a linear "count chain" on the
 * first var's literal of length H+1, then per-count-i tail that reads the
 * remaining blocks with the second var's chain length pinned to i.
 */
export const boundedEqualityPattern: Pattern = {
  name: 'bounded-equality',

  matches(ctx) {
    return analyse(ctx) !== null;
  },

  build(ctx) {
    const plan = analyse(ctx)!;
    return construct(ctx, plan);
  },
};

function analyse(ctx: PatternContext): Plan | null {
  if (ctx.litBlocks.length < 2) return null;
  if (ctx.litBlocks.some((b) => b.literal.length !== 1)) return null;

  const varBlocks = ctx.litBlocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.exponent.kind === 'var');
  if (varBlocks.length !== 2) return null;
  for (const { b } of varBlocks) {
    if (b.exponent.kind !== 'var') return null;
    if (b.exponent.coeff !== 1 || b.exponent.offset !== 0) return null;
  }

  const eq = findEqConstraint(ctx.bounds.rawRels);
  if (!eq) return null;

  // Both vars must correspond to var-blocks.
  const varNames = new Set(varBlocks.map(({ b }) => (b.exponent as any).name as string));
  if (!varNames.has(eq.varA) || !varNames.has(eq.varB)) return null;
  if (eq.varA === eq.varB) return null;

  // Reject extra cross-var constraints.
  for (const c of ctx.bounds.rawRels) {
    if (c === eq.constraint || c.kind !== 'rel') continue;
    const used = new Set<string>();
    for (const op of c.operands) collectVars(op, used);
    if (used.size > 1) return null;
  }

  // At least one var must have a finite upper bound.
  const aR = ctx.bounds.ranges.get(eq.varA);
  const bR = ctx.bounds.ranges.get(eq.varB);
  const aMax = aR?.max ?? Infinity;
  const bMax = bR?.max ?? Infinity;
  const H = Math.min(aMax, bMax);
  if (!Number.isFinite(H)) return null;
  if (H > 1000) return null; // sanity cap; bounded patterns above this aren't practical
  if ((aR?.min ?? 0) > 0 || (bR?.min ?? 0) > 0) return null; // require min=0 for now

  // Determine which var-block comes first in the skeleton.
  const aBlock = varBlocks.find(({ b }) => (b.exponent as any).name === eq.varA)!;
  const bBlock = varBlocks.find(({ b }) => (b.exponent as any).name === eq.varB)!;
  const first = aBlock.i < bBlock.i ? aBlock : bBlock;
  const second = aBlock.i < bBlock.i ? bBlock : aBlock;

  return { eq, firstBlockIdx: first.i, secondBlockIdx: second.i, H };
}

function construct(ctx: PatternContext, plan: Plan): NFA {
  resetCounter();
  const { firstBlockIdx, secondBlockIdx, H } = plan;

  const start = freshState(false);
  const nfa = emptyNFA(start);

  // Phase 1: blocks before the first var-block — single chain.
  let preTail = start.id;
  for (let i = 0; i < firstBlockIdx; i++) {
    const blk = ctx.litBlocks[i] as Extract<Block, { kind: 'lit' }>;
    if (blk.exponent.kind !== 'const') return nfa;
    preTail = appendConstChain(nfa, preTail, blk.literal, blk.exponent.value);
  }

  // Phase 2: first var-block — chain of H+1 states (each represents count i).
  const countStates: string[] = [preTail];
  const firstLit = (ctx.litBlocks[firstBlockIdx] as Extract<Block, { kind: 'lit' }>).literal;
  for (let i = 1; i <= H; i++) {
    const next = freshState(false);
    addState(nfa, next);
    addTransition(nfa, { from: countStates[i - 1], to: next.id, symbol: firstLit });
    countStates.push(next.id);
  }

  // Phase 3: blocks after first var-block, duplicated per count i.
  // At the second-var-block, each branch consumes exactly i second-literals.
  const heads: string[] = countStates.slice();
  for (let i = firstBlockIdx + 1; i < ctx.litBlocks.length; i++) {
    const blk = ctx.litBlocks[i] as Extract<Block, { kind: 'lit' }>;
    for (let r = 0; r <= H; r++) {
      if (i === secondBlockIdx) {
        heads[r] = appendConstChain(nfa, heads[r], blk.literal, r);
      } else {
        if (blk.exponent.kind !== 'const') return nfa;
        heads[r] = appendConstChain(nfa, heads[r], blk.literal, blk.exponent.value);
      }
    }
  }

  for (const id of heads) setAccept(nfa, id, true);
  return nfa;
}

function appendConstChain(nfa: NFA, from: string, literal: string, count: number): string {
  let cur = from;
  for (let i = 0; i < count; i++) {
    for (const ch of literal) {
      const next = freshState(false);
      addState(nfa, next);
      addTransition(nfa, { from: cur, to: next.id, symbol: ch });
      cur = next.id;
    }
  }
  return cur;
}

function findEqConstraint(rels: Constraint[]): EqInfo | null {
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    if (c.ops.length !== 1 || c.ops[0] !== '=') continue;
    const [a, b] = c.operands;
    if (a.kind === 'var' && b.kind === 'var') {
      return { varA: a.name, varB: b.name, constraint: c };
    }
  }
  return null;
}

function collectVars(e: any, out: Set<string>): void {
  if (e.kind === 'var') out.add(e.name);
  else if (e.kind === 'binop') {
    collectVars(e.left, out);
    collectVars(e.right, out);
  }
}
