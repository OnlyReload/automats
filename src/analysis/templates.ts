import type { DFA } from './dfa';
import { complementDfa, minimizeDfa } from './dfa';

/**
 * A named candidate language. `build` produces a DFA over the supplied
 * alphabet (the user's NFA alphabet — we won't try templates over symbols
 * the user never used). `describe` returns Hebrew prose; combinators
 * recursively assemble those.
 */
export interface Template {
  /** Stable id used for memoisation across combo iteration. */
  id: string;
  /** Hebrew description in standalone form (sentence-ready, no leading "ש"). */
  describe(): string;
  /** Description as a noun-clause for joining with "ו"/"או"/"לא": e.g. "מספר ה-a זוגי". */
  clause(): string;
  build(alphabet: string[]): DFA;
}

// ── Helpers for building small DFAs by hand ────────────────────────────────

function dfa(states: number, start: number, accept: number[], alphabet: string[], rows: Array<Record<string, number>>): DFA {
  const delta: Map<string, number>[] = rows.map((r) => {
    const m = new Map<string, number>();
    for (const a of alphabet) m.set(a, r[a] ?? states - 1);
    return m;
  });
  return { states, start, accept: new Set(accept), alphabet, delta };
}

// Σ* — accept everything.
function dfaSigmaStar(alphabet: string[]): DFA {
  const row: Record<string, number> = {};
  for (const a of alphabet) row[a] = 0;
  return dfa(1, 0, [0], alphabet, [row]);
}

// ∅ — accept nothing.
function dfaEmptyLang(alphabet: string[]): DFA {
  const row: Record<string, number> = {};
  for (const a of alphabet) row[a] = 0;
  return dfa(1, 0, [], alphabet, [row]);
}

// {ε} — accept only the empty word.
function dfaOnlyEpsilon(alphabet: string[]): DFA {
  const r0: Record<string, number> = {};
  const r1: Record<string, number> = {};
  for (const a of alphabet) { r0[a] = 1; r1[a] = 1; }
  return dfa(2, 0, [0], alphabet, [r0, r1]);
}

// Σ+ — non-empty.
function dfaNonEmpty(alphabet: string[]): DFA {
  const r0: Record<string, number> = {};
  const r1: Record<string, number> = {};
  for (const a of alphabet) { r0[a] = 1; r1[a] = 1; }
  return dfa(2, 0, [1], alphabet, [r0, r1]);
}

// Count of `c` modulo `k` equals `r`.
function dfaCountMod(c: string, k: number, r: number, alphabet: string[]): DFA {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < k; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) row[a] = a === c ? (i + 1) % k : i;
    rows.push(row);
  }
  return dfa(k, 0, [r], alphabet, rows);
}

// Length modulo k equals r.
function dfaLengthMod(k: number, r: number, alphabet: string[]): DFA {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < k; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) row[a] = (i + 1) % k;
    rows.push(row);
  }
  return dfa(k, 0, [r], alphabet, rows);
}

// Length exactly n.
function dfaLengthEq(n: number, alphabet: string[]): DFA {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i <= n + 1; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) row[a] = i <= n ? i + 1 : n + 1;
    rows.push(row);
  }
  return dfa(n + 2, 0, [n], alphabet, rows);
}

function dfaLengthGE(n: number, alphabet: string[]): DFA {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i <= n; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) row[a] = Math.min(i + 1, n);
    rows.push(row);
  }
  return dfa(n + 1, 0, [n], alphabet, rows);
}

function dfaLengthLE(n: number, alphabet: string[]): DFA {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i <= n + 1; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) row[a] = i < n + 1 ? i + 1 : n + 1;
    rows.push(row);
  }
  const accept: number[] = [];
  for (let i = 0; i <= n; i++) accept.push(i);
  return dfa(n + 2, 0, accept, alphabet, rows);
}

// Count of `c` exactly n.
function dfaCountEq(c: string, n: number, alphabet: string[]): DFA {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i <= n + 1; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) row[a] = a === c ? Math.min(i + 1, n + 1) : i;
    rows.push(row);
  }
  return dfa(n + 2, 0, [n], alphabet, rows);
}

