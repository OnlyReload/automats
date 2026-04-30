import type { PDA, PDATransition } from '../../automaton/pda';
import { PDA_EPSILON, PDA_STACK_BOTTOM } from '../../automaton/pda';
import type { Block } from '../skeleton';
import type { PdaContext, PdaPattern } from './index';

/**
 * Sandwich PDA pattern: { A^n M B^n | n >= 0, M = a regular middle }.
 *
 * The classifier flags this with rule R2 — the same variable `n` appears in two
 * non-adjacent literal blocks (e.g. `a^n b^m a^n` from L11). The middle is a
 * sequence of free constant or var blocks (each var bounded or unbounded with
 * no cross-var constraints, treated as "free reads").
 *
 * Construction:
 *   - q_push: read A's, push A.
 *   - q_mid:  read middle chars freely (any subset of the alphabet associated
 *             with middle blocks), regardless of stack top.
 *   - q_pop:  read A's at the end, pop A.
 *   - q_acc:  reached when stack returns to S.
 *
 * For simplicity, we accept any single-char middle block whose exponent is a
 * var (unbounded ≥ 0) or a constant. The middle's free reads peek at any of
 * {S, A} (the only stack tops that can occur during the run).
 */
export const sandwichPdaPattern: PdaPattern = {
  name: 'pda-sandwich',
  matches(ctx) {
    return analyse(ctx) !== null;
  },
  build(ctx) {
    const plan = analyse(ctx)!;
    return construct(plan);
  },
};

interface MiddleSegment {
  literal: string;
  // "free" means accept zero-or-more of literal; "fixed n" means exactly n.
  kind: 'free' | 'fixed';
  count?: number;
}

interface Plan {
  prefixLiterals: string[];   // const blocks before the first var-block
  varName: string;
  literal: string;            // the literal of the matching pair
  middle: MiddleSegment[];    // blocks between the two matching var-blocks
}

function analyse(ctx: PdaContext): Plan | null {
  const cls = ctx.classification;
  if (cls.kind !== 'nonRegular' || cls.rule !== 'R2') return null;

  const blocks = ctx.skeleton.blocks;
  if (blocks.some((b) => b.kind !== 'lit')) return null;
  const lits = blocks as Extract<Block, { kind: 'lit' }>[];
  if (lits.some((b) => b.literal.length !== 1)) return null;

  // Find a variable that appears as bare-var exponent in two distinct-literal
  // blocks (with the same literal — that's the "matching" pair).
  const varOccurrences = new Map<string, number[]>();
  for (let i = 0; i < lits.length; i++) {
    const b = lits[i];
    if (b.exponent.kind !== 'var') continue;
    if (b.exponent.coeff !== 1 || b.exponent.offset !== 0) continue;
    const arr = varOccurrences.get(b.exponent.name) ?? [];
    arr.push(i);
    varOccurrences.set(b.exponent.name, arr);
  }

  for (const [varName, idxs] of varOccurrences) {
    if (idxs.length !== 2) continue;
    const [iA, iB] = idxs;
    if (iA + 1 === iB) continue; // adjacent → linearConstrained
    if (lits[iA].literal !== lits[iB].literal) continue; // need same literal for matching

    // Verify: the middle blocks are all "free" (var blocks with no cross-var
    // constraints) or constant blocks.
    const middle: MiddleSegment[] = [];
    let middleOk = true;
    const middleVars = new Set<string>();
    for (let k = iA + 1; k < iB; k++) {
      const b = lits[k];
      if (b.exponent.kind === 'const') {
        middle.push({ literal: b.literal, kind: 'fixed', count: b.exponent.value });
      } else {
        if (b.exponent.coeff !== 1 || b.exponent.offset !== 0) { middleOk = false; break; }
        middleVars.add(b.exponent.name);
        middle.push({ literal: b.literal, kind: 'free' });
      }
    }
    if (!middleOk) continue;

    // No cross-var constraints involving the matching var or middle vars.
    if (hasComplexConstraints(ctx, varName, middleVars)) continue;

    // Trailing blocks AFTER iB are not handled.
    if (iB !== lits.length - 1) continue;

    // Prefix blocks before iA must all be constants.
    const prefixLiterals: string[] = [];
    let prefixOk = true;
    for (let k = 0; k < iA; k++) {
      const b = lits[k];
      if (b.exponent.kind !== 'const') { prefixOk = false; break; }
      for (let r = 0; r < b.exponent.value; r++) prefixLiterals.push(b.literal);
    }
    if (!prefixOk) continue;

    return {
      prefixLiterals,
      varName,
      literal: lits[iA].literal,
      middle,
    };
  }
  return null;
}

