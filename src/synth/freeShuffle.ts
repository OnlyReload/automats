import type { ArithExpr, Constraint, LangDecl, RelOp } from '../dsl/ast';
import { DslError } from '../dsl/errors';
import type { NFA, State, Transition } from '../automaton/types';
import type { Skeleton } from './skeleton';

/**
 * Free-shuffle synthesizer.
 *
 * Handles languages of the shape
 *   { w | w in {α₁, …, αₖ}*, C₁(#α₁(w), …, #αₖ(w)), … }
 * where the word is a single word variable (any interleaving over the alphabet)
 * and the constraints reference only letter counts `#α(w)` (and constants).
 *
 * The product automaton tracks (count-or-residue) per letter independently:
 *   - `#α(w) % k = c` → mod-k cycle on α-edges.
 *   - `#α(w) >= c`, `<= c`, `= c` → bounded count tracker on α-edges.
 *   - mixed `mod` + `count` for the same letter → product (small lcm × bound).
 *
 * Cross-letter equalities like `#a(w) = #b(w)` are NOT regular and rejected
 * with an R4-style error so the user sees the same vocabulary as the rest of
 * the classifier.
 */

const MAX_PRODUCT = 4000;

interface LetterState {
  /** Count value the tracker is exposing (saturated or real). 'dead' = exceeded a hard upper bound. */
  count: number | 'dead';
  /** Residue mod tracker.modulus. */
  residue: number;
}

interface LetterTracker {
  letter: string;
  /** Modulus (1 means "no mod constraint"). State component is value mod modulus. */
  modulus: number;
  /** Inclusive max we need to track exactly. Counts ≥ maxValid+1 are "dead" (overflow). */
  maxValid: number;
  /** If true, exceeding maxValid saturates at maxValid (used for `>= c` style). */
  saturate: boolean;
  /** Combined size = modulus × (saturate ? maxValid+1 : maxValid+2). */
  size: number;
}

interface Plan {
  alphabet: string[];
  trackers: Map<string, LetterTracker>;
  acceptPredicate: (env: Map<string, LetterState>) => boolean;
}

export interface FreeShuffleResult {
  /** Built NFA (really a DFA) when the language is regular and within size limits. */
  nfa: NFA | null;
  /** When the language uses `#letter(w)` syntax but isn't regular — explain why. */
  error: DslError | null;
}

/**
 * Detect whether the decl looks like a free-shuffle case (single word var as the
 * whole word, alphabet declared, only `#letter(w)` references in constraints).
 * Returns null if it doesn't look like one — caller falls through to normal flow.
 */
