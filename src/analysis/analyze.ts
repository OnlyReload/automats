import type { NFA } from '../automaton/types';
import {
  alphabetOf,
  complementDfa,
  equivalent,
  isEmpty,
  minimizeDfa,
  nfaToDfa,
  productDfa,
  type DFA,
} from './dfa';
import { dfaToRegex } from './regex';
import { enumerateSamples } from './simulate';
import { enumerateSingleTemplates, instantiate, type Template } from './templates';

export interface AnalysisResult {
  /** Hebrew prose if a template (or combo) matched. Otherwise undefined. */
  description?: string;
  /** Always present — exact regex via state elimination. */
  regex: string;
  /** Sample words for the user to sanity-check. */
  accepted: string[];
  rejected: string[];
  /** Minimal DFA size — useful diagnostic. */
  minStates: number;
  /** Hebrew alphabet rendering. */
  alphabet: string[];
}

const MAX_PAIR_STATES = 64;
const MAX_TRIPLE_STATES = 96;

export function analyze(nfa: NFA): AnalysisResult {
  const alphabet = alphabetOf(nfa);
  if (alphabet.length === 0) {
    // Degenerate: no transitions. Either {ε} or ∅ depending on start being accept.
    const startState = nfa.states.find((s) => s.id === nfa.start);
    if (startState?.accept) {
      return {
        description: 'רק המילה הריקה ε מתקבלת',
        regex: 'ε',
        accepted: [''],
        rejected: [],
        minStates: 1,
        alphabet,
      };
    }
    return {
      description: 'אף מילה אינה מתקבלת — שפה ריקה',
      regex: '∅',
      accepted: [],
      rejected: [''],
      minStates: 1,
      alphabet,
    };
  }

  const dfaRaw = nfaToDfa(nfa, alphabet);
  const dfa = minimizeDfa(dfaRaw);
  const regex = dfaToRegex(dfa);
  const samples = enumerateSamples(dfa, alphabet, 5, 12);

  const description = guessDescription(dfa, alphabet);

  return {
    description,
    regex,
    accepted: samples.accepted,
    rejected: samples.rejected,
    minStates: dfa.states,
    alphabet,
  };
}

function guessDescription(target: DFA, alphabet: string[]): string | undefined {
  // Trivial cases first.
  if (isEmpty(target)) return 'אף מילה אינה מתקבלת — שפה ריקה';
  const allDfa = minimizeDfa({
    states: 1, start: 0, accept: new Set([0]), alphabet,
    delta: [new Map(alphabet.map((a) => [a, 0]))],
  });
  if (equivalent(target, allDfa)) return 'כל מילה מעל הא״ב מתקבלת';

  const templates = enumerateSingleTemplates(alphabet);

  // Pre-instantiate (lazy via map). For combos we'll need DFAs many times.
  const cache = new Map<string, DFA>();
  const dfaOf = (t: Template) => {
    const k = t.id;
    let d = cache.get(k);
    if (!d) { d = instantiate(t, alphabet); cache.set(k, d); }
    return d;
  };

  // ── Singles ─────────────────────────────────────────────────────────────
  for (const t of templates) {
    const d = dfaOf(t);
    if (d.states !== target.states) continue;
    if (equivalent(d, target)) return t.describe();
  }

  // ── Complement of singles ───────────────────────────────────────────────
  for (const t of templates) {
    const d = complementDfa(dfaOf(t));
    if (equivalent(minimizeDfa(d), target)) return `לא מתקיים: ${t.clause()}`;
  }

  // ── Pairs (intersection / union) ────────────────────────────────────────
  // Restrict to templates whose state count is plausibly relevant: their
  // product can't exceed the target's state count by more than a small
  // factor. Heuristic — purely a search-space prune.
  const targetN = target.states;
  const pairCandidates = templates.filter((t) => dfaOf(t).states <= targetN);
  for (let i = 0; i < pairCandidates.length; i++) {
    const a = pairCandidates[i];
    const da = dfaOf(a);
    for (let j = i + 1; j < pairCandidates.length; j++) {
      const b = pairCandidates[j];
      const db = dfaOf(b);
      if (da.states * db.states > MAX_PAIR_STATES) continue;
      // ∩
      const inter = minimizeDfa(productDfa(da, db, 'and'));
      if (inter.states === targetN && equivalent(inter, target)) {
        return joinClauses([a, b], 'and');
      }
      // ∪
      const uni = minimizeDfa(productDfa(da, db, 'or'));
      if (uni.states === targetN && equivalent(uni, target)) {
        return joinClauses([a, b], 'or');
      }
    }
  }

  // ── Triples (intersection only — covers the textbook
  //    "even count of x AND avoids w1 AND avoids w2" shape). ───────────────
  // Search-space prune: only triples whose states multiply within budget.
  for (let i = 0; i < pairCandidates.length; i++) {
    const a = pairCandidates[i];
    const da = dfaOf(a);
    for (let j = i + 1; j < pairCandidates.length; j++) {
      const b = pairCandidates[j];
      const db = dfaOf(b);
      if (da.states * db.states > MAX_TRIPLE_STATES) continue;
      const ab = minimizeDfa(productDfa(da, db, 'and'));
      if (ab.states > targetN) continue;
      for (let k = j + 1; k < pairCandidates.length; k++) {
        const c = pairCandidates[k];
        const dc = dfaOf(c);
        if (ab.states * dc.states > MAX_TRIPLE_STATES) continue;
        const abc = minimizeDfa(productDfa(ab, dc, 'and'));
        if (abc.states === targetN && equivalent(abc, target)) {
          return joinClauses([a, b, c], 'and');
        }
      }
    }
  }

  return undefined;
}

function joinClauses(ts: Template[], op: 'and' | 'or'): string {
  const sep = op === 'and' ? ' וגם ' : ' או ';
  return ts.map((t) => t.clause()).join(sep);
}
