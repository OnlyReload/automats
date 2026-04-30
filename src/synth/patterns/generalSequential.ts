import type { ArithExpr, Constraint } from '../../dsl/ast';
import type { NFA, State, Transition } from '../../automaton/types';
import type { Pattern, PatternContext } from './index';
import { asLinear } from '../bounds';

/**
 * General Presburger-product pattern — the universal fallback.
 *
 * Handles any sequential language `α₁^e₁ α₂^e₂ … αₖ^eₖ | constraints` where:
 *   - Every literal is single-character (multi-char literals are handled by
 *     unrolling — but we keep the constraint for now to limit state explosion).
 *   - Each variable appears in at most one block as a bare `var` exponent
 *     (coeff=1, offset=0); collapse cases like `(xy)^n (xy)^m` are captured
 *     by linearConstrained earlier in dispatch.
 *   - Each variable can be assigned a finite "tracker":
 *       - count tracker: var has finite upper bound H ⇒ tracker domain
 *         [0..H+1] where H+1 means "out of range / dead".
 *       - mod tracker: var unbounded but appears only in modular constraints
 *         `var % k = ...` (or symmetric); tracker domain [0..k-1].
 *       - free: var unbounded with NO acceptance-relevant constraints; tracker
 *         is trivial (single state).
 *
 * Construction:
 *   - State = (block_index, tracker_tuple).
 *   - In a var block: self-loop reads the literal and advances that var's
 *     tracker; ε-transition advances to the next block (finalizing the
 *     tracker).
 *   - In a constant block: read literal exactly c times, no tracker change.
 *     Implemented by unrolling the constant block into c sub-blocks of
 *     "must-read-1".
 *   - Accept = (last_block, T) where T satisfies ALL constraints when
 *     interpreted as final variable values.
 *
 * After building, we run an ε-closure pass to produce a pure NFA without
 * ε-edges, then prune unreachable states.
 */

const MAX_STATES = 8000;
const MAX_TRACKER_PRODUCT = 4000;

interface CountTracker {
  kind: 'count';
  varName: string;
  /** Maximum valid count (inclusive). State = [0..maxValid]; state maxValid+1 = dead. */
  maxValid: number;
  /**
   * If true, once count reaches maxValid, additional reads keep the state at
   * maxValid (saturation). Used for vars that are unbounded but only matter
   * relative to bounded comparisons — beyond maxValid, the constraint outcome
   * stabilizes. If false (the default for explicit upper bounds), exceeding
   * maxValid moves to maxValid+1 = "dead" and rejects.
   */
  saturate: boolean;
}
interface ModTracker {
  kind: 'mod';
  varName: string;
  modulus: number;
}
interface FreeTracker {
  kind: 'free';
  varName: string;
}
type Tracker = CountTracker | ModTracker | FreeTracker;

interface UnrolledBlock {
  literal: string;
  /** 'var' = the var's tracker advances; 'step' = single-char obligatory read. */
  type: 'var' | 'step';
  varName?: string; // when type === 'var'
}

interface Plan {
  blocks: UnrolledBlock[];
  trackers: Tracker[];
  trackerByVar: Map<string, Tracker>;
  acceptPredicate: (env: Map<string, number | 'dead'>) => boolean;
}

export const generalSequentialPattern: Pattern = {
  name: 'general-sequential',
  matches(ctx) {
    return analyse(ctx) !== null;
  },
  build(ctx) {
    const plan = analyse(ctx)!;
    return construct(plan);
  },
};

