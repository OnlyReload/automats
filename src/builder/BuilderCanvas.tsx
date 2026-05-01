import { useEffect, useRef } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import { cyStylesheet, automatonToElements } from '../render/layout';
import type { BuilderState, Tool } from './nfa';

interface Props {
  state: BuilderState;
  tool: Tool;
  /** Currently-pending source state for an in-progress transition. */
  pendingFrom: string | null;
  onCanvasTap: (x: number, y: number) => void;
  onNodeTap: (id: string) => void;
  onEdgeTap: (from: string, to: string) => void;
  onNodeMove: (id: string, x: number, y: number) => void;
}

let activeBuilderCy: Core | null = null;
export function getBuilderCy(): Core | null { return activeBuilderCy; }

export default function BuilderCanvas({
  state, tool, pendingFrom,
  onCanvasTap, onNodeTap, onEdgeTap, onNodeMove,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  // Keep callback refs current without re-binding cytoscape handlers.
  const onCanvasTapRef = useRef(onCanvasTap);
  const onNodeTapRef = useRef(onNodeTap);
  const onEdgeTapRef = useRef(onEdgeTap);
  const onNodeMoveRef = useRef(onNodeMove);
  onCanvasTapRef.current = onCanvasTap;
  onNodeTapRef.current = onNodeTap;
  onEdgeTapRef.current = onEdgeTap;
  onNodeMoveRef.current = onNodeMove;

  // Mount: create cytoscape once.
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: cyStylesheet,
      wheelSensitivity: 0.3,
      maxZoom: 2.5,
      minZoom: 0.2,
    });
    cyRef.current = cy;
    activeBuilderCy = cy;

    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        const p = evt.position;
        onCanvasTapRef.current(p.x, p.y);
      }
    });
    cy.on('tap', 'node', (evt) => {
      const n = evt.target;
      const id = n.id();
      if (id === '__start__') return;
      onNodeTapRef.current(id);
    });
    cy.on('tap', 'edge', (evt) => {
      const e = evt.target;
      const src = e.data('source');
      const tgt = e.data('target');
      if (src === '__start__') return;
      onEdgeTapRef.current(src, tgt);
    });
    cy.on('dragfree', 'node', (evt) => {
      const n = evt.target;
      const id = n.id();
      if (id === '__start__') return;
      const p = n.position();
      onNodeMoveRef.current(id, p.x, p.y);
    });

    return () => {
      cy.destroy();
      if (activeBuilderCy === cy) activeBuilderCy = null;
    };
  }, []);

  // Reconcile elements & positions from props.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    syncElements(cy, state, pendingFrom);
  }, [state, pendingFrom]);

  // Cursor hint per tool — purely cosmetic.
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.style.cursor = tool === 'addState' ? 'crosshair' : 'default';
    }
  }, [tool]);

  return (
    <div
      ref={containerRef}
      dir="ltr"
      lang="en"
      style={{ width: '100%', height: '100%', direction: 'ltr' }}
    />
  );
}

/**
 * Reconcile cytoscape's element set with the desired set derived from the
 * builder state — without running a layout. Each node is positioned from the
 * builder's PositionMap (newly-added nodes were placed by the user's click).
 */
function syncElements(cy: Core, state: BuilderState, pendingFrom: string | null) {
  if (state.nfa.states.length === 0) {
    cy.elements().remove();
    return;
  }
  const desired = automatonToElements(state.nfa);
  const desiredById = new Map(desired.map((e) => [String(e.data!.id), e]));
  const positions = state.positions;

  // Remove anything not desired.
  cy.elements().forEach((el) => {
    if (!desiredById.has(el.id())) el.remove();
  });

  // Add or update.
  for (const el of desired) {
    const id = String(el.data!.id);
    const existing = cy.getElementById(id);
    if (existing.empty()) {
      const elDef = { ...el };
      if (el.group === 'edges' || el.data?.source) {
        // Edge — no position.
      } else {
        // Node — use builder's stored position, falling back to a guess for
        // the synthetic __start__ anchor.
        if (id === '__start__') {
          const target = String((el.data as { target?: string }).target ?? state.nfa.start);
          const tp = positions[target] ?? positionForFreshStart(state);
          elDef.position = { x: tp.x - 80, y: tp.y };
        } else if (positions[id]) {
          elDef.position = { x: positions[id].x, y: positions[id].y };
        }
      }
      cy.add(elDef);
    } else {
      // Update label/classes for existing element (accept toggle, etc.).
      existing.data('label', el.data!.label ?? '');
      const cls = el.classes;
      if (cls && existing.classes().join(' ') !== cls) {
        existing.classes(cls as string);
      }
      // Re-pin node position if user changed positions externally.
      if (el.group !== 'edges' && !el.data?.source && id !== '__start__' && positions[id]) {
        const cur = existing.position();
        const want = positions[id];
        if (Math.abs(cur.x - want.x) > 0.5 || Math.abs(cur.y - want.y) > 0.5) {
          existing.position({ x: want.x, y: want.y });
        }
      }
    }
  }

  // Highlight the pending "from" state for in-progress transition.
  cy.nodes().removeClass('builder-selected');
  if (pendingFrom) {
    cy.getElementById(pendingFrom).addClass('builder-selected');
  }
}

function positionForFreshStart(state: BuilderState): { x: number; y: number } {
  const startPos = state.positions[state.nfa.start];
  if (startPos) return startPos;
  return { x: 200, y: 200 };
}
