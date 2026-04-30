import type cytoscape from 'cytoscape';
import type { NFA } from '../automaton/types';
import type { PDA, PDATransition } from '../automaton/pda';
import { describeAction, PDA_EPSILON } from '../automaton/pda';

export type Renderable = NFA | PDA;

interface GraphView {
  nodes: { id: string; label: string; accept: boolean }[];
  /**
   * Edges grouped by (from, to) pair. Each visual edge bundles all the
   * transitions between that pair into one merged label. We avoid emitting
   * multiple edges per pair so the layout doesn't pile parallel curves on
   * top of each other.
   */
  edges: { from: string; to: string; label: string; isEpsilon: boolean }[];
  start: string;
  kind: 'nfa' | 'pda';
}

function isPDA(a: Renderable): a is PDA {
  return (a as PDA).kind === 'pda';
}

/**
 * Format a bundle of PDA transitions sharing the same (from, to) endpoint
 * pair. Transitions are grouped by their action so transitions that do the
 * same thing stack their heads together with a single shared action line.
 *
 * Each sub-bundle renders as:
 *   head1
 *   head2
 *   action       (omitted for peek-only)
 * Sub-bundles are separated by a blank line.
 */
function formatPdaBundle(ts: PDATransition[]): string {
  const byAction = new Map<string, PDATransition[]>();
  const order: string[] = [];
  for (const t of ts) {
    const key = `${t.action.pop ? '1' : '0'}|${t.action.pushSymbols.join(',')}`;
    if (!byAction.has(key)) {
      byAction.set(key, []);
      order.push(key);
    }
    byAction.get(key)!.push(t);
  }
  const blocks = order.map((key) => {
    const group = byAction.get(key)!;
    const heads = group.map((t) => `${t.inputSymbol}, ${t.stackTop}`);
    const action = describeAction(group[0].action);
    return action ? [...heads, action].join('\n') : heads.join('\n');
  });
  return blocks.join('\n\n');
}

function toGraphView(a: Renderable): GraphView {
  if (isPDA(a)) {
    const nodes = a.states.map((s) => ({ id: s.id, label: s.label ?? s.id, accept: s.accept }));
    // Group transitions by (from, to). Within a bundle, sub-group by shared
    // action so transitions that do the same thing on different stack tops
    // collapse to a stack of heads with one action line underneath. e.g. the
    // q_push self-loop in `a^n b^n` has two transitions both pushing `a`, so
    // the label becomes:
    //   a, S
    //   a, a
    //   דחוף a
    // instead of repeating `דחוף a` after each head.
    const groups = new Map<string, { from: string; to: string; ts: PDATransition[]; epsCount: number }>();
    for (const t of a.transitions) {
      const k = `${t.from}|${t.to}`;
      const g = groups.get(k) ?? { from: t.from, to: t.to, ts: [], epsCount: 0 };
      g.ts.push(t);
      if (t.inputSymbol === PDA_EPSILON) g.epsCount++;
      groups.set(k, g);
    }
    const edges = [...groups.values()].map((g) => ({
      from: g.from,
      to: g.to,
      label: formatPdaBundle(g.ts),
      // An edge is "purely epsilon" iff every bundled transition is ε.
      isEpsilon: g.epsCount === g.ts.length,
    }));
    return { nodes, edges, start: a.start, kind: 'pda' };
  }
  const nodes = a.states.map((s) => ({ id: s.id, label: s.label ?? s.id, accept: s.accept }));
  const groups = new Map<string, { from: string; to: string; labels: string[] }>();
  for (const t of a.transitions) {
    const k = `${t.from}|${t.to}`;
    const g = groups.get(k) ?? { from: t.from, to: t.to, labels: [] };
    g.labels.push(t.symbol);
    groups.set(k, g);
  }
  const edges = [...groups.values()].map((g) => ({
    from: g.from,
    to: g.to,
    // Sort and dedup symbol list for readability.
    label: [...new Set(g.labels)].sort().join(', '),
    isEpsilon: false,
  }));
  return { nodes, edges, start: a.start, kind: 'nfa' };
}

/**
 * Convert an automaton into Cytoscape elements. Each accept state is rendered
 * via a compound (parent + child) construction: the parent draws the outer
 * circle, the child draws the inner ring — together they look like the
 * textbook concentric "accept" notation, much cleaner than a single double
 * border.
 */