function analyse(ctx: PatternContext): Plan | null {
  if (ctx.litBlocks.length === 0) return null;
  if (ctx.litBlocks.some((b) => b.literal.length !== 1)) return null;

  // 1. Each var must appear in exactly one block as bare var (coeff=1 offset=0).
  const blockOfVar = new Map<string, number>();
  for (let i = 0; i < ctx.litBlocks.length; i++) {
    const b = ctx.litBlocks[i];
    if (b.exponent.kind !== 'var') continue;
    if (b.exponent.coeff !== 1 || b.exponent.offset !== 0) return null;
    if (blockOfVar.has(b.exponent.name)) return null;
    blockOfVar.set(b.exponent.name, i);
  }

  // 2. Determine tracker per var.
  const trackers: Tracker[] = [];
  const trackerByVar = new Map<string, Tracker>();
  for (const v of blockOfVar.keys()) {
    const range = ctx.bounds.ranges.get(v) ?? { min: 0, max: Infinity };
    if (Number.isFinite(range.max)) {
      const tr: Tracker = { kind: 'count', varName: v, maxValid: range.max, saturate: false };
      trackers.push(tr);
      trackerByVar.set(v, tr);
      continue;
    }
    // Unbounded above. Try saturation tracker — works when v's constraints all
    // compare it against bounded expressions (e.g. `n > m` with m bounded). The
    // tracker caps at the saturation point S; for counts ≥ S, the outcome of
    // every comparison is determined by S itself, so we don't need to track
    // higher.
    const sat = computeSaturation(v, ctx.bounds.rawRels, ctx.bounds.ranges);
    if (sat !== null && sat <= 200) {
      // Saturation works only if all v's constraints are non-modular (mod can't
      // be evaluated from a saturated count).
      if (!varAppearsInModular(v, ctx.bounds.rawRels)) {
        const tr: Tracker = {
          kind: 'count',
          varName: v,
          maxValid: Math.max(sat, range.min),
          saturate: true,
        };
        trackers.push(tr);
        trackerByVar.set(v, tr);
        continue;
      }
    }
    // Try modular tracker — only when min is 0 (we can't enforce a positive
    // lower bound from a residue alone).
    if (range.min === 0) {
      const moduli = collectModuliInvolvingVar(v, ctx.bounds.rawRels);
      if (moduli.length > 0 && moduli.every((k) => k > 0 && k <= 32)) {
        const m = moduli.reduce((a, b) => lcm(a, b), 1);
        if (m <= 32) {
          // Mod tracker requires var doesn't appear in any non-modular cross-var
          // constraint (otherwise we can't evaluate).
          if (!varAppearsInNonModularCrossVar(v, ctx.bounds.rawRels)) {
            const tr: Tracker = { kind: 'mod', varName: v, modulus: m };
            trackers.push(tr);
            trackerByVar.set(v, tr);
            continue;
          }
        }
      }
    }
    // Otherwise: var is unbounded with no usable tracker. Acceptable only if
    // var truly doesn't affect acceptance.
    if (varAffectsAcceptance(v, ctx.bounds.rawRels, range)) return null;
    const tr: Tracker = { kind: 'free', varName: v };
    trackers.push(tr);
    trackerByVar.set(v, tr);
  }

  // 3. Honour minimum bounds: count trackers must skip states below the min.
  // We model "min" by requiring the var's tracker reach >= min before block ε-out.
  // This is handled at acceptance time: the predicate enforces min.

  // 4. State-explosion guard.
  let product = 1;
  for (const tr of trackers) {
    if (tr.kind === 'count') product *= tr.maxValid + 2;
    else if (tr.kind === 'mod') product *= tr.modulus;
    else product *= 1;
  }
  if (product > MAX_TRACKER_PRODUCT) return null;

  // 5. Filter out pure single-var bound constraints (`n >= 0`, `n <= 5`, etc.).
  // Those are already enforced by `ranges` and the count-tracker overflow
  // semantics; the evaluator only needs to handle the *meaningful* constraints
  // that link multiple vars or use arithmetic like `%`.
  const meaningfulRels = ctx.bounds.rawRels.filter((c) => {
    if (c.kind !== 'rel') return true;
    const used = new Set<string>();
    for (const op of c.operands) collectVarsInExpr(op, used);
    if (used.size > 1) return true;
    // Single-var (or zero-var) constraint. Drop if every operand is a bare var
    // or constant — a "pure bound".
    return !c.operands.every((op) => op.kind === 'var' || op.kind === 'int');
  });

  // 6. Build constraint evaluator over the meaningful constraints. Verify each
  // constraint is evaluatable in tracker space (mod-tracked vars only allowed
  // inside `var % k` matching the tracker modulus).
  const evaluator = buildEvaluator(meaningfulRels, trackerByVar, ctx.bounds.ranges);
  if (!evaluator) return null;

  // 7. Unroll constant blocks into single-char step blocks.
  const blocks: UnrolledBlock[] = [];
  for (const b of ctx.litBlocks) {
    if (b.exponent.kind === 'const') {
      for (let r = 0; r < b.exponent.value; r++) {
        blocks.push({ literal: b.literal, type: 'step' });
      }
    } else {
      blocks.push({ literal: b.literal, type: 'var', varName: b.exponent.name });
    }
  }

  return { blocks, trackers, trackerByVar, acceptPredicate: evaluator };
}