export function tryFreeShuffle(decl: LangDecl, skel: Skeleton): FreeShuffleResult | null {
  if (skel.blocks.length !== 1) return null;
  const only = skel.blocks[0];
  if (only.kind !== 'wordRef') return null;
  if (only.reversed) return null;
  const wv = only.wordVar;

  const decls = decl.constraints.filter(
    (c) => c.kind === 'wordVarDecl' && c.wordVar === wv
  );
  if (decls.length === 0) return null;
  const alphabet = (decls[0] as Extract<Constraint, { kind: 'wordVarDecl' }>).alphabet;
  if (alphabet.length === 0) return null;
  for (const a of alphabet) {
    if (a.length !== 1) {
      return {
        nfa: null,
        error: new DslError(`באלף-בית של ${wv}: כל אות חייבת להיות תו בודד (קיבלתי '${a}').`, decl.span),
      };
    }
  }

  // Every relational constraint must reference only `#α(w)` (with this w) and constants.
  const relConstraints: Constraint[] = [];
  for (const c of decl.constraints) {
    if (c.kind === 'wordVarDecl') continue;
    if (c.kind !== 'rel') return null;
    for (const op of c.operands) {
      const check = checkExprUsesOnlyLetterCount(op, wv, new Set(alphabet));
      if (check) {
        return { nfa: null, error: new DslError(check, op.span) };
      }
    }
    relConstraints.push(c);
  }

  // Reject cross-letter equality / order constraints — those are non-regular.
  for (const c of relConstraints) {
    if (c.kind !== 'rel') continue;
    for (let i = 0; i < c.ops.length; i++) {
      const used = new Set<string>();
      collectLetters(c.operands[i], used);
      collectLetters(c.operands[i + 1], used);
      if (used.size <= 1) continue;
      // Two different letter counts on opposite sides → check whether at least
      // one side reduces to a constant (e.g. `#a(w) + #b(w) = 5` is fine,
      // bounded both letters). If both sides are unbounded counts of distinct
      // letters and the relation isn't a finite-sum bound, it's non-regular.
      // For v1: only allow cross-letter constraints where the constraint can
      // be rewritten as Σ cᵢ #αᵢ(w) ⊕ const, with ⊕ ∈ {<=, <, =} and all cᵢ
      // positive (so it bounds every involved count from above).
      const verdict = classifyCrossLetter(c.operands[i], c.operands[i + 1], c.ops[i]);
      if (verdict === 'non-regular') {
        const a = [...used].slice(0, 2);
        return {
          nfa: null,
          error: new DslError(
            `השפה אינה רגולרית: אילוץ צולב בין '#${a[0]}(${wv})' ל-'#${a[1]}(${wv})' מקשר שני מונים בלתי חסומים.`,
            c.span
          ),
        };
      }
    }
  }

  // Build trackers.
  const trackers = buildTrackers(alphabet, relConstraints);
  if (!trackers) {
    return {
      nfa: null,
      error: new DslError(
        'האילוצים על ספירת האותיות מורכבים מדי — יצא מספר עצום של מצבים.',
        decl.span
      ),
    };
  }

  let product = 1;
  for (const tr of trackers.values()) product *= tr.size;
  if (product > MAX_PRODUCT) {
    return {
      nfa: null,
      error: new DslError(
        `האילוצים יוצרים אוטומט גדול מדי (${product} מצבים). נסי אילוצים עם חסמים קטנים יותר.`,
        decl.span
      ),
    };
  }

  const acceptPredicate = buildAcceptPredicate(relConstraints, trackers);
  const plan: Plan = { alphabet, trackers, acceptPredicate };
  const nfa = construct(plan);
  return { nfa, error: null };
}

// ---------------------------------------------------------------------------
// Constraint analysis
// ---------------------------------------------------------------------------

function checkExprUsesOnlyLetterCount(
  e: ArithExpr,
  wv: string,
  alphabet: Set<string>
): string | null {
  if (e.kind === 'int') return null;
  if (e.kind === 'var') {
    return `המשתנה '${e.name}' אינו ספירת אותיות. בשפה מסוג '{ w | w in Σ*, ... }' השתמשי בצורה #א(${wv}).`;
  }
  if (e.kind === 'letterCount') {
    if (e.wordVar !== wv) {
      return `הספירה #${e.letter}(${e.wordVar}) מתייחסת למשתנה מילה אחר. השתמשי ב-${wv}.`;
    }
    if (!alphabet.has(e.letter)) {
      return `האות '${e.letter}' אינה באלף-בית של ${wv}.`;
    }
    return null;
  }
  if (e.kind === 'binop') {
    return checkExprUsesOnlyLetterCount(e.left, wv, alphabet)
      ?? checkExprUsesOnlyLetterCount(e.right, wv, alphabet);
  }
  return `ביטוי לא נתמך באילוצי ${wv}.`;
}

function collectLetters(e: ArithExpr, out: Set<string>): void {
  if (e.kind === 'letterCount') out.add(e.letter);
  else if (e.kind === 'binop') {
    collectLetters(e.left, out);
    collectLetters(e.right, out);
  }
}

/**
 * Classify a cross-letter constraint:
 *   - 'ok-bound' — bounds all involved letter counts from above (regular).
 *   - 'non-regular' — bidirectional or unbounded relation between counts.
 */