function hasComplexConstraints(
  ctx: PdaContext,
  matchVar: string,
  middleVars: Set<string>
): boolean {
  for (const c of ctx.decl.constraints) {
    if (c.kind !== 'rel') continue;
    const used = new Set<string>();
    for (const op of c.operands) collectVars(op, used);
    if (!used.has(matchVar) && [...middleVars].every((v) => !used.has(v))) continue;
    // Allow "pure bound" relations (var REL const). Disallow anything else.
    if (!c.operands.every((op) => op.kind === 'var' || op.kind === 'int')) return true;
    if (used.size > 1) return true;
  }
  return false;
}

function construct(plan: Plan): PDA {
  const transitions: PDATransition[] = [];
  let counter = 0;
  const fresh = () => `q${counter++}`;

  const litA = plan.literal;
  const stackAlphabet = new Set<string>([PDA_STACK_BOTTOM, litA]);
  const inputAlphabet = new Set<string>([litA]);
  for (const ch of plan.prefixLiterals) inputAlphabet.add(ch);
  for (const seg of plan.middle) inputAlphabet.add(seg.literal);

  // 1. Prefix chain.
  const startState = fresh();
  let prefixTail = startState;
  for (const ch of plan.prefixLiterals) {
    const next = fresh();
    transitions.push({
      from: prefixTail, to: next,
      inputSymbol: ch,
      stackTop: PDA_STACK_BOTTOM,
      action: { pop: false, pushSymbols: [] },
    });
    prefixTail = next;
  }

  // 2. Push phase (read A's).
  const qPush = fresh();
  transitions.push({
    from: prefixTail, to: qPush,
    inputSymbol: PDA_EPSILON,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [] },
  });
  transitions.push({
    from: qPush, to: qPush,
    inputSymbol: litA,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [litA] },
  });
  transitions.push({
    from: qPush, to: qPush,
    inputSymbol: litA,
    stackTop: litA,
    action: { pop: false, pushSymbols: [litA] },
  });

  // 3. Middle phase. We enter via ε from qPush regardless of top.
  const qMid = fresh();
  transitions.push({
    from: qPush, to: qMid,
    inputSymbol: PDA_EPSILON,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [] },
  });
  transitions.push({
    from: qPush, to: qMid,
    inputSymbol: PDA_EPSILON,
    stackTop: litA,
    action: { pop: false, pushSymbols: [] },
  });
  // Middle reads: process each middle segment in order.
  let midTail = qMid;
  for (const seg of plan.middle) {
    if (seg.kind === 'fixed') {
      // Fixed chain — read the literal exactly seg.count times.
      for (let r = 0; r < (seg.count ?? 0); r++) {
        const next = fresh();
        transitions.push({
          from: midTail, to: next,
          inputSymbol: seg.literal,
          stackTop: PDA_STACK_BOTTOM,
          action: { pop: false, pushSymbols: [] },
        });
        transitions.push({
          from: midTail, to: next,
          inputSymbol: seg.literal,
          stackTop: litA,
          action: { pop: false, pushSymbols: [] },
        });
        midTail = next;
      }
    } else {
      // Free — self-loop on midTail with this literal (zero or more reads).
      transitions.push({
        from: midTail, to: midTail,
        inputSymbol: seg.literal,
        stackTop: PDA_STACK_BOTTOM,
        action: { pop: false, pushSymbols: [] },
      });
      transitions.push({
        from: midTail, to: midTail,
        inputSymbol: seg.literal,
        stackTop: litA,
        action: { pop: false, pushSymbols: [] },
      });
    }
  }

  // 4. Pop phase.
  const qPop = fresh();
  transitions.push({
    from: midTail, to: qPop,
    inputSymbol: PDA_EPSILON,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [] },
  });
  transitions.push({
    from: midTail, to: qPop,
    inputSymbol: PDA_EPSILON,
    stackTop: litA,
    action: { pop: false, pushSymbols: [] },
  });
  transitions.push({
    from: qPop, to: qPop,
    inputSymbol: litA,
    stackTop: litA,
    action: { pop: true, pushSymbols: [] },
  });

  // 5. Accept.
  const qAcc = fresh();
  transitions.push({
    from: qPop, to: qAcc,
    inputSymbol: PDA_EPSILON,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [] },
  });

  const stateIds = new Set<string>();
  for (const t of transitions) { stateIds.add(t.from); stateIds.add(t.to); }
  stateIds.add(startState);
  const states = [...stateIds].map((id) => ({ id, accept: id === qAcc }));

  return {
    kind: 'pda',
    states,
    start: startState,
    initialStack: PDA_STACK_BOTTOM,
    inputAlphabet: [...inputAlphabet],
    stackAlphabet: [...stackAlphabet],
    transitions,
  };
}

function collectVars(e: { kind: string; name?: string; left?: unknown; right?: unknown }, out: Set<string>): void {
  if (e.kind === 'var') out.add(e.name as string);
  else if (e.kind === 'binop') {
    collectVars(e.left as { kind: string }, out);
    collectVars(e.right as { kind: string }, out);
  }
}