function collectVarsInExpr(e: ArithExpr, out: Set<string>): void {
  if (e.kind === 'var') out.add(e.name);
  else if (e.kind === 'binop') {
    collectVarsInExpr(e.left, out);
    collectVarsInExpr(e.right, out);
  }
}

function construct(plan: Plan): NFA {
  type Key = string;
  interface RawState {
    blockIdx: number;
    trackerVals: number[]; // aligned with plan.trackers order
    id: string;
  }

  const states = new Map<Key, RawState>();
  const epsTransitions: { from: string; to: string }[] = [];
  const charTransitions: Transition[] = [];
  let counter = 0;

  function key(blockIdx: number, vals: number[]): Key {
    return `${blockIdx}|${vals.join(',')}`;
  }
  function getOrCreate(blockIdx: number, vals: number[]): RawState {
    const k = key(blockIdx, vals);
    let s = states.get(k);
    if (!s) {
      s = { blockIdx, trackerVals: vals.slice(), id: `s${counter++}` };
      states.set(k, s);
    }
    return s;
  }

  const initialVals = plan.trackers.map(() => 0);
  const initial = getOrCreate(0, initialVals);
  const queue: RawState[] = [initial];
  const seen = new Set<string>([initial.id]);

  while (queue.length > 0) {
    if (states.size > MAX_STATES) {
      // Bail — too many states. Caller will report unsupported.
      return failSafe();
    }
    const s = queue.shift()!;
    const blockIdx = s.blockIdx;
    if (blockIdx >= plan.blocks.length) continue; // terminal — no outgoing.

    const block = plan.blocks[blockIdx];

    if (block.type === 'step') {
      const target = getOrCreate(blockIdx + 1, s.trackerVals);
      charTransitions.push({ from: s.id, to: target.id, symbol: block.literal });
      if (!seen.has(target.id)) { seen.add(target.id); queue.push(target); }
      continue;
    }

    // var block
    const vname = block.varName!;
    const trackerIdx = plan.trackers.findIndex((t) => t.varName === vname);
    const tracker = plan.trackers[trackerIdx];

    // Self-loop: advance tracker.
    const advanced = advanceTracker(tracker, s.trackerVals[trackerIdx]);
    if (advanced !== null) {
      const newVals = s.trackerVals.slice();
      newVals[trackerIdx] = advanced;
      const target = getOrCreate(blockIdx, newVals);
      charTransitions.push({ from: s.id, to: target.id, symbol: block.literal });
      if (!seen.has(target.id)) { seen.add(target.id); queue.push(target); }
    }

    // ε-out to next block.
    const epsTarget = getOrCreate(blockIdx + 1, s.trackerVals);
    epsTransitions.push({ from: s.id, to: epsTarget.id });
    if (!seen.has(epsTarget.id)) { seen.add(epsTarget.id); queue.push(epsTarget); }
  }

  // ε-closure: for each state, find the set of states reachable via ε.
  const epsClosure = computeEpsClosure(epsTransitions, [...states.values()].map((s) => s.id));

  // Build final NFA by ε-elimination:
  //   - For each state s: for each s' in epsClosure(s), for each char-trans (s', c, s''):
  //     add (s, c, s''). Dedup.
  //   - State s accepts iff any state in epsClosure(s) is accepting under the predicate.
  const charBySource = new Map<string, Transition[]>();
  for (const t of charTransitions) {
    const arr = charBySource.get(t.from) ?? [];
    arr.push(t);
    charBySource.set(t.from, arr);
  }

  const finalTransitions: Transition[] = [];
  const transKeys = new Set<string>();
  for (const s of states.values()) {
    for (const reach of epsClosure.get(s.id)!) {
      for (const ct of charBySource.get(reach) ?? []) {
        const tk = `${s.id}|${ct.symbol}|${ct.to}`;
        if (transKeys.has(tk)) continue;
        transKeys.add(tk);
        finalTransitions.push({ from: s.id, to: ct.to, symbol: ct.symbol });
      }
    }
  }

  // Determine accepts.
  const acceptStates = new Set<string>();
  for (const s of states.values()) {
    for (const reach of epsClosure.get(s.id)!) {
      const reachState = [...states.values()].find((x) => x.id === reach);
      if (!reachState) continue;
      if (reachState.blockIdx !== plan.blocks.length) continue;
      if (stateAccepts(plan, reachState.trackerVals)) {
        acceptStates.add(s.id);
        break;
      }
    }
  }

  // Reachability prune from initial state via the now-non-ε transitions.
  const reachable = new Set<string>([initial.id]);
  const queue2 = [initial.id];
  while (queue2.length > 0) {
    const cur = queue2.shift()!;
    for (const t of finalTransitions) {
      if (t.from === cur && !reachable.has(t.to)) {
        reachable.add(t.to);
        queue2.push(t.to);
      }
    }
  }

  // Optional: prune states from which no accept state is reachable (dead-state
  // elimination) — improves diagram clarity.
  const liveSuccessors = new Map<string, string[]>();
  for (const id of reachable) liveSuccessors.set(id, []);
  for (const t of finalTransitions) {
    if (reachable.has(t.from) && reachable.has(t.to)) {
      liveSuccessors.get(t.from)!.push(t.to);
    }
  }
  // Reverse-reachable from any accept state.
  const live = new Set<string>([...acceptStates].filter((id) => reachable.has(id)));
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const t of finalTransitions) {
      if (reachable.has(t.from) && live.has(t.to) && !live.has(t.from)) {
        live.add(t.from);
        progressed = true;
      }
    }
  }
  // The start state must remain even if dead — otherwise the NFA has no start.
  if (!live.has(initial.id)) live.add(initial.id);

  const finalStates: State[] = [];
  for (const s of states.values()) {
    if (!live.has(s.id)) continue;
    finalStates.push({ id: s.id, accept: acceptStates.has(s.id) });
  }
  const filteredTrans = finalTransitions.filter(
    (t) => live.has(t.from) && live.has(t.to)
  );
  const alphabet: string[] = [];
  for (const t of filteredTrans) {
    if (!alphabet.includes(t.symbol)) alphabet.push(t.symbol);
  }
  // Renumber state IDs to nice q0..qN order for visual consistency.
  const renamed = renumberStates(initial.id, finalStates, filteredTrans);
  return {
    states: renamed.states,
    start: renamed.start,
    transitions: renamed.transitions,
    alphabet,
  };
}

