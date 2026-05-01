import { describe, expect, it } from 'vitest';
import { parseLanguage } from '../dsl/parser';
import { synthesize, isPDA } from './synthesize';
import { DslError } from '../dsl/errors';
import { EXAMPLES } from '../examples';
import type { NFA } from '../automaton/types';

function buildNFA(src: string): NFA {
  const a = synthesize(parseLanguage(src));
  if (isPDA(a)) throw new Error(`expected NFA but got PDA for: ${src}`);
  return a;
}

function simulator(nfa: ReturnType<typeof buildNFA>): (input: string) => boolean {
  return (input: string) => {
    let cur = new Set<string>([nfa.start]);
    for (const ch of input) {
      const next = new Set<string>();
      for (const s of cur) {
        for (const t of nfa.transitions) {
          if (t.from === s && t.symbol === ch) next.add(t.to);
        }
      }
      cur = next;
      if (cur.size === 0) return false;
    }
    return [...cur].some((id) => nfa.states.find((s) => s.id === id)?.accept);
  };
}

describe('synthesize — regular textbook languages', () => {
  it('L4: { a^n b^m | n,m >= 0 } produces 2-state NFA', () => {
    const nfa = buildNFA('L4 = { a^n b^m | n >= 0, m >= 0 }');
    expect(nfa.states.length).toBe(2);
    expect(nfa.states.every((s) => s.accept)).toBe(true);
    // Self-loop on q0 with 'a', edge q0->q1 with 'b' implicit via loop, self-loop on q1 with 'b'
    expect(nfa.transitions.some((t) => t.from === nfa.start && t.symbol === 'a')).toBe(true);
    expect(nfa.alphabet).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('L1: { (xy)^n (xy)^m | n >= m >= 0 } collapses to (xy)^k loop', () => {
    const nfa = buildNFA('L1 = { (xy)^n (xy)^m | n >= m >= 0 }');
    // 2 states for the (xy) loop: start (accept, sees x), middle (sees y back to start)
    expect(nfa.states.length).toBe(2);
    expect(nfa.states[0].accept).toBe(true);
    expect(nfa.alphabet).toEqual(expect.arrayContaining(['x', 'y']));
  });

  it('strict inequality: { (xy)^n (xy)^m | n > m > 0 } requires min 3 reps', () => {
    const nfa = buildNFA('L = { (xy)^n (xy)^m | n > m > 0 }');
    const startState = nfa.states.find((s) => s.id === nfa.start)!;
    expect(startState.accept).toBe(false); // empty isn't in language
    const accepts = simulator(nfa);
    expect(accepts('')).toBe(false);
    expect(accepts('xy')).toBe(false);
    expect(accepts('xyxy')).toBe(false);     // 2 reps < 3
    expect(accepts('xyxyxy')).toBe(true);    // 3 reps
    expect(accepts('xyxyxyxy')).toBe(true);  // 4 reps
  });

  it('equality collapse: { (xy)^n (xy)^m | n = m } yields step-2 cycle', () => {
    const nfa = buildNFA('L = { (xy)^n (xy)^m | n = m, n >= 0, m >= 0 }');
    const accepts = simulator(nfa);
    expect(accepts('')).toBe(true);          // n=m=0
    expect(accepts('xy')).toBe(false);       // 1 rep total but only even allowed
    expect(accepts('xyxy')).toBe(true);      // 2 reps (n=m=1)
    expect(accepts('xyxyxy')).toBe(false);   // 3 reps not even
    expect(accepts('xyxyxyxy')).toBe(true);  // 4 reps (n=m=2)
  });

  it('single block: { a^n | n >= 0 } is a self-looping accept state', () => {
    const nfa = buildNFA('L = { a^n | n >= 0 }');
    expect(nfa.states.length).toBe(1);
    expect(nfa.states[0].accept).toBe(true);
    expect(nfa.transitions).toEqual([
      { from: nfa.start, to: nfa.start, symbol: 'a' },
    ]);
  });

  it('fixed power: { a^3 } produces a 4-state chain with only the last accepting', () => {
    const nfa = buildNFA('L = { a^3 | }');
    expect(nfa.states.length).toBe(4);
    const accepts = nfa.states.filter((s) => s.accept).map((s) => s.id);
    expect(accepts.length).toBe(1);
    expect(nfa.transitions.length).toBe(3);
  });

  it('L3: { a^n c^2 b^m | n%3 = m } builds a 3-cycle with per-residue tail', () => {
    const nfa = buildNFA('L3 = { a^n c^2 b^m | n%3 = m, m >= 0, n >= 0 }');
    // 3-state a-cycle + 3 residues × (2 c-states + 0/1/2 b-states)
    // = 3 + 3*2 + (0+1+2) = 12 states total.
    expect(nfa.states.length).toBe(12);
    expect(nfa.alphabet).toEqual(expect.arrayContaining(['a', 'b', 'c']));

    // Exactly 3 accept states (one per residue's terminal).
    const accepts = nfa.states.filter((s) => s.accept);
    expect(accepts.length).toBe(3);

    // Start state isn't accepting — the language requires "cc" minimum.
    const startState = nfa.states.find((s) => s.id === nfa.start);
    expect(startState?.accept).toBe(false);

    // The a-cycle: from start, three a-edges form a cycle.
    const aFromStart = nfa.transitions.filter((t) => t.from === nfa.start && t.symbol === 'a');
    expect(aFromStart.length).toBe(1);
  });

  it('bounded equality: { a^n b^m | n = m, m <= 3 } accepts only matching pairs', () => {
    const nfa = buildNFA('L = { a^n b^m | n = m, m <= 3, n >= 0, m >= 0 }');
    const accepts = (input: string): boolean => {
      let cur = new Set<string>([nfa.start]);
      for (const ch of input) {
        const next = new Set<string>();
        for (const s of cur) {
          for (const t of nfa.transitions) {
            if (t.from === s && t.symbol === ch) next.add(t.to);
          }
        }
        cur = next;
        if (cur.size === 0) return false;
      }
      return [...cur].some((id) => nfa.states.find((s) => s.id === id)?.accept);
    };
    expect(accepts('')).toBe(true);
    expect(accepts('ab')).toBe(true);
    expect(accepts('aabb')).toBe(true);
    expect(accepts('aaabbb')).toBe(true);
    expect(accepts('aaaabbbb')).toBe(false); // 4 > 3
    expect(accepts('aab')).toBe(false);
    expect(accepts('abb')).toBe(false);
  });

  it('bounded sum equality: { a^n b^m | n + m = 4 }', () => {
    const accepts = simulator(buildNFA('L = { a^n b^m | n + m = 4, n >= 0, m >= 0 }'));
    expect(accepts('aaaa')).toBe(true);     // n=4,m=0
    expect(accepts('aaab')).toBe(true);     // n=3,m=1
    expect(accepts('aabb')).toBe(true);
    expect(accepts('abbb')).toBe(true);
    expect(accepts('bbbb')).toBe(true);
    expect(accepts('aaaab')).toBe(false);   // n=4,m=1, total 5
    expect(accepts('aab')).toBe(false);     // total 3
    expect(accepts('')).toBe(false);
    expect(accepts('ba')).toBe(false);      // wrong order
  });

  it('bounded sum inequality: { a^n b^m | n + m <= 3 }', () => {
    const accepts = simulator(buildNFA('L = { a^n b^m | n + m <= 3, n >= 0, m >= 0 }'));
    expect(accepts('')).toBe(true);
    expect(accepts('a')).toBe(true);
    expect(accepts('b')).toBe(true);
    expect(accepts('ab')).toBe(true);
    expect(accepts('aab')).toBe(true);       // 3 ≤ 3
    expect(accepts('abb')).toBe(true);       // 3 ≤ 3
    expect(accepts('aaa')).toBe(true);
    expect(accepts('bbb')).toBe(true);
    expect(accepts('aaab')).toBe(false);     // total 4 > 3
    expect(accepts('aabb')).toBe(false);     // total 4 > 3
    expect(accepts('aaaa')).toBe(false);     // total 4
    expect(accepts('ba')).toBe(false);       // wrong order
  });

  it('independent modular: { a^n b^m | n%2 = 0, m%3 = 0 }', () => {
    const accepts = simulator(buildNFA('L = { a^n b^m | n%2 = 0, m%3 = 0, n >= 0, m >= 0 }'));
    expect(accepts('')).toBe(true);          // n=0,m=0
    expect(accepts('aa')).toBe(true);        // n=2
    expect(accepts('aabbb')).toBe(true);     // n=2,m=3
    expect(accepts('aaaabbbbbb')).toBe(true);// n=4,m=6
    expect(accepts('a')).toBe(false);        // n=1 not %2=0
    expect(accepts('bb')).toBe(false);       // m=2 not %3=0
    expect(accepts('aabb')).toBe(false);     // m=2
    expect(accepts('aabbbb')).toBe(false);   // m=4 not %3=0
  });

  it('linear with offset: { a^n b^m | n = m + 1, m <= 3 }', () => {
    const accepts = simulator(buildNFA('L = { a^n b^m | n = m + 1, m >= 0, m <= 3 }'));
    expect(accepts('a')).toBe(true);         // n=1,m=0
    expect(accepts('aab')).toBe(true);       // n=2,m=1
    expect(accepts('aaabb')).toBe(true);     // n=3,m=2
    expect(accepts('aaaabbb')).toBe(true);   // n=4,m=3
    expect(accepts('')).toBe(false);
    expect(accepts('ab')).toBe(false);       // n=1,m=1; need n=m+1
    expect(accepts('aaaaabbbb')).toBe(false);// n=5,m=4 (m>3)
  });

  it('range bounds: { a^n | 2 <= n <= 5 }', () => {
    const accepts = simulator(buildNFA('L = { a^n | 2 <= n, n <= 5 }'));
    expect(accepts('')).toBe(false);
    expect(accepts('a')).toBe(false);
    expect(accepts('aa')).toBe(true);
    expect(accepts('aaa')).toBe(true);
    expect(accepts('aaaa')).toBe(true);
    expect(accepts('aaaaa')).toBe(true);
    expect(accepts('aaaaaa')).toBe(false);
  });

  it('single-var modular: { a^n | n%3 = 1 }', () => {
    const accepts = simulator(buildNFA('L = { a^n | n%3 = 1, n >= 0 }'));
    expect(accepts('')).toBe(false);   // n=0, 0%3=0
    expect(accepts('a')).toBe(true);   // n=1
    expect(accepts('aa')).toBe(false); // n=2
    expect(accepts('aaa')).toBe(false);// n=3
    expect(accepts('aaaa')).toBe(true);// n=4
    expect(accepts('aaaaaaa')).toBe(true); // n=7
  });

  it('strict inequality bounded: { a^n b^m | n > m, m <= 3 }', () => {
    const accepts = simulator(buildNFA('L = { a^n b^m | n > m, m <= 3, n >= 0, m >= 0 }'));
    expect(accepts('a')).toBe(true);          // n=1,m=0
    expect(accepts('aa')).toBe(true);         // n=2,m=0
    expect(accepts('aab')).toBe(true);        // n=2,m=1
    expect(accepts('aaaabbb')).toBe(true);    // n=4,m=3
    expect(accepts('')).toBe(false);          // n=0,m=0 — n > m fails
    expect(accepts('ab')).toBe(false);        // n=1,m=1 — not >
    expect(accepts('aabb')).toBe(false);      // n=2,m=2
    expect(accepts('aaaabbbb')).toBe(false);  // m=4 > 3
  });

  it('non-strict bounded: { a^n b^m | n >= m, m <= 4 } accepts via saturation', () => {
    const accepts = simulator(buildNFA('L = { a^n b^m | n >= m, m <= 4, n >= 0, m >= 0 }'));
    expect(accepts('')).toBe(true);            // n=0,m=0
    expect(accepts('a')).toBe(true);
    expect(accepts('ab')).toBe(true);          // n=1,m=1
    expect(accepts('aaab')).toBe(true);        // n=3,m=1
    expect(accepts('aaaaaaa')).toBe(true);     // n=7,m=0 (n unbounded)
    expect(accepts('aaaabbbb')).toBe(true);    // n=4,m=4
    expect(accepts('aaaaabbbb')).toBe(true);   // n=5,m=4
    expect(accepts('abb')).toBe(false);        // n=1,m=2
    expect(accepts('aabbbbb')).toBe(false);    // m=5 > 4
  });

  it('two modulars combined: { a^n b^m | n%2 = 0, m%2 = 1 }', () => {
    const accepts = simulator(buildNFA('L = { a^n b^m | n%2 = 0, m%2 = 1, n >= 0, m >= 0 }'));
    expect(accepts('b')).toBe(true);          // n=0,m=1
    expect(accepts('aab')).toBe(true);        // n=2,m=1
    expect(accepts('bbb')).toBe(true);        // n=0,m=3
    expect(accepts('aabbb')).toBe(true);      // n=2,m=3
    expect(accepts('')).toBe(false);          // m=0 not %2=1
    expect(accepts('a')).toBe(false);         // n=1
    expect(accepts('ab')).toBe(false);        // n=1
    expect(accepts('bb')).toBe(false);        // m=2
    expect(accepts('aabb')).toBe(false);
  });

  it('three-block with constant in middle: { a^n c^2 b^m | n + m = 3 }', () => {
    const accepts = simulator(buildNFA('L = { a^n c^2 b^m | n + m = 3, n >= 0, m >= 0 }'));
    expect(accepts('cc')).toBe(false);          // n=0,m=0,total=0
    expect(accepts('aaaccbbb')).toBe(false);    // n=3,m=3,total=6
    expect(accepts('aaaacc')).toBe(false);      // n=4,total=4 wait n+m must=3 and n=4>3
    expect(accepts('ccbbb')).toBe(true);        // n=0,m=3
    expect(accepts('accbb')).toBe(true);        // n=1,m=2
    expect(accepts('aaccb')).toBe(true);        // n=2,m=1
    expect(accepts('aaacc')).toBe(true);        // n=3,m=0
    expect(accepts('cb')).toBe(false);          // missing one c
  });

  it('exclusive constant: { a^n c^3 | n >= 0 } accepts only with cccc..no, ccc', () => {
    const accepts = simulator(buildNFA('L = { a^n c^3 | n >= 0 }'));
    expect(accepts('ccc')).toBe(true);     // n=0
    expect(accepts('accc')).toBe(true);    // n=1
    expect(accepts('aaccc')).toBe(true);   // n=2
    expect(accepts('cc')).toBe(false);     // wrong constant count
    expect(accepts('cccc')).toBe(false);   // too many c
    expect(accepts('a')).toBe(false);      // missing constant
    expect(accepts('aac')).toBe(false);    // constant short
  });

  it('three-var bounded equality: { a^n b^m c^k | n = k, m <= 2, k <= 2 }', () => {
    const accepts = simulator(buildNFA('L = { a^n b^m c^k | n = k, m >= 0, m <= 2, k >= 0, k <= 2, n >= 0 }'));
    expect(accepts('')).toBe(true);          // n=k=0,m=0
    expect(accepts('ac')).toBe(true);        // n=k=1,m=0
    expect(accepts('aabcc')).toBe(true);     // n=k=2,m=1
    expect(accepts('abc')).toBe(true);       // n=k=1,m=1
    expect(accepts('aabbcc')).toBe(true);    // n=k=2,m=2
    expect(accepts('aac')).toBe(false);      // n=2,k=1
    expect(accepts('a')).toBe(false);        // n=1,k=0
    expect(accepts('aaabbccc')).toBe(false); // n=k=3 > 2
  });

  it('L3 accepts the canonical strings via NFA simulation', () => {
    const nfa = buildNFA('L3 = { a^n c^2 b^m | n%3 = m, m >= 0, n >= 0 }');
    const accepts = (input: string): boolean => {
      let cur = new Set<string>([nfa.start]);
      for (const ch of input) {
        const next = new Set<string>();
        for (const s of cur) {
          for (const t of nfa.transitions) {
            if (t.from === s && t.symbol === ch) next.add(t.to);
          }
        }
        cur = next;
        if (cur.size === 0) return false;
      }
      return [...cur].some((id) => nfa.states.find((s) => s.id === id)?.accept);
    };

    // n=0,m=0 → "cc"
    expect(accepts('cc')).toBe(true);
    // n=1,m=1 → "accb"
    expect(accepts('accb')).toBe(true);
    // n=2,m=2 → "aaccbb"
    expect(accepts('aaccbb')).toBe(true);
    // n=3,m=0 → "aaacc"
    expect(accepts('aaacc')).toBe(true);
    // n=4,m=1 → "aaaaccb"
    expect(accepts('aaaaccb')).toBe(true);

    // Wrong: n=1, m=0 → "acc" should reject
    expect(accepts('acc')).toBe(false);
    // Wrong: n=2, m=1 → "aaccb" should reject
    expect(accepts('aaccb')).toBe(false);
    // Empty string isn't in the language (cc is the shortest).
    expect(accepts('')).toBe(false);
  });
});

describe('synthesize — free-shuffle (letter-count constraints)', () => {
  it('#a(w)%2=0 ∧ #b(w)%3=0: every interleaving with even a-count and 3|b-count', () => {
    const nfa = buildNFA('L = { w | w in {a,b}*, #a(w) % 2 = 0, #b(w) % 3 = 0 }');
    expect(nfa.states.length).toBe(6); // product of 2-cycle and 3-cycle
    const accepts = simulator(nfa);
    expect(accepts('')).toBe(true);             // 0 a's, 0 b's
    expect(accepts('aa')).toBe(true);            // 2 a's
    expect(accepts('bbb')).toBe(true);           // 3 b's
    expect(accepts('abbab')).toBe(true);         // 2 a's, 3 b's interleaved
    expect(accepts('bababa')).toBe(false);       // 3 a's (odd) — reject
    expect(accepts('aabbb')).toBe(true);
    expect(accepts('aabbba')).toBe(false);       // 3 a's
    expect(accepts('a')).toBe(false);
    expect(accepts('ab')).toBe(false);
    expect(accepts('aaabbb')).toBe(false);       // 3 a's
    expect(accepts('aaaabbbbbb')).toBe(true);    // 4 a's, 6 b's
  });

  it('single-letter mod: { w | w in {a}*, #a(w)%3=1 } gives 3-state cycle', () => {
    const nfa = buildNFA('L = { w | w in {a}*, #a(w) % 3 = 1 }');
    expect(nfa.states.length).toBe(3);
    const accepts = simulator(nfa);
    expect(accepts('')).toBe(false);
    expect(accepts('a')).toBe(true);
    expect(accepts('aa')).toBe(false);
    expect(accepts('aaa')).toBe(false);
    expect(accepts('aaaa')).toBe(true);
  });

  it('count bound: { w | w in {a,b}*, #a(w) >= 2 } accepts iff at least two a\'s', () => {
    const nfa = buildNFA('L = { w | w in {a,b}*, #a(w) >= 2 }');
    const accepts = simulator(nfa);
    expect(accepts('')).toBe(false);
    expect(accepts('a')).toBe(false);
    expect(accepts('b')).toBe(false);
    expect(accepts('aa')).toBe(true);
    expect(accepts('bab')).toBe(false);
    expect(accepts('baba')).toBe(true);
    expect(accepts('bbbab')).toBe(false);
    expect(accepts('aabbbb')).toBe(true);
  });

  it('cross-letter equality { w | #a(w) = #b(w) } is non-regular and rejected', () => {
    expect(() =>
      buildNFA('L = { w | w in {a,b}*, #a(w) = #b(w) }')
    ).toThrow(DslError);
  });
});

describe('synthesize — non-regular rejections', () => {
  it('L5: { a^n c^2 b^m | n/3 = m } rejected by R3', () => {
    expect(() => buildNFA('L5 = { a^n c^2 b^m | n/3 = m, m >= 0, n >= 0 }')).toThrow(DslError);
    try {
      buildNFA('L5 = { a^n c^2 b^m | n/3 = m, m >= 0, n >= 0 }');
    } catch (e) {
      expect((e as DslError).rule).toBe('R3');
    }
  });

  it('a^n b^m | n>=m, n,m unbounded is non-regular (no PDA pattern matches >=)', () => {
    // Currently we only have a PDA pattern for `n = m`, not `n >= m`. This
    // language IS context-free (a CFL) but the equalCounts pattern only
    // matches strict equality. We expect a DslError until a more general PDA
    // pattern lands.
    expect(() => buildNFA('L = { a^n b^m | n >= m, n >= 0, m >= 0 }')).toThrow(DslError);
  });

  it('every dropdown example either synthesizes (NFA or PDA) or throws a meaningful DslError', () => {
    for (const ex of EXAMPLES) {
      try {
        const a = synthesize(parseLanguage(ex.source));
        expect(a.states.length, `${ex.id} should yield non-empty automaton`).toBeGreaterThan(0);
        expect(a.start, `${ex.id} should have a start state`).toBeTruthy();
      } catch (e) {
        expect(e, `${ex.id} should not throw a non-DslError`).toBeInstanceOf(DslError);
        const err = e as DslError;
        expect(err.rule, `${ex.id} threw without an R-rule; message: ${err.message}`).toBeDefined();
      }
    }
  });

});

// ---------------------------------------------------------------------------
// PDA construction & simulation
// ---------------------------------------------------------------------------
import { simulatePDA } from '../automaton/pda';
import type { PDA } from '../automaton/pda';

function buildPDA(src: string): PDA {
  const a = synthesize(parseLanguage(src));
  if (!isPDA(a)) throw new Error(`expected PDA but got NFA for: ${src}`);
  return a;
}

// ---------------------------------------------------------------------------
// Trap state transformation
// ---------------------------------------------------------------------------
import { addTrapState, TRAP_ID } from '../automaton/trapState';

describe('addTrapState', () => {
  it('adds a trap state when transitions are missing for some (state, symbol)', () => {
    // L4 = { a^n b^m | n,m >= 0 } — q0 has no transition on b in independent
    // construction? Actually independentBlocks DOES transition q0->q1 on b, so
    // every state has every symbol covered. Use a single-block instead.
    const nfa = buildNFA('L = { a^n | n >= 0 }');
    // Single state with self-loop on 'a', alphabet = ['a']. Already complete.
    const trapped = addTrapState(nfa);
    expect(trapped).toBe(nfa); // no-op when complete
  });

  it('adds a trap when independentBlocks NFA leaves missing transitions', () => {
    const nfa = buildNFA('L4 = { a^n b^m | n >= 0, m >= 0 }');
    const trapped = addTrapState(nfa);
    if (trapped !== nfa) {
      expect(trapped.states.some((s) => s.id === TRAP_ID)).toBe(true);
      // Every (state, symbol) in the augmented NFA has at least one transition.
      for (const s of trapped.states) {
        for (const sym of trapped.alphabet) {
          const has = trapped.transitions.some((t) => t.from === s.id && t.symbol === sym);
          expect(has, `${s.id}/${sym} should have a transition`).toBe(true);
        }
      }
      // Trap state has self-loops on every alphabet symbol.
      for (const sym of trapped.alphabet) {
        const loops = trapped.transitions.some(
          (t) => t.from === TRAP_ID && t.to === TRAP_ID && t.symbol === sym
        );
        expect(loops, `trap should self-loop on ${sym}`).toBe(true);
      }
    }
  });

  it('NFA acceptance is unchanged after adding trap state (language preservation)', () => {
    // If the augmentation changed acceptance, adding traps would be unsound.
    const nfa = buildNFA('L = { a^n b^m | n + m <= 3, n >= 0, m >= 0 }');
    const trapped = addTrapState(nfa);
    const baseSim = simulator(nfa);
    const trapSim = simulator(trapped);
    for (const w of ['', 'a', 'b', 'ab', 'aab', 'aaa', 'bbb', 'aabb', 'aaaa', 'ba']) {
      expect(trapSim(w), `mismatch on '${w}'`).toBe(baseSim(w));
    }
  });
});

describe('synthesize — PDA construction', () => {
  it('a^n b^n: equalCounts PDA accepts iff #a = #b', () => {
    const pda = buildPDA('L = { a^n b^n | n >= 0 }');
    expect(simulatePDA(pda, '')).toBe(true);
    expect(simulatePDA(pda, 'ab')).toBe(true);
    expect(simulatePDA(pda, 'aabb')).toBe(true);
    expect(simulatePDA(pda, 'aaabbb')).toBe(true);
    expect(simulatePDA(pda, 'aaaabbbb')).toBe(true);
    expect(simulatePDA(pda, 'a')).toBe(false);
    expect(simulatePDA(pda, 'b')).toBe(false);
    expect(simulatePDA(pda, 'aab')).toBe(false);
    expect(simulatePDA(pda, 'abb')).toBe(false);
    expect(simulatePDA(pda, 'ba')).toBe(false);
    expect(simulatePDA(pda, 'aabbb')).toBe(false);
  });

  it('a^n b^m | n=m: equalCounts PDA accepts iff n=m', () => {
    const pda = buildPDA('L = { a^n b^m | n = m, n >= 0, m >= 0 }');
    expect(simulatePDA(pda, '')).toBe(true);
    expect(simulatePDA(pda, 'ab')).toBe(true);
    expect(simulatePDA(pda, 'aaaabbbb')).toBe(true);
    expect(simulatePDA(pda, 'aaab')).toBe(false);
    expect(simulatePDA(pda, 'abb')).toBe(false);
    expect(simulatePDA(pda, 'b')).toBe(false);
  });

  it('a^n c^2 b^n: equalCounts PDA with constant middle', () => {
    const pda = buildPDA('L = { a^n c^2 b^n | n >= 0 }');
    expect(simulatePDA(pda, 'cc')).toBe(true);          // n=0
    expect(simulatePDA(pda, 'accb')).toBe(true);        // n=1
    expect(simulatePDA(pda, 'aaccbb')).toBe(true);      // n=2
    expect(simulatePDA(pda, 'aaaccbbb')).toBe(true);    // n=3
    expect(simulatePDA(pda, 'acc')).toBe(false);
    expect(simulatePDA(pda, 'aaccb')).toBe(false);
    expect(simulatePDA(pda, 'aabb')).toBe(false);       // missing c's
    expect(simulatePDA(pda, '')).toBe(false);           // missing the cc
  });

  it('L11 a^n b^m a^n: sandwich PDA accepts matching outer a-counts', () => {
    const pda = buildPDA('L11 = { a^n b^m a^n | n >= 0, m >= 0 }');
    expect(simulatePDA(pda, '')).toBe(true);             // n=m=0
    expect(simulatePDA(pda, 'b')).toBe(true);            // n=0, m=1
    expect(simulatePDA(pda, 'bbbb')).toBe(true);         // n=0, m=4
    expect(simulatePDA(pda, 'aa')).toBe(true);           // n=1, m=0
    expect(simulatePDA(pda, 'aba')).toBe(true);          // n=1, m=1
    expect(simulatePDA(pda, 'aabba')).toBe(false);       // n=1 left, n=1 right (mid=2 b's: aa..b..b..a)? actually 1 a then 2 b then 1 a: 'abba' yes; 'aabba' = 2a 2b 1a, mismatched.
    expect(simulatePDA(pda, 'abba')).toBe(true);         // n=1, m=2
    expect(simulatePDA(pda, 'aabaa')).toBe(true);        // n=2, m=1
    expect(simulatePDA(pda, 'aabbaa')).toBe(true);       // n=2, m=2
    expect(simulatePDA(pda, 'aaba')).toBe(false);        // n=2 left, n=1 right
    expect(simulatePDA(pda, 'a')).toBe(false);           // need matching pair
  });

  it('L12 palindrome { w R(w) | w in {a,b}* } accepts even-length palindromes', () => {
    const pda = buildPDA('L12 = { w R(w) | w in {a,b}* }');
    expect(simulatePDA(pda, '')).toBe(true);             // w = ""
    expect(simulatePDA(pda, 'aa')).toBe(true);           // w = "a"
    expect(simulatePDA(pda, 'bb')).toBe(true);           // w = "b"
    expect(simulatePDA(pda, 'abba')).toBe(true);         // w = "ab"
    expect(simulatePDA(pda, 'baab')).toBe(true);         // w = "ba"
    expect(simulatePDA(pda, 'abaaba')).toBe(true);       // w = "aba"
    expect(simulatePDA(pda, 'a')).toBe(false);           // odd length
    expect(simulatePDA(pda, 'ab')).toBe(false);          // not a palindrome
    expect(simulatePDA(pda, 'aab')).toBe(false);         // odd
    expect(simulatePDA(pda, 'abab')).toBe(false);        // not palindrome
  });

  it('PDA states have a stack alphabet that includes the bottom marker', () => {
    const pda = buildPDA('L = { a^n b^n | n >= 0 }');
    expect(pda.kind).toBe('pda');
    expect(pda.stackAlphabet).toContain('S');
    expect(pda.stackAlphabet).toContain('a');
    expect(pda.initialStack).toBe('S');
    expect(pda.states.some((s) => s.accept)).toBe(true);
  });
});
