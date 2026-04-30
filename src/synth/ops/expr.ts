// Expression language for composing languages:
//   atoms      : identifiers (L1, L2, …), parenthesized ( … ), R(…)
//   postfix    : *           Kleene star
//   prefix     : ~ ¬         complement
//   binary     : .           concatenation   (highest of the binaries)
//                & ∩         intersection
//                - \         difference
//                | ∪ +       union           (lowest)
//
// Whitespace is significant only as a token separator. Identifiers must start
// with a letter and may contain letters/digits/underscore.

export type OpExpr =
  | { kind: 'ref'; name: string }
  | { kind: 'union'; a: OpExpr; b: OpExpr }
  | { kind: 'diff'; a: OpExpr; b: OpExpr }
  | { kind: 'inter'; a: OpExpr; b: OpExpr }
  | { kind: 'concat'; a: OpExpr; b: OpExpr }
  | { kind: 'star'; a: OpExpr }
  | { kind: 'reverse'; a: OpExpr }
  | { kind: 'complement'; a: OpExpr };

export class ExprError extends Error {}

interface Tok {
  kind:
    | 'IDENT'
    | 'LPAREN'
    | 'RPAREN'
    | 'UNION'
    | 'DIFF'
    | 'INTER'
    | 'CONCAT'
    | 'STAR'
    | 'COMPLEMENT'
    | 'REVERSE'
    | 'EOF';
  text: string;
  pos: number;
}

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) i++;
      const text = input.slice(start, i);
      if (text === 'R') {
        out.push({ kind: 'REVERSE', text, pos: start });
      } else {
        out.push({ kind: 'IDENT', text, pos: start });
      }
      continue;
    }
    if (ch === '(') { out.push({ kind: 'LPAREN', text: ch, pos: i++ }); continue; }
    if (ch === ')') { out.push({ kind: 'RPAREN', text: ch, pos: i++ }); continue; }
    if (ch === '|' || ch === '∪' || ch === '+') { out.push({ kind: 'UNION', text: ch, pos: i++ }); continue; }
    if (ch === '&' || ch === '∩') { out.push({ kind: 'INTER', text: ch, pos: i++ }); continue; }
    if (ch === '-' || ch === '\\') { out.push({ kind: 'DIFF', text: ch, pos: i++ }); continue; }
    if (ch === '.' || ch === '·') { out.push({ kind: 'CONCAT', text: ch, pos: i++ }); continue; }
    if (ch === '*') { out.push({ kind: 'STAR', text: ch, pos: i++ }); continue; }
    if (ch === '~' || ch === '¬') { out.push({ kind: 'COMPLEMENT', text: ch, pos: i++ }); continue; }
    if (ch === 'ᴿ') { out.push({ kind: 'REVERSE', text: ch, pos: i++ }); continue; }
    throw new ExprError(`תו לא מזוהה בביטוי: '${ch}'`);
  }
  out.push({ kind: 'EOF', text: '', pos: i });
  return out;
}

class Parser {
  i = 0;
  constructor(public toks: Tok[]) {}
  peek(): Tok { return this.toks[this.i]; }
  eat(): Tok { return this.toks[this.i++]; }
  match(kind: Tok['kind']): boolean { return this.peek().kind === kind; }

  parseUnion(): OpExpr {
    let left = this.parseDiff();
    while (this.match('UNION')) {
      this.eat();
      left = { kind: 'union', a: left, b: this.parseDiff() };
    }
    return left;
  }
  parseDiff(): OpExpr {
    let left = this.parseInter();
    while (this.match('DIFF')) {
      this.eat();
      left = { kind: 'diff', a: left, b: this.parseInter() };
    }
    return left;
  }
  parseInter(): OpExpr {
    let left = this.parseConcat();
    while (this.match('INTER')) {
      this.eat();
      left = { kind: 'inter', a: left, b: this.parseConcat() };
    }
    return left;
  }
  parseConcat(): OpExpr {
    let left = this.parsePrefix();
    while (this.match('CONCAT')) {
      this.eat();
      left = { kind: 'concat', a: left, b: this.parsePrefix() };
    }
    return left;
  }
  parsePrefix(): OpExpr {
    if (this.match('COMPLEMENT')) {
      this.eat();
      return { kind: 'complement', a: this.parsePrefix() };
    }
    return this.parsePostfix();
  }
  parsePostfix(): OpExpr {
    let node = this.parseAtom();
    while (this.match('STAR') || this.peek().kind === 'REVERSE' && this.toks[this.i + 1]?.kind !== 'LPAREN') {
      const t = this.eat();
      if (t.kind === 'STAR') node = { kind: 'star', a: node };
      else node = { kind: 'reverse', a: node };
    }
    return node;
  }
  parseAtom(): OpExpr {
    const t = this.peek();
    if (t.kind === 'IDENT') {
      this.eat();
      return { kind: 'ref', name: t.text };
    }
    if (t.kind === 'REVERSE' && this.toks[this.i + 1]?.kind === 'LPAREN') {
      this.eat(); // R
      this.eat(); // (
      const inner = this.parseUnion();
      if (!this.match('RPAREN')) throw new ExprError('חסר ) אחרי R(...)');
      this.eat();
      return { kind: 'reverse', a: inner };
    }
    if (t.kind === 'LPAREN') {
      this.eat();
      const inner = this.parseUnion();
      if (!this.match('RPAREN')) throw new ExprError('חסר ) בביטוי');
      this.eat();
      return inner;
    }
    throw new ExprError(`לא צפוי בביטוי: '${t.text || 'סוף'}'`);
  }
}

export function parseExpr(input: string): OpExpr {
  const toks = tokenize(input);
  const p = new Parser(toks);
  const expr = p.parseUnion();
  if (!p.match('EOF')) {
    throw new ExprError(`שארית לא צפויה בביטוי: '${p.peek().text}'`);
  }
  return expr;
}

export function collectRefs(e: OpExpr, into = new Set<string>()): Set<string> {
  switch (e.kind) {
    case 'ref': into.add(e.name); break;
    case 'star':
    case 'reverse':
    case 'complement':
      collectRefs(e.a, into); break;
    default:
      collectRefs(e.a, into);
      collectRefs(e.b, into);
  }
  return into;
}