function failSafe(): NFA {
  // Return an empty NFA so callers can detect "this language is too large".
  // Pattern match will already have rejected; if we get here, we tripped a
  // safety cap during BFS — return a minimal valid NFA so the UI doesn't crash.
  return { states: [{ id: 'q0', accept: false }], start: 'q0', transitions: [], alphabet: [] };
}

function advanceTracker(tracker: Tracker, current: number): number | null {
  if (tracker.kind === 'count') {
    const next = current + 1;
    if (tracker.saturate) {
      return next > tracker.maxValid ? tracker.maxValid : next;
    }
    if (next > tracker.maxValid + 1) return null; // already dead, no more
    return next;
  }
  if (tracker.kind === 'mod') {
    return (current + 1) % tracker.modulus;
  }
  // free
  return current; // stays at 0 forever; literal still consumed
}

function stateAccepts(plan: Plan, vals: number[]): boolean {
  const env = new Map<string, number | 'dead'>();
  for (let i = 0; i < plan.trackers.length; i++) {
    const tr = plan.trackers[i];
    const v = vals[i];
    if (tr.kind === 'count' && !tr.saturate && v > tr.maxValid) {
      env.set(tr.varName, 'dead');
    } else {
      env.set(tr.varName, v);
    }
  }
  return plan.acceptPredicate(env);
}