export function automatonToElements(a: Renderable): cytoscape.ElementDefinition[] {
  const view = toGraphView(a);
  const elements: cytoscape.ElementDefinition[] = [];

  // Visible "start dot" — a small filled marker so the start position is
  // always obvious. ELK's layered algorithm naturally places it in the layer
  // before the start state because of the edge we add below.
  elements.push({ data: { id: '__start__', label: '' }, classes: 'start-anchor' });

  // Self-loop direction strategy:
  //   The graph layout flows left-to-right, so adjacent edges run horizontally.
  //   To avoid overlapping with horizontal flow we restrict loops to vertical
  //   directions only — alternating UP and DOWN per looping node so the
  //   diagram stays balanced when multiple nodes have self-loops.
  const selfLoopAngle = new Map<string, string>();
  let angleIdx = 0;
  for (const e of view.edges) {
    if (e.from !== e.to) continue;
    if (selfLoopAngle.has(e.from)) continue;
    selfLoopAngle.set(e.from, angleIdx % 2 === 0 ? '-90deg' : '90deg');
    angleIdx++;
  }

  // Detect bidirectional pairs: when both A→B and B→A exist as non-self edges.
  // We use these to shift bezier control points so the two parallel curves
  // visibly separate and their labels don't pile up on the midpoint.
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const directedKeys = new Set<string>();
  for (const e of view.edges) {
    if (e.from === e.to) continue;
    directedKeys.add(`${e.from}|${e.to}`);
  }
  const bidiPairs = new Set<string>();
  for (const e of view.edges) {
    if (e.from === e.to) continue;
    if (directedKeys.has(`${e.to}|${e.from}`)) bidiPairs.add(pairKey(e.from, e.to));
  }

  for (const n of view.nodes) {
    const isTrap = n.id === '__trap__';
    let cls = 'state';
    if (n.accept) cls = 'state state-accept';
    else if (isTrap) cls = 'state state-trap';
    elements.push({
      data: { id: n.id, label: n.label, accept: n.accept ? 'true' : 'false' },
      classes: cls,
    });
  }

  let edgeId = 0;
  for (const e of view.edges) {
    const classes: string[] = ['edge'];
    if (e.from === e.to) {
      classes.push('self-loop');
      const ang = selfLoopAngle.get(e.from) ?? '-90deg';
      classes.push(ang === '-90deg' ? 'self-loop-up' : 'self-loop-down');
    }
    if (e.isEpsilon) classes.push('eps-edge');
    if (view.kind === 'pda') classes.push('pda-edge');

    const isBidi = e.from !== e.to && bidiPairs.has(pairKey(e.from, e.to));
    if (isBidi) classes.push('bidi-edge');

    const data: cytoscape.ElementDefinition['data'] = {
      id: `e${edgeId++}`,
      source: e.from,
      target: e.to,
      label: e.label,
    };
    if (e.from === e.to) {
      // cytoscape's loop-direction takes an angle with unit, e.g. "-90deg".
      data.loopAngle = selfLoopAngle.get(e.from) ?? '-90deg';
    }
    if (isBidi) {
      // Push the two opposite-direction edges to opposite sides of the line
      // joining their endpoints. Sign the offset by the lexical order of the
      // endpoint ids so each edge in the pair gets a consistent, opposite
      // curve. Cytoscape parses control-point-distances as pixel numbers.
      const sign = e.from < e.to ? 1 : -1;
      data.bidiOffset = sign * 40;
    }
    elements.push({
      data,
      classes: classes.join(' '),
    });
  }

  // Start arrow.
  elements.push({
    data: { id: 'start-edge', source: '__start__', target: view.start, label: '' },
    classes: 'edge start-edge',
  });

  return elements;
}

// Backwards-compatible alias.
export const nfaToElements = automatonToElements;

