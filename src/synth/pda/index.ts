import type { LangDecl } from '../../dsl/ast';
import type { PDA } from '../../automaton/pda';
import type { Skeleton } from '../skeleton';
import type { Classification } from '../classifier';

/**
 * A PDA pattern: like the NFA patterns, each module exports a `{ matches, build }`
 * object. The dispatcher tries each in order and returns the first match.
 */
export interface PdaPattern {
  name: string;
  matches(ctx: PdaContext): boolean;
  build(ctx: PdaContext): PDA;
}

export interface PdaContext {
  decl: LangDecl;
  skeleton: Skeleton;
  classification: Classification;
}

import { equalCountsPdaPattern } from './equalCounts';
import { palindromePdaPattern } from './palindrome';
import { sandwichPdaPattern } from './sandwich';

export const PDA_PATTERNS: PdaPattern[] = [
  equalCountsPdaPattern,
  sandwichPdaPattern,
  palindromePdaPattern,
];

export function dispatchPda(ctx: PdaContext): PDA | null {
  for (const p of PDA_PATTERNS) {
    if (p.matches(ctx)) return p.build(ctx);
  }
  return null;
}
