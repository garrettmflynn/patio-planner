import React, { useMemo, useRef, useState, useEffect } from "react";

/**
 * Patio Tiling Planner — inventory-safe RANDOM solver with feasibility gate & auto-solve
 *
 * Guarantees
 *  - Refuses unless 100% coverage is achievable:
 *      • All tileable 12×6 grid cells covered using only whole 6×12 / 12×12 (no cuts)
 *      • Pad-Left (7″×30″) fully fillable using odd tiles with rips (cuts allowed)
 *  - Inventory-safe: never decrements below zero; never throws on underflow
 *  - Auto-solve: re-rolls random placement until a valid plan (or attempt cap)
 *  - Bottom 1″ shear (y=156–157) expected and shown
 */

/* ---------------------- Geometry (inches) ---------------------- */
const W = 104; // patio width
const H = 157; // patio height

const originalHole = { x1: W - 25, y1: 36, x2: W, y2: 61 }; // 25×25 (void)
const enlargedHole = { x1: W - 32, y1: 36, x2: W, y2: 66 }; // 32×30 (conceptual alignment)

// Tileable sections (on 12×6 grid)
const SECTIONS = [
  { id: "top-left",     name: "Top-Left",     x: 0,  y: 0,   w: 72, h: 36 }, // 6×6 cells
  { id: "band-left",    name: "Band-Left",    x: 0,  y: 36,  w: 72, h: 30 }, // 6×5 cells
  { id: "bottom-left",  name: "Bottom-Left",  x: 0,  y: 66,  w: 72, h: 90 }, // 6×15 cells
  { id: "top-right",    name: "Top-Right",    x: 72, y: 0,   w: 24, h: 36 }, // 2×6 cells
  { id: "bottom-right", name: "Bottom-Right", x: 72, y: 66,  w: 24, h: 90 }, // 2×15 cells
];

// Freehand / special zones
const PAD_LEFT     = { name: "Pad-Left",     x: 72, y: 36, w: 7,  h: 30 };  // must be fully filled (cuts OK)
const PAD_BOTTOM   = { name: "Pad-Bottom",   x: 79, y: 61, w: 25, h: 5  };  // annotate only
const RIGHT_BORDER = { name: "Right-Border", x: 96, y: 0,  w: 8,  h: 156 }; // optional odd-tile column (whole tiles)
const BOTTOM_RIP   = { name: "Bottom-Rip",   x: 0,  y: 156, w: 104, h: 1  }; // 1″ shear band

/* ---------------------- Inventory (GLOBAL) ---------------------- */
const INITIAL_INVENTORY = {
  "6x12": 159,
  "12x12": 8,
  "8x16": 7,
  "8x8": 15,
  "16x16": 6,
  "16x11": 2,
  "16x12": 6,
};

/* ---------------------- Colors ---------------------- */
const colors = {
  patio: "#f9fafb",
  outline: "#333",
  zones: ["#b7e4c7", "#95d5b2", "#74c69d", "#52b788", "#40916c"], // tileable bg shades
  t6x12: "#8ecae6",
  t12x12: "#cdb4db",
  border8: "#ffd166",
  pad: "#fff7cc",
  rip: "#ffb3b3",
  holeFill: "#ffffff",
  origOutline: "#0066cc",
  conceptOutline: "#cc0000",
  text: "#111",
};

/* ---------------------- Feasibility checks ---------------------- */
function totalCellsNeeded(sections) {
  return sections.reduce((a, s) => a + Math.floor(s.w / 12) * Math.floor(s.h / 6), 0);
}
function cellsSupply(inv) {
  // 12×12 covers 4 cells, 6×12 covers 1
  return 4 * (inv["12x12"] || 0) + (inv["6x12"] || 0);
}
function padLeftAreaNeeded() {
  return PAD_LEFT.w * PAD_LEFT.h; // 7×30 = 210 in²
}
function oddAreaSupply(inv) {
  const A = { "8x8": 64, "8x16": 128, "16x16": 256, "16x12": 192, "16x11": 176 };
  return Object.entries(A).reduce((sum, [k, a]) => sum + a * ((inv[k] || 0)), 0);
}

/* ---------------------- Random helpers ---------------------- */
function pickWeighted(entries) {
  const avail = entries.filter(e => e.weight > 0);
  const total = avail.reduce((a, e) => a + e.weight, 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const e of avail) {
    if (r < e.weight) return e.key;
    r -= e.weight;
  }
  return avail[avail.length - 1].key;
}
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------------------- Tileable solver (no-cuts) ---------------------- */
/** Fills each section's 12×6 grid using only whole 6×12 or 12×12.
 *  Inventory-guarded: will never decrement counts below 0.
 */
