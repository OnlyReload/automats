# Automats — Claude project notes

"Desmos for automata": a web tool that takes a formal-language description in
set-builder notation and renders the matching automaton (NFA or PDA).

## Stack

- **Build**: Vite 5 + TypeScript 5 (strict)
- **UI**: React 18, plain CSS in `src/styles/global.css`
- **Graph**: Cytoscape.js 3, primary layout `cytoscape-elk`, fallback
  `cytoscape-dagre` (used while ELK is loading and as a hard fallback if
  the dynamic import fails)
- **Tests**: Vitest (Node environment)

## Commands

| Script              | What it does                              |
|---------------------|-------------------------------------------|
| `npm run dev`       | Vite dev server                           |
| `npm run build`     | `tsc -b && vite build` (full type-check)  |
| `npm run preview`   | Serve built bundle                        |
| `npm test`          | Run Vitest once                           |
| `npm run test:watch`| Vitest watch mode                         |

After I ask you to make changes, give me a link to localhost to test.

## Architecture

Pipeline (input → diagram):

```
DSL text
  → tokens (src/dsl/tokens.ts)
  → AST   (src/dsl/parser.ts → src/dsl/ast.ts)
  → Parikh skeleton (src/synth/skeleton.ts)
  → bound propagation (src/synth/bounds.ts)
  → regularity classifier (src/synth/classifier.ts)
        ├── regular     → NFA dispatch (src/synth/patterns/*)  → NFA
        └── nonRegular  → PDA dispatch (src/synth/pda/*)       → PDA
                                  └── (no PDA match) → DslError with R-rule
  → Cytoscape elements (src/render/layout.ts) — polymorphic over NFA | PDA
  → rendered graph (src/render/Graph.tsx)
```

Output type is `Automaton = NFA | PDA` (`src/synth/synthesize.ts`); the
renderer, JSON export, and UI all branch on `isPDA(a)`.

The **classifier** uses four accept/reject rules (R1/R2/R3/R4) plus a
palindrome reject rule. Critical invariant: when a non-regular shape has
no matching PDA pattern, surface a labeled R-rule error rather than
guessing — we never silently emit a wrong automaton.

## Folder map

- `src/dsl/` — lexer, parser, AST types, structured errors with source spans.
- `src/synth/` — skeleton extraction, classifier, bound propagation, top-level `synthesize.ts`, NFA builder helpers.
- `src/synth/patterns/` — NFA pattern catalog. Order in `index.ts` matters — see "NFA pattern dispatch" below.
- `src/synth/pda/` — PDA pattern catalog (`equalCounts`, `sandwich`, `palindrome`).
- `src/automaton/` — `types.ts` (NFA), `pda.ts` (PDA + Hebrew action vocabulary).
- `src/render/` — polymorphic Cytoscape wrapper, ELK layout config (with dagre fallback), PNG/JSON exports.
- `src/ui/` — React components (Editor, ErrorPanel, Toolbar).
- `src/i18n/` — Hebrew strings + error message templates (R2/R3/R4/palindrome/etc.).
- `src/examples/` — seeded textbook languages organized by pattern (single-block, independent, modular, bounded equality, sums, PDAs, rejected).
- `src/types/` — local `.d.ts` shims (cytoscape-dagre, cytoscape-elk).
- `docs/` — changelog, architecture deep-dive, project status.

## NFA pattern dispatch

Patterns are tried in `PATTERNS` order. Specific patterns first (cleaner
output), then the universal fallback last:

1. `singleBlock` — one literal block, plain bare-bound constraints only.
2. `boundedRange` — disabled placeholder (returns false).
3. `linearConstrained` — same-literal collapse via brute-force enumeration of
   achievable totals; recovers `(min, step, max)` of the combined counter.
4. `modular` — handcrafted clean output for `n % k = m` cross-var shapes.
5. `boundedEquality` — clean output for `n = m` with one bound.
6. `independentBlocks` — canonical phase-state for fully free blocks
   (every block min=0, max=∞ — bailing out otherwise to generalSequential).
7. `generalSequential` — universal Presburger fallback. Per-variable
   trackers (count, mod, free, saturated count); ε-NFA → ε-elimination →
   reachability + dead-state pruning → BFS state renumbering.

## PDA pattern dispatch

Tried in order via `dispatchPda`:

1. `equalCounts` — `{ A^n B^m | n = m }` and `{ A^n B^n }`, optionally with
   constant prefix and middle (e.g. `a^n c^2 b^n`). Standard q_push → q_pop → q_acc.
2. `sandwich` — `{ A^n M B^n | M is a free middle }` (textbook L₁₁ shape).
3. `palindrome` — `{ w R(w) | w ∈ Σ* }`. Non-deterministic midpoint guess.

PDA action vocabulary (`src/automaton/pda.ts`) — Hebrew textbook terms:

- **דחוף X** — push (pop=false, pushSymbols=[X])
- **שלוף** — pop (pop=true, pushSymbols=[])
- **החלף X** / **החלף γ** — replace (pop=true, pushSymbols=[…, X])
- **העתק** — peek-only no-op (pop=false, pushSymbols=[])

Stack starts with bottom marker `S`. Acceptance is **by final state**.
Edge labels render as `input, top / action`.

## RTL notes

- HTML root is `dir="rtl"` and `lang="he"`.
- The Cytoscape canvas is wrapped in `dir="ltr"` (the graph itself reads
  LTR even inside an RTL UI).
- Error panels mixing Hebrew prose with English DSL spans use `<bdi>` to
  keep DSL spans LTR.
- DSL textarea is `direction: ltr` for the same reason.

## Adding a new NFA pattern

1. Create `src/synth/patterns/myPattern.ts` exporting a `Pattern`
   (`name`, `matches`, `build`).
2. Register it in `src/synth/patterns/index.ts` in the `PATTERNS` array.
   Place it before `generalSequential` (the universal fallback) but after
   any narrower pattern that would otherwise capture the same shape with
   a worse-shaped diagram.
3. Add a vitest case in `src/synth/synthesize.test.ts` covering both the
   matching condition and a simulator-based correctness check (build the
   NFA, then run the in-test simulator over a few accepting and
   non-accepting strings).

## Adding a new PDA pattern

1. Create `src/synth/pda/myPattern.ts` exporting a `PdaPattern`.
2. Register it in `src/synth/pda/index.ts`'s `PDA_PATTERNS` array.
3. Use the Hebrew action vocabulary (`PDAAction`) so the renderer
   produces consistent `input, top / action` edge labels.
4. Add a vitest case using the PDA simulator.

## Adding a new classifier rule

Error strings live in `src/i18n/he.ts`. The classifier in
`src/synth/classifier.ts` returns one of three classifications: `regular`,
`nonRegular` (with `rule: 'R2' | 'R3' | 'R4' | 'palindrome'`), or
`unsupported`. `synthesize()` first tries the PDA dispatch on
`nonRegular` before throwing; only `unsupported` is unconditional.

If you add a new R-rule, extend the `Classification['rule']` union and
add a string in `i18n/he.ts`.

## Scope reminders

- Languages span both regular (NFA) and context-free (PDA via the three
  patterns above). Anything else gets a labeled R-rule error.
- Multi-character literals are best-supported in the linearConstrained
  collapse path; PDA patterns and most NFA patterns assume single-char
  literals. See `docs/project_status.md` for the running gap list.

## Known gaps

See `docs/project_status.md` for the running list — it's the source of
truth.
