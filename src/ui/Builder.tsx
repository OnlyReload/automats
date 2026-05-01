import { useState } from 'react';
import { strings as t } from '../i18n/he';
import type { BuilderState, Tool } from '../builder/nfa';
import { analyze, type AnalysisResult } from '../analysis/analyze';

interface Props {
  state: BuilderState;
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  onClear: () => void;
  pendingFrom: string | null;
  onCancelPending: () => void;
}

const TOOLS: { id: Tool; label: string }[] = [
  { id: 'addState', label: t.toolAddState },
  { id: 'addTransition', label: t.toolAddTransition },
  { id: 'toggleAccept', label: t.toolToggleAccept },
  { id: 'setStart', label: t.toolSetStart },
  { id: 'delete', label: t.toolDelete },
];

export default function Builder({
  state, tool, onToolChange, onClear, pendingFrom, onCancelPending,
}: Props) {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const canAnalyze = state.nfa.states.length > 0 && state.nfa.start;

  const runAnalysis = () => {
    setAnalyzing(true);
    // Defer to next tick so the spinner state lands before potentially-heavy work.
    setTimeout(() => {
      try {
        const r = analyze(state.nfa);
        setAnalysis(r);
      } finally {
        setAnalyzing(false);
      }
    }, 10);
  };

  return (
    <div className="builder">
      <div className="builder-tools">
        {TOOLS.map((tt) => (
          <button
            key={tt.id}
            className={`builder-tool ${tool === tt.id ? 'active' : ''}`}
            onClick={() => onToolChange(tt.id)}
            title={tt.label}
          >
            {tt.label}
          </button>
        ))}
        <button className="builder-tool builder-clear" onClick={onClear}>
          {t.toolClear}
        </button>
      </div>

      <div className="builder-hint">
        {hintFor(tool, pendingFrom)}
        {pendingFrom && (
          <button className="builder-cancel" onClick={onCancelPending}>
            {t.toolCancel}
          </button>
        )}
      </div>

      <div className="builder-actions">
        <button onClick={runAnalysis} disabled={!canAnalyze || analyzing}>
          {analyzing ? t.analyzing : t.analyzeLanguage}
        </button>
      </div>

      {analysis && <AnalysisPanel result={analysis} />}
    </div>
  );
}

function hintFor(tool: Tool, pending: string | null): string {
  if (pending) return t.hintPickTarget(pending);
  switch (tool) {
    case 'addState': return t.hintAddState;
    case 'addTransition': return t.hintAddTransitionFrom;
    case 'toggleAccept': return t.hintToggleAccept;
    case 'setStart': return t.hintSetStart;
    case 'delete': return t.hintDelete;
    default: return '';
  }
}

function AnalysisPanel({ result }: { result: AnalysisResult }) {
  return (
    <div className="analysis-panel">
      <div className="analysis-section">
        <strong>{t.analysisDescription}</strong>
        <div className="analysis-desc">
          {result.description ?? t.noDescriptionFound}
        </div>
      </div>
      <div className="analysis-section">
        <strong>{t.analysisRegex}</strong>
        <div className="analysis-regex"><code>{result.regex}</code></div>
      </div>
      <div className="analysis-section analysis-meta">
        {t.analysisAlphabet}: <code>{result.alphabet.length ? result.alphabet.join(', ') : '∅'}</code>
        {' · '}
        {t.analysisMinStates}: {result.minStates}
      </div>
      {(result.accepted.length > 0 || result.rejected.length > 0) && (
        <div className="analysis-samples">
          <div>
            <strong>{t.analysisAccepted}</strong>{' '}
            <code>{result.accepted.map(formatWord).join(', ') || '—'}</code>
          </div>
          <div>
            <strong>{t.analysisRejected}</strong>{' '}
            <code>{result.rejected.map(formatWord).join(', ') || '—'}</code>
          </div>
        </div>
      )}
    </div>
  );
}

function formatWord(w: string): string { return w === '' ? 'ε' : w; }
