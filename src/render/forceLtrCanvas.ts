/**
 * Global LTR canvas patch. Cytoscape renders edge labels through an internal
 * texture cache: text is painted onto offscreen canvases that are never added
 * to the DOM. Those offscreen canvases inherit paragraph direction from the
 * host page (`<html dir="rtl">`), which can shift label text positioning so
 * the box clips characters at the line edges.
 *
 * Patching the visible cytoscape canvas alone misses the cache. Instead we
 * wrap `HTMLCanvasElement.prototype.getContext` so every 2D context returned
 * — visible or offscreen — has `direction = 'ltr'` set, and `fillText` /
 * `strokeText` / `measureText` reassert that direction immediately before
 * each call. Must be installed before any cytoscape code runs.
 */
const patchKey = Symbol.for('automats.ltrPatched');

export function installLtrCanvasPatch(): void {
  patchPrototype(HTMLCanvasElement.prototype as unknown as PatchableProto);
  if (typeof OffscreenCanvas !== 'undefined') {
    patchPrototype(OffscreenCanvas.prototype as unknown as PatchableProto);
  }
}

interface PatchableProto {
  getContext: (id: string, opts?: unknown) => unknown;
}

function patchPrototype(proto: PatchableProto): void {
  const original = proto.getContext;
  if ((original as unknown as Record<symbol, boolean>)[patchKey]) return;
  const wrapped = function (this: unknown, contextId: string, options?: unknown) {
    const ctx = original.call(this, contextId, options);
    if (contextId === '2d' && ctx) {
      patch2dContext(ctx as CanvasRenderingContext2D);
    }
    return ctx;
  };
  (wrapped as unknown as Record<symbol, boolean>)[patchKey] = true;
  proto.getContext = wrapped;
}

function patch2dContext(ctx: CanvasRenderingContext2D): void {
  const tagged = ctx as CanvasRenderingContext2D & Record<symbol, boolean>;
  if (tagged[patchKey]) return;
  ctx.direction = 'ltr';
  const origFill = ctx.fillText.bind(ctx);
  const origStroke = ctx.strokeText.bind(ctx);
  const origMeasure = ctx.measureText.bind(ctx);
  ctx.fillText = ((text: string, x: number, y: number, maxWidth?: number) => {
    ctx.direction = 'ltr';
    return maxWidth === undefined ? origFill(text, x, y) : origFill(text, x, y, maxWidth);
  }) as CanvasRenderingContext2D['fillText'];
  ctx.strokeText = ((text: string, x: number, y: number, maxWidth?: number) => {
    ctx.direction = 'ltr';
    return maxWidth === undefined ? origStroke(text, x, y) : origStroke(text, x, y, maxWidth);
  }) as CanvasRenderingContext2D['strokeText'];
  ctx.measureText = ((text: string) => {
    ctx.direction = 'ltr';
    return origMeasure(text);
  }) as CanvasRenderingContext2D['measureText'];
  tagged[patchKey] = true;
}