// Contains substring w (KMP-style).
function dfaContains(w: string, alphabet: string[]): DFA {
  const m = w.length;
  // States 0..m. State m = absorbing accept.
  const rows: Record<string, number>[] = [];
  for (let i = 0; i <= m; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) {
      if (i === m) { row[a] = m; continue; }
      // Find longest prefix of w that is a suffix of (w[0..i] + a).
      const candidate = w.slice(0, i) + a;
      let next = 0;
      for (let len = Math.min(m, candidate.length); len > 0; len--) {
        if (w.startsWith(candidate.slice(candidate.length - len))) { next = len; break; }
      }
      row[a] = next;
    }
    rows.push(row);
  }
  return dfa(m + 1, 0, [m], alphabet, rows);
}

function dfaAvoids(w: string, alphabet: string[]): DFA {
  return complementDfa(dfaContains(w, alphabet));
}

// Starts with w.
function dfaStartsWith(w: string, alphabet: string[]): DFA {
  const m = w.length;
  // States: 0..m progress, m+1 dead.
  const rows: Record<string, number>[] = [];
  for (let i = 0; i <= m + 1; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) {
      if (i === m) row[a] = m; // absorbing accept
      else if (i === m + 1) row[a] = m + 1; // dead
      else row[a] = a === w[i] ? i + 1 : m + 1;
    }
    rows.push(row);
  }
  return dfa(m + 2, 0, [m], alphabet, rows);
}

// Ends with w (suffix-DFA from KMP).
function dfaEndsWith(w: string, alphabet: string[]): DFA {
  const m = w.length;
  const rows: Record<string, number>[] = [];
  for (let i = 0; i <= m; i++) {
    const row: Record<string, number> = {};
    for (const a of alphabet) {
      const candidate = w.slice(0, i) + a;
      let next = 0;
      for (let len = Math.min(m, candidate.length); len > 0; len--) {
        if (w.startsWith(candidate.slice(candidate.length - len))) { next = len; break; }
      }
      row[a] = next;
    }
    rows.push(row);
  }
  return dfa(m + 1, 0, [m], alphabet, rows);
}

// ── Hebrew helpers ─────────────────────────────────────────────────────────

const ord = ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש'];

function he_count_c(c: string): string { return `מספר המופעים של '${c}'`; }
function he_word(w: string): string { return `'${w}'`; }
function he_length(): string { return 'אורך המילה'; }

// ── Template builders ──────────────────────────────────────────────────────

function tplSigmaStar(): Template {
  return {
    id: 'sigmaStar',
    describe: () => 'כל מילה מעל הא״ב מתקבלת',
    clause: () => 'כל מילה',
    build: (al) => dfaSigmaStar(al),
  };
}

function tplEmpty(): Template {
  return {
    id: 'emptyLang',
    describe: () => 'אף מילה אינה מתקבלת — שפה ריקה',
    clause: () => 'אף מילה אינה מתקבלת',
    build: (al) => dfaEmptyLang(al),
  };
}

function tplOnlyEps(): Template {
  return {
    id: 'onlyEps',
    describe: () => 'רק המילה הריקה ε מתקבלת',
    clause: () => 'המילה ריקה',
    build: (al) => dfaOnlyEpsilon(al),
  };
}

function tplNonEmpty(): Template {
  return {
    id: 'nonEmpty',
    describe: () => 'כל מילה לא ריקה',
    clause: () => 'המילה אינה ריקה',
    build: (al) => dfaNonEmpty(al),
  };
}

function tplCountMod(c: string, k: number, r: number): Template {
  let clause: string;
  if (k === 2) {
    clause = r === 0 ? `${he_count_c(c)} זוגי` : `${he_count_c(c)} אי־זוגי`;
  } else {
    clause = `${he_count_c(c)} מתחלק ב־${k} עם שארית ${r}`;
    if (r === 0) clause = `${he_count_c(c)} מתחלק ב־${k}`;
  }
  return {
    id: `countMod_${c}_${k}_${r}`,
    describe: () => clause,
    clause: () => clause,
    build: (al) => dfaCountMod(c, k, r, al),
  };
}

function tplCountEq(c: string, n: number): Template {
  const clause = `${he_count_c(c)} שווה ל־${n}`;
  return {
    id: `countEq_${c}_${n}`,
    describe: () => clause,
    clause: () => clause,
    build: (al) => dfaCountEq(c, n, al),
  };
}

