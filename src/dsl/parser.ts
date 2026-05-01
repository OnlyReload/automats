import type {
  ArithExpr,
  Atom,
  Constraint,
  LangDecl,
  RelOp,
  Span,
  Term,
  Word,
} from './ast';
import { DslError } from './errors';
import { isSingleAlpha, tokenize, type Token, type TokenKind } from './tokens';

class Cursor {
  i = 0;
  constructor(public tokens: Token[]) {}

  peek(offset = 0): Token {
    return this.tokens[this.i + offset];
  }

  consume(): Token {
    return this.tokens[this.i++];
  }

  expect(kind: TokenKind, message?: string): Token {
    const t = this.peek();
    if (t.kind !== kind) {
      throw new DslError(message ?? `נדרש ${kind}, נמצא ${t.kind}: '${t.text}'`, t.span);
    }
    return this.consume();
  }

  match(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  matchText(text: string): boolean {
    return this.peek().text === text;
  }
}

const REL_OPS: Record<string, RelOp> = {
  EQ: '=',
  GE: '>=',
  LE: '<=',
  GT: '>',
  LT: '<',
};

const REL_OP_KINDS = new Set<TokenKind>(['EQ', 'GE', 'LE', 'GT', 'LT']);

function spanOf(start: Span, end: Span): Span {
  return { start: start.start, end: end.end };
}

export function parseLanguage(input: string): LangDecl {
  const tokens = tokenize(input);
  const c = new Cursor(tokens);

  // LangDecl = Ident "=" "{" Word "|" Constraints "}"
  const nameTok = c.expect('IDENT', 'שם השפה צריך להיות מזהה (למשל L1)');
  c.expect('EQ', 'נדרש = אחרי שם השפה');
  c.expect('LBRACE', 'נדרש { לפני המילה');

  // Two-pass strategy: split tokens before/after PIPE. Parse constraints first
  // to discover word vars, then parse the word with that context.
  const pipeIdx = findTopLevelPipe(tokens, c.i);
  if (pipeIdx === -1) throw new DslError("נדרש | בין המילה לתנאים", { start: tokens[c.i].span.start, end: tokens[c.i].span.start });

  const closeIdx = findMatchingRBrace(tokens, c.i - 1);
  if (closeIdx === -1) throw new DslError("חסר } בסוף השפה", tokens[tokens.length - 1].span);

  const wordTokens = tokens.slice(c.i, pipeIdx);
  const constraintTokens = tokens.slice(pipeIdx + 1, closeIdx);

  // Parse constraints first (without word-var context) to find word var declarations.
  const constraints = parseConstraints([...constraintTokens, eofAt(tokens[closeIdx].span.start)]);

  const wordVars = new Set<string>();
  for (const k of constraints) {
    if (k.kind === 'wordVarDecl') wordVars.add(k.wordVar);
  }
  // R(x) in the word also tells us x is a word var
  for (const tok of wordTokens) {
    /* handled in parseWord by greedy lookahead */
    void tok;
  }

  const word = parseWord([...wordTokens, eofAt(tokens[pipeIdx].span.start)], wordVars);

  // advance the main cursor past everything to the closing brace
  c.i = closeIdx + 1;

  return {
    kind: 'langDecl',
    name: nameTok.text,
    word,
    constraints,
    span: spanOf(nameTok.span, tokens[closeIdx].span),
  };
}

function eofAt(pos: number): Token {
  return { kind: 'EOF', text: '', span: { start: pos, end: pos } };
}

function findTopLevelPipe(tokens: Token[], from: number): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'LBRACE' || t.kind === 'LPAREN') depth++;
    else if (t.kind === 'RBRACE' || t.kind === 'RPAREN') {
      if (depth === 0) return -1;
      depth--;
    } else if (t.kind === 'PIPE' && depth === 0) return i;
  }
  return -1;
}

