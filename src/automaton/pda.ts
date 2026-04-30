/**
 * Pushdown automaton — Israeli textbook conventions.
 *
 * A transition reads one input symbol (or ε), peeks at the stack top, and
 * applies an action that may push, pop, or replace the top. The action
 * vocabulary uses the Hebrew textbook terms:
 *
 *   - דחוף X  (push X)     — add X on top, leaving the previous top below
 *   - שלוף    (pop)        — remove the current top
 *   - החלף X  (replace X)  — pop the current top, push X (new top is X)
 *   - העתק    (copy)       — peek only, no stack change
 *
 * The stack starts with a single bottom marker (typically `S`) so transitions
 * conditioned on `S` can detect "stack is empty" without an extra rule.
 *
 * Acceptance is "by final state" — a configuration is accepting iff the input
 * is fully consumed AND the current state is in the accepting set. Stack
 * contents at acceptance are unconstrained.
 */

export const PDA_STACK_BOTTOM = 'S';
export const PDA_EPSILON = 'ε';

export interface PDAState {
  id: string;
  accept: boolean;
  label?: string;
}

/**
 * A unified action representation:
 *  - pop=false, pushSymbols=['X']           ⇒  דחוף X    (push)
 *  - pop=true,  pushSymbols=[]              ⇒  שלוף      (pop)
 *  - pop=true,  pushSymbols=['X']           ⇒  החלף X    (replace)
 *  - pop=true,  pushSymbols=['X', 'Y', ...] ⇒  החלף XY  (last symbol = new top)
 *  - pop=false, pushSymbols=[]              ⇒  העתק      (no-op / peek-only)
 */
export interface PDAAction {
  pop: boolean;
  pushSymbols: string[];
}

export interface PDATransition {
  from: string;
  to: string;
  /** Input symbol read; PDA_EPSILON for stack-only / state-only transitions. */
  inputSymbol: string;
  /** Required top of stack (always required — peek). */
  stackTop: string;
  action: PDAAction;
}

export interface PDA {
  kind: 'pda';
  states: PDAState[];
  start: string;
  initialStack: string;
  inputAlphabet: string[];
  stackAlphabet: string[];
  transitions: PDATransition[];
}

/**
 * Hebrew textbook action label. The vocabulary is intentionally limited to
 * the two primary operations students learn: push (דחוף) and pop (שלוף).
 *
 * - Peek-only / no-op transitions return an empty string so the caller can
 *   drop the `/ action` segment from the label entirely.
 * - "Replace top with γ" is rendered as a multi-symbol push (e.g. `דחוף ab`),
 *   keeping the label inside the {push, pop} vocabulary.
 */
export function describeAction(action: PDAAction): string {
  if (!action.pop && action.pushSymbols.length === 0) return ''; // peek-only
  if (action.pop && action.pushSymbols.length === 0) return 'שלוף';
  if (!action.pop && action.pushSymbols.length > 0) {
    return `דחוף ${action.pushSymbols.join('')}`;
  }
  // pop + push (replace) — describe as a push of the new symbol; the popping
  // is already implied by the stack-top match shown earlier in the label.
  return `דחוף ${action.pushSymbols.join('')}`;
}

/**
 * Render a transition as a two-line label:
 *   line 1 — the head `input, top` (Latin only)
 *   line 2 — the action verb (Hebrew only)
 *
 * Peek-only actions render as a single line (head only).
 *
 * Why two lines instead of the textbook `input, top / action`: cytoscape's
 * text labels render on a canvas whose paragraph direction is inherited
 * from the RTL host page. Mixing Hebrew with Latin on a single line lets
 * the Unicode bidi algorithm reorder the Hebrew run, and stray neutrals
 * (`/`, spaces around it) end up clipped outside the label-background
 * box. Splitting into mono-script lines keeps each line's bidi resolution
 * trivial. We also drop the `/` separator entirely — the newline already
 * acts as the visual separator, and removing it eliminates the last
 * surviving neutral that bidi was reordering at line ends.
 */
export function describeTransition(t: PDATransition): string {
  const action = describeAction(t.action);
  const head = `${t.inputSymbol}, ${t.stackTop}`;
  return action ? `${head}\n${action}` : head;
}

/**
 * Apply a PDA action to a stack. The stack is a string of single-char symbols;
 * the leftmost char is the TOP. (We use a string for ergonomics — these
 * automata typically have small stack alphabets.)
 */
export function applyAction(stack: string, action: PDAAction): string {
  let s = stack;
  if (action.pop) s = s.slice(1);
  // pushSymbols last = new top, so prepend in reverse to preserve order.
  for (let i = action.pushSymbols.length - 1; i >= 0; i--) {
    s = action.pushSymbols[i] + s;
  }
  return s;
}

/**
 * BFS-based PDA simulator for tests. Returns true iff some non-deterministic
 * branch consumes the entire input and ends in an accept state. Bounds the
 * search by a state-explosion cap to avoid infinite ε-loops on malformed
 * automata.
 */
export function simulatePDA(pda: PDA, input: string, maxConfigs = 50000): boolean {
  type Config = { state: string; stack: string; pos: number };
  const seen = new Set<string>();
  const queue: Config[] = [];

  function enqueue(c: Config): void {
    // Cap stack length in the visited key to prevent unbounded growth on
    // useless ε-loops (a malformed PDA can push forever). 64 chars is plenty
    // for any textbook example.
    const stackKey = c.stack.length > 64 ? c.stack.slice(0, 64) + '…' : c.stack;
    const k = `${c.state}|${stackKey}|${c.pos}`;
    if (seen.has(k)) return;
    seen.add(k);
    queue.push(c);
  }

  enqueue({ state: pda.start, stack: pda.initialStack, pos: 0 });

  let visited = 0;
  while (queue.length > 0) {
    if (visited++ > maxConfigs) return false;
    const c = queue.shift()!;
    if (c.pos === input.length) {
      const st = pda.states.find((s) => s.id === c.state);
      if (st?.accept) return true;
    }
    const top = c.stack[0];
    if (!top) continue; // empty stack — no transitions can fire (since they all peek a symbol)
    for (const t of pda.transitions) {
      if (t.from !== c.state) continue;
      if (t.stackTop !== top) continue;
      if (t.inputSymbol === PDA_EPSILON) {
        enqueue({
          state: t.to,
          stack: applyAction(c.stack, t.action),
          pos: c.pos,
        });
      } else if (c.pos < input.length && input[c.pos] === t.inputSymbol) {
        enqueue({
          state: t.to,
          stack: applyAction(c.stack, t.action),
          pos: c.pos + 1,
        });
      }
    }
  }
  return false;
}
