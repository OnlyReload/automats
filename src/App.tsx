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
import { EXAMPLES } from './examples';
import { evaluateCompose, ComposeError, type LangSlot } from './synth/ops/evaluate';
import { enumerateLanguage, formatFinite } from './synth/ops/enumerate';
import { formatResultLanguage } from './synth/ops/describe';

type Mode = 'single' | 'compose';

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
    // compose mode
    if (!expression.trim()) return { kind: 'empty' };
    try {
      const result = evaluateCompose(slots, expression);
      const enumerated = enumerateLanguage(result.automaton);
      let expressionText: string;
      if (enumerated.kind === 'finite') {
        expressionText = formatFinite(enumerated.words);
      } else {
        expressionText = formatResultLanguage(result.expression, slots);
      }
      return {
        kind: 'ok',
        automaton: result.automaton,
        langName: 'compose',
        expressionText,
      };
    } catch (e) {
      if (e instanceof ComposeError) {
        return { kind: 'error', message: e.message, source: expression };
      }
      const err = e as { message: string; span?: { start: number; end: number } };
      return { kind: 'error', message: err.message, source: expression, span: err.span };
    }
  }, [mode, source, slots, expression]);

  const displayed: Automaton | null = useMemo(() => {
    if (outcome.kind !== 'ok') return null;
    if (!showTraps) return outcome.automaton;
    if (isPDA(outcome.automaton)) return outcome.automaton;
    return addTrapState(outcome.automaton);
  }, [outcome, showTraps]);

  const langName = outcome.kind === 'ok' ? outcome.langName : '';
  const automaton = displayed;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>{t.title}</h1>
        </div>
        <div className="subtitle">{t.subtitle}</div>
      </header>

      <aside className="sidebar">
        <div className="mode-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={mode === 'single'}
            className={`mode-tab ${mode === 'single' ? 'active' : ''}`}
            onClick={() => setMode('single')}
          >
            {t.modeSingle}
          </button>
          <button
            role="tab"
            aria-selected={mode === 'compose'}
            className={`mode-tab ${mode === 'compose' ? 'active' : ''}`}
            onClick={() => setMode('compose')}
          >
            {t.modeCompose}
          </button>
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

        {mode === 'single' ? (
          <Editor value={source} onChange={setSource} />
        ) : (
          <Compose
            slots={slots}
            expression={expression}
            onSlotsChange={setSlots}
            onExpressionChange={setExpression}
          />
        )}

        {outcome.kind === 'error' && (
          <ErrorPanel
            message={outcome.message}
            source={outcome.source}
            span={outcome.span}
          />
        )}
        {outcome.kind === 'ok' && automaton && (
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
          {automaton ? (
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
