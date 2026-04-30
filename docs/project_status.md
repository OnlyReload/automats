# Project status

Last updated: 2026-04-29

## Current capability

The synthesizer handles **regular languages** via a tiered NFA pattern catalog
(with a universal Presburger-product fallback) AND **non-regular context-free
languages** via a PDA pattern catalog. The pipeline is:

```
DSL → AST → skeleton → classifier
        ├── regular → NFA dispatch → NFA
        └── non-regular → PDA dispatch → PDA
                              └── (no match) → DslError with R-rule
```

Output type is `Automaton = NFA | PDA`. The renderer, JSON export, and UI all
handle both kinds.

### NFA pattern catalog (regular path)

1. `singleBlock` — one literal block, plain bounds only.
2. `linearConstrained` — same-literal collapse, computes `(min, step, max)` of
   the combined counter via brute-force enumeration.
3. `modular` — handcrafted clean output for `n % k = m` cross-var shapes.
4. `boundedEquality` — clean output for `n = m` with one bound.
5. `independentBlocks` — canonical phase-state for fully free blocks.
6. `generalSequential` — universal Presburger fallback. Per-variable trackers
   (count, mod, free, or **saturated** count), ε-NFA → ε-elimination →
   reachability + dead-state pruning → BFS state renumbering.

### PDA pattern catalog (non-regular path)

1. `equalCounts` — handles `{ A^n B^m | n = m }` and `{ A^n B^n }`, optionally
   with constant-block prefix and middle (e.g. `a^n c^2 b^n`). Standard
   push/pop construction with q_push → q_pop → q_acc.
2. `sandwich` — handles `{ A^n M B^n | M is a free middle, A=B literal }`
   (textbook L₁₁ shape). Push outer A's, free reads of middle alphabet, pop
   outer A's.
3. `palindrome` — handles `{ w R(w) | w ∈ Σ* }`. Non-deterministic guess of
   midpoint, push first half / pop matching second half.

PDA action vocabulary (Hebrew textbook):
- **דחוף X** — push X on top, leave previous top below.
- **שלוף** — pop the top.
- **החלף X** (or `החלף γ` for multi-symbol replacement) — pop top, push γ.
- **העתק** — peek-only (no stack change), used for ε-state transitions.

Transition labels are rendered as `input, top / action` per Hebrew convention.
The stack starts with the bottom marker `S`. Acceptance is **by final state**.

## Constraint shapes that work

### Regular (produce NFAs)

| Shape | Example | How |
|---|---|---|
| Free counter | `{ aⁿ \| n ≥ 0 }` | singleBlock |
| Fixed length | `{ a³ }` | singleBlock |
| Bounded range | `{ aⁿ \| 2 ≤ n ≤ 5 }` | singleBlock |
| Single-var modular | `{ aⁿ \| n%3 = 1 }` | generalSequential |
| Same-literal collapse | `{ (xy)ⁿ (xy)ᵐ \| n > m > 0 }` | linearConstrained |
| Equality collapse (step ≠ 1) | `{ (xy)ⁿ (xy)ᵐ \| n = m }` | linearConstrained |
| Independent blocks | `{ aⁿ bᵐ \| n,m ≥ 0 }` | independentBlocks |
| Fixed-constant block | `{ aⁿ c³ \| n ≥ 0 }` | generalSequential |
| Bounded equality | `{ aⁿ bᵐ \| n = m, m ≤ 3 }` | boundedEquality |
| Bounded sum equality | `{ aⁿ bᵐ \| n + m = 4 }` | generalSequential |
| Bounded sum inequality | `{ aⁿ bᵐ \| n + m ≤ 3 }` | generalSequential |
| Linear with offset | `{ aⁿ bᵐ \| n = m+1, m ≤ 3 }` | generalSequential |
| Saturation | `{ aⁿ bᵐ \| n > m, m ≤ 3 }` | generalSequential |
| Modular cross-vars | `{ aⁿ c² bᵐ \| n%3 = m }` | modular |
| Two independent moduli | `{ aⁿ bᵐ \| n%2=0, m%3=0 }` | generalSequential |
| Three-var bounded equality | `{ aⁿ bᵐ cᵏ \| n = k, m,k ≤ 2 }` | generalSequential |
| Three-block constant middle | `{ aⁿ c² bᵐ \| n + m = 3 }` | generalSequential |

### Non-regular but context-free (produce PDAs)

