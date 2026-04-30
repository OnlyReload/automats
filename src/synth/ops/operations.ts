import type { NFA, State, Transition } from '../../automaton/types';
import { EPSILON } from '../../automaton/types';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let counter = 0;
function fresh(): string {
  return `c${counter++}`;
}
export function resetCounter(): void {
  counter = 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneNFA(nfa: NFA): NFA {
  const map = new Map<string, string>();
  const states: State[] = nfa.states.map((s) => {
    const id = fresh();
    map.set(s.id, id);
    return { id, accept: s.accept };
  });
  const transitions: Transition[] = nfa.transitions.map((t) => ({
    from: map.get(t.from)!,
    to: map.get(t.to)!,
    symbol: t.symbol,
  }));
  return {
    states,
    start: map.get(nfa.start)!,
    transitions,
    alphabet: [...nfa.alphabet],
  };
}

function unionAlphabets(a: string[], b: string[]): string[] {
  const set = new Set([...a, ...b]);
  return [...set];
}

// ---------------------------------------------------------------------------
// Union: new start with ε-edges to both starts
// ---------------------------------------------------------------------------

export function unionNFA(a: NFA, b: NFA): NFA {
  const ca = cloneNFA(a);
  const cb = cloneNFA(b);
  const start = fresh();
  return {
    states: [{ id: start, accept: false }, ...ca.states, ...cb.states],
    start,
    transitions: [
      { from: start, to: ca.start, symbol: EPSILON },
      { from: start, to: cb.start, symbol: EPSILON },
      ...ca.transitions,
      ...cb.transitions,
    ],
    alphabet: unionAlphabets(ca.alphabet, cb.alphabet),
  };
}

// ---------------------------------------------------------------------------
// Concatenation: ε from each accept of A to start of B; A accepts un-marked
// ---------------------------------------------------------------------------

export function concatNFA(a: NFA, b: NFA): NFA {
  const ca = cloneNFA(a);
  const cb = cloneNFA(b);
  const bridges: Transition[] = ca.states
    .filter((s) => s.accept)
    .map((s) => ({ from: s.id, to: cb.start, symbol: EPSILON }));
  return {
    states: [
      ...ca.states.map((s) => ({ id: s.id, accept: false })),
      ...cb.states,
    ],
    start: ca.start,
    transitions: [...ca.transitions, ...bridges, ...cb.transitions],
    alphabet: unionAlphabets(ca.alphabet, cb.alphabet),
  };
}

// ---------------------------------------------------------------------------
// Kleene star: new accepting start, ε to old start, ε from old accepts back
// ---------------------------------------------------------------------------

export function starNFA(a: NFA): NFA {
  const ca = cloneNFA(a);
  const newStart = fresh();
  const backEdges: Transition[] = ca.states
    .filter((s) => s.accept)
    .map((s) => ({ from: s.id, to: newStart, symbol: EPSILON }));
  return {
    states: [
      { id: newStart, accept: true },
      ...ca.states.map((s) => ({ id: s.id, accept: false })),
    ],
    start: newStart,
    transitions: [
      { from: newStart, to: ca.start, symbol: EPSILON },
      ...ca.transitions,
      ...backEdges,
    ],
    alphabet: [...ca.alphabet],
  };
}

// ---------------------------------------------------------------------------
// Reversal: flip transitions; new ε-start to all old accepts; old start = accept
// ---------------------------------------------------------------------------

export function reverseNFA(a: NFA): NFA {
  const ca = cloneNFA(a);
  const newStart = fresh();
  const oldStart = ca.start;
  const oldAccepts = ca.states.filter((s) => s.accept).map((s) => s.id);
  const reversed: Transition[] = ca.transitions.map((t) => ({
    from: t.to,
    to: t.from,
    symbol: t.symbol,
  }));
  const epsTo: Transition[] = oldAccepts.map((id) => ({
    from: newStart,
    to: id,
    symbol: EPSILON,
  }));
  return {
    states: [
      { id: newStart, accept: false },
      ...ca.states.map((s) => ({ id: s.id, accept: s.id === oldStart })),
    ],
    start: newStart,
    transitions: [...epsTo, ...reversed],
    alphabet: [...ca.alphabet],
  };
}

// ---------------------------------------------------------------------------
// Determinization (subset construction with ε-closure)
// ---------------------------------------------------------------------------

function epsClosure(seeds: Iterable<string>, eps: Map<string, string[]>): Set<string> {
  const out = new Set<string>(seeds);
  const stack = [...out];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of eps.get(cur) ?? []) {
      if (!out.has(next)) {
        out.add(next);
        stack.push(next);
      }
    }
  }
  return out;
}

