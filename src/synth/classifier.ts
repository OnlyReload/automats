import type { Constraint, LangDecl } from '../dsl/ast';
import { strings as t } from '../i18n/he';
import type { Block, LinearExpr, Skeleton } from './skeleton';
import { propagateBounds } from './bounds';

export type Classification =
  | { kind: 'regular'; bounds: VarBounds }
  | { kind: 'nonRegular'; rule: 'R2' | 'R3' | 'R4' | 'palindrome'; reason: string }
  | { kind: 'unsupported'; reason: string };

export interface VarBounds {
  /** Constant range [min, max] for each var, where Infinity means unbounded above. */
  ranges: Map<string, { min: number; max: number }>;
  /** Equality constraints between vars or var-vs-const, kept as raw constraint nodes. */
  rawRels: Constraint[];
}

/**
 * Classify the language as regular / non-regular / unsupported.
 *
 * Rules from the plan:
 *   R1 — every exponent is a constant or `c·n + d` for a single variable.
 *        (Already enforced during skeleton building; toLinear throws otherwise.)
 *   R2 — a count variable cannot appear in two non-adjacent literal blocks
 *        unless every block between them has a count variable that is bounded
 *        to a constant range.
 *   R3 — constraints stay within bounded Presburger; integer division (`/`)
 *        against a free variable on the other side is rejected.
 *   Palindrome reject — `R(w)` paired with the same `w` unreversed.
 */
export function classify(decl: LangDecl, skel: Skeleton): Classification {
  // Palindrome reject (highest priority — most informative error).
  const wordRefs = skel.blocks.filter((b): b is Extract<Block, { kind: 'wordRef' }> => b.kind === 'wordRef');
  for (const wv of skel.wordVars) {
    const seenForward = wordRefs.some((b) => b.wordVar === wv && !b.reversed);
    const seenReversed = wordRefs.some((b) => b.wordVar === wv && b.reversed);
    if (seenForward && seenReversed) {
      return {
        kind: 'nonRegular',
        rule: 'palindrome',
        reason: t.errPalindrome(wv),
      };
    }
  }
  if (wordRefs.length > 0) {
    return {
      kind: 'unsupported',
      reason: t.errWordVarUnsupported,
    };
  }

  // Compute variable bounds from constraints.
  const bounds = computeBounds(decl, skel);

  // R3 — reject constraints we can't model in v1.
  const r3 = checkR3(decl);
  if (r3) return r3;

  // R2 — same variable in non-adjacent blocks with unbounded intermediates.
  const r2 = checkR2(skel.blocks, bounds);
  if (r2) return r2;

  // R4 — bare-var equality / inequality between two unbounded variables (e.g.
  // `n = m`, `n >= m`) makes the language non-regular UNLESS the two vars
  // appear in adjacent blocks sharing the same literal (in which case they
  // collapse to a single counter — handled by linearConstrained).
  const r4 = checkR4(decl, bounds, skel);
  if (r4) return r4;

  return { kind: 'regular', bounds };
}

function checkR4(decl: LangDecl, bounds: VarBounds, skel: Skeleton): Classification | null {
  for (const c of decl.constraints) {
    if (c.kind !== 'rel') continue;
    for (let i = 0; i < c.ops.length; i++) {
      const left = c.operands[i];
      const right = c.operands[i + 1];
      if (left.kind !== 'var' || right.kind !== 'var') continue;
      if (left.name === right.name) continue;
      const lMax = bounds.ranges.get(left.name)?.max ?? Infinity;
      const rMax = bounds.ranges.get(right.name)?.max ?? Infinity;
      if (lMax !== Infinity || rMax !== Infinity) continue;
      if (collapsesToSingleCounter(skel, left.name, right.name)) continue;
      return {
        kind: 'nonRegular',
        rule: 'R4',
        reason: t.errR4(left.name, right.name),
      };
    }
  }
  return null;
}

