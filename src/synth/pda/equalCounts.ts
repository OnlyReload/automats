import type { Constraint } from '../../dsl/ast';
import type { PDA, PDATransition } from '../../automaton/pda';
import { PDA_EPSILON, PDA_STACK_BOTTOM } from '../../automaton/pda';
import type { Block } from '../skeleton';
import type { PdaContext, PdaPattern } from './index';

/**
 * Equal-counts PDA pattern.
 *
 * Handles `{ A^n B^m | n = m, n,m unbounded }` and `{ A^n B^n | n unbounded }`,
 * with A and B distinct single-char literals. Constant-exponent blocks are
 * allowed in the prefix and between the two var-blocks.
 *
 * Construction (textbook):
 *   States:
 *     - prefix-chain (one state per constant char in any prefix block)
 *     - q_push        (push phase: read A's, push A on stack)
 *     - q_pop         (pop phase:  read B's, pop A from stack)
 *     - q_acc         (accepting; reached when stack returns to S)
 *
 *   Initial stack: S (bottom marker).
 *
 *   Transitions:
 *     - q_push, A, S       → q_push,  דחוף A
 *     - q_push, A, A       → q_push,  דחוף A
 *     - q_push, ε, S       → q_acc                 (n = m = 0 case)
 *     - q_push, B, A       → q_pop,   שלוף         (start popping on first B)
 *     - q_pop,  B, A       → q_pop,   שלוף
 *     - q_pop,  ε, S       → q_acc                 (stack empty → success)
 */
export const equalCountsPdaPattern: PdaPattern = {
  name: 'pda-equal-counts',
  matches(ctx) {
    return analyse(ctx) !== null;
  },
  build(ctx) {
    const plan = analyse(ctx)!;
    return construct(plan);
  },
};

interface Plan {
  prefixLiterals: string[];   // ordered list of single-char literals from constant prefix blocks (BEFORE both var blocks)
  middleLiterals: string[];   // ordered list of single-char literals from constant blocks BETWEEN the two var blocks
  varA: string;               // first var name (push phase var)
  varB: string;               // second var name (pop phase var)
  litA: string;               // literal of var-A's block
  litB: string;               // literal of var-B's block
}

function analyse(ctx: PdaContext): Plan | null {
  // Must be classified as nonRegular with rule R4 OR R2 with `n = m` shape
  // hidden behind same-var (a^n b^n literal). We accept both routes here.
  const cls = ctx.classification;
  if (cls.kind !== 'nonRegular') return null;
  if (cls.rule !== 'R4' && cls.rule !== 'R2') return null;

  const blocks = ctx.skeleton.blocks;
  // Every block must be a literal block.
  if (blocks.some((b) => b.kind !== 'lit')) return null;
  const lits = blocks as Extract<Block, { kind: 'lit' }>[];
  if (lits.some((b) => b.literal.length !== 1)) return null;

  // Find var-blocks (kind=var, coeff=1, offset=0).
  const varBlocks: { idx: number; name: string; literal: string }[] = [];
  for (let i = 0; i < lits.length; i++) {
    const b = lits[i];
    if (b.exponent.kind !== 'var') continue;
    if (b.exponent.coeff !== 1 || b.exponent.offset !== 0) return null;
    varBlocks.push({ idx: i, name: b.exponent.name, literal: b.literal });
  }

  // Two scenarios:
  //  (a) Two distinct vars n, m equated (R4): { A^n B^m | n = m }
  //  (b) Same var in two distinct-literal blocks (R2): { A^n B^n }
  let varA: { idx: number; name: string; literal: string };
  let varB: { idx: number; name: string; literal: string };

  if (varBlocks.length === 2 && varBlocks[0].name !== varBlocks[1].name) {
    // (a) — require an `=` constraint between the two vars (with no other
    // cross-var constraints).
    if (!hasBareEquality(ctx.decl.constraints, varBlocks[0].name, varBlocks[1].name)) return null;
    if (hasOtherCrossVarConstraints(ctx.decl.constraints, varBlocks[0].name, varBlocks[1].name)) return null;
    [varA, varB] = varBlocks;
  } else if (varBlocks.length === 2 && varBlocks[0].name === varBlocks[1].name) {
    // (b) — same var twice. Need distinct literals (else linearConstrained
    // would have collapsed it).
    if (varBlocks[0].literal === varBlocks[1].literal) return null;
    [varA, varB] = varBlocks;
  } else {
    return null;
  }

  if (varA.literal === varB.literal) return null;
  if (varA.idx >= varB.idx) return null;

  // Collect const-block literals: prefix (before varA) and middle (between).
  // Anything AFTER varB disqualifies — we don't model trailing constants here.
  if (varB.idx !== lits.length - 1) return null;

  const prefixLiterals: string[] = [];
  for (let i = 0; i < varA.idx; i++) {
    const b = lits[i];
    if (b.exponent.kind !== 'const') return null;
    for (let r = 0; r < b.exponent.value; r++) prefixLiterals.push(b.literal);
  }
  const middleLiterals: string[] = [];
  for (let i = varA.idx + 1; i < varB.idx; i++) {
    const b = lits[i];
    if (b.exponent.kind !== 'const') return null;
    for (let r = 0; r < b.exponent.value; r++) middleLiterals.push(b.literal);
  }

  return {
    prefixLiterals,
    middleLiterals,
    varA: varA.name,
    varB: varB.name,
    litA: varA.literal,
    litB: varB.literal,
  };
}

