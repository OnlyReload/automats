import { EXAMPLES } from '../examples';
import type { Automaton } from '../synth/synthesize';
import { strings as t } from '../i18n/he';
import { exportPng } from '../render/exportPng';
import { exportJson } from '../render/exportJson';

interface Props {
  source: string;
  onSourceChange: (v: string) => void;
  automaton: Automaton | null;
  langName: string;
  showTraps: boolean;
  onToggleTraps: () => void;
  /** Trap-state toggle is only meaningful for NFAs. */
  canToggleTraps: boolean;
  /** Hide the example dropdown when not in single mode. */
  showExamples?: boolean;
}

export default function Toolbar({
  onSourceChange,
  automaton,
  langName,
  showTraps,
  onToggleTraps,
  canToggleTraps,
  showExamples = true,
}: Props) {
  return (
    <div className="toolbar">
      {showExamples && (
        <>
          <label htmlFor="example-select">{t.exampleLabel}</label>
          <select
            id="example-select"
            defaultValue=""
            onChange={(e) => {
              const ex = EXAMPLES.find((x) => x.id === e.target.value);
              if (ex) onSourceChange(ex.source);
            }}
          >
            <option value="" disabled>
              —
            </option>
            {EXAMPLES.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.label}
              </option>
            ))}
          </select>
        </>
      )}
      <button
        disabled={!canToggleTraps}
        onClick={onToggleTraps}
        title="הוספה/הסרה של מצבי מלכודת לאוטומט הסופי"
      >
        {showTraps ? t.hideTraps : t.showTraps}
      </button>
      <button disabled={!automaton} onClick={() => exportPng(`${langName || 'automaton'}.png`)}>
        {t.exportPng}
      </button>
      <button disabled={!automaton} onClick={() => automaton && exportJson(automaton, langName || 'automaton')}>
        {t.exportJson}
      </button>
    </div>
  );
}