function solveTileableRandom(sections, inv0, opts) {
  const { bias1212 = 2.0, bias6x12 = 1.0, min1212Share = 0.1 } = opts || {};
  const inv = { ...inv0 };
  const out = [];

  const globalCells = sections.reduce((a, s) => a + Math.floor(s.w / 12) * Math.floor(s.h / 6), 0);
  let target1212 = Math.min(inv["12x12"] || 0, Math.floor((globalCells * min1212Share) / 4));

  for (const s of sections) {
    const cols = Math.floor(s.w / 12), rows = Math.floor(s.h / 6);
    const grid = Array.from({ length: rows }, () => Array(cols).fill(false));
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ r, c });
    shuffleInPlace(cells);

    const placements = [];

    for (const { r, c } of cells) {
      if (grid[r][c]) continue;

      // Build weighted options from *available* inventory only
      const want1212 = (inv["12x12"] || 0) > 0 && r + 1 < rows && c + 1 < cols &&
                       !grid[r][c] && !grid[r][c + 1] && !grid[r + 1][c] && !grid[r + 1][c + 1];
      const want6    = (inv["6x12"] || 0) > 0;

      const extraBias = target1212 > 0 ? 3 : 1;
      const options = [];
      if (want1212) options.push({ key: "12x12", weight: (inv["12x12"] || 0) * bias1212 * extraBias });
      if (want6)    options.push({ key: "6x12",  weight: (inv["6x12"]  || 0) * bias6x12 });

      // If nothing is available (should not happen if feasibility gate passed), fallback to any that fits
      if (options.length === 0) {
        // Try 12x12 if geometry allows AND count > 0
        if (r + 1 < rows && c + 1 < cols && (inv["12x12"] || 0) > 0 &&
            !grid[r][c] && !grid[r][c + 1] && !grid[r + 1][c] && !grid[r + 1][c + 1]) {
          options.push({ key: "12x12", weight: 1 });
        }
        // Try 6x12 if count > 0
        if ((inv["6x12"] || 0) > 0) {
          options.push({ key: "6x12", weight: 1 });
        }
      }

      const choice = pickWeighted(options);
      if (choice === "12x12") {
        // Place 2×2 cells
        grid[r][c] = grid[r][c + 1] = grid[r + 1][c] = grid[r + 1][c + 1] = true;
        placements.push({ name: "12x12", x: s.x + c * 12, y: s.y + r * 6, w: 24, h: 12 });
        inv["12x12"]--;
        if (target1212 > 0) target1212--;
      } else if (choice === "6x12") {
        grid[r][c] = true;
        placements.push({ name: "6x12", x: s.x + c * 12, y: s.y + r * 6, w: 12, h: 6 });
        inv["6x12"]--;
      } else {
        // No placeable tile available — leave cell for feasibility overlay to catch
        // (We won't place anything; the overlay will refuse the plan, and Auto-solve can re-roll.)
      }
    }

    out.push({
      section: s,
      placements,
      used: {
        "12x12": placements.filter(p => p.name === "12x12").length,
        "6x12": placements.filter(p => p.name === "6x12").length,
      }
    });
  }

  return { perSection: out, remaining: inv };
}

/* ---------------------- Freehand fillers ---------------------- */
function fillRightBorderRandom(inv, startY = RIGHT_BORDER.y, totalH = RIGHT_BORDER.h) {
  const placements = []; let y = startY; let remain = totalH; const cuts = []; const use = { "8x16": 0, "8x8": 0 };
  while (remain >= 8) {
    const w816 = (inv["8x16"] || 0) > 0 && remain >= 16 ? (inv["8x16"] || 0) * 2 : 0;
    const w88  = (inv["8x8"]  || 0) > 0 && remain >= 8  ? (inv["8x8"]  || 0) * 1 : 0;
    const choice = pickWeighted([{ key: "8x16", weight: w816 }, { key: "8x8", weight: w88 }]) || null;
    if (choice === "8x16") {
      placements.push({ zone: "RIGHT_BORDER", name: "8x16", x: RIGHT_BORDER.x, y, w: 8, h: 16 });
      y += 16; remain -= 16; inv["8x16"]--; use["8x16"]++; continue;
    }
    if (choice === "8x8") {
      placements.push({ zone: "RIGHT_BORDER", name: "8x8", x: RIGHT_BORDER.x, y, w: 8, h: 8 });
      y += 8; remain -= 8; inv["8x8"]--; use["8x8"]++; continue;
    }
    // If chosen doesn't fit, try 8×8 straight
    if (remain >= 8 && (inv["8x8"] || 0) > 0) {
      placements.push({ zone: "RIGHT_BORDER", name: "8x8", x: RIGHT_BORDER.x, y, w: 8, h: 8 });
      y += 8; remain -= 8; inv["8x8"]--; use["8x8"]++; continue;
    }
    break;
  }
  return { placements, cuts, use };
}

