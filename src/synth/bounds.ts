import type { ArithExpr, Constraint, RelOp } from '../dsl/ast';

export type Range = { min: number; max: number };

/**
 * Linear combination form: sum(coeff * var) + constant.
 * Returns null if the expression isn't representable as a linear combination.
 */
export interface LinearForm {
  coeffs: Map<string, number>;
  constant: number;
}

export function asLinear(e: ArithExpr): LinearForm | null {
  if (e.kind === 'int') return { coeffs: new Map(), constant: e.value };
  if (e.kind === 'var') return { coeffs: new Map([[e.name, 1]]), constant: 0 };
  if (e.kind !== 'binop') return null;
  if (e.op === '+' || e.op === '-') {
    const l = asLinear(e.left);
    const r = asLinear(e.right);
    if (!l || !r) return null;
    const sign = e.op === '+' ? 1 : -1;
    const out: LinearForm = { coeffs: new Map(l.coeffs), constant: l.constant + sign * r.constant };
    for (const [v, c] of r.coeffs) {
      out.coeffs.set(v, (out.coeffs.get(v) ?? 0) + sign * c);
    }
    return out;
  }
  if (e.op === '*') {
    const l = asLinear(e.left);
    const r = asLinear(e.right);
    if (!l || !r) return null;
    if (l.coeffs.size === 0) {
      const k = l.constant;
      const out: LinearForm = {
        coeffs: new Map([...r.coeffs].map(([v, c]) => [v, c * k])),
        constant: r.constant * k,
      };
      return out;
    }
    if (r.coeffs.size === 0) {
      const k = r.constant;
      const out: LinearForm = {
        coeffs: new Map([...l.coeffs].map(([v, c]) => [v, c * k])),
        constant: l.constant * k,
      };
      return out;
    }
    return null; // var * var — not linear
  }
  return null; // / and % — not handled here; caller deals with `%`-equality separately
}

/**
 * Iteratively tighten ranges from cross-variable constraints.
 *
 * Each constraint of the form `LHS op RHS` is rewritten as `(LHS - RHS) op 0`.
 * For each variable v in the resulting linear form, we bound `v` using the
 * current ranges of the other variables. Repeat until nothing changes (or we
 * hit an iteration cap to bound runtime on degenerate inputs).
 */
export function propagateBounds(rels: Constraint[], ranges: Map<string, Range>): void {
  const ITER_CAP = 30;
  for (let iter = 0; iter < ITER_CAP; iter++) {
    let changed = false;
    for (const c of rels) {
      if (c.kind !== 'rel') continue;
      for (let i = 0; i < c.ops.length; i++) {
        if (tightenFromRelation(c.operands[i], c.operands[i + 1], c.ops[i], ranges)) {
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  // Floor mins at 0 (count vars are non-negative).
  for (const [v, r] of ranges) {
    if (r.min < 0) r.min = 0;
    if (r.max < r.min) {
      // Infeasible; keep ranges consistent so downstream doesn't see negative-width.
      r.max = r.min;
    }
    void v;
  }
}

function tightenFromRelation(
  left: ArithExpr,
  right: ArithExpr,
  op: RelOp,
  ranges: Map<string, Range>
): boolean {
  const l = asLinear(left);
  const r = asLinear(right);
  if (!l || !r) return false;

  // net(L,R) = L - R
  const coeffs = new Map<string, number>();
  for (const [v, c] of l.coeffs) coeffs.set(v, c);
  for (const [v, c] of r.coeffs) coeffs.set(v, (coeffs.get(v) ?? 0) - c);
  const K = l.constant - r.constant;

  // net OP 0 ⇒ net ∈ [lo, hi]
  let lo: number;
  let hi: number;
  switch (op) {
    case '=': lo = 0; hi = 0; break;
    case '>=': lo = 0; hi = Infinity; break;
    case '<=': lo = -Infinity; hi = 0; break;
    case '>': lo = 1; hi = Infinity; break;
    case '<': lo = -Infinity; hi = -1; break;
    default: return false;
  }

  let changed = false;
  for (const [v, cv] of coeffs) {
    if (cv === 0) continue;
    if (!ranges.has(v)) ranges.set(v, { min: 0, max: Infinity });

    // Compute the bounds on (sum of other terms) using their current ranges.
    let othersMin = 0;
    let othersMax = 0;
    let othersMinDead = false;
    let othersMaxDead = false;
    for (const [w, cw] of coeffs) {
      if (w === v) continue;
      const wr = ranges.get(w);
      if (!wr) return false;
      if (cw > 0) {
        othersMin += cw * wr.min;
        if (wr.max === Infinity) othersMaxDead = true;
        else othersMax += cw * wr.max;
      } else {
        if (wr.max === Infinity) othersMinDead = true;
        else othersMin += cw * wr.max;
        othersMax += cw * wr.min;
      }
    }

    // cv * v ∈ [lo - K - othersMax, hi - K - othersMin]
    const cvLo = (othersMaxDead || lo === -Infinity) ? -Infinity : lo - K - othersMax;
    const cvHi = (othersMinDead || hi === Infinity) ? Infinity : hi - K - othersMin;

    let vLo: number;
    let vHi: number;
    if (cv > 0) {
      vLo = cvLo === -Infinity ? -Infinity : Math.ceil(cvLo / cv);
      vHi = cvHi === Infinity ? Infinity : Math.floor(cvHi / cv);
    } else {
      vLo = cvHi === Infinity ? -Infinity : Math.ceil(cvHi / cv);
      vHi = cvLo === -Infinity ? Infinity : Math.floor(cvLo / cv);
    }

    const range = ranges.get(v)!;
    if (vLo > range.min) {
      range.min = vLo;
      changed = true;
    }
    if (vHi < range.max) {
      range.max = vHi;
      changed = true;
    }
  }
  return changed;
}
