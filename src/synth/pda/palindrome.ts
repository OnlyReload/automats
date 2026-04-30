import type { PDA, PDATransition } from '../../automaton/pda';
import { PDA_EPSILON, PDA_STACK_BOTTOM } from '../../automaton/pda';
import type { PdaContext, PdaPattern } from './index';

/**
 * Palindrome PDA pattern: { w R(w) | w in Σ* }.
 *
 * Construction (textbook):
 *   - q_push: read each input char and push it on the stack.
 *   - Non-deterministic guess of midpoint via ε-transition to q_pop.
 *   - q_pop: read each input char and pop iff it matches the top.
 *   - q_acc: reached when stack is back to S (bottom).
 *
 * Initial stack: S.
 *
 * For each alphabet symbol c:
 *   - q_push, c, S       → q_push,  דחוף c
 *   - q_push, c, X       → q_push,  דחוף c  (for each stack symbol X)
 *   - q_push, ε, S       → q_acc            (empty w — n = 0)
 *   - q_push, ε, X       → q_pop            (guess midpoint with X on top)
 *   - q_pop,  c, c       → q_pop,  שלוף    (matched pop)
 *   - q_pop,  ε, S       → q_acc           (stack empty, accept)
 */
export const palindromePdaPattern: PdaPattern = {
  name: 'pda-palindrome',
  matches(ctx) {
    return analyse(ctx) !== null;
  },
  build(ctx) {
    const plan = analyse(ctx)!;
    return construct(plan);
  },
};

interface Plan {
  alphabet: string[]; // single-char input alphabet
}

function analyse(ctx: PdaContext): Plan | null {
  const cls = ctx.classification;
  if (cls.kind !== 'nonRegular') return null;
  if (cls.rule !== 'palindrome') return null;

  // Skeleton must be exactly: wordRef(w, forward) followed by wordRef(w, reversed)
  const blocks = ctx.skeleton.blocks;
  if (blocks.length !== 2) return null;
  const a = blocks[0];
  const b = blocks[1];
  if (a.kind !== 'wordRef' || b.kind !== 'wordRef') return null;
  if (a.wordVar !== b.wordVar) return null;
  if (a.reversed === b.reversed) return null; // need one forward + one reversed

  // Locate the wordVar declaration to get the alphabet.
  for (const c of ctx.decl.constraints) {
    if (c.kind === 'wordVarDecl' && c.wordVar === a.wordVar) {
      const alphabet = c.alphabet.filter((s) => s.length === 1);
      if (alphabet.length === 0) return null;
      if (alphabet.length > 8) return null; // sanity cap
      return { alphabet };
    }
  }
  return null;
}

function construct(plan: Plan): PDA {
  const transitions: PDATransition[] = [];
  const qPush = 'q_push';
  const qPop = 'q_pop';
  const qAcc = 'q_acc';

  const stackAlphabet = new Set<string>([PDA_STACK_BOTTOM, ...plan.alphabet]);

  // q_push self-loops: read c, push c, regardless of top.
  for (const c of plan.alphabet) {
    transitions.push({
      from: qPush, to: qPush,
      inputSymbol: c,
      stackTop: PDA_STACK_BOTTOM,
      action: { pop: false, pushSymbols: [c] },
    });
    for (const top of plan.alphabet) {
      transitions.push({
        from: qPush, to: qPush,
        inputSymbol: c,
        stackTop: top,
        action: { pop: false, pushSymbols: [c] },
      });
    }
  }

  // ε-transitions: q_push → q_acc (empty w), q_push → q_pop (start matching).
  transitions.push({
    from: qPush, to: qAcc,
    inputSymbol: PDA_EPSILON,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [] },
  });
  for (const top of plan.alphabet) {
    transitions.push({
      from: qPush, to: qPop,
      inputSymbol: PDA_EPSILON,
      stackTop: top,
      action: { pop: false, pushSymbols: [] },
    });
  }

  // q_pop: pop on matching char.
  for (const c of plan.alphabet) {
    transitions.push({
      from: qPop, to: qPop,
      inputSymbol: c,
      stackTop: c,
      action: { pop: true, pushSymbols: [] },
    });
  }
  // q_pop, ε, S → q_acc.
  transitions.push({
    from: qPop, to: qAcc,
    inputSymbol: PDA_EPSILON,
    stackTop: PDA_STACK_BOTTOM,
    action: { pop: false, pushSymbols: [] },
  });

  return {
    kind: 'pda',
    states: [
      { id: qPush, accept: false },
      { id: qPop, accept: false },
      { id: qAcc, accept: true },
    ],
    start: qPush,
    initialStack: PDA_STACK_BOTTOM,
    inputAlphabet: plan.alphabet.slice(),
    stackAlphabet: [...stackAlphabet],
    transitions,
  };
}