function computeEpsClosure(
  edges: { from: string; to: string }[],
  allIds: string[]
): Map<string, Set<string>> {
  const closure = new Map<string, Set<string>>();
  const adj = new Map<string, string[]>();
  for (const id of allIds) {
    closure.set(id, new Set([id]));
    adj.set(id, []);
  }
  for (const e of edges) adj.get(e.from)!.push(e.to);
  for (const id of allIds) {
    const stack = [id];
    const seen = closure.get(id)!;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
  }
  return closure;
}

function renumberStates(
  startId: string,
  states: State[],
  transitions: Transition[]
): { states: State[]; start: string; transitions: Transition[] } {
  // BFS from start, assign q0, q1, q2... in BFS order for nicer reading.
  const order: string[] = [startId];
  const seen = new Set<string>([startId]);
  while (order.length < states.length) {
    let progressed = false;
    for (const id of order.slice()) {
      for (const t of transitions) {
        if (t.from === id && !seen.has(t.to) && states.some((s) => s.id === t.to)) {
          seen.add(t.to);
          order.push(t.to);
          progressed = true;
        }
      }
    }
    if (!progressed) {
      // Add any remaining (disconnected — shouldn't happen post-prune).
      for (const s of states) if (!seen.has(s.id)) { order.push(s.id); seen.add(s.id); }
      break;
    }
  }
  const map = new Map<string, string>();
  order.forEach((old, i) => map.set(old, `q${i}`));
  return {
    states: states.map((s) => ({ id: map.get(s.id) ?? s.id, accept: s.accept })),
    start: map.get(startId)!,
    transitions: transitions.map((t) => ({
      from: map.get(t.from) ?? t.from,
      to: map.get(t.to) ?? t.to,
      symbol: t.symbol,
    })),
  };
}

// ---------------------------------------------------------------------------
// Constraint evaluation
// ---------------------------------------------------------------------------

function buildEvaluator(
  rels: Constraint[],
  trackerByVar: Map<string, Tracker>,
  ranges: Map<string, { min: number; max: number }>
): ((env: Map<string, number | 'dead'>) => boolean) | null {
  // Verify: every var referenced is tracked, and mod-tracked vars are only used
  // in expressions of the form `var % k` (with k dividing tracker's modulus)
  // OR the var stands alone equated against a residue inside such an expression.
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    for (const operand of c.operands) {
      if (!operandEvaluatable(operand, trackerByVar)) return null;
    }
  }
  // Predicate.
  return (env) => {
    // First: enforce per-var minimum bounds (from ranges) when value is a
    // count tracker.
    for (const [v, tr] of trackerByVar) {
      const val = env.get(v);
      if (val === 'dead') return false;
      if (tr.kind === 'count') {
        const min = ranges.get(v)?.min ?? 0;
        if ((val as number) < min) return false;
      }
    }
    // Then evaluate every relation.
    for (const c of rels) {
      if (c.kind !== 'rel') continue;
      const vals = c.operands.map((e) => evalExpr(e, env, trackerByVar));
      if (vals.some((v) => v === null)) return false;
      for (let i = 0; i < c.ops.length; i++) {
        const a = vals[i] as number;
        const b = vals[i + 1] as number;
        if (!checkOp(a, c.ops[i], b)) return false;
      }
    }
    return true;
  };
}

