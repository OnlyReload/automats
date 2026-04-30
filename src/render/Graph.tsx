import { useEffect, useRef } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { cyStylesheet, makeLayoutOptions, automatonToElements, type Renderable } from './layout';

cytoscape.use(dagre);

let elkRegistered: boolean | null = null;
async function ensureElk(): Promise<boolean> {
  if (elkRegistered !== null) return elkRegistered;
  try {
    const mod = await import('cytoscape-elk');
    cytoscape.use((mod as { default: cytoscape.Ext }).default);
    elkRegistered = true;
  } catch {
    elkRegistered = false;
  }
  return elkRegistered;
}

interface Props {
  automaton: Renderable;
}

let activeCy: Core | null = null;
export function getActiveCy(): Core | null {
  return activeCy;
}

function isPDA(a: Renderable): boolean {
  return (a as { kind?: string }).kind === 'pda';
}

/**
 * Compact built-in fallback layout used on first paint and whenever ELK
 * isn't available. `cose` is force-directed and gives an organic,
 * "circle-like" arrangement out of the box — no straight LR rows, so
 * diagrams stay zoomed in rather than being stretched across the canvas.
 */
function coseFallback(kind: 'nfa' | 'pda'): cytoscape.LayoutOptions {
  return {
    name: 'cose',
    fit: true,
    padding: 50,
    animate: false,
    randomize: false,
    nodeDimensionsIncludeLabels: true,
    idealEdgeLength: kind === 'pda' ? 150 : 110,
    nodeRepulsion: 400000,
    nodeOverlap: 30,
    edgeElasticity: 120,
    gravity: 80,
    numIter: 1500,
    coolingFactor: 0.95,
    initialTemp: 200,
    minTemp: 1.0,
    componentSpacing: 100,
  } as unknown as cytoscape.LayoutOptions;
}

export default function Graph({ automaton }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const kind: 'nfa' | 'pda' = isPDA(automaton) ? 'pda' : 'nfa';

    let cancelled = false;
    let cy: Core | null = null;

    cy = cytoscape({
      container,
      elements: automatonToElements(automaton),
      style: cyStylesheet,
      layout: coseFallback(kind),
      wheelSensitivity: 0.3,
      maxZoom: 2.5,
      minZoom: 0.2,
    });
    cyRef.current = cy;
    activeCy = cy;

    // LTR canvas enforcement is installed globally in main.tsx via
    // installLtrCanvasPatch — it patches HTMLCanvasElement.prototype.getContext
    // so every 2D context (including cytoscape's offscreen text-glyph cache
    // canvases) has direction='ltr' before any text is drawn.
    cy.one('layoutstop', () => {
      cy?.fit(undefined, 40);
    });

    // Once ELK is available, run its force algorithm for a refined
    // organic layout (cytoscape's cose is already compact, but ELK's
    // force gives slightly better edge spacing on dense graphs).
    ensureElk().then((ok) => {
      if (cancelled || !ok || !cy) return;
      cy.layout(makeLayoutOptions(kind)).run();
    });

    return () => {
      cancelled = true;
      if (cy) {
        cy.destroy();
        if (activeCy === cy) activeCy = null;
      }
    };
  }, [automaton]);

  // dir="ltr" + lang="en" so the inner <canvas> inherits an LTR text
  // direction. Without this, our `<html dir="rtl">` host bleeds into
  // cytoscape's canvas text rendering and reorders Hebrew/Latin labels
  // (causing "שלוףS" overlaps and missing-looking actions).
  return (
    <div
      ref={containerRef}
      dir="ltr"
      lang="en"
      style={{ width: '100%', height: '100%', direction: 'ltr' }}
    />
  );
}
