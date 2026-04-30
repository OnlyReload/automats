import type { NFA } from '../../automaton/types';
import type { VarBounds } from '../classifier';
import type { Block, Skeleton } from '../skeleton';

export interface PatternContext {
  skeleton: Skeleton;
  bounds: VarBounds;
  /** Only literal blocks — wordRefs are filtered out before pattern dispatch. */
  litBlocks: Extract<Block, { kind: 'lit' }>[];
}

export interface Pattern {
  name: string;
  matches(ctx: PatternContext): boolean;
  build(ctx: PatternContext): NFA;
}

import { singleBlockPattern } from './singleBlock';
import { independentBlocksPattern } from './independentBlocks';
import { boundedRangePattern } from './bounded';
import { linearConstrainedPattern } from './linearConstrained';
import { modularPattern } from './modular';
import { boundedEqualityPattern } from './boundedEquality';
import { generalSequentialPattern } from './generalSequential';

export const PATTERNS: Pattern[] = [
  // Special-case patterns first — they produce cleaner / smaller diagrams
  // when the language matches their narrow shape.
  singleBlockPattern,
  boundedRangePattern,
  linearConstrainedPattern,
  modularPattern,
  boundedEqualityPattern,
  independentBlocksPattern,
  // Universal Presburger fallback — handles N-var sequential constructions
  // via product over per-variable count/mod trackers.
  generalSequentialPattern,
];

export function dispatch(ctx: PatternContext): NFA | null {
  for (const p of PATTERNS) {
    if (p.matches(ctx)) return p.build(ctx);
  }
  return null;
}
