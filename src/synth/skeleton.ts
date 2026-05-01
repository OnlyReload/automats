import type { ArithExpr, Atom, LangDecl, Term, Word } from '../dsl/ast';
import { DslError } from '../dsl/errors';

/**
 * A "block" in the language's word: a literal string α raised to some count
 * expression e (which may be a constant or a linear expression in free vars).
 *
 * For example, in `a^n c^2 b^m`, the blocks are:
 *   [{ literal: 'a',  exponent: { kind: 'var', name: 'n' } },
 *    { literal: 'c',  exponent: { kind: 'const', value: 2 } },
 *    { literal: 'b',  exponent: { kind: 'var', name: 'm' } }]
 *
 * Word vars (`w`) and reverse (`R(w)`) become `wordRef` blocks — the classifier
 * uses them to apply the palindrome reject rule.
 */
export type LinearExpr =
  | { kind: 'const'; value: number }
  | { kind: 'var'; name: string; coeff: number; offset: number }; // coeff*var + offset

export type Block =
  | { kind: 'lit'; literal: string; exponent: LinearExpr }
  | { kind: 'wordRef'; wordVar: string; reversed: boolean };

export interface Skeleton {
  blocks: Block[];
  /** Free count variables appearing in any exponent. */
  countVars: Set<string>;
  /** Word variables declared in constraints. */
  wordVars: Set<string>;
}

/**
 * Walk the AST word and collect blocks. Multi-symbol literals come from
 * `(xy)^n`-style groups: the literal is `xy`, exponent is `n`. Adjacent atoms
 * with the same exponent shape collapse where possible (a single symbol with
 * no exponent is `a^1` essentially — we keep it as `a` with const 1).
 */
export function buildSkeleton(decl: LangDecl): Skeleton {
  const wordVars = new Set<string>();
  for (const k of decl.constraints) {
    if (k.kind === 'wordVarDecl') wordVars.add(k.wordVar);
  }
  const blocks: Block[] = [];
  const countVars = new Set<string>();
  collectBlocks(decl.word, blocks, countVars, wordVars);
  return { blocks, countVars, wordVars };
}

function collectBlocks(word: Word, out: Block[], countVars: Set<string>, wordVars: Set<string>): void {
  for (const term of word.terms) {
    addTermAsBlock(term, out, countVars, wordVars);
  }
}

function addTermAsBlock(
  term: Term,
  out: Block[],
  countVars: Set<string>,
  wordVars: Set<string>
): void {
  const literal = atomLiteral(term.atom, wordVars);
  if (literal === null) {
    // Word variable or reverse — not a literal block.
    if (term.atom.kind === 'wordVar') {
      out.push({ kind: 'wordRef', wordVar: term.atom.name, reversed: false });
      return;
    }
    if (term.atom.kind === 'reverse') {
      out.push({ kind: 'wordRef', wordVar: term.atom.wordVar, reversed: true });
      return;
    }
    if (term.atom.kind === 'group') {
      // Group with internal structure (e.g., (a^n b^m)) — recurse, then apply
      // the outer exponent to the produced blocks if it's a constant > 0. For
      // v1 we only support groups whose contents are themselves a flat literal
      // (handled by atomLiteral above) or a structure with a constant power.
      const inner: Block[] = [];
      collectBlocks(term.atom.word, inner, countVars, wordVars);
      const exp = term.exponent ? toLinear(term.exponent, countVars) : { kind: 'const' as const, value: 1 };
      if (exp.kind === 'const' && exp.value === 1) {
        out.push(...inner);
        return;
      }
      throw new DslError(
        `קבוצה מורכבת עם מעריך ${formatLinear(exp)} אינה נתמכת ב־v1.`,
        term.span
      );
    }
    return;
  }

  const exponent = term.exponent ? toLinear(term.exponent, countVars) : { kind: 'const' as const, value: 1 };
  out.push({ kind: 'lit', literal, exponent });
}