function operandEvaluatable(e: ArithExpr, trackerByVar: Map<string, Tracker>): boolean {
  if (e.kind === 'int') return true;
  if (e.kind === 'var') {
    const tr = trackerByVar.get(e.name);
    if (!tr) return false; // unknown var (constraint references something not in skeleton)
    if (tr.kind === 'mod') return false; // mod-tracked var used outside `var % k` is unsafe
    return true;
  }
  if (e.kind === 'binop') {
    if (e.op === '%') {
      // `var % k` where var is tracked: legal as long as k divides tracker's
      // resolution, OR var is count-tracked.
      if (e.left.kind === 'var' && e.right.kind === 'int') {
        const tr = trackerByVar.get(e.left.name);
        if (!tr) return false;
        if (tr.kind === 'count') return true;
        if (tr.kind === 'mod') return tr.modulus % e.right.value === 0;
        if (tr.kind === 'free') return false; // can't compute residue of free var
      }
      // RHS must evaluate to a constant; LHS recursive
      return operandEvaluatable(e.left, trackerByVar) && operandEvaluatable(e.right, trackerByVar);
    }
    return operandEvaluatable(e.left, trackerByVar) && operandEvaluatable(e.right, trackerByVar);
  }
  return false;
}

function evalExpr(
  e: ArithExpr,
  env: Map<string, number | 'dead'>,
  trackerByVar: Map<string, Tracker>
): number | null {
  if (e.kind === 'int') return e.value;
  if (e.kind === 'var') {
    const v = env.get(e.name);
    if (v === undefined || v === 'dead') return null;
    return v;
  }
  if (e.kind !== 'binop') return null;
  if (e.op === '%' && e.left.kind === 'var' && e.right.kind === 'int') {
    const tr = trackerByVar.get(e.left.name);
    const val = env.get(e.left.name);
    if (val === undefined || val === 'dead') return null;
    if (tr?.kind === 'mod') {
      // tracker stores val mod tracker.modulus; we need val mod e.right.value.
      if (tr.modulus % e.right.value !== 0) return null;
      return val % e.right.value;
    }
    return ((val as number) % e.right.value + e.right.value) % e.right.value;
  }
  const l = evalExpr(e.left, env, trackerByVar);
  const r = evalExpr(e.right, env, trackerByVar);
  if (l === null || r === null) return null;
  switch (e.op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return r === 0 ? null : Math.trunc(l / r);
    case '%': return r === 0 ? null : ((l % r) + r) % r;
  }
}

function checkOp(a: number, op: string, b: number): boolean {
  switch (op) {
    case '=': return a === b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '<': return a < b;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a saturation point for `v`: the smallest threshold S such that for
 * any count of v ≥ S, the satisfaction outcome of every constraint stabilizes.
 * Returns null if any constraint involving v has unbounded "other side" or
 * involves modular arithmetic on v (which doesn't saturate).
 *
 * For `v REL expr(others)` with others bounded, the constraint outcome only
 * depends on whether v exceeds certain thresholds determined by the bounds of
 * the other vars. We pick the largest such threshold (+1 slack).
 */
function computeSaturation(
  v: string,
  rels: Constraint[],
  ranges: Map<string, { min: number; max: number }>
): number | null {
  let sat = 0;
  let found = false;
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    for (let i = 0; i < c.ops.length; i++) {
      const left = c.operands[i];
      const right = c.operands[i + 1];
      if (containsModExpr(left) || containsModExpr(right)) {
        // If the constraint uses % on v itself, saturation breaks.
        if (containsModOnVar(left, v) || containsModOnVar(right, v)) return null;
        continue;
      }
      const ll = asLinear(left);
      const rr = asLinear(right);
      if (!ll || !rr) continue;
      const coeffs = new Map<string, number>();
      for (const [k, n] of ll.coeffs) coeffs.set(k, n);
      for (const [k, n] of rr.coeffs) coeffs.set(k, (coeffs.get(k) ?? 0) - n);
      const K = ll.constant - rr.constant;
      const cv = coeffs.get(v) ?? 0;
      if (cv === 0) continue;

      let othersMin = 0;
      let othersMax = 0;
      let otherUnbounded = false;
      for (const [w, cw] of coeffs) {
        if (w === v) continue;
        const r = ranges.get(w);
        if (!r || !Number.isFinite(r.max)) { otherUnbounded = true; break; }
        if (cw > 0) {
          othersMin += cw * r.min;
          othersMax += cw * r.max;
        } else {
          othersMin += cw * r.max;
          othersMax += cw * r.min;
        }
      }
      if (otherUnbounded) return null;
      // The constraint cv*v + others + K op 0 stabilizes once |cv*v| dominates.
      // Pick saturation = max(|threshold from othersMax|, |threshold from othersMin|).
      const thresholds = [
        Math.abs((-K - othersMax) / cv),
        Math.abs((-K - othersMin) / cv),
      ];
      sat = Math.max(sat, Math.ceil(Math.max(...thresholds)) + 1);
      found = true;
    }
  }
  return found ? sat : null;
}

function containsModExpr(e: ArithExpr): boolean {
  if (e.kind === 'binop') {
    if (e.op === '%') return true;
    return containsModExpr(e.left) || containsModExpr(e.right);
  }
  return false;
}

function containsModOnVar(e: ArithExpr, v: string): boolean {
  if (e.kind === 'binop') {
    if (e.op === '%' && e.left.kind === 'var' && e.left.name === v) return true;
    return containsModOnVar(e.left, v) || containsModOnVar(e.right, v);
  }
  return false;
}

function varAppearsInModular(v: string, rels: Constraint[]): boolean {
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    for (const op of c.operands) {
      if (containsModOnVar(op, v)) return true;
    }
  }
  return false;
}

function varAppearsInNonModularCrossVar(v: string, rels: Constraint[]): boolean {
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    const used = new Set<string>();
    for (const op of c.operands) collectVarsInExpr(op, used);
    if (!used.has(v) || used.size < 2) continue;
    // Cross-var. If any operand uses v outside `var % k`, it's non-modular.
    for (const op of c.operands) {
      if (operandUsesVarOutsideMod(op, v)) return true;
    }
  }
  return false;
}