function collapsesToSingleCounter(skel: Skeleton, a: string, b: string): boolean {
  // Find the two literal blocks holding `a` and `b` as bare variable exponents.
  // If they share the same literal AND no non-empty block sits between them,
  // both vars contribute to the same effective counter.
  const idxA = skel.blocks.findIndex(
    (blk) => blk.kind === 'lit' && blk.exponent.kind === 'var' && blk.exponent.name === a
  );
  const idxB = skel.blocks.findIndex(
    (blk) => blk.kind === 'lit' && blk.exponent.kind === 'var' && blk.exponent.name === b
  );
  if (idxA === -1 || idxB === -1) return false;
  const lo = Math.min(idxA, idxB);
  const hi = Math.max(idxA, idxB);
  const litA = (skel.blocks[idxA] as Extract<Block, { kind: 'lit' }>).literal;
  const litB = (skel.blocks[idxB] as Extract<Block, { kind: 'lit' }>).literal;
  if (litA !== litB) return false;
  // Only adjacent (or only-empty-blocks-between) qualifies.
  for (let k = lo + 1; k < hi; k++) {
    const mid = skel.blocks[k];
    if (mid.kind !== 'lit') return false;
    if (mid.exponent.kind === 'const' && mid.exponent.value === 0) continue;
    return false;
  }
  return true;
}

function computeBounds(decl: LangDecl, skel: Skeleton): VarBounds {
  const ranges = new Map<string, { min: number; max: number }>();
  for (const v of skel.countVars) {
    ranges.set(v, { min: 0, max: Infinity });
  }

  for (const c of decl.constraints) {
    if (c.kind !== 'rel') continue;
    // For each adjacent pair operand[i] OP operand[i+1], extract bounds where
    // one side is a single variable and the other a constant.
    for (let i = 0; i < c.ops.length; i++) {
      const left = c.operands[i];
      const right = c.operands[i + 1];
      const op = c.ops[i];

      const lVar = left.kind === 'var' ? left.name : null;
      const rVar = right.kind === 'var' ? right.name : null;
      const lConst = constValue(left);
      const rConst = constValue(right);

      if (lVar && rConst !== null) tightenBound(ranges, lVar, op, rConst);
      else if (rVar && lConst !== null) tightenBound(ranges, rVar, flipOp(op), lConst);

      // Modular equation `var % k = otherVar` (or symmetric) bounds otherVar
      // to [0, k-1] — combined with the existing `>= 0` it confines otherVar.
      if (op === '=') {
        const lMod = matchModExpr(left);
        const rMod = matchModExpr(right);
        if (lMod && rVar) tightenBound(ranges, rVar, '<=', lMod.modulus - 1);
        else if (rMod && lVar) tightenBound(ranges, lVar, '<=', rMod.modulus - 1);
      }
    }
  }

  // Iteratively tighten via linear propagation (handles n+m=K, n+m<=K, n=m+c,
  // n=2m, etc.). Modular equations are skipped here since asLinear can't handle
  // `%` against a variable; we already incorporated `var % k = otherVar` above.
  propagateBounds(decl.constraints, ranges);

  return { ranges, rawRels: decl.constraints };
}

function matchModExpr(e: { kind: string; op?: string; left?: unknown; right?: unknown; name?: string; value?: number }): { varName: string; modulus: number } | null {
  if (e.kind !== 'binop') return null;
  const node = e as { op: string; left: { kind: string; name?: string; value?: number }; right: { kind: string; name?: string; value?: number } };
  if (node.op !== '%') return null;
  if (node.left.kind === 'var' && node.right.kind === 'int' && (node.right.value as number) > 0) {
    return { varName: node.left.name as string, modulus: node.right.value as number };
  }
  return null;
}

function constValue(e: { kind: string; value?: number }): number | null {
  if (e.kind === 'int') return (e as { value: number }).value;
  return null;
}

function flipOp(op: string): string {
  switch (op) {
    case '<': return '>';
    case '<=': return '>=';
    case '>': return '<';
    case '>=': return '<=';
    default: return op;
  }
}