| Shape | Example | How |
|---|---|---|
| `aⁿ bⁿ` | `{ aⁿ bⁿ \| n ≥ 0 }` | equalCounts |
| `aⁿ bᵐ \| n=m` (unbounded) | `{ aⁿ bᵐ \| n = m }` | equalCounts |
| Constant middle | `{ aⁿ c² bⁿ }` | equalCounts |
| Sandwich (L₁₁) | `{ aⁿ bᵐ aⁿ }` | sandwich |
| Palindrome (L₁₂) | `{ w R(w) }` | palindrome |

### Cases the classifier still rejects with explanation

- **R3** — division by free variable: `{ aⁿ c² bᵐ \| n/3 = m }` (would need
  more than a stack; not a CFL by Parikh).
- **R4** — bare `>`/`>=`/`<` between two unbounded vars (no PDA pattern yet
  for inequalities; the language IS context-free but not handled).

## Rendering

The diagram renderer is polymorphic over `NFA | PDA`:

- **Layout** uses **ELK** (Eclipse Layout Kernel via `cytoscape-elk`) with the
  `layered` algorithm and SPLINES edge routing for high-quality, non-overlapping
  placement. ELK is lazy-loaded as a separate chunk; the initial render uses a
  fast dagre layout, then ELK refines positioning when its chunk arrives. This
  keeps the initial JS bundle around 240 KB gzipped.
- **State styling**: regular states are circles with a single border (accent
  blue); accept states use a thick `border-style: double` (concentric textbook
  notation in green).
- **Edge styling**:
  - NFA edges autorotate their labels along the line (compact for short
    `a, b, c` symbol lists).
  - PDA edges show multi-line `input, top / action` labels in a smaller
    monospaced font, **horizontal** (not autorotated), with a rounded text
    background that stops the label from being cut by the edge line.
  - **ε-transitions** (PDA stack-only moves) render in **dashed lines and a
    softer color** so they read distinct from input-consuming transitions.
- **Self-loops** distribute their direction angles (-90°, 90°, 0°, 180°, …)
  cycling per loop-bearing node so multiple self-loops in the same diagram
  don't pile up in the same spot.
- **Start arrow** is a clear blue triangle from an invisible anchor.
- Per-type spacing: PDAs get larger node and rank separation (multi-line
  labels need more breathing room).
- Edges between the same `(from, to)` pair are merged into one labeled edge
  to prevent overlapping parallel curves.

## Done — v1 scaffold

- [x] Vite + React + TypeScript scaffold; `npm run dev`/`build`/`test` working.
- [x] DSL parser + AST + structured errors with source spans.
- [x] Parikh skeleton extraction.
- [x] Regularity classifier (R1/R2/R3/R4 + palindrome reject).
- [x] Iterative bound propagation (`src/synth/bounds.ts`).
- [x] **Six NFA patterns** including the universal generalSequential fallback
      with saturation tracker support.
- [x] **Three PDA patterns** (equalCounts, sandwich, palindrome) with shared
      simulator.
- [x] Polymorphic renderer: NFA edges show `symbol`, PDA edges show
      `input, top / action` (Hebrew action vocabulary).
- [x] PNG + JSON export for both NFA and PDA (JSON includes type, stack
      alphabet, action labels for PDA).
- [x] Hebrew RTL UI shell with editor, error panel, info panel showing kind
      + counts + stack alphabet for PDAs.
- [x] **38 unit tests** — parser, NFA synthesis (with simulation),
      PDA synthesis (with PDA simulator), classifier, dropdown smoke test
      that every example yields an automaton OR throws a labeled R-rule.

## Next — v1.1

- [ ] PDA pattern for `{ aⁿ bᵐ \| n ≥ m }` (and other inequalities) — needs
      a slightly different push/pop construction with possible "extra" pops.
- [ ] `bounded` pattern with schematic ellipsis (avoid 1000-state diagrams).
- [ ] Determinize pass for NFAs.
- [ ] String-testing UI: type a string, animate the automaton accepting/rejecting.
- [ ] More examples from the textbook.

## Backlog — beyond v1.1

- [ ] DFA minimization (Hopcroft).
- [ ] Export to interop formats (JFLAP `.jff`, Graphviz DOT).
- [ ] Inline DSL syntax highlighting in the editor.
- [ ] Deploy to GitHub Pages or Vercel.

## Known gaps

- Multi-character literals as truly *independent* blocks aren't unrolled in
  generalSequential.
- Linear exponents like `a^(2n+1)` not supported in generalSequential
  (only `coeff=1, offset=0`).
- PDA patterns assume single-char literals.
- The cytoscape-dagre layout occasionally tangles long PDA labels with
  self-loops; manual zoom/pan is the workaround.
- Bundle size ~740 KB (Cytoscape).
