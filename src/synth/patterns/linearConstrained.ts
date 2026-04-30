import type { ArithExpr, Constraint } from '../../dsl/ast';
import type { NFA } from '../../automaton/types';
import { addState, addTransition, emptyNFA, freshState, resetCounter, setAccept } from '../builder';
import type { Pattern, PatternContext } from './index';

/**
 * Linear-constrained pattern (same-literal collapse):
 *   { α^n α^m | constraints over n,m } collapses to { α^(n+m) | ... }, which is
 *   regular for any constraint set as long as the achievable values of n+m form
 *   an arithmetic progression with finite description (min, step, optional max).
 *
 * We brute-force enumerate (n,m) pairs over a sane window to recover (min,
 * step, max) of the n+m totals. This handles inequalities (`n>m`, `n>=m`),
 * equalities (`n=m`, `n=m+c`, `n=2m`), and combinations with lower/upper
 * bounds — exactly the shapes that show up when two same-literal blocks are
 * adjacent in the textbook DSL.
 */
const ENUMERATION_CAP = 60;

interface CollapseDomain {
  min: number;
  step: number;
  max: number; // Infinity if unbounded above
}

export const linearConstrainedPattern: Pattern = {
  name: 'linear-constrained',
  matches(ctx) {
    if (ctx.litBlocks.length !== 2) return false;
    const [a, b] = ctx.litBlocks;
    if (a.literal !== b.literal) return false;
    if (a.exponent.kind !== 'var' || b.exponent.kind !== 'var') return false;
    if (a.exponent.coeff !== 1 || a.exponent.offset !== 0) return false;
    if (b.exponent.coeff !== 1 || b.exponent.offset !== 0) return false;
    if (a.exponent.name === b.exponent.name) return false;
    return computeDomain(ctx, a.exponent.name, b.exponent.name) !== null;
  },
  build(ctx) {
    resetCounter();
    const [a, b] = ctx.litBlocks;
    const nName = (a.exponent as any).name as string;
    const mName = (b.exponent as any).name as string;
    const dom = computeDomain(ctx, nName, mName)!;
    return buildSingleBlock(ctx.litBlocks[0].literal, dom);
  },
};

function computeDomain(
  ctx: PatternContext,
  nName: string,
  mName: string
): CollapseDomain | null {
  const nRange = ctx.bounds.ranges.get(nName) ?? { min: 0, max: Infinity };
  const mRange = ctx.bounds.ranges.get(mName) ?? { min: 0, max: Infinity };
  const nLo = nRange.min;
  const mLo = mRange.min;
  const nHi = Number.isFinite(nRange.max) ? Math.min(nRange.max, ENUMERATION_CAP) : ENUMERATION_CAP;
  const mHi = Number.isFinite(mRange.max) ? Math.min(mRange.max, ENUMERATION_CAP) : ENUMERATION_CAP;

  // Collect cross-var constraints between n and m (skip pure single-var bounds).
  const rels: Constraint[] = [];
  for (const c of ctx.bounds.rawRels) {
    if (c.kind !== 'rel') continue;
    const used = new Set<string>();
    for (const op of c.operands) collectVars(op, used);
    if (used.has(nName) || used.has(mName)) rels.push(c);
  }

  const totals = new Set<number>();
  for (let nv = nLo; nv <= nHi; nv++) {
    for (let mv = mLo; mv <= mHi; mv++) {
      if (rels.every((c) => satisfies(c, { [nName]: nv, [mName]: mv }))) {
        totals.add(nv + mv);
      }
    }
  }
  if (totals.size === 0) return null;

  const sorted = [...totals].sort((a, b) => a - b);
  const min = sorted[0];

  // step = gcd of differences from min
  let step = 0;
  for (const t of sorted) step = gcd(step, t - min);
  if (step === 0) step = 1; // single value

  // bounded above iff max-achievable < both caps
  const bothBounded = Number.isFinite(nRange.max) && Number.isFinite(mRange.max);
  const max = bothBounded ? sorted[sorted.length - 1] : Infinity;

  // Sanity: every value in [min, max] (with step) should be achievable. If not,
  // the language shape is more complex than a simple AP and we bail.
  const expected: number[] = [];
  if (Number.isFinite(max)) {
    for (let v = min; v <= max; v += step) expected.push(v);
  } else {
    for (let v = min; v <= min + step * 20 && v <= sorted[sorted.length - 1]; v += step) {
      expected.push(v);
    }
  }
  for (const v of expected) {
    if (!totals.has(v)) return null;
  }
  return { min, step, max };
}