export function determinize(nfa: NFA, alphabet: string[]): NFA {
  const eps = new Map<string, string[]>();
  const move = new Map<string, Map<string, string[]>>();
  for (const s of nfa.states) {
    eps.set(s.id, []);
    move.set(s.id, new Map());
  }
  for (const t of nfa.transitions) {
    if (t.symbol === EPSILON) {
      eps.get(t.from)!.push(t.to);
    } else {
      const m = move.get(t.from)!;
      if (!m.has(t.symbol)) m.set(t.symbol, []);
      m.get(t.symbol)!.push(t.to);
    }
  }
  const acceptSet = new Set(nfa.states.filter((s) => s.accept).map((s) => s.id));
  const hasAccept = (set: Set<string>): boolean => {
    for (const id of set) if (acceptSet.has(id)) return true;
    return false;
  };

  const startSet = epsClosure([nfa.start], eps);
  const key = (s: Set<string>): string => [...s].sort().join('|');

  type DState = { id: string; ids: Set<string>; accept: boolean };
  const dStates = new Map<string, DState>();
  const startId = fresh();
  dStates.set(key(startSet), { id: startId, ids: startSet, accept: hasAccept(startSet) });
  const queue: string[] = [key(startSet)];
  const dTrans: Transition[] = [];

  while (queue.length) {
    const k = queue.shift()!;
    const cur = dStates.get(k)!;
    for (const sym of alphabet) {
      const tos = new Set<string>();
      for (const id of cur.ids) {
        for (const to of move.get(id)?.get(sym) ?? []) tos.add(to);
      }
      if (tos.size === 0) continue;
      const closed = epsClosure(tos, eps);
      const ck = key(closed);
      let target = dStates.get(ck);
      if (!target) {
        target = { id: fresh(), ids: closed, accept: hasAccept(closed) };
        dStates.set(ck, target);
        queue.push(ck);
      }
      dTrans.push({ from: cur.id, to: target.id, symbol: sym });
    }
  }

  return {
    states: [...dStates.values()].map((d) => ({ id: d.id, accept: d.accept })),
    start: startId,
    transitions: dTrans,
    alphabet: [...alphabet],
  };
}

function complete(dfa: NFA, alphabet: string[]): NFA {
  const has = new Map<string, Set<string>>();
  for (const s of dfa.states) has.set(s.id, new Set());
  for (const t of dfa.transitions) has.get(t.from)!.add(t.symbol);
  let trapId: string | null = null;
  const newTrans: Transition[] = [...dfa.transitions];
  for (const s of dfa.states) {
    const present = has.get(s.id)!;
    for (const sym of alphabet) {
      if (!present.has(sym)) {
        if (!trapId) trapId = fresh();
        newTrans.push({ from: s.id, to: trapId, symbol: sym });
      }
    }
  }
  if (!trapId) return { ...dfa, alphabet: [...alphabet] };
  for (const sym of alphabet) {
    newTrans.push({ from: trapId, to: trapId, symbol: sym });
  }
  return {
    states: [...dfa.states, { id: trapId, accept: false }],
    start: dfa.start,
    transitions: newTrans,
    alphabet: [...alphabet],
  };
}

// ---------------------------------------------------------------------------
// Complement: determinize → complete → flip accept
// ---------------------------------------------------------------------------