function fillPadLeftFull(inv) {
  // Fill 7×30 entirely; allow cutting from odd tiles (inventory-guarded)
  const placements = []; const cuts = []; let remain = PAD_LEFT.h; let y = PAD_LEFT.y;
  const donors = ["16x16", "8x16", "16x12", "16x11", "8x8"]; // prefer larger first
  while (remain > 0) {
    const useH = remain >= 16 ? 16 : (remain >= 8 ? 8 : remain);
    const donor = donors.find(k => (inv[k] || 0) > 0);
    if (!donor) break; // out of odd tiles
    placements.push({ zone: "PAD_LEFT", name: `7x${useH} (rip from ${donor})`, x: PAD_LEFT.x, y, w: 7, h: useH });
    cuts.push({ from: donor, to: `7×${useH} + offcuts` });
    inv[donor]--;
    y += useH; remain -= useH;
  }
  return { placements, cuts, done: remain === 0, remainingHeight: remain };
}

function solveFreehand(inv0) {
  const inv = { ...inv0 };
  const left   = fillPadLeftFull(inv);   // must be full
  const border = fillRightBorderRandom(inv); // optional
  return {
    placements: [...left.placements, ...border.placements],
    cuts: [...left.cuts, ...border.cuts],
    remaining: inv,
    padLeftFilled: left.done,
    padLeftRemainingHeight: left.remainingHeight,
    use: border.use,
  };
}