function atomLiteral(atom: Atom, wordVars: Set<string>): string | null {
  if (atom.kind === 'symbol') return atom.symbol;
  if (atom.kind === 'wordVar') return null;
  if (atom.kind === 'reverse') return null;
  if (atom.kind === 'group') {
    // A group is a literal if every inner term is a no-exponent symbol, OR
    // each inner term has a constant exponent (so we can expand to a literal).
    let s = '';
    for (const t of atom.word.terms) {
      const inner = atomLiteral(t.atom, wordVars);
      if (inner === null) return null;
      const reps = t.exponent ? constExponent(t.exponent) : 1;
      if (reps === null) return null;
      s += inner.repeat(reps);
    }
    return s;
  }
  return null;
}

function constExponent(e: ArithExpr): number | null {
  const folded = foldConst(e);
  return folded === null ? null : folded;
}

function foldConst(e: ArithExpr): number | null {
  if (e.kind === 'int') return e.value;
  if (e.kind === 'var') return null;
  if (e.kind === 'letterCount') return null;
  const l = foldConst(e.left);
  const r = foldConst(e.right);
  if (l === null || r === null) return null;
  switch (e.op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return r === 0 ? null : Math.trunc(l / r);
    case '%': return r === 0 ? null : ((l % r) + r) % r;
  }
}

/**
 * Convert an arithmetic expression to a linear form `coeff*var + offset` if
 * possible. Returns null if the expression isn't a constant or a single-variable
 * linear function. We accept: `n`, `c`, `n+c`, `n-c`, `c+n`, `c*n`, `(n+c)`.
 */
export function toLinear(e: ArithExpr, countVars: Set<string>): LinearExpr {
  const folded = foldConst(e);
  if (folded !== null) return { kind: 'const', value: folded };

  // Try to extract (coeff, var, offset) from a small grammar of linear forms.
  const lin = extractLinear(e);
  if (lin === null) {
    throw new DslError(
      'מעריך מורכב מדי. ניתן להשתמש בקבוע, משתנה אחד, או צורה לינארית פשוטה (כמו n+2 או n-1).',
      e.span
    );
  }
  countVars.add(lin.name);
  return { kind: 'var', name: lin.name, coeff: lin.coeff, offset: lin.offset };
}

function extractLinear(e: ArithExpr): { name: string; coeff: number; offset: number } | null {
  if (e.kind === 'var') return { name: e.name, coeff: 1, offset: 0 };
  if (e.kind === 'int') return null; // pure const handled by foldConst
  if (e.kind === 'binop') {
    if (e.op === '+' || e.op === '-') {
      const l = e.left.kind === 'var' || e.left.kind === 'binop' ? extractLinear(e.left) : null;
      const lConst = foldConst(e.left);
      const r = e.right.kind === 'var' || e.right.kind === 'binop' ? extractLinear(e.right) : null;
      const rConst = foldConst(e.right);
      // var ± const
      if (l !== null && rConst !== null) {
        return { name: l.name, coeff: l.coeff, offset: l.offset + (e.op === '+' ? rConst : -rConst) };
      }
      // const + var (only for +)
      if (e.op === '+' && lConst !== null && r !== null) {
        return { name: r.name, coeff: r.coeff, offset: r.offset + lConst };
      }
    }
    if (e.op === '*') {
      const lConst = foldConst(e.left);
      const rLin = e.right.kind === 'var' ? extractLinear(e.right) : null;
      if (lConst !== null && rLin !== null) {
        return { name: rLin.name, coeff: rLin.coeff * lConst, offset: rLin.offset * lConst };
      }
      const rConst = foldConst(e.right);
      const lLin = e.left.kind === 'var' ? extractLinear(e.left) : null;
      if (rConst !== null && lLin !== null) {
        return { name: lLin.name, coeff: lLin.coeff * rConst, offset: lLin.offset * rConst };
      }
    }
  }
  return null;
}

export function formatLinear(e: LinearExpr): string {
  if (e.kind === 'const') return String(e.value);
  const c = e.coeff === 1 ? '' : e.coeff === -1 ? '-' : `${e.coeff}*`;
  if (e.offset === 0) return `${c}${e.name}`;
  if (e.offset > 0) return `${c}${e.name}+${e.offset}`;
  return `${c}${e.name}${e.offset}`;
}
