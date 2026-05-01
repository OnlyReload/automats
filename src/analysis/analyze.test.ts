import { describe, it, expect } from 'vitest';
import { analyze } from './analyze';
import type { NFA } from '../automaton/types';
import { dfaContains, dfaCountMod, dfaAvoids } from './_test_helpers';
import { complementDfa, productDfa, minimizeDfa, type DFA } from './dfa';

// Build a minimal NFA whose language equals a target DFA's language by
// re-using the DFA structure as an NFA (every DFA is an NFA).
function dfaAsNfa(d: DFA): NFA {
  const states = [];
  for (let i = 0; i < d.states; i++) {
    states.push({ id: `q${i}`, accept: d.accept.has(i) });
  }
  const transitions = [];
  for (let i = 0; i < d.states; i++) {
    for (const a of d.alphabet) {
      const j = d.delta[i].get(a)!;
      transitions.push({ from: `q${i}`, to: `q${j}`, symbol: a });
    }
  }
  return {
    states,
    start: 'q0',
    transitions,
    alphabet: d.alphabet,
  };
}

describe('analyze', () => {
  it('detects Σ*', () => {
    const nfa: NFA = {
      states: [{ id: 'q0', accept: true }],
      start: 'q0',
      transitions: [
        { from: 'q0', to: 'q0', symbol: 'a' },
        { from: 'q0', to: 'q0', symbol: 'b' },
      ],
      alphabet: ['a', 'b'],
    };
    const r = analyze(nfa);
    expect(r.description).toContain('כל מילה');
  });

  it('detects even count of a', () => {
    const d = dfaCountMod('a', 2, 0, ['a', 'b']);
    const r = analyze(dfaAsNfa(d));
    expect(r.description).toContain('זוגי');
  });

  it('detects "contains aba"', () => {
    const d = dfaContains('aba', ['a', 'b']);
    const r = analyze(dfaAsNfa(d));
    expect(r.description).toMatch(/מכילה.*aba/);
  });

  it('detects "avoids aba"', () => {
    const d = dfaAvoids('aba', ['a', 'b']);
    const r = analyze(dfaAsNfa(d));
    expect(r.description).toMatch(/אינה מכילה.*aba/);
  });

  it('detects intersection: even count of a AND avoids aba', () => {
    const sigma = ['a', 'b'];
    const d1 = dfaCountMod('a', 2, 0, sigma);
    const d2 = dfaAvoids('aba', sigma);
    const target = minimizeDfa(productDfa(d1, d2, 'and'));
    const r = analyze(dfaAsNfa(target));
    expect(r.description).toBeTruthy();
    expect(r.description).toContain('זוגי');
    expect(r.description).toMatch(/אינה מכילה|אין רצף/);
  });

  it('detects triple intersection: even count of a AND avoids aba AND avoids bab', () => {
    const sigma = ['a', 'b'];
    const d1 = dfaCountMod('a', 2, 0, sigma);
    const d2 = dfaAvoids('aba', sigma);
    const d3 = dfaAvoids('bab', sigma);
    const target = minimizeDfa(productDfa(minimizeDfa(productDfa(d1, d2, 'and')), d3, 'and'));
    const r = analyze(dfaAsNfa(target));
    expect(r.description).toBeTruthy();
    // Must reference at least two of the three components.
    const desc = r.description ?? '';
    const refs = [/זוגי/.test(desc), /aba/.test(desc), /bab/.test(desc)].filter(Boolean).length;
    expect(refs).toBeGreaterThanOrEqual(2);
  });

  it('falls back to regex when no template matches', () => {
    // Some weird hand-rolled DFA that's unlikely to be a known template.
    const sigma = ['a', 'b'];
    const delta: Map<string, number>[] = [
      new Map([['a', 1], ['b', 2]]),
      new Map([['a', 2], ['b', 0]]),
      new Map([['a', 0], ['b', 1]]),
    ];
    const d: DFA = { states: 3, start: 0, accept: new Set([1]), alphabet: sigma, delta };
    const r = analyze(dfaAsNfa(d));
    expect(r.regex).toBeTruthy();
    expect(r.regex).not.toBe('∅');
  });

  void complementDfa;
});
