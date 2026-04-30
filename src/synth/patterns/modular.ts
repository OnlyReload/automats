import type { ArithExpr, Constraint } from '../../dsl/ast';
import type { NFA } from '../../automaton/types';
import { addState, addTransition, emptyNFA, freshState, resetCounter, setAccept } from '../builder';
import type { Block } from '../skeleton';
import type { Pattern, PatternContext } from './index';

export interface ModInfo {
  modVar: string;
  eqVar: string;
  modulus: number;
  constraint: Constraint;
}

/**
 * Modular pattern:
 *   Skeleton is a sequence of single-char literal blocks where exactly two
 *   blocks have variable exponents (`α^n` and `γ^m`, both with coeff=1,
 *   offset=0), the n-block precedes the m-block, and the only cross-variable
 *   constraint is `n % k = m` (or symmetric). Other blocks have constant
 *   exponents. n and m are otherwise non-negative; the modular equation plus
 *   m >= 0 forces m ∈ [0, k-1].
 *
 * Construction:
 *   - Build a k-state cycle on α^n's literal, tracking n mod k.
 *   - Duplicate every block AFTER the n-block once per residue r ∈ [0, k-1].
 *   - In the per-residue copy, the m-block becomes a chain of exactly r m-literals.
 *   - The final state of each per-residue copy is accepting.
 */
export const modularPattern: Pattern = {
  name: 'modular',

  matches(ctx) {
    return analyse(ctx) !== null;
  },

  build(ctx) {
    const plan = analyse(ctx)!;
    return construct(ctx, plan);
  },
};

interface Plan {
  mod: ModInfo;
  modBlockIdx: number;
  eqBlockIdx: number;
}

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

  const mod = findModConstraint(ctx.bounds.rawRels);
  if (!mod) return null;
  if (mod.modulus < 1 || mod.modulus > 32) return null;

  const modBlock = varBlocks.find(({ b }) => (b.exponent as any).name === mod.modVar);
  const eqBlock = varBlocks.find(({ b }) => (b.exponent as any).name === mod.eqVar);
  if (!modBlock || !eqBlock) return null;
  if (modBlock.i >= eqBlock.i) return null; // require n-block before m-block

  // Reject exotic extra constraints. We allow:
  //   - the modular constraint itself
  //   - single-variable bounds (handled by computeBounds; harmless here)
  //   - wordVarDecl (no word vars in this pattern; safe to ignore)
  for (const c of ctx.bounds.rawRels) {
    if (c === mod.constraint) continue;
    if (c.kind !== 'rel') continue;
    const used = new Set<string>();
    for (const op of c.operands) collectVars(op, used);
    if (used.size > 1) return null;
  }

  // m must be allowed to take values 0..k-1. Check bounds aren't tighter.
  const mRange = ctx.bounds.ranges.get(mod.eqVar);
  if (mRange && (mRange.min > 0 || mRange.max < mod.modulus - 1)) return null;
  // n must allow at least one value in each residue class. n unbounded above
  // is the typical case; if bounded, the existing bounded patterns can take
  // over (we just decline here).
  const nRange = ctx.bounds.ranges.get(mod.modVar);
  if (nRange && nRange.max !== Infinity) return null;

  return { mod, modBlockIdx: modBlock.i, eqBlockIdx: eqBlock.i };
}

function construct(ctx: PatternContext, plan: Plan): NFA {
  resetCounter();
  const { mod, modBlockIdx, eqBlockIdx } = plan;
  const k = mod.modulus;

  const start = freshState(false);
  const nfa = emptyNFA(start);

  // Phase 1: blocks before the n-block. All constants — single chain.
  let preTail = start.id;
  for (let i = 0; i < modBlockIdx; i++) {
    const blk = ctx.litBlocks[i] as Extract<Block, { kind: 'lit' }>;
    if (blk.exponent.kind !== 'const') return start.accept ? nfa : nfa; // shouldn't happen
    preTail = appendConstChain(nfa, preTail, blk.literal, blk.exponent.value);
  }

  // Phase 2: n-block — k-state cycle.
  const cycle: string[] = [preTail];
  for (let r = 1; r < k; r++) {
    const s = freshState(false);
    addState(nfa, s);
    cycle.push(s.id);
  }
  const nLit = (ctx.litBlocks[modBlockIdx] as Extract<Block, { kind: 'lit' }>).literal;
  for (let r = 0; r < k; r++) {
    addTransition(nfa, { from: cycle[r], to: cycle[(r + 1) % k], symbol: nLit });
  }

  // Phase 3: blocks after the n-block, duplicated per residue. After the
  // m-block, each residue r consumes exactly r copies of the m-literal.
  const heads: string[] = cycle.slice();
  for (let i = modBlockIdx + 1; i < ctx.litBlocks.length; i++) {
    const blk = ctx.litBlocks[i] as Extract<Block, { kind: 'lit' }>;
    for (let r = 0; r < k; r++) {
      if (i === eqBlockIdx) {
        heads[r] = appendConstChain(nfa, heads[r], blk.literal, r);
      } else {
        if (blk.exponent.kind !== 'const') return nfa; // declined in analyse
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

export function findModConstraint(rels: Constraint[]): ModInfo | null {
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    if (c.ops.length !== 1 || c.ops[0] !== '=') continue;
    const [a, b] = c.operands;
    const fromA = matchModExpr(a);
    if (fromA && b.kind === 'var') {
      return { modVar: fromA.varName, eqVar: b.name, modulus: fromA.modulus, constraint: c };
    }
    const fromB = matchModExpr(b);
    if (fromB && a.kind === 'var') {
      return { modVar: fromB.varName, eqVar: a.name, modulus: fromB.modulus, constraint: c };
    }
  }
  return null;
}

function matchModExpr(e: ArithExpr): { varName: string; modulus: number } | null {
  if (e.kind !== 'binop' || e.op !== '%') return null;
  if (e.left.kind === 'var' && e.right.kind === 'int' && e.right.value > 0) {
    return { varName: e.left.name, modulus: e.right.value };
  }
  return null;
}

function collectVars(e: ArithExpr, out: Set<string>): void {
  if (e.kind === 'var') out.add(e.name);
  else if (e.kind === 'binop') {
    collectVars(e.left, out);
    collectVars(e.right, out);
  }
}