export const cyStylesheet: cytoscape.StylesheetCSS[] = [
  // ── State node ────────────────────────────────────────────────────────
  {
    selector: 'node.state',
    css: {
      'background-color': '#1d212b',
      'border-color': '#7aa2f7',
      'border-width': 2,
      label: 'data(label)',
      color: '#e8eaf0',
      'text-valign': 'center',
      'text-halign': 'center',
      width: 46,
      height: 46,
      'font-family': 'ui-monospace, Consolas, monospace',
      'font-size': 14,
      'font-weight': 'bold' as cytoscape.Css.FontWeight,
      shape: 'ellipse',
    },
  },
  // ── Accept state — textbook concentric circles via thick double border ─
  {
    selector: 'node.state-accept',
    css: {
      'background-color': '#1d212b',
      'border-color': '#9ece6a',
      'border-width': 6,
      'border-style': 'double',
      shape: 'ellipse',
      width: 50,
      height: 50,
    },
  },
  // ── Trap (sink) state — visually muted so it reads as "dead end". ─────
  {
    selector: 'node.state-trap',
    css: {
      'background-color': '#26181b',
      'border-color': '#f7768e',
      'border-width': 2,
      'border-style': 'dashed',
      color: '#f7c1cb',
      shape: 'ellipse',
    },
  },
  // ── Start dot — small visible marker before the start state ──────────
  {
    selector: 'node.start-anchor',
    css: {
      width: 12,
      height: 12,
      'background-color': '#7aa2f7',
      'border-width': 0,
      shape: 'ellipse',
      label: '',
    },
  },
  // ── Generic edge ──────────────────────────────────────────────────────
  {
    selector: 'edge.edge',
    css: {
      width: 1.5,
      'line-color': '#9aa3b8',
      'target-arrow-color': '#9aa3b8',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 1.2,
      'curve-style': 'bezier',
      label: 'data(label)',
      color: '#e8eaf0',
      'font-family': 'ui-monospace, Consolas, monospace',
      'font-size': 12,
      'text-background-color': '#0e0f13',
      'text-background-opacity': 0.92,
      'text-background-padding': '3px',
      'text-background-shape': 'roundrectangle',
      'text-border-color': '#2a2f3c',
      'text-border-width': 1,
      'text-border-opacity': 1,
      'text-rotation': 'autorotate',
      'text-wrap': 'wrap' as 'wrap',
      'edge-distances': 'intersection',
    },
  },
  // ── PDA edge — labels are multi-line, never auto-rotated, smaller font ─
  // Two-line labels: head (Latin) on top, action (Hebrew) below. Centered
  // justification + extra background padding keeps the auto-sized box wide
  // enough that the leftmost characters of Hebrew lines (which use a
  // fallback font that cytoscape mis-measures) don't get clipped outside
  // the box edge.
  {
    selector: 'edge.pda-edge',
    css: {
      'font-size': 11,
      'text-rotation': 'none' as 'none',
      'text-margin-y': -4,
      'text-wrap': 'wrap' as 'wrap',
      'text-justification': 'center' as 'center',
      'text-background-padding': '8px',
      'text-max-width': 200 as unknown as string,
    },
  },
  // ── ε-edges in a softer color so they read as "stack-only" moves ──────
  {
    selector: 'edge.eps-edge',
    css: {
      'line-color': '#5b6478',
      'target-arrow-color': '#5b6478',
      'line-style': 'dashed',
    },
  },
  // ── Self-loop styling ─────────────────────────────────────────────────
  // Cytoscape doesn't accept data-mapper values for `loop-direction`, so the
  // direction is hard-coded per class instead. Loops are kept tight (small
  // sweep, modest control point) and labels are lifted clear of the node so
  // they never crowd horizontal inbound/outbound edges.
  {
    selector: 'edge.self-loop',
    css: {
      'curve-style': 'bezier',
      'loop-sweep': '20deg',
      'control-point-step-size': 60,
      'text-rotation': 'none' as 'none',
    },
  },
  {
    selector: 'edge.self-loop-up',
    css: {
      'loop-direction': '-90deg',
      'text-margin-y': -22,
    },
  },
  {
    selector: 'edge.self-loop-down',
    css: {
      'loop-direction': '90deg',
      'text-margin-y': 22,
    },
  },
  // ── Bidirectional pair: shift each edge to opposite side of the line ──
  // Without this the two parallel curves between A↔B sit too close and their
  // labels stack on the midpoint.
  {
    selector: 'edge.bidi-edge',
    css: {
      'curve-style': 'unbundled-bezier',
      'control-point-distances': 'data(bidiOffset)' as unknown as 'autorotate',
      'control-point-weights': '0.5',
    },
  },
  // ── Start-arrow styling ───────────────────────────────────────────────
  {
    selector: 'edge.start-edge',
    css: {
      'line-color': '#7aa2f7',
      'target-arrow-color': '#7aa2f7',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 1.4,
      width: 2,
      label: '',
      'curve-style': 'straight',
    },
  },
];

/**
 * Default layout — ELK 'layered' for clean edge routing, large separations,
 * and orthogonal/spline routing that avoids label collisions. Falls back to
 * dagre at the call site if elk isn't registered (e.g. in tests).
 */
export function makeLayoutOptions(kind: 'nfa' | 'pda'): cytoscape.LayoutOptions {
  // ELK's force-directed algorithm produces a compact, organic ("circle-like")
  // layout — nodes settle around each other with edges of roughly equal
  // length, instead of being pushed into a wide left-to-right column. Edges
  // remain bezier curves so the diagram reads naturally without long straight
  // runs that force the canvas to zoom out.
  const edgeLen = kind === 'pda' ? 160 : 120;
  const nodeSpacing = kind === 'pda' ? 70 : 55;

  return {
    name: 'elk',
    nodeDimensionsIncludeLabels: true,
    fit: true,
    padding: 50,
    animate: false,
    elk: {
      algorithm: 'force',
      // Desired edge length keeps connected states at a comfortable distance.
      'elk.force.repulsion': 5,
      'elk.force.iterations': 400,
      'elk.spacing.nodeNode': nodeSpacing,
      'elk.spacing.edgeNode': 30,
      'elk.spacing.edgeEdge': 24,
      'elk.spacing.labelLabel': 20,
      'elk.spacing.labelNode': 20,
      // Reserve clearance around self-loops so the loop's arc never crosses
      // an adjacent node or label.
      'elk.spacing.nodeSelfLoop': 60,
      // Force the random seed so the layout is stable across re-renders.
      'elk.randomSeed': 1,
      // Gives the force algorithm a target edge length to spring around.
      'elk.layered.spacing.nodeNodeBetweenLayers': edgeLen,
    },
  } as unknown as cytoscape.LayoutOptions;
}

// Legacy export (kept so other modules importing it still build).
export const dagreLayout = {
  name: 'dagre',
  rankDir: 'LR',
  nodeSep: 70,
  rankSep: 110,
  edgeSep: 30,
  fit: true,
  padding: 30,
  animate: false,
};