function classifyCrossLetter(left: ArithExpr, right: ArithExpr, op: RelOp): 'ok-bound' | 'non-regular' {
  const lin = subtractAsLinear(left, right);
  if (!lin) return 'non-regular';
  // lin = Σ cᵢ #αᵢ(w) + K.   The relation `lin op 0` (where op was for left vs right).
  const allPositive = [...lin.coeffs.values()].every((c) => c > 0);
  const allNegative = [...lin.coeffs.values()].every((c) => c < 0);
  // For `Σ cᵢ #αᵢ <= const` (cᵢ all positive), each #αᵢ is bounded above → regular.
  if ((op === '<=' || op === '<' || op === '=') && allPositive) return 'ok-bound';
  if ((op === '>=' || op === '>' || op === '=') && allNegative) return 'ok-bound';
  return 'non-regular';
}

interface LinearLetters {
  coeffs: Map<string, number>; // letter → coefficient
  constant: number;
}

function subtractAsLinear(left: ArithExpr, right: ArithExpr): LinearLetters | null {
  const l = exprAsLinear(left);
  const r = exprAsLinear(right);
  if (!l || !r) return null;
  const coeffs = new Map<string, number>();
  for (const [k, v] of l.coeffs) coeffs.set(k, v);
  for (const [k, v] of r.coeffs) coeffs.set(k, (coeffs.get(k) ?? 0) - v);
  // Drop zero entries.
  for (const [k, v] of [...coeffs]) if (v === 0) coeffs.delete(k);
  return { coeffs, constant: l.constant - r.constant };
}