function tightenBound(
  ranges: Map<string, { min: number; max: number }>,
  v: string,
  op: string,
  c: number
): void {
  const cur = ranges.get(v) ?? { min: 0, max: Infinity };
  switch (op) {
    case '=':
      cur.min = Math.max(cur.min, c);
      cur.max = Math.min(cur.max, c);
      break;
    case '>=':
      cur.min = Math.max(cur.min, c);
      break;
    case '>':
      cur.min = Math.max(cur.min, c + 1);
      break;
    case '<=':
      cur.max = Math.min(cur.max, c);
      break;
    case '<':
      cur.max = Math.min(cur.max, c - 1);
      break;
  }
  ranges.set(v, cur);
}

function checkR3(decl: LangDecl): Classification | null {
  // Reject constraints involving integer division (`/`) where the result
  // depends on a free variable. e.g. n/3 = m makes the language non-regular.
  for (const c of decl.constraints) {
    if (c.kind !== 'rel') continue;
    for (const operand of c.operands) {
      if (containsDivByVar(operand)) {
        return {
          kind: 'nonRegular',
          rule: 'R3',
          reason: t.errR3Div,
        };
      }
    }
  }
  return null;
}

function containsDivByVar(e: { kind: string; op?: string; left?: unknown; right?: unknown }): boolean {
  if (e.kind === 'binop') {
    const node = e as { op: string; left: { kind: string }; right: { kind: string } };
    if (node.op === '/' && containsAnyVar(node.right)) return true;
    if (node.op === '/' && containsAnyVar(node.left)) return true;
    return (
      containsDivByVar(node.left as { kind: string }) ||
      containsDivByVar(node.right as { kind: string })
    );
  }
  return false;
}

function containsAnyVar(e: { kind: string; left?: unknown; right?: unknown }): boolean {
  if (e.kind === 'var') return true;
  if (e.kind === 'binop') {
    const node = e as { left: { kind: string }; right: { kind: string } };
    return containsAnyVar(node.left) || containsAnyVar(node.right);
  }
  return false;
}

function checkR2(blocks: Block[], bounds: VarBounds): Classification | null {
  // For every count var, find the indices of literal blocks whose exponent
  // mentions that var. If the var appears in two indices i<j and there exists
  // any k with i<k<j whose own variable is unbounded, the language isn't
  // regular under our v1 rules.
  const indicesByVar = new Map<string, number[]>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== 'lit') continue;
    if (b.exponent.kind !== 'var') continue;
    const arr = indicesByVar.get(b.exponent.name) ?? [];
    arr.push(i);
    indicesByVar.set(b.exponent.name, arr);
  }

  for (const [varName, idxs] of indicesByVar) {
    if (idxs.length < 2) continue;
    for (let p = 0; p < idxs.length - 1; p++) {
      const i = idxs[p];
      const j = idxs[p + 1];
      const litI = (blocks[i] as Extract<Block, { kind: 'lit' }>).literal;
      const litJ = (blocks[j] as Extract<Block, { kind: 'lit' }>).literal;
      if (j === i + 1 && litI === litJ) {
        // Adjacent same-literal pair (e.g. (xy)^n (xy)^m) collapses to
        // (literal)^(n+m); pattern matcher handles. Treat as ok.
        continue;
      }
      // Same var across distinct literals (or with non-empty blocks between
      // and any unbounded mid var) requires unbounded synchronization →
      // non-regular.
      if (litI !== litJ) {
        return {
          kind: 'nonRegular',
          rule: 'R2',
          reason: t.errR2(varName, varName),
        };
      }
      for (let k = i + 1; k < j; k++) {
        const mid = blocks[k];
        if (mid.kind !== 'lit') continue;
        if (mid.exponent.kind === 'const') continue; // bounded by definition
        const midVar = mid.exponent.name;
        const range = bounds.ranges.get(midVar);
        if (!range || range.max === Infinity) {
          return {
            kind: 'nonRegular',
            rule: 'R2',
            reason: t.errR2(varName, midVar),
          };
        }
      }
    }
  }
  return null;
}

export function isUnboundedAbove(b: LinearExpr, bounds: VarBounds): boolean {
  if (b.kind === 'const') return false;
  const r = bounds.ranges.get(b.name);
  return !r || r.max === Infinity;
}
