# Changelog

## [unreleased] — PDA support + universal Presburger fallback

### Added
- **Pushdown automata as a first-class output**:
  - `src/automaton/pda.ts` with the Hebrew textbook action vocabulary (דחוף / שלוף / החלף / העתק), bottom-marker `S`, acceptance by final state, and a unified `PDAAction { pop, pushSymbols[] }` representation that covers push / pop / replace / no-op.
  - PDA pattern catalog under `src/synth/pda/`: `equalCounts` (handles `a^n b^n` and same-counter variations with optional constant prefix/middle, e.g. `a^n c^2 b^n`), `sandwich` (textbook L₁₁ shape `a^n b^m a^n`), `palindrome` (`w R(w)` via non-deterministic midpoint guess).
  - PDA dispatcher (`src/synth/pda/index.ts`) tried after the classifier returns `nonRegular`; classifier errors are only thrown when no PDA pattern matches.
- **`generalSequential` NFA pattern** — universal Presburger fallback that builds per-variable trackers (count / mod / free / saturated-count), composes them as an ε-NFA, then runs ε-elimination → reachability + dead-state pruning → BFS state renumbering. Picks up everything the special-case patterns decline.
- **`boundedEquality` NFA pattern** for clean output on `n = m, m ≤ k`-style shapes.
- **R4 classifier rule**: bare `>`/`>=`/`<`/`<=` between two unbounded variables → non-regular (with the same "try a PDA" fallback path).
- **Iterative bound propagation** (`src/synth/bounds.ts`): solves `n + m = K`, `n = m + c`, `n = 2m`, etc. via fixed-point linear refinement before the classifier and pattern dispatch see the bounds.
- **Polymorphic renderer** (`src/render/layout.ts`): NFA edges show the input symbol (deduplicated, comma-joined per state-pair); PDA edges show `input, top / action` per Hebrew convention with multi-line labels for bundled transitions, dashed styling for ε-edges, deterministic per-node self-loop angle distribution.
- **ELK layout** (`cytoscape-elk`) loaded dynamically as the primary layout, with `dagre` rendered immediately as a fallback so the graph is visible during the ELK module fetch.
- **PDA-aware exports**: `exportJson` includes `type`, `stackAlphabet`, and human-readable Hebrew action labels for PDA transitions; PNG export works for both.
- **UI updates**: info panel labels the kind (`רגולרית` / `אוטומט מחסנית (PDA)`) and includes the stack alphabet for PDAs. Toolbar and `App.tsx` switched from `nfa` to `automaton` to handle the union type.
- **Expanded examples library** (`src/examples/index.ts`): 24 curated languages organized into single-block basics, independent blocks, same-literal collapse, modular constraints, bounded equality / sums, three-block, PDAs, and a rejected example demonstrating R3.
- **Test suite expanded** to ~38 cases covering parser, NFA synthesis with simulator-based correctness, PDA synthesis with a PDA simulator, classifier rules, and a dropdown smoke test asserting every example yields an automaton or a labeled R-rule error.

### Changed
- `synthesize()` returns `Automaton = NFA | PDA`. `App.tsx`, `Toolbar.tsx`, `Graph.tsx`, and `exportJson.ts` all branch on `isPDA(a)`.
- `independentBlocks` now bails out for any non-pure-bound single-var constraint (e.g. `n%2=0` doesn't go here anymore — `generalSequential` picks it up) and for blocks with non-default min/max, preventing buggy chains from sneaking through.
- `singleBlock.matches` is stricter: declines when constraints aren't pure bounds, deferring modular/arithmetic to the universal fallback.

## [unreleased] — v1 scaffold

### Added
- Vite + React 18 + TypeScript 5 project scaffold.
- DSL lexer + parser + AST for set-builder language descriptions: single-letter alphabet symbols, parenthesized multi-char strings `(xy)`, variable / constant / linear (`n+2`) exponents, chained relations `1000 >= n >= m >= 0`, word variables `w` with reverse `R(w)`, and `w in {a,b}*` declarations.
- Parikh-block skeleton extraction.
- Initial regularity classifier (R1/R2/R3 + palindrome reject).
- Initial NFA pattern catalog: `singleBlock`, `independentBlocks` (canonical phase-state construction).
- NFA data model and builder helpers.
- Cytoscape graph rendering with `dagre` LR layout, accept-state styling via doubled border, invisible start-anchor for the start arrow.
- Hebrew RTL UI shell with editor, error panel, toolbar example dropdown, info panel showing state/transition counts.
- PNG and JSON export.
- Hebrew error messages keyed by classifier rule, rendered with `<bdi>` to keep DSL spans LTR inside RTL prose.
- Initial Vitest suite (parser + synthesis).
