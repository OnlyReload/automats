import { strings as t } from '../i18n/he';

interface Props {
  value: string;
  onChange: (v: string) => void;
}

export default function Editor({ value, onChange }: Props) {
  return (
    <div className="editor">
      <label className="editor-label">{t.inputLabel}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>
  );
}
