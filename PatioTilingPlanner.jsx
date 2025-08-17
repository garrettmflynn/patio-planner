import React, { useMemo, useRef, useState } from "react";

/**
 * Patio Tiling Planner — segmented into tileable vs freehand vs hole.
 *
 * Tileable regions: shaded in distinct shades of green.
 * Freehand: yellow/red.
 * Original hole: white (dashed blue outline).
 * Enlarged hole (conceptual): red outline.
 */

// ---------- Problem input ----------
const W = 104; // patio width
const H = 157; // patio height

// Original hole: 25×25, top at y=36, flush right edge
// Virtual hole (enlarged): +7 left, +5 bottom
const originalHole = { x1: W - 25, y1: 36, x2: W, y2: 36 + 25 };
const enlargedHole = { x1: W - 25 - 7, y1: 36, x2: W, y2: 36 + 25 + 5 };

// ---------- Segmentation ----------
const segments = {
  tileable: [
    { name: "Top-Left", x: 0, y: 0, w: 72, h: 36, color: "#b7e4c7" },
    { name: "Band-Left", x: 0, y: 36, w: 72, h: 30, color: "#95d5b2" },
    { name: "Bottom-Left", x: 0, y: 66, w: 72, h: 90, color: "#74c69d" },
    { name: "Top-Right", x: 72, y: 0, w: 24, h: 36, color: "#52b788" },
    { name: "Bottom-Right", x: 72, y: 66, w: 24, h: 90, color: "#40916c" },
  ],
  freehand: [
    { name: "Pad-Left", x: 72, y: 36, w: 7, h: 30, color: "#ffeb99" },
    { name: "Pad-Bottom", x: 79, y: 61, w: 25, h: 5, color: "#ffeb99" },
    { name: "Right-Border", x: 96, y: 0, w: 8, h: 157, color: "#ffe066" },
    { name: "Bottom-Rip", x: 0, y: 156, w: 104, h: 1, color: "#ffadad" },
  ],
};

function exportSVG(svgRef, filename = "patio-layout.svg") {
  if (!svgRef.current) return;
  const serializer = new XMLSerializer();
  const source = serializer.serializeToString(svgRef.current);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function PatioTilingPlanner() {
  const [scale] = useState(4);
  const svgRef = useRef(null);

  const svgW = W * scale;
  const svgH = H * scale;

  return (
    <div style={{ padding: 16 }}>
      <div className="no-print" style={{ marginBottom: 12 }}>
        <button onClick={() => window.print()}>Print</button>
        <button onClick={() => exportSVG(svgRef)}>Export SVG</button>
      </div>

      <svg
        ref={svgRef}
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
      >
        {/* Patio outline */}
        <rect
          x={0}
          y={0}
          width={W * scale}
          height={H * scale}
          fill="#f9fafb"
          stroke="#333"
          strokeWidth={2}
        />

        {/* Tileable segments */}
        {segments.tileable.map((s, i) => (
          <rect
            key={"tile-" + i}
            x={s.x * scale}
            y={s.y * scale}
            width={s.w * scale}
            height={s.h * scale}
            fill={s.color}
            stroke="#555"
            strokeWidth={0.5}
          />
        ))}

        {/* Freehand segments */}
        {segments.freehand.map((s, i) => (
          <rect
            key={"free-" + i}
            x={s.x * scale}
            y={s.y * scale}
            width={s.w * scale}
            height={s.h * scale}
            fill={s.color}
            stroke="#555"
            strokeWidth={0.5}
          />
        ))}

        {/* Original hole (not tileable) */}
        <rect
          x={originalHole.x1 * scale}
          y={originalHole.y1 * scale}
          width={(originalHole.x2 - originalHole.x1) * scale}
          height={(originalHole.y2 - originalHole.y1) * scale}
          fill="#ffffff"
          stroke="#0000cc"
          strokeWidth={2}
          strokeDasharray="4 3"
        />

        {/* Enlarged conceptual hole (alignment only) */}
        <rect
          x={enlargedHole.x1 * scale}
          y={enlargedHole.y1 * scale}
          width={(enlargedHole.x2 - enlargedHole.x1) * scale}
          height={(enlargedHole.y2 - enlargedHole.y1) * scale}
          fill="none"
          stroke="#cc0000"
          strokeWidth={2}
        />
      </svg>

      <div style={{ marginTop: 12 }}>
        <h3>Legend</h3>
        <ul>
          {segments.tileable.map((s, i) => (
            <li key={"tile-l-" + i}>
              <span style={{ background: s.color, padding: "0 8px" }} /> {s.name}: {s.w}″ × {s.h}″
            </li>
          ))}
          {segments.freehand.map((s, i) => (
            <li key={"free-l-" + i}>
              <span style={{ background: s.color, padding: "0 8px" }} /> {s.name}: {s.w}″ × {s.h}″
            </li>
          ))}
          <li>
            <span style={{ border: "2px dashed blue", padding: "0 8px" }} /> Original Hole: 25″ × 25″
          </li>
          <li>
            <span style={{ border: "2px solid red", padding: "0 8px" }} /> Conceptual Enlarged Hole: 32″ × 30″
          </li>
        </ul>
      </div>
    </div>
  );
}
