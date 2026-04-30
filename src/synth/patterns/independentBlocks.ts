import type { NFA, State } from '../../automaton/types';
import { addState, emptyNFA, freshState, resetCounter } from '../builder';
import type { Pattern } from './index';

/**
 * Independent blocks pattern: { α₁^v₁ α₂^v₂ … αₖ^vₖ | each vᵢ has its own
 * single-variable bounds, no cross-block constraints }.
 *
 * Canonical construction (textbook-style, single-char literals):
 *   - One "phase" state per segment q_i, all accept iff every later segment
 *     can take 0 (true here since vᵢ ≥ 0 unless tightened).
 *   - Self-loop at q_i on the segment's char.
 *   - Forward edges: from q_i, for every j ≥ i, on the first char of segment_j
 *     go to q_j. This lets the machine skip empty later segments and advance
 *     when it sees a later segment's first character.
 *
 * For multi-char literals, we expand each segment into a literal-cycle of
 * states; the "head" of the cycle plays the role of q_i above, and forward
 * edges connect heads.
 */
export const independentBlocksPattern: Pattern = {
  name: 'independent-blocks',

  matches(ctx) {
    if (ctx.litBlocks.length < 1) return false;

    // Reject if two blocks share the same variable (handled elsewhere or non-regular).
    const seenVars = new Set<string>();
    for (const b of ctx.litBlocks) {
      if (b.exponent.kind === 'var') {
        if (seenVars.has(b.exponent.name)) return false;
        seenVars.add(b.exponent.name);
      }
    }
    // Reject any constraint involving more than one variable, OR any single-var
    // constraint that isn't a plain bare-var bound (e.g. `n % 2 = 0` is on one
    // var but isn't a bound — we must defer to a constraint-aware builder).
    for (const c of ctx.bounds.rawRels) {
      if (c.kind !== 'rel') continue;
      const used = new Set<string>();
      for (const op of c.operands) collectVars(op, used);
      if (used.size > 1) return false;
      if (used.size === 1 && !isPureBound(c)) return false;
    }

    // Require all literals to be single-char for the canonical construction.
    // (Multi-char independent blocks like (xy)*(zw)* fall back to a future
    // pattern; (xy)^n (xy)^m is handled by linearConstrained collapse.)
    if (ctx.litBlocks.some((b) => b.literal.length !== 1)) return false;

    // Only fire the canonical (every block min=0, max=∞) branch — the chain
    // branch is buggy for mixed const/var blocks. Defer those to
    // generalSequential.
    for (const b of ctx.litBlocks) {
      if (b.exponent.kind === 'const') return false;
      const r = ctx.bounds.ranges.get(b.exponent.name) ?? { min: 0, max: Infinity };
      if (r.min !== 0 || r.max !== Infinity) return false;
    }

    return true;
  },

  build(ctx) {
    resetCounter();
    // Effective [min, max] for each block's literal-repetition count.
    const mins = ctx.litBlocks.map((b) => effectiveMin(b, ctx));
    const maxs = ctx.litBlocks.map((b) => effectiveMax(b, ctx));

    // For v1 simplicity, this pattern only supports unbounded blocks where
    // min = 0 (i.e. plain `n >= 0`). Bounded or min>0 cases fall to other
    // patterns later. If any segment has min > 0 or max < ∞, bail out.
    if (mins.some((m) => m > 0) || maxs.some((m) => m !== Infinity)) {
      // Build a chain that handles min/max constraints by unrolling.
      return buildChainConstruction(ctx, mins, maxs);
    }

    // Canonical phase-state construction.
    const phases: State[] = ctx.litBlocks.map(() => freshState(true));
    const start = phases[0];
    const nfa = emptyNFA(start);
    for (let i = 1; i < phases.length; i++) addState(nfa, phases[i]);

    for (let i = 0; i < ctx.litBlocks.length; i++) {
      const litI = ctx.litBlocks[i].literal;
      // Self-loop on phase i for its own char.
      nfa.transitions.push({ from: phases[i].id, to: phases[i].id, symbol: litI });
      if (!nfa.alphabet.includes(litI)) nfa.alphabet.push(litI);
      // Forward edges to every later phase j on phase j's first char.
      for (let j = i + 1; j < ctx.litBlocks.length; j++) {
        const litJ = ctx.litBlocks[j].literal;
        nfa.transitions.push({ from: phases[i].id, to: phases[j].id, symbol: litJ });
        if (!nfa.alphabet.includes(litJ)) nfa.alphabet.push(litJ);
      }
    }
    return nfa;
  },
};