function construct(plan: Plan): PDA {
  const transitions: PDATransition[] = [];
  let counter = 0;
  const fresh = () => `q${counter++}`;

  const stackAlphabet = new Set<string>([PDA_STACK_BOTTOM, plan.litA]);
  const inputAlphabet = new Set<string>([plan.litA, plan.litB, ...plan.prefixLiterals, ...plan.middleLiterals]);

  // 1. Prefix chain — read each prefix literal exactly once.
  const startState = fresh();
  let prefixTail = startState;
  for (const ch of plan.prefixLiterals) {
    const next = fresh();
    transitions.push({
      from: prefixTail, to: next,
      inputSymbol: ch,
      stackTop: PDA_STACK_BOTTOM,
      action: { pop: false, pushSymbols: [] }, // העתק
    });
    prefixTail = next;
  }

  // 2. Push phase (q_push). Reads A's, pushes A onto stack.
  const qPush = fresh();
  transitions.push({
    from: prefixTail, to: qPush,
    inputSymbol: PDA_EPSILON,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [] },
  });

  // Self-loops: push A on top of S, push A on top of A.
  transitions.push({
    from: qPush, to: qPush,
    inputSymbol: plan.litA,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [plan.litA] },
  });
  transitions.push({
    from: qPush, to: qPush,
    inputSymbol: plan.litA,
    stackTop: plan.litA,
    action: { pop: false, pushSymbols: [plan.litA] },
  });

  // 3. Middle chain — between the two var blocks. We need to traverse middle
  // chars regardless of stack content (top might be S if A^0, or A if A^k).
  // Build the chain twice — once threading through S, once through A — then
  // converge at the pop-phase entry. To avoid state explosion, we instead
  // model middle chars as transitions that happen "before pop phase begins":
  //   - From qPush, on the first middle char (or directly to qPop if no
  //     middle), read it without changing the stack.
  //
  // Simpler implementation: insert a fresh chain after qPush that reads middle
  // chars while peeking either S or A. Each chain state has two transitions on
  // the same input char (one for each possible top), so the construction
  // remains correct regardless of how many A's were pushed.
  let middleHead = qPush;
  // Use ε-transition from qPush to a fresh "midStart" so that the self-loops
  // on qPush above don't fire on middle characters. (qPush has no transitions
  // for middle chars, so it's actually OK to chain directly from qPush — but
  // we add an explicit ε for clarity.)
  if (plan.middleLiterals.length > 0) {
    const midStart = fresh();
    transitions.push({
      from: qPush, to: midStart,
      inputSymbol: PDA_EPSILON,
      stackTop: PDA_STACK_BOTTOM,
      action: { pop: false, pushSymbols: [] },
    });
    transitions.push({
      from: qPush, to: midStart,
      inputSymbol: PDA_EPSILON,
      stackTop: plan.litA,
      action: { pop: false, pushSymbols: [] },
    });
    middleHead = midStart;
    let cur = midStart;
    for (const ch of plan.middleLiterals) {
      const next = fresh();
      transitions.push({
        from: cur, to: next,
        inputSymbol: ch,
        stackTop: PDA_STACK_BOTTOM,
        action: { pop: false, pushSymbols: [] },
      });
      transitions.push({
        from: cur, to: next,
        inputSymbol: ch,
        stackTop: plan.litA,
        action: { pop: false, pushSymbols: [] },
      });
      cur = next;
      inputAlphabet.add(ch);
    }
    middleHead = cur;
  }

  // 4. Pop phase (q_pop). Reads B's, pops A from stack.
  const qPop = fresh();
  transitions.push({
    from: middleHead, to: qPop,
    inputSymbol: plan.litB,
    stackTop: plan.litA,
    action: { pop: true, pushSymbols: [] },
  });
  transitions.push({
    from: qPop, to: qPop,
    inputSymbol: plan.litB,
    stackTop: plan.litA,
    action: { pop: true, pushSymbols: [] },
  });

  // 5. Accept state.
  const qAcc = fresh();
  // Empty case (n = m = 0): from middleHead with stack still S, ε to qAcc.
  transitions.push({
    from: middleHead, to: qAcc,
    inputSymbol: PDA_EPSILON,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [] },
  });
  // After popping all A's: from qPop with top=S, ε to qAcc.
  transitions.push({
    from: qPop, to: qAcc,
    inputSymbol: PDA_EPSILON,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [] },
  });

  // Build state list.
  const stateIds = new Set<string>([startState, qPush, qPop, qAcc, middleHead]);
  for (const t of transitions) { stateIds.add(t.from); stateIds.add(t.to); }
  const states = [...stateIds].map((id) => ({
    id,
    accept: id === qAcc,
  }));

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

function hasBareEquality(rels: Constraint[], a: string, b: string): boolean {
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    if (c.ops.length !== 1 || c.ops[0] !== '=') continue;
    const [l, r] = c.operands;
    if (l.kind === 'var' && r.kind === 'var') {
      if ((l.name === a && r.name === b) || (l.name === b && r.name === a)) return true;
    }
  }
  return false;
}

function hasOtherCrossVarConstraints(rels: Constraint[], a: string, b: string): boolean {
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    if (c.ops.length === 1 && c.ops[0] === '=') {
      const [l, r] = c.operands;
      if (l.kind === 'var' && r.kind === 'var') {
        const names = [l.name, r.name].sort();
        const target = [a, b].sort();
        if (names[0] === target[0] && names[1] === target[1]) continue; // the equality we want
      }
    }
    // Any other constraint touching both vars is "other".
    const used = new Set<string>();
    for (const op of c.operands) collectVars(op, used);
    if (used.has(a) && used.has(b)) return true;
  }
  return false;
}

function collectVars(e: { kind: string; name?: string; left?: unknown; right?: unknown }, out: Set<string>): void {
  if (e.kind === 'var') out.add(e.name as string);
  else if (e.kind === 'binop') {
    collectVars(e.left as { kind: string }, out);
    collectVars(e.right as { kind: string }, out);
  }
}
