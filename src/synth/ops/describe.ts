// Symbolic description of compose results: where possible, fold the operation
// tree into a single set-builder description (renaming bound variables to
// avoid clashes); otherwise fall back to per-operand description joined with
// the operator symbol.

import type { ArithExpr, Atom, Constraint, LangDecl, Term, Word } from '../../dsl/ast';
import { parseLanguage } from '../../dsl/parser';
import type { OpExpr } from './expr';
import type { LangSlot } from './evaluate';

// ---------------------------------------------------------------------------
// Variable manipulation on the AST
// ---------------------------------------------------------------------------

function collectVars(decl: LangDecl): Set<string> {
  const vars = new Set<string>();
  const walkExpr = (e: ArithExpr): void => {
    if (e.kind === 'var') vars.add(e.name);
    else if (e.kind === 'binop') { walkExpr(e.left); walkExpr(e.right); }
  };
  const walkWord = (w: Word): void => {
    for (const term of w.terms) {
      if (term.exponent) walkExpr(term.exponent);
      if (term.atom.kind === 'group') walkWord(term.atom.word);
    }
  };
  walkWord(decl.word);
  for (const c of decl.constraints) {
    if (c.kind === 'rel') for (const op of c.operands) walkExpr(op);
  }
  return vars;
}

function renameVars(decl: LangDecl, map: Map<string, string>): LangDecl {
  if (map.size === 0) return decl;
  const renameExpr = (e: ArithExpr): ArithExpr => {
    if (e.kind === 'var' && map.has(e.name)) return { ...e, name: map.get(e.name)! };
    if (e.kind === 'binop') return { ...e, left: renameExpr(e.left), right: renameExpr(e.right) };
    return e;
  };
  const renameWord = (w: Word): Word => ({
    ...w,
    terms: w.terms.map((t): Term => ({
      ...t,
      atom: t.atom.kind === 'group'
        ? ({ ...t.atom, word: renameWord(t.atom.word) } as Atom)
        : t.atom,
      exponent: t.exponent ? renameExpr(t.exponent) : null,
    })),
  });
  return {
    ...decl,
    word: renameWord(decl.word),
    constraints: decl.constraints.map((c) =>
      c.kind === 'rel' ? { ...c, operands: c.operands.map(renameExpr) } : c
    ),
  };
}