function exprAsLinear(e: ArithExpr): LinearLetters | null {
  if (e.kind === 'int') return { coeffs: new Map(), constant: e.value };
  if (e.kind === 'letterCount') return { coeffs: new Map([[e.letter, 1]]), constant: 0 };
  if (e.kind === 'var') return null;
  if (e.kind !== 'binop') return null;
  if (e.op === '+' || e.op === '-') {
    const l = exprAsLinear(e.left);
    const r = exprAsLinear(e.right);
    if (!l || !r) return null;
    const sign = e.op === '+' ? 1 : -1;
    const coeffs = new Map<string, number>(l.coeffs);
    for (const [k, v] of r.coeffs) coeffs.set(k, (coeffs.get(k) ?? 0) + sign * v);
    return { coeffs, constant: l.constant + sign * r.constant };
  }
  if (e.op === '*') {
    const l = exprAsLinear(e.left);
    const r = exprAsLinear(e.right);
    if (!l || !r) return null;
    if (l.coeffs.size === 0) {
      const k = l.constant;
      return {
        coeffs: new Map([...r.coeffs].map(([a, c]) => [a, c * k])),
        constant: r.constant * k,
      };
    }
    if (r.coeffs.size === 0) {
      const k = r.constant;
      return {
        coeffs: new Map([...l.coeffs].map(([a, c]) => [a, c * k])),
        constant: l.constant * k,
      };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tracker construction
// ---------------------------------------------------------------------------

function buildTrackers(
  alphabet: string[],
  rels: Constraint[]
): Map<string, LetterTracker> | null {
  const trackers = new Map<string, LetterTracker>();
  for (const a of alphabet) {
    trackers.set(a, { letter: a, modulus: 1, maxValid: 0, saturate: true, size: 1 });
  }

  // First pass: gather per-letter modulus (lcm of all `#a(w) % k = const` moduli).
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    for (let i = 0; i < c.ops.length; i++) {
      const m = matchModEq(c.operands[i], c.operands[i + 1], c.ops[i]);
      if (!m) continue;
      const tr = trackers.get(m.letter);
      if (!tr) return null;
      const newMod = lcm(tr.modulus, m.modulus);
      if (newMod > 64) return null;
      tr.modulus = newMod;
    }
  }

  // Second pass: gather per-letter count bounds (from constraints linear in one letter).
  // For Σcᵢ #αᵢ ≤ K constraints we infer per-letter upper bound = floor(K / cᵢ).
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    for (let i = 0; i < c.ops.length; i++) {
      applyBoundConstraint(c.operands[i], c.operands[i + 1], c.ops[i], trackers);
    }
  }

  // Compute combined size per tracker.
  for (const tr of trackers.values()) {
    const countComponent = tr.saturate ? tr.maxValid + 1 : tr.maxValid + 2;
    tr.size = tr.modulus * countComponent;
  }
  return trackers;
}

function matchModEq(left: ArithExpr, right: ArithExpr, op: RelOp): { letter: string; modulus: number } | null {
  if (op !== '=') return null;
  const m = matchSingleMod(left);
  if (m && right.kind === 'int') return m;
  const m2 = matchSingleMod(right);
  if (m2 && left.kind === 'int') return m2;
  // `#a(w) % k = #b(w)` form would be cross-letter — not handled here.
  return null;
}

function matchSingleMod(e: ArithExpr): { letter: string; modulus: number } | null {
  if (e.kind !== 'binop' || e.op !== '%') return null;
  if (e.left.kind === 'letterCount' && e.right.kind === 'int' && e.right.value > 0) {
    return { letter: e.left.letter, modulus: e.right.value };
  }
  return null;
}

function applyBoundConstraint(
  left: ArithExpr,
  right: ArithExpr,
  op: RelOp,
  trackers: Map<string, LetterTracker>
): void {
  const lin = subtractAsLinear(left, right);
  if (!lin) return;
  // After subtraction, treat the relation as `lin.lhs OP 0` where lhs = Σ cᵢ #αᵢ + K.
  // Single-letter case: lin = c·#α + K, op:
  if (lin.coeffs.size === 1) {
    const [letter, c] = [...lin.coeffs][0];
    const tr = trackers.get(letter);
    if (!tr) return;
    // c · #α + K op 0  →  #α op (-K/c)  (sign flip if c < 0)
    let newOp: RelOp = op;
    if (c < 0) newOp = flipOp(op);
    const target = -lin.constant / Math.abs(c);
    if (newOp === '=') tightenLetter(tr, Math.ceil(target), Math.floor(target));
    else if (newOp === '>=') tightenLetter(tr, Math.ceil(target), Infinity);
    else if (newOp === '>') tightenLetter(tr, Math.floor(target) + 1, Infinity);
    else if (newOp === '<=') tightenLetter(tr, 0, Math.floor(target));
    else if (newOp === '<') tightenLetter(tr, 0, Math.ceil(target) - 1);
    return;
  }
  // Multi-letter, all-positive coefficients with `<=`/`<`/`=` and constant on RHS:
  // Σ cᵢ #αᵢ + K op 0   ⇒  Σ cᵢ #αᵢ ≤ -K (for op = <=). Per-letter upper bound = floor((-K)/cᵢ).
  const allPos = [...lin.coeffs.values()].every((c) => c > 0);
  const allNeg = [...lin.coeffs.values()].every((c) => c < 0);
  if (!allPos && !allNeg) return;
  let normOp: RelOp = op;
  let coeffs = lin.coeffs;
  let K = lin.constant;
  if (allNeg) {
    normOp = flipOp(op);
    coeffs = new Map([...coeffs].map(([k, v]) => [k, -v]));
    K = -K;
  }
  // Now Σ cᵢ #αᵢ + K normOp 0 with cᵢ > 0.
  if (normOp !== '<=' && normOp !== '<' && normOp !== '=') return;
  const bound = normOp === '<' ? -K - 1 : -K;
  for (const [letter, ci] of coeffs) {
    const tr = trackers.get(letter);
    if (!tr) continue;
    const upper = Math.floor(bound / ci);
    tightenLetter(tr, 0, upper);
  }
}

function tightenLetter(tr: LetterTracker, lo: number, hi: number): void {
  // Combine new [lo,hi] into tr's existing (saturate, maxValid).
  // Existing range: saturate=true means [0, maxValid] all valid + over saturates.
  //                 saturate=false means [0, maxValid] valid, > → dead.
  // We always start with saturate=true and maxValid=0 (no constraint = unbounded; we use saturate as proxy).
  // Two regimes:
  //   - upper bound finite → tighten to non-saturating bounded count tracker.
  //   - lower bound > 0 → also need to track up to that lower bound at minimum.
  if (hi !== Infinity) {
    if (tr.saturate) {
      // First finite upper bound seen — switch to non-saturating with maxValid=hi.
      tr.saturate = false;
      tr.maxValid = Math.max(0, hi);
    } else {
      tr.maxValid = Math.min(tr.maxValid, Math.max(0, hi));
    }
  }
  if (lo > 0) {
    // We need to distinguish counts up to `lo`. Bump maxValid up to at least lo.
    tr.maxValid = Math.max(tr.maxValid, lo);
    // (saturate stays as-is — if there was no upper bound, saturate=true caps
    //  the tracker at maxValid which is fine since the predicate only checks ≥ lo.)
  }
}

function flipOp(op: RelOp): RelOp {
  switch (op) {
    case '<': return '>';
    case '<=': return '>=';
    case '>': return '<';
    case '>=': return '<=';
    case '=': return '=';
  }
}

// ---------------------------------------------------------------------------
// Acceptance predicate
// ---------------------------------------------------------------------------

function buildAcceptPredicate(
  rels: Constraint[],
  trackers: Map<string, LetterTracker>
): (env: Map<string, LetterState>) => boolean {
  return (env) => {
    for (const v of env.values()) if (v.count === 'dead') return false;
    for (const c of rels) {
      if (c.kind !== 'rel') continue;
      const vals: (number | null)[] = c.operands.map((e) => evalExpr(e, env, trackers));
      if (vals.some((v) => v === null)) return false;
      for (let i = 0; i < c.ops.length; i++) {
        if (!checkOp(vals[i] as number, c.ops[i], vals[i + 1] as number)) return false;
      }
    }
    return true;
  };
}

function evalExpr(
  e: ArithExpr,
  env: Map<string, LetterState>,
  trackers: Map<string, LetterTracker>
): number | null {
  if (e.kind === 'int') return e.value;
  if (e.kind === 'var') return null;
  if (e.kind === 'letterCount') {
    const s = env.get(e.letter);
    if (!s || s.count === 'dead') return null;
    return s.count;
  }
  if (e.kind !== 'binop') return null;
  if (e.op === '%' && e.left.kind === 'letterCount' && e.right.kind === 'int') {
    const tr = trackers.get(e.left.letter);
    const s = env.get(e.left.letter);
    if (!s || s.count === 'dead' || !tr) return null;
    // Use the residue tracked at modulus tr.modulus iff the requested k divides it.
    if (tr.modulus % e.right.value === 0) {
      return s.residue % e.right.value;
    }
    // Otherwise fall back to using the count directly (only sound when the
    // letter has a finite known count, i.e. non-saturating tracker).
    if (!tr.saturate) {
      return ((s.count as number) % e.right.value + e.right.value) % e.right.value;
    }
    return null;
  }
  const l = evalExpr(e.left, env, trackers);
  const r = evalExpr(e.right, env, trackers);
  if (l === null || r === null) return null;
  switch (e.op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return r === 0 ? null : Math.trunc(l / r);
    case '%': return r === 0 ? null : ((l % r) + r) % r;
  }
}

function checkOp(a: number, op: RelOp, b: number): boolean {
  switch (op) {
    case '=': return a === b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '<': return a < b;
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

interface CombinedValue {
  /** Per-letter scalar = (count-or-saturated) * modulus + residue.
   *  count: 0..maxValid (or maxValid+1 = dead when !saturate)
   *  residue: 0..modulus-1
   *  Encoding: scalar = countComponent * modulus + residue, where
   *   countComponent = saturate ? min(count, maxValid) : count (with overflow = maxValid+1)
   */
}
void undefined as unknown as CombinedValue;

function construct(plan: Plan): NFA {
  const letters = plan.alphabet;
  const trackers = letters.map((l) => plan.trackers.get(l)!);

  // Each letter's component is in [0, tr.size). Encode whole state as flat index.
  function encode(vals: number[]): number {
    let idx = 0;
    for (let i = 0; i < trackers.length; i++) {
      idx = idx * trackers[i].size + vals[i];
    }
    return idx;
  }
  function decode(idx: number): number[] {
    const vals = new Array(trackers.length).fill(0);
    for (let i = trackers.length - 1; i >= 0; i--) {
      vals[i] = idx % trackers[i].size;
      idx = Math.floor(idx / trackers[i].size);
    }
    return vals;
  }
  function advance(letterIdx: number, vals: number[]): number[] | null {
    const tr = trackers[letterIdx];
    const cur = vals[letterIdx];
    const curResidue = cur % tr.modulus;
    const curCount = Math.floor(cur / tr.modulus);
    const nextResidue = (curResidue + 1) % tr.modulus;
    let nextCount = curCount;
    if (tr.saturate) {
      nextCount = Math.min(curCount + 1, tr.maxValid);
    } else {
      nextCount = curCount + 1;
      if (nextCount > tr.maxValid + 1) nextCount = tr.maxValid + 1; // stays dead
    }
    const nextVals = vals.slice();
    nextVals[letterIdx] = nextCount * tr.modulus + nextResidue;
    return nextVals;
  }
  function valsToEnv(vals: number[]): Map<string, LetterState> {
    const env = new Map<string, LetterState>();
    for (let i = 0; i < trackers.length; i++) {
      const tr = trackers[i];
      const v = vals[i];
      const residue = v % tr.modulus;
      const count = Math.floor(v / tr.modulus);
      if (!tr.saturate && count > tr.maxValid) {
        env.set(tr.letter, { count: 'dead', residue });
        continue;
      }
      env.set(tr.letter, { count, residue });
    }
    return env;
  }

  // BFS from initial state (all zeros).
  const initialVals = trackers.map(() => 0);
  const initialIdx = encode(initialVals);
  const visited = new Map<number, number>(); // idx → numeric id
  const order: number[] = [];
  visited.set(initialIdx, 0);
  order.push(initialIdx);
  const queue = [initialIdx];

  const transitions: Transition[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const vals = decode(cur);
    for (let i = 0; i < letters.length; i++) {
      const next = advance(i, vals);
      if (!next) continue;
      const nextIdx = encode(next);
      if (!visited.has(nextIdx)) {
        visited.set(nextIdx, order.length);
        order.push(nextIdx);
        queue.push(nextIdx);
      }
      transitions.push({ from: `q${visited.get(cur)!}`, to: `q${visited.get(nextIdx)!}`, symbol: letters[i] });
    }
  }

  // Mark accepting.
  const states: State[] = order.map((idx, i) => ({
    id: `q${i}`,
    accept: plan.acceptPredicate(valsToEnv(decode(idx))),
  }));

  // Prune unreachable from accept (dead-state elimination) for cleaner diagrams.
  const acceptIds = new Set(states.filter((s) => s.accept).map((s) => s.id));
  const live = new Set<string>(acceptIds);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const t of transitions) {
      if (live.has(t.to) && !live.has(t.from)) {
        live.add(t.from);
        progressed = true;
      }
    }
  }
  if (!live.has('q0')) live.add('q0');

  const finalStates = states.filter((s) => live.has(s.id));
  const finalTrans = transitions.filter((t) => live.has(t.from) && live.has(t.to));
  const alphabet: string[] = [];
  for (const t of finalTrans) if (!alphabet.includes(t.symbol)) alphabet.push(t.symbol);

  return { states: finalStates, start: 'q0', transitions: finalTrans, alphabet };
}

function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
}
function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b > 0) { [a, b] = [b, a % b]; }
  return a;
}