function tplLengthMod(k: number, r: number): Template {
  let clause: string;
  if (k === 2) clause = r === 0 ? `${he_length()} זוגי` : `${he_length()} אי־זוגי`;
  else if (r === 0) clause = `${he_length()} מתחלק ב־${k}`;
  else clause = `${he_length()} מתחלק ב־${k} עם שארית ${r}`;
  return {
    id: `lenMod_${k}_${r}`,
    describe: () => clause,
    clause: () => clause,
    build: (al) => dfaLengthMod(k, r, al),
  };
}

function tplLengthEq(n: number): Template {
  return {
    id: `lenEq_${n}`,
    describe: () => `${he_length()} שווה ל־${n}`,
    clause: () => `${he_length()} שווה ל־${n}`,
    build: (al) => dfaLengthEq(n, al),
  };
}

function tplLengthGE(n: number): Template {
  return {
    id: `lenGE_${n}`,
    describe: () => `${he_length()} לפחות ${n}`,
    clause: () => `${he_length()} לפחות ${n}`,
    build: (al) => dfaLengthGE(n, al),
  };
}

function tplLengthLE(n: number): Template {
  return {
    id: `lenLE_${n}`,
    describe: () => `${he_length()} לכל היותר ${n}`,
    clause: () => `${he_length()} לכל היותר ${n}`,
    build: (al) => dfaLengthLE(n, al),
  };
}

function tplContains(w: string): Template {
  return {
    id: `contains_${w}`,
    describe: () => `המילה מכילה את הרצף ${he_word(w)}`,
    clause: () => `מופיע הרצף ${he_word(w)}`,
    build: (al) => dfaContains(w, al),
  };
}

function tplAvoids(w: string): Template {
  return {
    id: `avoids_${w}`,
    describe: () => `המילה אינה מכילה את הרצף ${he_word(w)}`,
    clause: () => `אין רצף ${he_word(w)}`,
    build: (al) => dfaAvoids(w, al),
  };
}

function tplStartsWith(w: string): Template {
  return {
    id: `starts_${w}`,
    describe: () => `המילה מתחילה ב־${he_word(w)}`,
    clause: () => `המילה מתחילה ב־${he_word(w)}`,
    build: (al) => dfaStartsWith(w, al),
  };
}

function tplEndsWith(w: string): Template {
  return {
    id: `ends_${w}`,
    describe: () => `המילה מסתיימת ב־${he_word(w)}`,
    clause: () => `המילה מסתיימת ב־${he_word(w)}`,
    build: (al) => dfaEndsWith(w, al),
  };
}

void ord;

// ── Catalog enumeration ────────────────────────────────────────────────────

/** All non-trivial single templates ordered roughly by description "niceness". */
export function enumerateSingleTemplates(alphabet: string[]): Template[] {
  const out: Template[] = [];
  out.push(tplSigmaStar(), tplEmpty(), tplOnlyEps(), tplNonEmpty());

  for (const c of alphabet) {
    out.push(tplCountMod(c, 2, 0));
    out.push(tplCountMod(c, 2, 1));
    for (let k = 3; k <= 5; k++) {
      for (let r = 0; r < k; r++) out.push(tplCountMod(c, k, r));
    }
    for (let n = 0; n <= 4; n++) out.push(tplCountEq(c, n));
  }
  for (let k = 2; k <= 5; k++) {
    for (let r = 0; r < k; r++) out.push(tplLengthMod(k, r));
  }
  for (let n = 0; n <= 5; n++) out.push(tplLengthEq(n));
  for (let n = 1; n <= 5; n++) out.push(tplLengthGE(n));
  for (let n = 0; n <= 5; n++) out.push(tplLengthLE(n));

  // Substrings of length 1..3 over the alphabet.
  const subs: string[] = [];
  for (const a of alphabet) subs.push(a);
  for (const a of alphabet) for (const b of alphabet) subs.push(a + b);
  for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) subs.push(a + b + c);

  for (const w of subs) {
    out.push(tplContains(w));
    out.push(tplAvoids(w));
    out.push(tplStartsWith(w));
    out.push(tplEndsWith(w));
  }

  return out;
}

/** Pre-build (and minimise) a template's DFA over the given alphabet. */
export function instantiate(t: Template, alphabet: string[]): DFA {
  return minimizeDfa(t.build(alphabet));
}
