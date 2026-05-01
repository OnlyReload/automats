import type { DFA } from './dfa';

/**
 * Convert a (minimal) DFA to a regular expression via state elimination.
 * Result uses '|' for union, juxtaposition for concat, '*' for Kleene star,
 * 'ε' for empty word, '∅' for empty language.
 */
export function dfaToRegex(d: DFA): string {
  if (!d.accept.size) return '∅';

  // Add fresh start S and accept F. Edges: S -ε-> d.start; each accept -ε-> F.
  const N = d.states;
  const S = N, F = N + 1;
  const total = N + 2;

  // R[i][j] holds current regex from i to j, or null if no edge.
  const R: (string | null)[][] = Array.from({ length: total }, () => Array(total).fill(null));

  for (let i = 0; i < N; i++) {
    for (const a of d.alphabet) {
      const j = d.delta[i].get(a)!;
      R[i][j] = R[i][j] === null ? a : `${R[i][j]}|${a}`;
    }
  }
  R[S][d.start] = 'ε';
  for (const acc of d.accept) R[acc][F] = 'ε';

  // Eliminate states 0..N-1.
  for (let k = 0; k < N; k++) {
    const loop = R[k][k];
    const loopStar = loop ? star(loop) : '';
    for (let i = 0; i < total; i++) {
      if (i === k) continue;
      if (R[i][k] === null) continue;
      for (let j = 0; j < total; j++) {
        if (j === k) continue;
        if (R[k][j] === null) continue;
        const piece = concat(concat(R[i][k]!, loopStar), R[k][j]!);
        R[i][j] = R[i][j] === null ? piece : union(R[i][j]!, piece);
      }
    }
    // Remove edges touching k.
    for (let i = 0; i < total; i++) { R[i][k] = null; R[k][i] = null; }
  }

  return simplify(R[S][F] ?? '∅');
}

function isAtom(s: string): boolean {
  if (s.length <= 1) return true;
  // Parenthesised whole.
  if (s.startsWith('(') && s.endsWith(')') && balanced(s.slice(1, -1))) return true;
  // Starred atom.
  if (s.endsWith('*') && isAtom(s.slice(0, -1))) return true;
  return false;
}

function balanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') { if (--depth < 0) return false; }
  }
  return depth === 0;
}

function paren(s: string): string {
  return isAtom(s) ? s : `(${s})`;
}

function star(s: string): string {
  if (s === 'ε' || s === '∅') return 'ε';
  if (s.endsWith('*') && isAtom(s.slice(0, -1))) return s;
  return `${paren(s)}*`;
}

function concat(a: string, b: string): string {
  if (a === '∅' || b === '∅') return '∅';
  if (a === 'ε' || a === '') return b;
  if (b === 'ε' || b === '') return a;
  return `${parenForConcat(a)}${parenForConcat(b)}`;
}

function parenForConcat(s: string): string {
  // Need parens for unions inside concat.
  if (containsTopLevelUnion(s)) return `(${s})`;
  return s;
}

function containsTopLevelUnion(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) return true;
  }
  return false;
}

function union(a: string, b: string): string {
  if (a === '∅') return b;
  if (b === '∅') return a;
  if (a === b) return a;
  return `${a}|${b}`;
}

function simplify(s: string): string {
  let prev = '';
  let cur = s;
  while (cur !== prev) {
    prev = cur;
    cur = cur
      .replace(/\(([a-zA-Z0-9])\)/g, '$1')
      .replace(/εε/g, 'ε')
      .replace(/\(ε\)/g, 'ε');
  }
  return cur;
}
