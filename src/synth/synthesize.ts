import type { LangDecl } from '../dsl/ast';
import { DslError } from '../dsl/errors';
import { strings as t } from '../i18n/he';
import type { NFA } from '../automaton/types';
import type { PDA } from '../automaton/pda';
import { classify } from './classifier';
import { dispatch, type PatternContext } from './patterns';
import { dispatchPda } from './pda';
import { buildSkeleton, type Block } from './skeleton';

export type Automaton = NFA | PDA;

export function isPDA(a: Automaton): a is PDA {
  return (a as PDA).kind === 'pda';
}

export function synthesize(decl: LangDecl): Automaton {
  const skeleton = buildSkeleton(decl);
  const cls = classify(decl, skeleton);

  if (cls.kind === 'unsupported') {
    throw new DslError(cls.reason, decl.span);
  }

  if (cls.kind === 'nonRegular') {
    // Try to construct a pushdown automaton for the non-regular shape.
    const pda = dispatchPda({ decl, skeleton, classification: cls });
    if (pda) return pda;
    // No PDA pattern matched — fall through to the original DslError so the
    // user sees the correct rule explanation.
    throw new DslError(cls.reason, decl.span, cls.rule);
  }

  const litBlocks = skeleton.blocks.filter(
    (b): b is Extract<Block, { kind: 'lit' }> => b.kind === 'lit'
  );

  const ctx: PatternContext = {
    skeleton,
    bounds: cls.bounds,
    litBlocks,
  };

  const nfa = dispatch(ctx);
  if (!nfa) {
    throw new DslError(t.errUnknownPattern, decl.span);
  }
  return nfa;
}
