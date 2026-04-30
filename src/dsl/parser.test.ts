import { describe, expect, it } from 'vitest';
import { parseLanguage } from './parser';

describe('DSL parser — textbook languages', () => {
  it('parses L1: { (xy)^n (xy)^m | n >= m >= 0 }', () => {
    const decl = parseLanguage('L1 = { (xy)^n (xy)^m | n >= m >= 0 }');
    expect(decl.name).toBe('L1');
    expect(decl.word.terms).toHaveLength(2);
    expect(decl.word.terms[0].atom.kind).toBe('group');
    expect(decl.word.terms[0].exponent).toMatchObject({ kind: 'var', name: 'n' });
    expect(decl.constraints).toHaveLength(1);
    expect(decl.constraints[0]).toMatchObject({ kind: 'rel', ops: ['>=', '>='] });
  });

  it('parses L2: { a^n b^m | 1000 >= n >= m >= 0 }', () => {
    const decl = parseLanguage('L2 = { a^n b^m | 1000 >= n >= m >= 0 }');
    const c = decl.constraints[0];
    expect(c.kind).toBe('rel');
    if (c.kind !== 'rel') return;
    expect(c.ops).toEqual(['>=', '>=', '>=']);
    expect(c.operands).toHaveLength(4);
    expect(c.operands[0]).toMatchObject({ kind: 'int', value: 1000 });
  });

  it('parses L3: { a^n c^2 b^m | n%3 = m, m,n >= 0 }', () => {
    const decl = parseLanguage('L3 = { a^n c^2 b^m | n%3 = m, m >= 0, n >= 0 }');
    expect(decl.word.terms).toHaveLength(3);
    expect(decl.word.terms[1].exponent).toMatchObject({ kind: 'int', value: 2 });
    expect(decl.constraints).toHaveLength(3);
  });

  it('parses L4: { a^n b^m | n,m >= 0 }', () => {
    const decl = parseLanguage('L4 = { a^n b^m | n >= 0, m >= 0 }');
    expect(decl.word.terms).toHaveLength(2);
    expect(decl.word.terms[0]).toMatchObject({
      atom: { kind: 'symbol', symbol: 'a' },
      exponent: { kind: 'var', name: 'n' },
    });
  });

  it('parses arithmetic in exponents: a^(n+2)', () => {
    const decl = parseLanguage('L = { a^(n+2) | n > 0 }');
    expect(decl.word.terms[0].exponent).toMatchObject({
      kind: 'binop',
      op: '+',
      left: { kind: 'var', name: 'n' },
      right: { kind: 'int', value: 2 },
    });
  });

  it('parses palindrome with R(w) and word var declaration', () => {
    const decl = parseLanguage('L12 = { w R(w) | w in {a,b}* }');
    expect(decl.word.terms).toHaveLength(2);
    expect(decl.word.terms[0].atom).toMatchObject({ kind: 'wordVar', name: 'w' });
    expect(decl.word.terms[1].atom).toMatchObject({ kind: 'reverse', wordVar: 'w' });
    expect(decl.constraints[0]).toMatchObject({ kind: 'wordVarDecl', wordVar: 'w', alphabet: ['a', 'b'] });
  });

  it('errors on missing pipe', () => {
    expect(() => parseLanguage('L = { a^n }')).toThrow();
  });

  it('errors on missing closing brace', () => {
    expect(() => parseLanguage('L = { a^n | n >= 0 ')).toThrow();
  });
});