function buildChainConstruction(
  ctx: { litBlocks: { literal: string }[] },
  mins: number[],
  maxs: number[]
): NFA {
  // Generic builder: unroll each segment into a chain of state-edges. For
  // unbounded max, the last node of the chain has a self-loop on its symbol.
  resetCounter();
  const start = freshState(false);
  const nfa = emptyNFA(start);

  // For each segment, we build either a fixed chain (if max < ∞) or a
  // prefix-chain-of-min then self-loop (if max == ∞).
  let cur: string = start.id;
  const segmentExits: string[] = []; // state where segment i is "complete enough"

  for (let i = 0; i < ctx.litBlocks.length; i++) {
    const lit = ctx.litBlocks[i].literal;
    const min = mins[i];
    const max = maxs[i];

    // First: take `min` mandatory copies.
    for (let r = 0; r < min; r++) {
      const next = freshState(false);
      addState(nfa, next);
      nfa.transitions.push({ from: cur, to: next.id, symbol: lit });
      if (!nfa.alphabet.includes(lit)) nfa.alphabet.push(lit);
      cur = next.id;
    }

    if (max === Infinity) {
      // Self-loop on cur for the rest.
      nfa.transitions.push({ from: cur, to: cur, symbol: lit });
      segmentExits.push(cur);
    } else {
      const optional = max - min;
      let acceptableHere = cur;
      for (let r = 0; r < optional; r++) {
        const next = freshState(false);
        addState(nfa, next);
        nfa.transitions.push({ from: acceptableHere, to: next.id, symbol: lit });
        if (!nfa.alphabet.includes(lit)) nfa.alphabet.push(lit);
        acceptableHere = next.id;
      }
      segmentExits.push(acceptableHere);
      cur = acceptableHere;
    }
  }

  // All segment-exit states accept; also start accepts iff every segment can take 0.
  if (mins.every((m) => m === 0)) start.accept = true;
  for (const id of segmentExits) {
    const s = nfa.states.find((x) => x.id === id);
    if (s) s.accept = true;
  }
  return nfa;
}

function effectiveMin(
  b: { exponent: { kind: 'const'; value: number } | { kind: 'var'; name: string; coeff: number; offset: number } },
  ctx: { bounds: { ranges: Map<string, { min: number; max: number }> } }
): number {
  const exp = b.exponent;
  if (exp.kind === 'const') return Math.max(0, exp.value);
  const r = ctx.bounds.ranges.get(exp.name);
  const min = r?.min ?? 0;
  return Math.max(0, exp.coeff * min + exp.offset);
}

function effectiveMax(
  b: { exponent: { kind: 'const'; value: number } | { kind: 'var'; name: string; coeff: number; offset: number } },
  ctx: { bounds: { ranges: Map<string, { min: number; max: number }> } }
): number {
  const exp = b.exponent;
  if (exp.kind === 'const') return Math.max(0, exp.value);
  const r = ctx.bounds.ranges.get(exp.name);
  if (!r || r.max === Infinity) return Infinity;
  return Math.max(0, exp.coeff * r.max + exp.offset);
}

function collectVars(e: { kind: string; name?: string; left?: unknown; right?: unknown }, out: Set<string>): void {
  if (e.kind === 'var') out.add(e.name as string);
  if (e.kind === 'binop') {
    collectVars(e.left as { kind: string }, out);
    collectVars(e.right as { kind: string }, out);
  }
}

// A "pure bound" constraint is a single-var relation where every operand is
// either a bare variable or a constant (no `%`, no arithmetic). Allows things
// like `n >= 0`, `n = 5`, `0 <= n <= 10` but rejects `n % 2 = 0`.
function isPureBound(c: { operands: { kind: string }[] }): boolean {
  for (const op of c.operands) {
    if (op.kind !== 'var' && op.kind !== 'int') return false;
  }
  return true;
}