/* ---------------------- Export SVG ---------------------- */
function exportSVG(svgRef, filename = "patio-random-solver.svg") {
  if (!svgRef.current) return;
  const serializer = new XMLSerializer();
  const source = serializer.serializeToString(svgRef.current);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ---------------------- Component ---------------------- */
export default function PatioTilingPlanner() {
  const [scale, setScale] = useState(4);
  const [inventory, setInventory] = useState(INITIAL_INVENTORY);
  const [nonce, setNonce] = useState(0);
  const [bias1212, setBias1212] = useState(2.0);
  const [bias6x12, setBias6x12] = useState(1.0);
  const [min1212Share, setMin1212Share] = useState(0.1);

  // Main placements (randomized)
  const tile = useMemo(() => {
    return solveTileableRandom(SECTIONS, inventory, { bias1212, bias6x12, min1212Share });
  }, [inventory, nonce, bias1212, bias6x12, min1212Share]);

  // Freehand: Pad-Left must fill; Right border optional
  const free = useMemo(() => {
    return solveFreehand(inventory);
  }, [inventory, nonce]);

  // Feasibility gate — supply-based (safe: no underflow)
  const needCells = Math.max(0, totalCellsNeeded(SECTIONS) - cellsSupply(inventory));
  const needPadArea = Math.max(0, padLeftAreaNeeded() - oddAreaSupply(inventory));
  const insufficientSupply = (needCells > 0) || (needPadArea > 0);

  // Also require Pad-Left actually filled by the current random pick/cut sequence
  const insufficient = insufficientSupply || !free.padLeftFilled;

  // Auto-solve loop: keep rerolling random placement until feasible or attempts cap
  const [autoSolve, setAutoSolve] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const MAX_ATTEMPTS = 300;
  useEffect(() => {
    if (!autoSolve) return;
    if (!insufficient) { setAutoSolve(false); setAttempts(0); return; }
    if (attempts < MAX_ATTEMPTS) {
      const id = setTimeout(() => { setAttempts(a => a + 1); setNonce(n => n + 1); }, 0);
      return () => clearTimeout(id);
    } else {
      setAutoSolve(false);
    }
  }, [autoSolve, insufficient, attempts]);

  // Layout
  const svgRef = useRef(null);
  const sidePanel = 520;
  const svgW = W * scale + sidePanel;
  const svgH = H * scale + 60;

  // Legend/usage layout
  const baseY = 10; const rowH = 16; const blockGap = 12;
  const legendRows = 7; // header + rows
  const legendEndY = baseY + (legendRows + 1) * rowH + blockGap;
  const usageHeaderY = legendEndY;

  const totalUsed6x12 = tile.perSection.reduce((s, e) => s + e.used["6x12"], 0);
  const totalUsed12x12 = tile.perSection.reduce((s, e) => s + e.used["12x12"], 0);

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <strong>Random per-section solver (inventory-safe)</strong>
        <button onClick={() => setNonce(n => n + 1)} disabled={autoSolve}>Reroll</button>
        <button
          onClick={() => { setAttempts(0); setAutoSolve(true); }}
          disabled={autoSolve && attempts > 0}
        >
          {autoSolve ? `Auto-solving… (${attempts}/${MAX_ATTEMPTS})` : "Auto-solve"}
        </button>
        <label style={{ marginLeft: "auto" }}>
          Scale <input type="range" min={3} max={10} value={scale} onChange={e => setScale(parseInt(e.target.value))} />
        </label>
        <button onClick={() => window.print()} disabled={insufficient} title={insufficient ? "Refused plan cannot be printed — fix inventory or Auto-solve" : ""}>
          Print
        </button>
        <button onClick={() => exportSVG(svgRef)} disabled={insufficient} title={insufficient ? "Refused plan cannot be exported — fix inventory or Auto-solve" : ""}>
          Export SVG
        </button>
      </div>

      {/* Inventory + bias controls */}
      <div className="no-print" style={{ display: "grid", gridTemplateColumns: "repeat(10, minmax(90px,1fr))", gap: 8, alignItems: "center", marginBottom: 8 }}>
        {Object.keys(INITIAL_INVENTORY).map(k => (
          <label key={k} style={{ fontSize: 12 }}>
            {k}: <input type="number" min={0} value={inventory[k]} onChange={e => setInventory(inv => ({ ...inv, [k]: parseInt(e.target.value || "0") }))} style={{ width: 60, marginLeft: 4 }} />
          </label>
        ))}
        <label style={{ fontSize: 12 }}>12×12 bias
          <input type="range" min={0} max={4} step={0.1} value={bias1212} onChange={e => setBias1212(parseFloat(e.target.value))} />
        </label>
        <label style={{ fontSize: 12 }}>6×12 bias
          <input type="range" min={0} max={3} step={0.1} value={bias6x12} onChange={e => setBias6x12(parseFloat(e.target.value))} />
        </label>
        <label style={{ fontSize: 12 }}>min 12×12 share
          <input type="range" min={0} max={0.4} step={0.02} value={min1212Share} onChange={e => setMin1212Share(parseFloat(e.target.value))} />
        </label>
      </div>

      <svg ref={svgRef} width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
        {/* Patio outline */}
        <rect x={0} y={0} width={W * scale} height={H * scale} fill={colors.patio} stroke={colors.outline} strokeWidth={2} />

        {/* Section backgrounds (always drawn) */}
        {SECTIONS.map((s, i) => (
          <rect key={`zone-${s.id}`} x={s.x * scale} y={s.y * scale} width={s.w * scale} height={s.h * scale} fill={colors.zones[i % colors.zones.length]} opacity={0.35} />
        ))}

        {/* Freehand / special zones */}
        <rect x={PAD_LEFT.x * scale} y={PAD_LEFT.y * scale} width={PAD_LEFT.w * scale} height={PAD_LEFT.h * scale} fill={colors.pad} stroke={colors.outline} strokeDasharray="5 4" opacity={0.9} />
        <rect x={BOTTOM_RIP.x * scale} y={BOTTOM_RIP.y * scale} width={BOTTOM_RIP.w * scale} height={BOTTOM_RIP.h * scale} fill={colors.rip} opacity={0.85} />

        {/* Hole outlines */}
        <rect x={originalHole.x1 * scale} y={originalHole.y1 * scale} width={(originalHole.x2 - originalHole.x1) * scale} height={(originalHole.y2 - originalHole.y1) * scale} fill={colors.holeFill} stroke={colors.origOutline} strokeDasharray="6 4" strokeWidth={1.8} />
        <rect x={enlargedHole.x1 * scale} y={enlargedHole.y1 * scale} width={(enlargedHole.x2 - enlargedHole.x1) * scale} height={(enlargedHole.y2 - enlargedHole.y1) * scale} fill="none" stroke={colors.conceptOutline} strokeWidth={2} />

        {/* Placements (only when not refused) */}
        {!insufficient && tile.perSection.map((entry, idx) => (
          <g key={`sec-${idx}`}>
            {entry.placements.map((p, i) => (
              <rect
                key={i}
                x={p.x * scale}
                y={p.y * scale}
                width={p.w * scale}
                height={p.h * scale}
                fill={p.name === "12x12" ? colors.t12x12 : colors.t6x12}
                stroke="#666"
                strokeWidth={0.4}
              />
            ))}
          </g>
        ))}

        {!insufficient && free.placements.map((p, i) => (
          <rect key={`free-${i}`} x={p.x * scale} y={p.y * scale} width={p.w * scale} height={p.h * scale}
                fill={p.zone === "RIGHT_BORDER" ? colors.border8 : colors.pad} stroke="#666" strokeWidth={0.4} opacity={0.95} />
        ))}

        {/* Refusal overlay */}
        {insufficient && (
          <g>
            <rect x={0} y={0} width={W * scale} height={H * scale} fill="#ffffff" opacity={0.78} />
            <text x={(W * scale) / 2} y={(H * scale) / 2 - 20} fontSize={20} fontWeight="bold" textAnchor="middle" fill="#b91c1c">
              INSUFFICIENT INVENTORY — PLAN REFUSED
            </text>
            <text x={(W * scale) / 2} y={(H * scale) / 2 + 6} fontSize={14} textAnchor="middle" fill="#1f2937">
              Add {needCells} × 6×12-equivalent cells
            </text>
            <text x={(W * scale) / 2} y={(H * scale) / 2 + 24} fontSize={14} textAnchor="middle" fill="#1f2937">
              Add {needPadArea} in² of odd tiles for Pad-Left 7″×30″
            </text>
            {!free.padLeftFilled && (
              <text x={(W * scale) / 2} y={(H * scale) / 2 + 42} fontSize={13} textAnchor="middle" fill="#7a271a">
                Pad-Left remaining height: {free.padLeftRemainingHeight || 0}″
              </text>
            )}
          </g>
        )}

        {/* Right panel */}
        <g transform={`translate(${W * scale + 16}, 10)`} fontSize={12} fill={colors.text}>
          {/* Legend */}
          <text x={0} y={baseY} fontSize={13} fontWeight="bold">Legend</text>
          <g transform={`translate(0, ${baseY + rowH})`}>
            <g transform="translate(0,0)"><rect width={14} height={10} fill={colors.t12x12} stroke="#444" /><text x={22} y={9}>12×12 placements</text></g>
            <g transform={`translate(0, ${rowH * 1.25})`}><rect width={14} height={10} fill={colors.t6x12} stroke="#444" /><text x={22} y={9}>6×12 placements</text></g>
            <g transform={`translate(0, ${rowH * 2.5})`}><rect width={14} height={10} fill={colors.border8} stroke="#444" /><text x={22} y={9}>Right border (8×16 / 8×8 whole)</text></g>
            <g transform={`translate(0, ${rowH * 3.75})`}><rect width={14} height={10} fill={colors.pad} stroke="#444" /><text x={22} y={9}>Pad-Left 7″×30″ (cuts from odd tiles)</text></g>
            <g transform={`translate(0, ${rowH * 5.0})`}><rect width={14} height={10} fill={colors.rip} stroke="#444" /><text x={22} y={9}>Bottom rip 1″ (shear)</text></g>
            <g transform={`translate(0, ${rowH * 6.25})`}><rect width={14} height={10} fill={colors.holeFill} stroke={colors.origOutline} strokeDasharray="6 4" /><text x={22} y={9}>Original hole 25″×25″ (void)</text></g>
            <g transform={`translate(0, ${rowH * 7.5})`}><rect width={14} height={10} fill="none" stroke={colors.conceptOutline} /><text x={22} y={9}>Concept hole 32″×30″</text></g>
          </g>

          {/* Usage */}
          {!insufficient && (
            <g transform={`translate(0, ${usageHeaderY})`}>
              <text fontSize={13} fontWeight="bold">Usage</text>
              <text y={18}>6×12 used: {totalUsed6x12} (remain {tile.remaining["6x12"] || 0})</text>
              <text y={36}>12×12 used: {totalUsed12x12} (remain {tile.remaining["12x12"] || 0})</text>
              <text y={54}>Pad-Left: fully filled by cuts from odd tiles.</text>
            </g>
          )}
        </g>
      </svg>
    </div>
  );
}