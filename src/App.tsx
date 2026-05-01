import { useMemo, useState } from 'react';
import { parseLanguage } from './dsl/parser';
import { synthesize, isPDA, type Automaton } from './synth/synthesize';
import { addTrapState } from './automaton/trapState';
import { strings as t } from './i18n/he';
import Graph from './render/Graph';
import ErrorPanel from './ui/ErrorPanel';
import Toolbar from './ui/Toolbar';
import Editor from './ui/Editor';
import Compose from './ui/Compose';
import Builder from './ui/Builder';
import BuilderCanvas from './builder/BuilderCanvas';
import {
  emptyBuilder,
  addState as bAddState,
  addTransition as bAddTransition,
  toggleAccept as bToggleAccept,
  setStart as bSetStart,
  deleteState as bDeleteState,
  deleteEdgePair as bDeleteEdgePair,
  setPosition as bSetPosition,
  type BuilderState,
  type Tool,
} from './builder/nfa';
import { EXAMPLES } from './examples';
import { evaluateCompose, ComposeError, type LangSlot } from './synth/ops/evaluate';
import { enumerateLanguage, formatFinite } from './synth/ops/enumerate';
import { formatResultLanguage } from './synth/ops/describe';

type Mode = 'single' | 'compose' | 'build';

type SynthOutcome =
  | { kind: 'empty' }
  | { kind: 'ok'; automaton: Automaton; langName: string; expressionText?: string }
  | { kind: 'error'; message: string; source: string; span?: { start: number; end: number } };

const DEFAULT_SLOTS: LangSlot[] = [
  { name: 'L1', source: '{ a^n | n >= 0 }' },
  { name: 'L2', source: '{ b^n | n >= 0 }' },
];
const DEFAULT_EXPR = 'L1 · L2';