export function complementNFA(a: NFA, alphabet?: string[]): NFA {
  const alpha = alphabet ?? [...a.alphabet];
  const dfa = determinize(a, alpha);
  const completed = complete(dfa, alpha);
  return {
    ...completed,
    states: completed.states.map((s) => ({ id: s.id, accept: !s.accept })),
  };
}

// ---------------------------------------------------------------------------
// Intersection: product of completed DFAs
// ---------------------------------------------------------------------------

export function intersectNFA(a: NFA, b: NFA): NFA {
  const alpha = unionAlphabets(a.alphabet, b.alphabet);
  const da = complete(determinize(a, alpha), alpha);
  const db = complete(determinize(b, alpha), alpha);

  const stepA = new Map<string, Map<string, string>>();
  const stepB = new Map<string, Map<string, string>>();
  const acceptA = new Map<string, boolean>();
  const acceptB = new Map<string, boolean>();
  for (const s of da.states) {
    stepA.set(s.id, new Map());
    acceptA.set(s.id, s.accept);
  }
  for (const s of db.states) {
    stepB.set(s.id, new Map());
    acceptB.set(s.id, s.accept);
  }
  for (const t of da.transitions) stepA.get(t.from)!.set(t.symbol, t.to);
  for (const t of db.transitions) stepB.get(t.from)!.set(t.symbol, t.to);

  const ids = new Map<string, string>();
  const states: State[] = [];
  const trans: Transition[] = [];
  const startKey = `${da.start}#${db.start}`;
  const startId = fresh();
  ids.set(startKey, startId);
  states.push({ id: startId, accept: acceptA.get(da.start)! && acceptB.get(db.start)! });

  const queue: { a: string; b: string }[] = [{ a: da.start, b: db.start }];
  while (queue.length) {
    const cur = queue.shift()!;
    const id = ids.get(`${cur.a}#${cur.b}`)!;
    for (const sym of alpha) {
      const ta = stepA.get(cur.a)!.get(sym);
      const tb = stepB.get(cur.b)!.get(sym);
      if (!ta || !tb) continue;
      const nk = `${ta}#${tb}`;
      let nid = ids.get(nk);
      if (!nid) {
        nid = fresh();
        ids.set(nk, nid);
        states.push({ id: nid, accept: acceptA.get(ta)! && acceptB.get(tb)! });
        queue.push({ a: ta, b: tb });
      }
      trans.push({ from: id, to: nid, symbol: sym });
    }
  }

  return { states, start: startId, transitions: trans, alphabet: alpha };
}

// ---------------------------------------------------------------------------
// Difference: A ∩ ¬B
// ---------------------------------------------------------------------------

export function differenceNFA(a: NFA, b: NFA): NFA {
  const alpha = unionAlphabets(a.alphabet, b.alphabet);
  return intersectNFA(a, complementNFA(b, alpha));
}

// ---------------------------------------------------------------------------
// Trim & relabel: drop unreachable states; renumber q0..qn in BFS order
// ---------------------------------------------------------------------------

export function trimAndRelabel(nfa: NFA): NFA {
  const adj = new Map<string, string[]>();
  for (const s of nfa.states) adj.set(s.id, []);
  for (const t of nfa.transitions) adj.get(t.from)!.push(t.to);

  const order: string[] = [];
  const seen = new Set<string>([nfa.start]);
  const queue = [nfa.start];
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }

  const idMap = new Map<string, string>();
  order.forEach((id, i) => idMap.set(id, `q${i}`));
  const acceptMap = new Map(nfa.states.map((s) => [s.id, s.accept]));

  return {
    states: order.map((id) => ({ id: idMap.get(id)!, accept: acceptMap.get(id)! })),
    start: idMap.get(nfa.start)!,
    transitions: nfa.transitions
      .filter((t) => idMap.has(t.from) && idMap.has(t.to))
      .map((t) => ({ from: idMap.get(t.from)!, to: idMap.get(t.to)!, symbol: t.symbol })),
    alphabet: [...nfa.alphabet],
  };
}
