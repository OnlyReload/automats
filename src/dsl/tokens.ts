import type { Span } from './ast';
import { DslError } from './errors';

export type TokenKind =
  | 'IDENT'        // multi-char identifier (e.g., L1, and, in, R)
  | 'SYMBOL'       // single alphabetic char acting as alphabet symbol (when not consumed as IDENT)
  | 'INT'
  | 'EQ' | 'GE' | 'LE' | 'GT' | 'LT'
  | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH' | 'PERCENT'
  | 'CARET'
  | 'LPAREN' | 'RPAREN' | 'LBRACE' | 'RBRACE'
  | 'COMMA' | 'PIPE'
  | 'EOF';

export interface Token {
  kind: TokenKind;
  text: string;
  span: Span;
}

const KEYWORDS = new Set(['and', 'in']);

// In our DSL, single alphabetic chars are alphabet symbols. But we sometimes need
// multi-char identifiers (language name like "L1", keywords "and"/"in", function "R", word vars).
// Strategy: greedily collect alphanumerics; the parser disambiguates by context.
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const c = input[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    const start = i;

    if (c >= '0' && c <= '9') {
      while (i < n && input[i] >= '0' && input[i] <= '9') i++;
      tokens.push({ kind: 'INT', text: input.slice(start, i), span: { start, end: i } });
      continue;
    }

    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      while (
        i < n &&
        ((input[i] >= 'a' && input[i] <= 'z') ||
          (input[i] >= 'A' && input[i] <= 'Z') ||
          (input[i] >= '0' && input[i] <= '9') ||
          input[i] === '_')
      )
        i++;
      tokens.push({ kind: 'IDENT', text: input.slice(start, i), span: { start, end: i } });
      continue;
    }

    // Two-char operators
    if (c === '>' && input[i + 1] === '=') {
      tokens.push({ kind: 'GE', text: '>=', span: { start, end: i + 2 } });
      i += 2;
      continue;
    }
    if (c === '<' && input[i + 1] === '=') {
      tokens.push({ kind: 'LE', text: '<=', span: { start, end: i + 2 } });
      i += 2;
      continue;
    }

    const single: Record<string, TokenKind> = {
      '=': 'EQ',
      '>': 'GT',
      '<': 'LT',
      '+': 'PLUS',
      '-': 'MINUS',
      '*': 'STAR',
      '/': 'SLASH',
      '%': 'PERCENT',
      '^': 'CARET',
      '(': 'LPAREN',
      ')': 'RPAREN',
      '{': 'LBRACE',
      '}': 'RBRACE',
      ',': 'COMMA',
      '|': 'PIPE',
    };
    const kind = single[c];
    if (kind) {
      tokens.push({ kind, text: c, span: { start, end: i + 1 } });
      i++;
      continue;
    }

    throw new DslError(`תו לא צפוי: '${c}'`, { start, end: i + 1 });
  }

  tokens.push({ kind: 'EOF', text: '', span: { start: n, end: n } });
  return tokens;
}

export function isKeyword(t: Token): boolean {
  return t.kind === 'IDENT' && KEYWORDS.has(t.text);
}

export function isSingleAlpha(t: Token): boolean {
  return t.kind === 'IDENT' && t.text.length === 1 && /^[a-z]$/i.test(t.text);
}