function operandUsesVarOutsideMod(e: ArithExpr, v: string): boolean {
  if (e.kind === 'var') return e.name === v;
  if (e.kind === 'binop') {
    if (e.op === '%' && e.left.kind === 'var' && e.left.name === v) {
      // `v % k` — v is inside a mod, only RHS could use v outside.
      return operandUsesVarOutsideMod(e.right, v);
    }
    return operandUsesVarOutsideMod(e.left, v) || operandUsesVarOutsideMod(e.right, v);
  }
  return false;
}

function collectModuliInvolvingVar(v: string, rels: Constraint[]): number[] {
  const out: number[] = [];
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    for (const operand of c.operands) {
      collectModFromExpr(operand, v, out);
    }
  }
  return out;
}

function collectModFromExpr(e: ArithExpr, v: string, out: number[]): void {
  if (e.kind === 'binop') {
    if (
      e.op === '%' &&
      e.left.kind === 'var' && e.left.name === v &&
      e.right.kind === 'int'
    ) {
      out.push(e.right.value);
    }
    collectModFromExpr(e.left, v, out);
    collectModFromExpr(e.right, v, out);
  }
}

function varAffectsAcceptance(
  v: string,
  rels: Constraint[],
  range: { min: number; max: number }
): boolean {
  if (range.min > 0) return true;
  for (const c of rels) {
    if (c.kind !== 'rel') continue;
    // If v appears in any cross-var or non-trivial constraint, it affects acceptance.
    let countV = 0;
    let countOther = 0;
    let mentionsVNonTrivially = false;
    for (const operand of c.operands) {
      const used = collectVars(operand);
      if (used.has(v)) {
        countV++;
        // Trivial mention: the operand IS exactly `v`.
        if (operand.kind !== 'var' || operand.name !== v) mentionsVNonTrivially = true;
      }
      for (const u of used) if (u !== v) countOther++;
    }
    if (countV === 0) continue;
    if (mentionsVNonTrivially) return true;
    if (countOther > 0) return true;
    // Only `v REL const` style → captured by ranges already; doesn't affect.
  }
  return false;
}

function collectVars(e: ArithExpr): Set<string> {
  const out = new Set<string>();
  function walk(x: ArithExpr) {
    if (x.kind === 'var') out.add(x.name);
    else if (x.kind === 'binop') { walk(x.left); walk(x.right); }
  }
  walk(e);
  return out;
}

function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
}
function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b > 0) { [a, b] = [b, a % b]; }
  return a;
}
