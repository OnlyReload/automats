import { useRef } from 'react';
import type { LangSlot } from '../synth/ops/evaluate';
import { strings as t } from '../i18n/he';

interface Props {
  slots: LangSlot[];
  expression: string;
  onSlotsChange: (slots: LangSlot[]) => void;
  onExpressionChange: (v: string) => void;
}

const OPERATORS: { sym: string; insert: string; title: string }[] = [
  { sym: '∪', insert: ' ∪ ', title: 'איחוד' },
  { sym: '·', insert: ' · ', title: 'שרשור' },
  { sym: '∩', insert: ' ∩ ', title: 'חיתוך' },
  { sym: '\\', insert: ' \\ ', title: 'הפרש' },
  { sym: '*', insert: '*', title: 'כוכב קליני' },
  { sym: 'ᴿ', insert: 'ᴿ', title: 'היפוך' },
  { sym: '¬', insert: '¬', title: 'משלים' },
  { sym: '( )', insert: '()', title: 'סוגריים' },
];

function nextSlotName(slots: LangSlot[]): string {
  const used = new Set(slots.map((s) => s.name));
  for (let i = 1; i < 99; i++) {
    const name = `L${i}`;
    if (!used.has(name)) return name;
  }
  return `L${slots.length + 1}`;
}

export default function Compose({ slots, expression, onSlotsChange, onExpressionChange }: Props) {
  const exprRef = useRef<HTMLInputElement>(null);

  const updateSlot = (i: number, patch: Partial<LangSlot>) => {
    const next = slots.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    onSlotsChange(next);
  };
  const addSlot = () => {
    onSlotsChange([...slots, { name: nextSlotName(slots), source: '' }]);
  };
  const removeSlot = (i: number) => {
    if (slots.length <= 1) return;
    onSlotsChange(slots.filter((_, idx) => idx !== i));
  };

  const insertOp = (s: string) => {
    const el = exprRef.current;
    if (!el) {
      onExpressionChange(expression + s);
      return;
    }
    const start = el.selectionStart ?? expression.length;
    const end = el.selectionEnd ?? expression.length;
    const next = expression.slice(0, start) + s + expression.slice(end);
    onExpressionChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + s.length;
      el.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="compose">
      <div className="compose-slots">
        {slots.map((slot, i) => (
          <div className="compose-slot" key={i}>
            <div className="compose-slot-row">
              <input
                className="compose-name"
                value={slot.name}
                onChange={(e) => updateSlot(i, { name: e.target.value })}
                placeholder="L1"
                spellCheck={false}
              />
              <span className="compose-eq">=</span>
              <button
                className="compose-remove"
                onClick={() => removeSlot(i)}
                disabled={slots.length <= 1}
                title={t.composeRemoveLang}
                aria-label={t.composeRemoveLang}
              >
                ×
              </button>
            </div>
            <textarea
              className="compose-source"
              value={slot.source}
              onChange={(e) => updateSlot(i, { source: e.target.value })}
              placeholder="{ a^n | n >= 0 }"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              rows={2}
            />
          </div>
        ))}
        <button className="compose-add" onClick={addSlot}>
          + {t.composeAddLang}
        </button>
      </div>

      <div className="compose-expr">
        <label className="editor-label">{t.composeResultLabel}</label>
        <input
          ref={exprRef}
          className="compose-expr-input"
          value={expression}
          onChange={(e) => onExpressionChange(e.target.value)}
          placeholder="L1 ∪ L2"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        <div className="compose-ops">
          {OPERATORS.map((op) => (
            <button
              key={op.sym}
              className="compose-op"
              onClick={() => insertOp(op.insert)}
              title={op.title}
            >
              {op.sym}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