function buildSingleBlock(literal: string, dom: CollapseDomain): NFA {
  const start = freshState(false);
  const nfa = emptyNFA(start);

  // Strategy: build a chain of "boundary" states q_0, q_1, ... where q_i marks
  // having read exactly i copies of `literal`. For literal length L > 1, each
  // boundary is L chars apart. q_i accepts iff i is in the achievable totals
  // (i = min + step*k, also <= max if bounded).

  if (dom.max !== Infinity) {
    let cur = start.id;
    if (achievable(0, dom)) start.accept = true;
    for (let i = 1; i <= dom.max; i++) {
      cur = appendOneRep(nfa, cur, literal);
      if (achievable(i, dom)) setAccept(nfa, cur, true);
    }
    return nfa;
  }

  // Unbounded above: chain of `min` mandatory reps, then a cycle of `step` reps.
  let cur = start.id;
  if (dom.min === 0) start.accept = true;
  for (let i = 1; i <= dom.min; i++) {
    cur = appendOneRep(nfa, cur, literal);
    // Only the last (i = min) is "achievable so far"; intermediates aren't.
  }
  setAccept(nfa, cur, true); // i = min, achievable.
  const cycleEntry = cur;

  // Cycle of `step` repetitions back to cycleEntry.
  let prev = cycleEntry;
  for (let r = 0; r < dom.step; r++) {
    const isLast = r === dom.step - 1;
    prev = appendOneRepWithTarget(nfa, prev, literal, isLast ? cycleEntry : null);
    // Boundary at position min + r + 1. Achievable only if last (= min + step).
  }
  return nfa;
}

function achievable(i: number, dom: CollapseDomain): boolean {
  if (i < dom.min) return false;
  if (i > dom.max) return false;
  return (i - dom.min) % dom.step === 0;
}

function appendOneRep(nfa: NFA, from: string, literal: string): string {
  let cur = from;
  for (const ch of literal) {
    const next = freshState(false);
    addState(nfa, next);
    addTransition(nfa, { from: cur, to: next.id, symbol: ch });
    if (!nfa.alphabet.includes(ch)) nfa.alphabet.push(ch);
    cur = next.id;
  }
  return cur;
}

// Like appendOneRep but the LAST char-transition's target can be overridden
// (used to close the cycle back to a specific state). Returns the final
// target id.
function appendOneRepWithTarget(
  nfa: NFA,
  from: string,
  literal: string,
  finalTargetOverride: string | null
): string {
  let cur = from;
  for (let i = 0; i < literal.length; i++) {
    const isLast = i === literal.length - 1;
    const ch = literal[i];
    let target: string;
    if (isLast && finalTargetOverride !== null) {
      target = finalTargetOverride;
    } else {
      const next = freshState(false);
      addState(nfa, next);
      target = next.id;
    }
    addTransition(nfa, { from: cur, to: target, symbol: ch });
    if (!nfa.alphabet.includes(ch)) nfa.alphabet.push(ch);
    cur = target;
  }
  return cur;
}

function satisfies(c: Constraint, env: Record<string, number>): boolean {
  if (c.kind !== 'rel') return true;
  const vals = c.operands.map((e) => evalExpr(e, env));
  for (let i = 0; i < c.ops.length; i++) {
    const a = vals[i];
    const b = vals[i + 1];
    if (a === null || b === null) return false;
    switch (c.ops[i]) {
      case '=': if (a !== b) return false; break;
      case '>=': if (!(a >= b)) return false; break;
      case '<=': if (!(a <= b)) return false; break;
      case '>': if (!(a > b)) return false; break;
      case '<': if (!(a < b)) return false; break;
    }
  }
  return true;
}

function evalExpr(e: ArithExpr, env: Record<string, number>): number | null {
  if (e.kind === 'int') return e.value;
  if (e.kind === 'var') return env[e.name] ?? null;
  const l = evalExpr(e.left, env);
  const r = evalExpr(e.right, env);
  if (l === null || r === null) return null;
  switch (e.op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return r === 0 ? null : Math.trunc(l / r);
    case '%': return r === 0 ? null : ((l % r) + r) % r;
  }
}

function collectVars(e: ArithExpr, out: Set<string>): void {
  if (e.kind === 'var') out.add(e.name);
  else if (e.kind === 'binop') {
    collectVars(e.left, out);
    collectVars(e.right, out);
  }
}

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b > 0) { [a, b] = [b, a % b]; }
  return a;
}