export default function App() {
  const [mode, setMode] = useState<Mode>('single');
  const [source, setSource] = useState<string>(EXAMPLES.find((e) => e.id === 'L4')?.source ?? EXAMPLES[0].source);
  const [showTraps, setShowTraps] = useState<boolean>(false);
  const [slots, setSlots] = useState<LangSlot[]>(DEFAULT_SLOTS);
  const [expression, setExpression] = useState<string>(DEFAULT_EXPR);

  // Builder mode state.
  const [builder, setBuilder] = useState<BuilderState>(() => emptyBuilder());
  const [tool, setTool] = useState<Tool>('addState');
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);

  const outcome: SynthOutcome = useMemo(() => {
    if (mode === 'single') {
      const text = source.trim();
      if (!text) return { kind: 'empty' };
      try {
        const decl = parseLanguage(text);
        const automaton = synthesize(decl);
        return { kind: 'ok', automaton, langName: decl.name };
      } catch (e) {
        const err = e as { message: string; span?: { start: number; end: number } };
        return { kind: 'error', message: err.message, source: text, span: err.span };
      }
    }
    if (mode === 'compose') {
      if (!expression.trim()) return { kind: 'empty' };
      try {
        const result = evaluateCompose(slots, expression);
        const enumerated = enumerateLanguage(result.automaton);
        let expressionText: string;
        if (enumerated.kind === 'finite') expressionText = formatFinite(enumerated.words);
        else expressionText = formatResultLanguage(result.expression, slots);
        return { kind: 'ok', automaton: result.automaton, langName: 'compose', expressionText };
      } catch (e) {
        if (e instanceof ComposeError) return { kind: 'error', message: e.message, source: expression };
        const err = e as { message: string; span?: { start: number; end: number } };
        return { kind: 'error', message: err.message, source: expression, span: err.span };
      }
    }
    // mode === 'build' — automaton comes from the builder state directly.
    if (builder.nfa.states.length === 0) return { kind: 'empty' };
    return { kind: 'ok', automaton: builder.nfa, langName: 'custom' };
  }, [mode, source, slots, expression, builder]);

  const displayed: Automaton | null = useMemo(() => {
    if (outcome.kind !== 'ok') return null;
    if (!showTraps) return outcome.automaton;
    if (isPDA(outcome.automaton)) return outcome.automaton;
    return addTrapState(outcome.automaton);
  }, [outcome, showTraps]);

  const langName = outcome.kind === 'ok' ? outcome.langName : '';
  const automaton = displayed;

  // ── Builder canvas event handlers ─────────────────────────────────────
  const onCanvasTap = (x: number, y: number) => {
    if (tool !== 'addState') return;
    setBuilder((b) => bAddState(b, x, y));
  };
  const onNodeTap = (id: string) => {
    if (tool === 'toggleAccept') return setBuilder((b) => bToggleAccept(b, id));
    if (tool === 'setStart') return setBuilder((b) => bSetStart(b, id));
    if (tool === 'delete') {
      setBuilder((b) => bDeleteState(b, id));
      return;
    }
    if (tool === 'addTransition') {
      if (pendingFrom === null) { setPendingFrom(id); return; }
      const from = pendingFrom;
      setPendingFrom(null);
      const raw = window.prompt(t.promptSymbols, '');
      if (raw === null) return;
      const symbols = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (!symbols.length) return;
      setBuilder((b) => bAddTransition(b, from, id, symbols));
    }
  };
  const onEdgeTap = (from: string, to: string) => {
    if (tool === 'delete' && from !== '__start__') {
      setBuilder((b) => bDeleteEdgePair(b, from, to));
    }
  };
  const onNodeMove = (id: string, x: number, y: number) => {
    setBuilder((b) => bSetPosition(b, id, x, y));
  };
  const onClear = () => { setBuilder(emptyBuilder()); setPendingFrom(null); };
  const onToolChange = (next: Tool) => {
    setTool(next);
    setPendingFrom(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div><h1>{t.title}</h1></div>
        <div className="subtitle">{t.subtitle}</div>
      </header>

      <aside className="sidebar">
        <div className="mode-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'single'}
            className={`mode-tab ${mode === 'single' ? 'active' : ''}`}
            onClick={() => setMode('single')}>{t.modeSingle}</button>
          <button role="tab" aria-selected={mode === 'compose'}
            className={`mode-tab ${mode === 'compose' ? 'active' : ''}`}
            onClick={() => setMode('compose')}>{t.modeCompose}</button>
          <button role="tab" aria-selected={mode === 'build'}
            className={`mode-tab ${mode === 'build' ? 'active' : ''}`}
            onClick={() => setMode('build')}>{t.modeBuild}</button>
        </div>

        <Toolbar
          source={source}
          onSourceChange={setSource}
          automaton={automaton}
          langName={langName}
          showTraps={showTraps}
          onToggleTraps={() => setShowTraps((v) => !v)}
          canToggleTraps={!!automaton && !isPDA(automaton)}
          showExamples={mode === 'single'}
        />

        {mode === 'single' && <Editor value={source} onChange={setSource} />}
        {mode === 'compose' && (
          <Compose
            slots={slots}
            expression={expression}
            onSlotsChange={setSlots}
            onExpressionChange={setExpression}
          />
        )}
        {mode === 'build' && (
          <Builder
            state={builder}
            tool={tool}
            onToolChange={onToolChange}
            onClear={onClear}
            pendingFrom={pendingFrom}
            onCancelPending={() => setPendingFrom(null)}
          />
        )}

        {outcome.kind === 'error' && (
          <ErrorPanel message={outcome.message} source={outcome.source} span={outcome.span} />
        )}
        {outcome.kind === 'ok' && automaton && mode !== 'build' && (
          <div className="info-panel">
            <strong>{isPDA(automaton) ? t.pda : t.regular}</strong>
            {' — '}
            {t.statesLabel}: {automaton.states.length},{' '}
            {t.transitionsLabel}: {automaton.transitions.length}
            {isPDA(automaton) && (
              <>
                {', '}
                {t.stackAlphabetLabel}: {automaton.stackAlphabet.join(', ')}
              </>
            )}
            {outcome.kind === 'ok' && outcome.expressionText && (
              <div className="info-expr">
                {t.composeResultPanel}: <code>{outcome.expressionText}</code>
              </div>
            )}
          </div>
        )}
      </aside>

      <section className="canvas-area">
        <div className="canvas-host">
          {mode === 'build' ? (
            <>
              <BuilderCanvas
                state={builder}
                tool={tool}
                pendingFrom={pendingFrom}
                onCanvasTap={onCanvasTap}
                onNodeTap={onNodeTap}
                onEdgeTap={onEdgeTap}
                onNodeMove={onNodeMove}
              />
              {builder.nfa.states.length === 0 && (
                <div className="empty-state" style={{ pointerEvents: 'none' }}>
                  {t.builderEmptyHint}
                </div>
              )}
            </>
          ) : automaton ? (
            <Graph automaton={automaton} />
          ) : (
            <div className="empty-state">
              {outcome.kind === 'empty' ? t.emptyHint : t.errorHint}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
