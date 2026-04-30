# Architecture

## Pipeline

```
DSL text
  │
  ▼
tokens   src/dsl/tokens.ts          single-pass scanner; greedy alpha IDENTs
  │
  ▼
AST      src/dsl/parser.ts          two-phase: split on top-level `|`, parse
  │      src/dsl/ast.ts             constraints first to learn word-var names,
  │                                 then parse the word with that context.
  │                                 Multi-char IDENTs in word position are
  │                                 split into single-symbol terms (textbook
  │                                 convention: `ab` = `a` then `b`).
  ▼
Skeleton src/synth/skeleton.ts      extracts a list of "blocks", each either
  │                                 { lit: 'a', exponent: const|var-linear }
  │                                 or a wordRef (forward or reversed).
  ▼
Bounds   src/synth/bounds.ts +      per-variable [min, max] inferred from
  │      src/synth/classifier.ts    chained relations and conjunctions, then
  │                                 iteratively tightened by linear
  │                                 propagation (handles n+m=K, n=m+c, n=2m,
  │                                 modular `var % k = otherVar`).
  ▼
Classify src/synth/classifier.ts    R1/R2/R3/R4 + palindrome reject.
  │                                 Returns regular(bounds) | nonRegular(rule)
  │                                 | unsupported.
  ▼
Dispatch                          ┌── regular     → NFA pattern dispatch
                                  │                 (src/synth/patterns/index.ts)
                                  │
                                  └── nonRegular  → PDA pattern dispatch
                                                    (src/synth/pda/index.ts)
                                                    └── (no match) → throw
                                                        DslError(rule)
  │
  ▼
NFA      src/automaton/types.ts     { states, start, transitions, alphabet }
or PDA   src/automaton/pda.ts       { kind: 'pda', states, start, initialStack,
                                      inputAlphabet, stackAlphabet,
                                      transitions[input,top,action] }
  │
  ▼
Layout   src/render/layout.ts       polymorphic. NFA: dedup + join symbols.
  │                                 PDA: `input, top / action` per Hebrew
  │                                 convention, multi-line bundled labels,
  │                                 dashed ε-edges, per-node loop angles.
  ▼
Render   src/render/Graph.tsx       elk primary, dagre fallback (and immediate
                                    placeholder layout while elk loads).
                                    PNG export via `cy.png()`. JSON export
                                    branches on automaton kind.
```

## Why these choices

### Pattern matcher over a general regex compiler

Going from arbitrary set-builder descriptions to automata is undecidable,
but the textbook's notation is a small, recurring catalog of shapes. A
specific-first / universal-fallback pattern matcher gives us:

- Cleaner output diagrams (textbook-shaped) than a generic regex →
  Thompson NFA pipeline.
- Honest failure: shapes outside both the regular and PDA catalogs get
  a labeled R-rule error rather than a silently-wrong automaton.
- Room to grow: each new textbook form is one new file in
  `src/synth/patterns/` (or `src/synth/pda/`) plus a registration line.

### Universal Presburger fallback (`generalSequential`)

The hand-crafted patterns produce small, textbook-shaped NFAs but only
cover narrow shapes. `generalSequential` accepts arbitrary linear
constraints by composing per-variable trackers (count, mod, free, or
saturated count) into an ε-NFA, then ε-eliminating + pruning + BFS
renumbering to recover a clean diagram. This is the catch-all that keeps
the catalog honest — when a special-case pattern declines, we don't fail
silently; the fallback either succeeds or the classifier explains why
the language isn't regular.

### Two output kinds, one pipeline

`synthesize()` returns `Automaton = NFA | PDA`. The classifier decides
the kind:

- `regular` → `dispatch()` over `PATTERNS` returns an NFA.
- `nonRegular` → `dispatchPda()` over `PDA_PATTERNS` returns a PDA.
  If no PDA pattern matches, we throw the original classifier error
  with its R-rule label.
- `unsupported` → unconditional throw.

Downstream code (`Graph.tsx`, `Toolbar.tsx`, `exportJson.ts`,
`render/layout.ts`) branches on `isPDA(a)`.

### PDA action vocabulary in Hebrew

PDA transitions render edge labels as `input, top / action`. The action
vocabulary uses textbook Hebrew terms — דחוף / שלוף / החלף / העתק —
implemented via a single `PDAAction { pop, pushSymbols[] }` shape that
maps to push / pop / replace / no-op based on the field values
(`src/automaton/pda.ts`). This keeps simulation and rendering simple
while staying faithful to the curriculum.

### Single-letter alphabet symbols by lexer convention

The textbook treats every lowercase letter as an atomic symbol. The lexer
greedily collects `[A-Za-z0-9_]+` to support multi-letter identifiers
(`L1`, `and`, `in`, `R`), and the *parser* re-splits multi-char IDENTs
into single-symbol atoms when it encounters them in word position. This
is the only spot where textbook convention conflicts with normal lexing
rules.

### NFA, not DFA, as the synthesis output

The textbook diagrams are NFAs (often with parallel edges that merge
nicely under ELK / dagre layout). Determinization is on the v1.1 backlog
but isn't on the critical path.

### ELK primary, dagre fallback

`cytoscape-elk` produces noticeably better layouts for these diagrams
(especially for PDAs with multi-line labels and many self-loops), but
the module is large. `Graph.tsx` renders an immediate dagre layout for
fast first paint and then re-runs ELK once the dynamic import resolves.

## Key invariants

- **Never falsely claim non-regularity.** Classifier returns
  `nonRegular` only when an explicit rule fires (R2, R3, R4,
  palindrome). Anything else outside the catalog is `unsupported`.
- **Pattern order matters.** `PATTERNS` in
  `src/synth/patterns/index.ts` goes from most specific to most general;
  `generalSequential` is the universal fallback and must stay last.
- **The graph canvas is LTR even in an RTL UI.** Wrap it in
  `dir="ltr"` and use `<bdi>` around DSL spans inside Hebrew error text.
- **PDA stack starts with bottom marker `S`.** Acceptance is by final
  state — stack contents at acceptance are unconstrained.

## Extension points

- New regular pattern → new file in `src/synth/patterns/` + entry in
  `PATTERNS` in `index.ts`. Keep specific patterns before the universal
  `generalSequential` fallback.
- New PDA pattern → new file in `src/synth/pda/` + entry in
  `PDA_PATTERNS`. Use the Hebrew action vocabulary so labels render
  consistently.
- New classifier rule → check in `classifier.ts`, string in
  `src/i18n/he.ts`, extension of the `Classification['rule']` union.
