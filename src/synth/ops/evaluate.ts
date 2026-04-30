import type { NFA } from '../../automaton/types';
import { parseLanguage } from '../../dsl/parser';
import { synthesize, isPDA } from '../synthesize';
import { resetCounter as resetSynthCounter } from '../builder';
import {
  complementNFA,
  concatNFA,
  differenceNFA,
  intersectNFA,
  resetCounter as resetOpsCounter,
  reverseNFA,
  starNFA,
  trimAndRelabel,
  unionNFA,
} from './operations';
import { collectRefs, ExprError, parseExpr, type OpExpr } from './expr';

export interface LangSlot {
  name: string;
  source: string;
}

export interface ComposeResult {
  automaton: NFA;
  expression: OpExpr;
}

export class ComposeError extends Error {
  constructor(message: string, public source?: string) {
    super(message);
  }
}

function build(slots: LangSlot[]): Map<string, NFA> {
  const map = new Map<string, NFA>();
  for (const slot of slots) {
    const text = slot.source.trim();
    if (!text || !slot.name.trim()) continue;
    // Allow shorthand: just `{ ... }` body — auto-prepend the slot name.
    const fullSource = text.startsWith('{') ? `${slot.name} = ${text}` : text;
    let decl;
    try {
      decl = parseLanguage(fullSource);
    } catch (e) {
      const msg = (e as Error).message;
      throw new ComposeError(`שגיאה בשפה ${slot.name}: ${msg}`, slot.name);
    }
    resetSynthCounter();
    const a = synthesize(decl);
    if (isPDA(a)) {
      throw new ComposeError(
        `השפה ${slot.name} לא רגולרית (PDA) — הרכבה תומכת רק בשפות רגולריות.`,
        slot.name
      );
    }
    map.set(slot.name, a);
  }
  return map;
}

function evalExpr(e: OpExpr, langs: Map<string, NFA>): NFA {
  switch (e.kind) {
    case 'ref': {
      const a = langs.get(e.name);
      if (!a) throw new ComposeError(`השפה '${e.name}' לא מוגדרת.`);
      return a;
    }
    case 'union': return unionNFA(evalExpr(e.a, langs), evalExpr(e.b, langs));
    case 'concat': return concatNFA(evalExpr(e.a, langs), evalExpr(e.b, langs));
    case 'inter': return intersectNFA(evalExpr(e.a, langs), evalExpr(e.b, langs));
    case 'diff': return differenceNFA(evalExpr(e.a, langs), evalExpr(e.b, langs));
    case 'star': return starNFA(evalExpr(e.a, langs));
    case 'reverse': return reverseNFA(evalExpr(e.a, langs));
    case 'complement': return complementNFA(evalExpr(e.a, langs));
  }
}

export function evaluateCompose(slots: LangSlot[], expression: string): ComposeResult {
  const text = expression.trim();
  if (!text) throw new ComposeError('כתבי ביטוי, למשל L1 ∪ L2.');
  let expr: OpExpr;
  try {
    expr = parseExpr(text);
  } catch (e) {
    if (e instanceof ExprError) throw new ComposeError(e.message);
    throw e;
  }
  const refs = collectRefs(expr);
  resetOpsCounter();
  const langs = build(slots.filter((s) => refs.has(s.name)));
  for (const r of refs) {
    if (!langs.has(r)) throw new ComposeError(`השפה '${r}' לא מוגדרת.`);
  }
  const result = evalExpr(expr, langs);
  return { automaton: trimAndRelabel(result), expression: expr };
}

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

function prettyDsl(text: string): string {
  return text
    // x^(expr) → xᵉˣᵖʳ
    .replace(/\^\(([^)]+)\)/g, (_, inner: string) => toSuper(inner.replace(/\s+/g, '')))
    // x^token → xᵗᵒᵏᵉⁿ (alphanumeric run)
    .replace(/\^([A-Za-z0-9]+)/g, (_, run: string) => toSuper(run))
    // relational ops
    .replace(/>=/g, '≥')
    .replace(/<=/g, '≤')
    .replace(/!=/g, '≠')
    // % stays as mod marker; tighten whitespace around `,` and `|`
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/{\s+/g, '{')
    .replace(/\s+}/g, '}')
    .trim();
}

export function formatExpr(e: OpExpr, slots?: LangSlot[]): string {
  const sub = (name: string): string => {
    const slot = slots?.find((s) => s.name === name);
    if (!slot) return name;
    const text = slot.source.trim();
    if (!text) return name;
    // Strip optional `Name = ` prefix so we just show the body `{ ... }`.
    const eqIdx = text.indexOf('=');
    let body = text;
    if (eqIdx >= 0 && /^[A-Za-z][A-Za-z0-9_]*\s*$/.test(text.slice(0, eqIdx))) {
      body = text.slice(eqIdx + 1).trim();
    }
    return prettyDsl(body);
  };
  const f = (e: OpExpr): string => {
    switch (e.kind) {
      case 'ref': return sub(e.name);
      case 'union': return `(${f(e.a)} ∪ ${f(e.b)})`;
      case 'concat': return `(${f(e.a)} · ${f(e.b)})`;
      case 'inter': return `(${f(e.a)} ∩ ${f(e.b)})`;
      case 'diff': return `(${f(e.a)} \\ ${f(e.b)})`;
      case 'star': return `(${f(e.a)})*`;
      case 'reverse': return `(${f(e.a)})ᴿ`;
      case 'complement': return `¬(${f(e.a)})`;
    }
  };
  return f(e);
}