function findMatchingRBrace(tokens: Token[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'LBRACE') depth++;
    else if (t.kind === 'RBRACE') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Word parsing
// ---------------------------------------------------------------------------

function parseWord(tokens: Token[], wordVars: Set<string>): Word {
  const c = new Cursor(tokens);
  const start = c.peek().span;
  const terms: Term[] = [];
  while (!c.match('EOF')) {
    splitMultiCharIdent(c, wordVars, terms);
    if (c.match('EOF')) break;
    terms.push(parseTerm(c, wordVars));
  }
  if (terms.length === 0) {
    return { kind: 'word', terms: [], span: { start: start.start, end: start.start } };
  }
  return {
    kind: 'word',
    terms,
    span: spanOf(terms[0].span, terms[terms.length - 1].span),
  };
}

// In word position, textbook convention treats each alphabetic char as an atomic
// alphabet symbol. The greedy lexer collects "abc" into one IDENT, so when we
// encounter a multi-char IDENT here that isn't a word var or `R(`, we synthesize
// (n-1) bare-symbol terms for the prefix, leaving the last char as an IDENT
// token for parseTerm (so it can pick up an optional `^exponent`).
function splitMultiCharIdent(c: Cursor, wordVars: Set<string>, out: Term[]): void {
  const t = c.peek();
  if (t.kind !== 'IDENT') return;
  if (t.text.length <= 1) return;
  if (wordVars.has(t.text)) return;
  if (t.text === 'R' && c.peek(1).kind === 'LPAREN') return;
  // Split prefix off into bare-symbol terms; replace head token with last char.
  const prefix = t.text.slice(0, -1);
  const last = t.text.slice(-1);
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    const span: Span = { start: t.span.start + i, end: t.span.start + i + 1 };
    out.push({
      kind: 'term',
      atom: { kind: 'symbol', symbol: ch, span },
      exponent: null,
      span,
    });
  }
  // Mutate the head token in place so parseTerm sees the trailing char as an IDENT.
  c.tokens[c.i] = {
    kind: 'IDENT',
    text: last,
    span: { start: t.span.end - 1, end: t.span.end },
  };
}

function parseTerm(c: Cursor, wordVars: Set<string>): Term {
  const atom = parseAtom(c, wordVars);
  let exponent: ArithExpr | null = null;
  let endSpan = atom.span;
  if (c.match('CARET')) {
    c.consume();
    exponent = parseExponent(c);
    endSpan = exponent.span;
  }
  return {
    kind: 'term',
    atom,
    exponent,
    span: spanOf(atom.span, endSpan),
  };
}

function parseAtom(c: Cursor, wordVars: Set<string>): Atom {
  const t = c.peek();

  // R(wordvar) — reverse
  if (t.kind === 'IDENT' && t.text === 'R' && c.peek(1).kind === 'LPAREN') {
    c.consume(); // R
    c.consume(); // (
    const wv = c.expect('IDENT', 'נדרש שם של משתנה מילה בתוך R(...)');
    const close = c.expect('RPAREN', 'נדרש ) אחרי R(...)');
    return {
      kind: 'reverse',
      wordVar: wv.text,
      span: spanOf(t.span, close.span),
    };
  }

  // Word variable (declared in constraints)
  if (t.kind === 'IDENT' && wordVars.has(t.text)) {
    c.consume();
    return { kind: 'wordVar', name: t.text, span: t.span };
  }

  // Parenthesized group: (xy) or (a^n b^m)
  if (t.kind === 'LPAREN') {
    c.consume();
    const inner: Term[] = [];
    const start = t.span;
    while (!c.match('RPAREN') && !c.match('EOF')) {
      splitMultiCharIdent(c, wordVars, inner);
      if (c.match('RPAREN') || c.match('EOF')) break;
      inner.push(parseTerm(c, wordVars));
    }
    const close = c.expect('RPAREN', 'נדרש ) לסגירת הקבוצה');
    const word: Word = {
      kind: 'word',
      terms: inner,
      span: { start: start.start, end: close.span.end },
    };
    return { kind: 'group', word, span: { start: start.start, end: close.span.end } };
  }

  // Single-character alphabet symbol
  if (isSingleAlpha(t)) {
    c.consume();
    return { kind: 'symbol', symbol: t.text, span: t.span };
  }

  throw new DslError(
    `אטום לא מזוהה במילה: '${t.text}'. ניתן להשתמש באותיות בודדות (כמו a), קבוצות בסוגריים ((xy)), משתני מילה (w) או R(w).`,
    t.span
  );
}

function parseExponent(c: Cursor): ArithExpr {
  // Exponent = Int | Var | "(" ArithExpr ")"
  const t = c.peek();
  if (t.kind === 'INT') {
    c.consume();
    return { kind: 'int', value: parseInt(t.text, 10), span: t.span };
  }
  if (t.kind === 'IDENT') {
    c.consume();
    return { kind: 'var', name: t.text, span: t.span };
  }
  if (t.kind === 'LPAREN') {
    c.consume();
    const expr = parseArithExpr(c);
    c.expect('RPAREN', 'נדרש ) לסגירת המעריך');
    return expr;
  }
  throw new DslError(`מעריך לא חוקי: '${t.text}'`, t.span);
}

// ---------------------------------------------------------------------------
// Arithmetic expressions (used in exponents and constraints)
// ---------------------------------------------------------------------------

function parseArithExpr(c: Cursor): ArithExpr {
  let left = parseArithTerm(c);
  while (c.match('PLUS') || c.match('MINUS')) {
    const op = c.consume().text as '+' | '-';
    const right = parseArithTerm(c);
    left = { kind: 'binop', op, left, right, span: spanOf(left.span, right.span) };
  }
  return left;
}