function freshVar(taken: Set<string>): string {
  const pool = ['n', 'm', 'k', 'p', 'q', 'r', 's', 't', 'i', 'j', 'a', 'b', 'c'];
  for (const v of pool) if (!taken.has(v)) return v;
  for (let i = 1; ; i++) {
    for (const v of pool) {
      const candidate = `${v}${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}

// ---------------------------------------------------------------------------
// Operations on language descriptions
// ---------------------------------------------------------------------------

function mergeConcat(a: LangDecl, b: LangDecl): LangDecl {
  const aVars = collectVars(a);
  const bVars = collectVars(b);
  const taken = new Set(aVars);
  const map = new Map<string, string>();
  for (const v of bVars) {
    if (taken.has(v)) {
      const fresh = freshVar(taken);
      map.set(v, fresh);
      taken.add(fresh);
    } else {
      taken.add(v);
    }
  }
  const bRen = renameVars(b, map);
  return {
    ...a,
    word: { ...a.word, terms: [...a.word.terms, ...bRen.word.terms] },
    constraints: [...a.constraints, ...bRen.constraints],
  };
}

function reverseWord(w: Word): Word {
  const reversed = [...w.terms].reverse().map((t): Term => {
    if (t.atom.kind === 'group') {
      return { ...t, atom: { ...t.atom, word: reverseWord(t.atom.word) } as Atom };
    }
    return t;
  });
  return { ...w, terms: reversed };
}

function reverseDecl(a: LangDecl): LangDecl {
  return { ...a, word: reverseWord(a.word) };
}

// ---------------------------------------------------------------------------
// AST → string
// ---------------------------------------------------------------------------

function precOf(op: '+' | '-' | '*' | '/' | '%'): number {
  if (op === '+' || op === '-') return 1;
  return 2;
}

function printArith(e: ArithExpr, parentPrec = 0): string {
  if (e.kind === 'int') return String(e.value);
  if (e.kind === 'var') return e.name;
  const my = precOf(e.op);
  const s = `${printArith(e.left, my)}${e.op}${printArith(e.right, my)}`;
  return my < parentPrec ? `(${s})` : s;
}

function printAtom(a: Atom): string {
  if (a.kind === 'symbol') return a.symbol;
  if (a.kind === 'wordVar') return a.name;
  if (a.kind === 'reverse') return `R(${a.wordVar})`;
  return `(${printWord(a.word)})`;
}

function printTerm(t: Term): string {
  const base = printAtom(t.atom);
  if (!t.exponent) return base;
  if (t.exponent.kind === 'int' || t.exponent.kind === 'var') {
    return `${base}^${printArith(t.exponent)}`;
  }
  return `${base}^(${printArith(t.exponent)})`;
}

function printWord(w: Word): string {
  return w.terms.map(printTerm).join(' ');
}

function printConstraint(c: Constraint): string {
  if (c.kind === 'wordVarDecl') {
    return `${c.wordVar} in {${c.alphabet.join(',')}}*`;
  }
  let out = printArith(c.operands[0]);
  for (let i = 0; i < c.ops.length; i++) {
    out += ` ${c.ops[i]} ${printArith(c.operands[i + 1])}`;
  }
  return out;
}

function printDecl(d: LangDecl): string {
  const body = d.word.terms.length === 0 ? 'ε' : printWord(d.word);
  if (d.constraints.length === 0) return `{${body}}`;
  return `{${body} | ${d.constraints.map(printConstraint).join(', ')}}`;
}

// ---------------------------------------------------------------------------
// Pretty pass: superscripts and Unicode relations
// ---------------------------------------------------------------------------

const SUPER: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ',
  h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ',
  o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ',
  w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
};

function toSuper(s: string): string {
  let out = '';
  for (const ch of s) out += SUPER[ch] ?? ch;
  return out;
}

function prettify(text: string): string {
  return text
    .replace(/\^\(([^)]+)\)/g, (_, inner: string) => toSuper(inner.replace(/\s+/g, '')))
    .replace(/\^([A-Za-z0-9]+)/g, (_, run: string) => toSuper(run))
    .replace(/>=/g, '≥')
    .replace(/<=/g, '≤')
    .replace(/!=/g, '≠');
}

// ---------------------------------------------------------------------------
// OpExpr → Desc → string
// ---------------------------------------------------------------------------

// Precedence (higher = binds tighter). Atom never needs parens; binaries
// wrap an operand only when its precedence is strictly lower.
const P_ATOM = 100;
const P_POSTFIX = 80;   // *  ᴿ
const P_PREFIX = 70;    // ¬
const P_CONCAT = 60;    // ·
const P_INTER = 50;     // ∩
const P_DIFF = 40;      // \
const P_UNION = 30;     // ∪

type Desc =
  | { kind: 'lang'; decl: LangDecl }
  | { kind: 'op'; text: string; prec: number };

function descToken(d: Desc): { text: string; prec: number } {
  if (d.kind === 'lang') return { text: prettify(printDecl(d.decl)), prec: P_ATOM };
  return { text: d.text, prec: d.prec };
}

function paren(d: Desc, parentPrec: number): string {
  const { text, prec } = descToken(d);
  return prec < parentPrec ? `(${text})` : text;
}

function leafDecl(name: string, slots: LangSlot[]): LangDecl | null {
  const slot = slots.find((s) => s.name === name);
  if (!slot) return null;
  const text = slot.source.trim();
  if (!text) return null;
  const fullSource = text.startsWith('{') ? `${slot.name} = ${text}` : text;
  try {
    return parseLanguage(fullSource);
  } catch {
    return null;
  }
}

// Two language declarations are "same-shape" if their word AST is identical
// up to a renaming of bound variables. When that holds, ∩/\\ can be folded
// into a single set-builder by combining constraints.
function sameShape(a: LangDecl, b: LangDecl): Map<string, string> | null {
  const map = new Map<string, string>();
  const used = new Set<string>();
  const matchExpr = (x: ArithExpr, y: ArithExpr): boolean => {
    if (x.kind !== y.kind) return false;
    if (x.kind === 'int' && y.kind === 'int') return x.value === y.value;
    if (x.kind === 'var' && y.kind === 'var') {
      const mapped = map.get(x.name);
      if (mapped !== undefined) return mapped === y.name;
      if (used.has(y.name)) return false;
      map.set(x.name, y.name);
      used.add(y.name);
      return true;
    }
    if (x.kind === 'binop' && y.kind === 'binop') {
      return x.op === y.op && matchExpr(x.left, y.left) && matchExpr(x.right, y.right);
    }
    return false;
  };
  const matchAtom = (x: Atom, y: Atom): boolean => {
    if (x.kind !== y.kind) return false;
    if (x.kind === 'symbol' && y.kind === 'symbol') return x.symbol === y.symbol;
    if (x.kind === 'wordVar' && y.kind === 'wordVar') return x.name === y.name;
    if (x.kind === 'reverse' && y.kind === 'reverse') return x.wordVar === y.wordVar;
    if (x.kind === 'group' && y.kind === 'group') return matchWord(x.word, y.word);
    return false;
  };
  const matchWord = (x: Word, y: Word): boolean => {
    if (x.terms.length !== y.terms.length) return false;
    for (let i = 0; i < x.terms.length; i++) {
      const tx = x.terms[i], ty = y.terms[i];
      if (!matchAtom(tx.atom, ty.atom)) return false;
      if (!!tx.exponent !== !!ty.exponent) return false;
      if (tx.exponent && ty.exponent && !matchExpr(tx.exponent, ty.exponent)) return false;
    }
    return true;
  };
  return matchWord(a.word, b.word) ? map : null;
}

function mergeConstraints(a: LangDecl, b: LangDecl): LangDecl {
  // Prerequisite: a and b have identical word shape (sameShape returned a map
  // of a-vars → b-vars). Rename b's vars to align with a's, then take the
  // union of constraints.
  const map = sameShape(a, b);
  if (!map) return a;
  const inv = new Map<string, string>();
  for (const [aVar, bVar] of map) inv.set(bVar, aVar);
  const bAligned = renameVars(b, inv);
  return {
    ...a,
    constraints: [...a.constraints, ...bAligned.constraints],
  };
}

function describe(e: OpExpr, slots: LangSlot[]): Desc {
  switch (e.kind) {
    case 'ref': {
      const decl = leafDecl(e.name, slots);
      return decl ? { kind: 'lang', decl } : { kind: 'op', text: e.name, prec: P_ATOM };
    }
    case 'concat': {
      const a = describe(e.a, slots);
      const b = describe(e.b, slots);
      if (a.kind === 'lang' && b.kind === 'lang') {
        return { kind: 'lang', decl: mergeConcat(a.decl, b.decl) };
      }
      return {
        kind: 'op',
        text: `${paren(a, P_CONCAT)} · ${paren(b, P_CONCAT + 1)}`,
        prec: P_CONCAT,
      };
    }
    case 'reverse': {
      const inner = describe(e.a, slots);
      if (inner.kind === 'lang') {
        return { kind: 'lang', decl: reverseDecl(inner.decl) };
      }
      return { kind: 'op', text: `${paren(inner, P_POSTFIX + 1)}ᴿ`, prec: P_POSTFIX };
    }
    case 'star': {
      const inner = describe(e.a, slots);
      return { kind: 'op', text: `${paren(inner, P_POSTFIX + 1)}*`, prec: P_POSTFIX };
    }
    case 'complement': {
      const inner = describe(e.a, slots);
      return { kind: 'op', text: `¬${paren(inner, P_PREFIX + 1)}`, prec: P_PREFIX };
    }
    case 'inter': {
      const a = describe(e.a, slots);
      const b = describe(e.b, slots);
      if (a.kind === 'lang' && b.kind === 'lang' && sameShape(a.decl, b.decl)) {
        return { kind: 'lang', decl: mergeConstraints(a.decl, b.decl) };
      }
      return {
        kind: 'op',
        text: `${paren(a, P_INTER)} ∩ ${paren(b, P_INTER + 1)}`,
        prec: P_INTER,
      };
    }
    case 'diff': {
      const a = describe(e.a, slots);
      const b = describe(e.b, slots);
      return {
        kind: 'op',
        text: `${paren(a, P_DIFF)} \\ ${paren(b, P_DIFF + 1)}`,
        prec: P_DIFF,
      };
    }
    case 'union': {
      const a = describe(e.a, slots);
      const b = describe(e.b, slots);
      return {
        kind: 'op',
        text: `${paren(a, P_UNION)} ∪ ${paren(b, P_UNION + 1)}`,
        prec: P_UNION,
      };
    }
  }
}

export function formatResultLanguage(e: OpExpr, slots: LangSlot[]): string {
  return descToken(describe(e, slots)).text;
}
