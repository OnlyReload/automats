interface Props {
  message: string;
  source: string;
  span?: { start: number; end: number };
}

export default function ErrorPanel({ message, source, span }: Props) {
  let caretLine: string | null = null;
  if (span && span.start <= source.length) {
    const before = source.slice(0, span.start);
    const width = Math.max(1, span.end - span.start);
    caretLine = ' '.repeat(before.length) + '^'.repeat(width);
  }
  return (
    <div className="error-panel">
      <div>{message}</div>
      {caretLine && (
        <>
          <div className="caret-line">
            <bdi>{source}</bdi>
          </div>
          <div className="caret-line">
            <bdi>{caretLine}</bdi>
          </div>
        </>
      )}
    </div>
  );
}