function parseArithTerm(c: Cursor): ArithExpr {
  let left = parseArithFact(c);
  while (c.match('STAR') || c.match('SLASH') || c.match('PERCENT')) {
    const op = c.consume().text as '*' | '/' | '%';
    const right = parseArithFact(c);
    left = { kind: 'binop', op, left, right, span: spanOf(left.span, right.span) };
  }
  return left;
}

function parseArithFact(c: Cursor): ArithExpr {
  const t = c.peek();
  // Letter-count expression: #a(w) — count of letter `a` in word var `w`.
  if (t.kind === 'HASH') {
    c.consume();
    const letterTok = c.expect('IDENT', "אחרי # נדרשת אות (כמו #a(w))");
    if (letterTok.text.length !== 1) {
      throw new DslError("האות אחרי # חייבת להיות תו בודד (למשל #a(w))", letterTok.span);
    }
    c.expect('LPAREN', "נדרש ( אחרי #" + letterTok.text);
    const wvTok = c.expect('IDENT', "נדרש שם של משתנה מילה בתוך #" + letterTok.text + "(...)");
    const close = c.expect('RPAREN', "נדרש ) אחרי #" + letterTok.text + "(" + wvTok.text);
    return {
      kind: 'letterCount',
      letter: letterTok.text,
      wordVar: wvTok.text,
      span: spanOf(t.span, close.span),
    };
  }
  if (t.kind === 'INT') {
    c.consume();
    return { kind: 'int', value: parseInt(t.text, 10), span: t.span };
  }
  if (t.kind === 'IDENT') {
    c.consume();
    return { kind: 'var', name: t.text, span: t.span };
  }
  if (t.kind === 'LPAREN') {
    c.consume();
    const expr = parseArithExpr(c);
    c.expect('RPAREN', 'נדרש ) לסגירת ביטוי');
    return expr;
  }
  if (t.kind === 'MINUS') {
    c.consume();
    const operand = parseArithFact(c);
    return {
      kind: 'binop',
      op: '-',
      left: { kind: 'int', value: 0, span: t.span },
      right: operand,
      span: spanOf(t.span, operand.span),
    };
  }
  throw new DslError(`ביטוי חשבוני לא חוקי: '${t.text}'`, t.span);
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

function parseConstraints(tokens: Token[]): Constraint[] {
  const c = new Cursor(tokens);
  const out: Constraint[] = [];
  if (c.match('EOF')) return out;
  out.push(parseConstraint(c));
  while (c.match('COMMA') || (c.peek().kind === 'IDENT' && c.peek().text === 'and')) {
    c.consume();
    out.push(parseConstraint(c));
  }
  if (!c.match('EOF')) {
    const t = c.peek();
    throw new DslError(`מצופה פסיק או 'and', נמצא '${t.text}'`, t.span);
  }
  return out;
}

function parseConstraint(c: Cursor): Constraint {
  // Lookahead for "wordvar in {a,b,...}*"
  const t = c.peek();
  if (
    t.kind === 'IDENT' &&
    c.peek(1).kind === 'IDENT' &&
    c.peek(1).text === 'in' &&
    c.peek(2).kind === 'LBRACE'
  ) {
    const wvTok = c.consume();
    c.consume(); // 'in'
    c.consume(); // {
    const alphabet: string[] = [];
    if (!c.match('RBRACE')) {
      alphabet.push(c.expect('IDENT').text);
      while (c.match('COMMA')) {
        c.consume();
        alphabet.push(c.expect('IDENT').text);
      }
    }
    const close = c.expect('RBRACE', 'נדרש } לסגירת הא"ב');
    let endSpan = close.span;
    if (c.match('STAR')) {
      endSpan = c.consume().span;
    }
    return {
      kind: 'wordVarDecl',
      wordVar: wvTok.text,
      alphabet,
      span: spanOf(wvTok.span, endSpan),
    };
  }

  // Otherwise, a chained relation: expr REL expr [REL expr]*
  const operands: ArithExpr[] = [parseArithExpr(c)];
  const ops: RelOp[] = [];
  while (REL_OP_KINDS.has(c.peek().kind)) {
    const opTok = c.consume();
    ops.push(REL_OPS[opTok.kind]);
    operands.push(parseArithExpr(c));
  }
  if (ops.length === 0) {
    throw new DslError(
      `תנאי חייב להכיל יחס (כמו =, >=, <=). נמצא: '${c.peek().text}'`,
      operands[0].span
    );
  }
  return {
    kind: 'rel',
    operands,
    ops,
    span: spanOf(operands[0].span, operands[operands.length - 1].span),
  };
}
