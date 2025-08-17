import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Patio Tiling — Interactive Planner (manual place + autofill + persistence)
 * -------------------------------------------------------------------------
 * - Manual placement: click to place the selected block; drag to move; click a placed block to select
 * - Keyboard: 1–7 select tile type, R / [ / ] rotate, Del/Backspace delete, Ctrl/⌘+Z undo, Ctrl/⌘+Y redo
 * - Snap: 1", 2", 4", 6" (hold Alt while placing to bypass snap for that click)
 * - Persist: auto-saves placements/scale/snap to localStorage; Export/Import JSON (placements only)
 * - Autofill: fills remaining area around manual placements with fixed inventory (largest-first, inventory-safe)
 * - Constraints: cannot overlap, cannot cover the original 25×25 hole, must lie inside 104×157
 * - Inventory: **fixed** (not editable interactively). Remaining counts update as you place tiles.
 */

// -------------------- Geometry (inches) --------------------
const W = 104; // patio width
const H = 157; // patio height
const ORIGINAL_HOLE = { x: 104 - 25, y: 36, w: 25, h: 25 }; // 25×25, flush right @ y=36

// -------------------- Fixed inventory --------------------
const FIXED_INVENTORY = Object.freeze({
  "6x12": 159,
  "8x16": 7,
  "12x12": 8,
  "8x8": 15,
  "16x16": 6,
  "16x11": 2,
  "16x12": 6,
});

// -------------------- Tile catalog --------------------
const TILE_TYPES = [
  { key: "6x12",  w: 12, h: 6,  color: "#8ecae6" },
  { key: "12x12", w: 12, h: 12, color: "#cdb4db" },
  { key: "8x16",  w: 16, h: 8,  color: "#ffd166" },
  { key: "8x8",   w: 8,  h: 8,  color: "#fec5bb" },
  { key: "16x16", w: 16, h: 16, color: "#90be6d" },
  { key: "16x11", w: 16, h: 11, color: "#f4978e" },
  { key: "16x12", w: 16, h: 12, color: "#a5d8ff" },
];
const TYPE_INDEX = Object.fromEntries(TILE_TYPES.map((t,i)=>[t.key,i]));

// -------------------- Utilities --------------------
const LS_KEY = "patio-planner-v4";
function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function rectsOverlap(a,b){ return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
function insidePatio(r){ return r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H; }
function intersectsHole(r){ return rectsOverlap(r, ORIGINAL_HOLE); }
function snapValue(v, grid){ return Math.round(v / grid) * grid; }
function rotateSize(w,h){ return { w: h, h: w }; }
function uid(){ return Math.random().toString(36).slice(2,9); }

// Check if a rectangle can be placed with current placements
function canPlace(rect, placements, ignoreId){
  if (!insidePatio(rect) || intersectsHole(rect)) return false;
  for (const p of placements){ if (ignoreId && p.id===ignoreId) continue; if (rectsOverlap(rect,p)) return false; }
  return true;
}

// -------------------- Persistence --------------------
function savePlan(state){ try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {} }
function loadPlan(){ try { const raw = localStorage.getItem(LS_KEY); if (!raw) return null; return JSON.parse(raw); } catch { return null; } }

// -------------------- Autofill (largest-first greedy) --------------------
/**
 * Simple greedy autofill:
 *  - Scans at 1" steps
 *  - Tries tiles from largest area to smallest (both orientations)
 *  - Respects fixed inventory **minus** what you've already placed
 */
function autofill(placements, remainingInv){
  const result = []; // new placements only
  const occupied = [...placements];
  const types = [...TILE_TYPES].sort((a,b)=> (b.w*b.h) - (a.w*a.h));

  function tryPlaceAt(x,y,type,rot){
    const size = rot ? rotateSize(type.w,type.h) : { w:type.w, h:type.h };
    const rect = { x, y, w:size.w, h:size.h };
    if ((remainingInv[type.key]||0) <= 0) return false;
    if (!canPlace(rect, occupied)) return false;
    const id = uid();
    const tile = { id, key:type.key, x, y, w:rect.w, h:rect.h, rot:!!rot, color:type.color, auto:true };
    occupied.push(tile); result.push(tile); remainingInv[type.key]--; return true;
  }

  for (let y=0; y<=H-1; y+=1){
    for (let x=0; x<=W-1; x+=1){
      // skip if already occupied
      if (occupied.some(p => x>=p.x && x<p.x+p.w && y>=p.y && y<p.y+p.h)) continue;
      // skip if inside hole
      if (x>=ORIGINAL_HOLE.x && x<ORIGINAL_HOLE.x+ORIGINAL_HOLE.w && y>=ORIGINAL_HOLE.y && y<ORIGINAL_HOLE.y+ORIGINAL_HOLE.h) continue;
      for (const t of types){
        if (tryPlaceAt(x,y,t,false)) break;
        if (tryPlaceAt(x,y,t,true)) break;
      }
    }
  }
  return { added: result, updatedRemaining: remainingInv };
}

// -------------------- Main Component --------------------
export default function PatioPlannerInteractive(){
  const [scale, setScale] = useState(4); // px per inch
  const [snap, setSnap] = useState(1); // snap inches
  const [placements, setPlacements] = useState([]);
  const [selectedKey, setSelectedKey] = useState("6x12");
  const [selectedId, setSelectedId] = useState(null);
  const [drag, setDrag] = useState(null); // {id, dx, dy}

  // Undo/redo stacks
  const [undoStack, setUndo] = useState([]);
  const [redoStack, setRedo] = useState([]);

  // Load persisted plan (placements, scale, snap only)
  useEffect(()=>{
    const saved = loadPlan();
    if (saved){
      setScale(saved.scale ?? 4);
      setSnap(saved.snap ?? 1);
      setPlacements(saved.placements ?? []);
    }
  },[]);

  // Persist on change
  useEffect(()=>{ savePlan({ scale, snap, placements }); }, [scale,snap,placements]);

  // Remaining inventory = fixed - used
  const usedCounts = useMemo(()=>{
    const counts = Object.fromEntries(Object.keys(FIXED_INVENTORY).map(k=>[k,0]));
    for (const p of placements){ counts[p.key] = (counts[p.key]||0) + 1; }
    return counts;
  },[placements]);
  const remaining = useMemo(()=>{
    const r = {...FIXED_INVENTORY};
    for (const k of Object.keys(r)) r[k] = Math.max(0, r[k] - (usedCounts[k]||0));
    return r;
  },[usedCounts]);

  // --- New: Overflow (outside-grid) accounting ---
  const PATIO_RECT = { x:0, y:0, w:W, h:H };
  function overflowInfo(tile){
    const x1 = tile.x, y1 = tile.y, x2 = tile.x + tile.w, y2 = tile.y + tile.h;
    const left   = Math.max(0, -x1);
    const right  = Math.max(0, x2 - W);
    const top    = Math.max(0, -y1);
    const bottom = Math.max(0, y2 - H);
    if (!left && !right && !top && !bottom) return null;
    const insideW = Math.max(0, Math.min(x2, W) - Math.max(x1, 0));
    const insideH = Math.max(0, Math.min(y2, H) - Math.max(y1, 0));
    const area = left*tile.h + right*tile.h + top*insideW + bottom*insideW;
    return { left, right, top, bottom, area, insideW, insideH };
  }
  const overflowList = useMemo(()=>{
    const items = [];
    for (const p of placements){ const ov = overflowInfo(p); if (ov){ items.push({ id:p.id, key:p.key, ...ov }); } }
    return items;
  },[placements]);
  const totalTrimArea = useMemo(()=> overflowList.reduce((a,i)=>a + i.area, 0), [overflowList]);

  // Place at mouse (allow partially outside, still forbid hole & overlaps)
  const svgRef = useRef(null);
  function placeAt(clientX, clientY, altSnap=false){
    const svg = svgRef.current; if (!svg) return;
    const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
    const ctm = svg.getScreenCTM(); if (!ctm) return; const loc = pt.matrixTransform(ctm.inverse());
    let x = loc.x/scale, y = loc.y/scale;
    const type = TILE_TYPES[TYPE_INDEX[selectedKey]];
    const doSnap = altSnap ? 1 : snap;
    x = snapValue(x, doSnap); y = snapValue(y, doSnap);
    const rect = { x, y, w: type.w, h: type.h };
    // inventory check
    if ((remaining[selectedKey]||0) <= 0) return; // out of stock
    // forbid covering the original hole, and forbid overlap with other tiles (even outside)
    if (intersectsHole(rect)) return;
    for (const p of placements){ if (rectsOverlap(rect, p)) return; }
    const p = { id: uid(), key: selectedKey, x, y, w: type.w, h: type.h, rot: false, color: type.color };
    pushHistory(); setPlacements(prev=>[...prev, p]); setSelectedId(p.id);
  }

  // History
  function pushHistory(){ setUndo(u=>[...u, { placements: JSON.stringify(placements) }]); setRedo([]); }
  function undo(){ const last = undoStack[undoStack.length-1]; if (!last) return; setUndo(u=>u.slice(0,-1)); setRedo(r=>[...r,{ placements: JSON.stringify(placements) }]); setPlacements(JSON.parse(last.placements)); setSelectedId(null); }
  function redo(){ const last = redoStack[redoStack.length-1]; if (!last) return; setRedo(r=>r.slice(0,-1)); setUndo(u=>[...u,{ placements: JSON.stringify(placements) }]); setPlacements(JSON.parse(last.placements)); setSelectedId(null); }

  // Drag to move (allow outside, still block overlaps/hole)
  function onMouseDown(e){
    const svg = svgRef.current; if (!svg) return;
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const ctm = svg.getScreenCTM(); if (!ctm) return; const loc = pt.matrixTransform(ctm.inverse());
    const x = loc.x/scale, y = loc.y/scale;
    const hit = [...placements].reverse().find(p => x>=p.x && x<=p.x+p.w && y>=p.y && y<=p.y+p.h);
    if (hit){ setSelectedId(hit.id); setDrag({ id: hit.id, dx: x - hit.x, dy: y - hit.y }); }
    else { placeAt(e.clientX, e.clientY, e.altKey); }
  }
  function onMouseMove(e){ if (!drag) return; const svg = svgRef.current; const pt = svg.createSVGPoint(); pt.x=e.clientX; pt.y=e.clientY; const ctm = svg.getScreenCTM(); if (!ctm) return; const loc = pt.matrixTransform(ctm.inverse()); let x=loc.x/scale - drag.dx; let y=loc.y/scale - drag.dy; x = snapValue(x, snap); y = snapValue(y, snap); setPlacements(prev=>prev.map(p=> p.id===drag.id? { ...p, x, y }: p)); }
  function onMouseUp(){ if (!drag) return; const p = placements.find(t=>t.id===drag.id); if (p){ const rect = { x:p.x, y:p.y, w:p.w, h:p.h }; if (intersectsHole(rect) || placements.some(q=> q.id!==p.id && rectsOverlap(rect,q))){ undo(); } else { pushHistory(); } } setDrag(null); }

  // Rotate selected (allow outside)
  function rotateSelected(){
    const sel = placements.find(p=>p.id===selectedId); if (!sel) return;
    const type = TILE_TYPES[TYPE_INDEX[sel.key]];
    const newRot = !sel.rot; const size = newRot? rotateSize(type.w,type.h): { w:type.w, h:type.h };
    const x = snapValue(sel.x, snap), y = snapValue(sel.y, snap);
    const rect = { x, y, w:size.w, h:size.h };
    if (intersectsHole(rect) || placements.some(q=> q.id!==sel.id && rectsOverlap(rect,q))) return;
    pushHistory(); setPlacements(prev=> prev.map(p=> p.id===sel.id? { ...p, x, y, w:size.w, h:size.h, rot:newRot }: p));
  }

  // Delete selected
  function deleteSelected(){ if (!selectedId) return; pushHistory(); setPlacements(prev=> prev.filter(p=>p.id!==selectedId)); setSelectedId(null); }

  // Autofill action (uses remaining inventory derived from FIXED_INVENTORY - used)
  function doAutofill(){
    const invCopy = {...remaining};
    const { added } = autofill(placements, invCopy);
    if (added.length>0){ pushHistory(); setPlacements(prev=>[...prev, ...added]); }
  }

  // Keyboard shortcuts
  useEffect(()=>{
    function onKey(e){
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key>='1' && e.key<='7'){ const i = parseInt(e.key,10)-1; const t = TILE_TYPES[i]; if (t){ setSelectedKey(t.key); } }
      if (e.key==='r' || e.key==='R' || e.key===']' || e.key==='['){ rotateSelected(); }
      if (e.key==='Delete' || e.key==='Backspace'){ deleteSelected(); }
      if ((e.key==='z'||e.key==='Z') && (e.ctrlKey||e.metaKey)){ e.preventDefault(); undo(); }
      if ((e.key==='y'||(e.shiftKey&&(e.key==='Z'||e.key==='z'))) && (e.ctrlKey||e.metaKey)){ e.preventDefault(); redo(); }
    }
    window.addEventListener('keydown', onKey); return ()=>window.removeEventListener('keydown', onKey);
  },[selectedId, placements, undoStack, redoStack, snap]);

  // Export / Import (placements only)
  function exportJSON(){ const data = { scale, snap, placements }; const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='patio-plan.json'; a.click(); URL.revokeObjectURL(url); }
  function importJSON(ev){ const file = ev.target.files?.[0]; if (!file) return; const r = new FileReader(); r.onload = () => { try { const data = JSON.parse(r.result); pushHistory(); setScale(data.scale??4); setSnap(data.snap??1); setPlacements(data.placements??[]); } catch { alert('Invalid file'); } }; r.readAsText(file); ev.target.value=''; }

  const s = scale;

  // Hatch pattern for outside cuts
  const hatch = (
    <defs>
      <pattern id="outsideHatch" patternUnits="userSpaceOnUse" width={8} height={8} patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="8" stroke="#cc0000" strokeWidth="2" />
      </pattern>
    </defs>
  );

  return (
    <div style={{ padding: 12, fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system' }}>
      <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8, flexWrap:'wrap' }}>
        <strong>Interactive Patio Planner</strong>
        <button onClick={()=>{ pushHistory(); setPlacements([]); }}>Clear</button>
        <button onClick={undo} disabled={!undoStack.length}>Undo</button>
        <button onClick={redo} disabled={!redoStack.length}>Redo</button>
        <button onClick={doAutofill} title="Fill remaining area using fixed inventory (largest-first)">Autofill</button>
        <label style={{ marginLeft:'auto' }}>Scale <input type="range" min={3} max={10} value={scale} onChange={e=>setScale(parseInt(e.target.value))} /></label>
        <label>Snap
          <select value={snap} onChange={e=>setSnap(parseFloat(e.target.value))}>
            <option value={1}>1"</option>
            <option value={2}>2"</option>
            <option value={4}>4"</option>
            <option value={6}>6"</option>
          </select>
        </label>
        <button onClick={()=>window.print()}>Print</button>
        <button onClick={exportJSON}>Export JSON</button>
        <label style={{ border:'1px solid #ccc', padding:'2px 6px', borderRadius:6, cursor:'pointer' }}>
          Import JSON <input type="file" accept="application/json" style={{ display:'none' }} onChange={importJSON} />
        </label>
      </div>

      {/* Inventory summary (read-only) */}
      <div className="no-print" style={{ display:'grid', gridTemplateColumns:'repeat(7, minmax(120px,1fr))', gap:8, alignItems:'center', marginBottom:8 }}>
        {TILE_TYPES.map(t=> (
          <div key={t.key} style={{ fontSize:12, display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ width:14, height:10, background:t.color, border:'1px solid #444', display:'inline-block' }} />
            {t.key}: <b style={{ marginLeft:4 }}>{(FIXED_INVENTORY[t.key]??0)}</b>
            <span style={{ color:'#666', marginLeft:8 }}>remain: {remaining[t.key]??0}</span>
          </div>
        ))}
      </div>

      {/* Tile picker & help */}
      <div style={{ display:'flex', gap:12, alignItems:'center', marginBottom:8, flexWrap:'wrap' }}>
        <div>Selected: <b>{selectedKey}</b> (press 1–7 to switch)</div>
        <div style={{ color:'#555' }}>Rotate: <kbd>R</kbd>/<kbd>[</kbd>/<kbd>]</kbd> · Delete: <kbd>Del</kbd>/<kbd>Backspace</kbd> · Undo: <kbd>Ctrl/⌘+Z</kbd> · Redo: <kbd>Ctrl/⌘+Y</kbd> or <kbd>Shift+Z</kbd> · Hold <kbd>Alt</kbd> to bypass snap on placement</div>
      </div>

      <svg ref={svgRef} width={W*s + 320} height={H*s + 40} viewBox={`0 0 ${W*s + 320} ${H*s + 40}`} style={{ background:'#fff' }}
           onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}>
        {hatch}
        {/* Border */}
        <rect x={0} y={0} width={W*s} height={H*s} fill="#f9fafb" stroke="#333" strokeWidth={2} />

        {/* Grid (6" coarse + 1" fine) */}
        <g opacity={0.25}>
          {Array.from({length: Math.floor(W/6)+1}, (_,i)=> (
            <line key={`g6x-${i}`} x1={i*6*s} y1={0} x2={i*6*s} y2={H*s} stroke="#6b7280" strokeWidth={i%2?0.6:0.8} />
          ))}
          {Array.from({length: Math.floor(H/6)+1}, (_,i)=> (
            <line key={`g6y-${i}`} x1={0} y1={i*6*s} x2={W*s} y2={i*6*s} stroke="#6b7280" strokeWidth={i%2?0.6:0.8} />
          ))}
        </g>
        <g opacity={0.12}>
          {Array.from({length: W+1}, (_,i)=> (
            <line key={`g1x-${i}`} x1={i*s} y1={0} x2={i*s} y2={H*s} stroke="#94a3b8" strokeWidth={0.4} />
          ))}
          {Array.from({length: H+1}, (_,i)=> (
            <line key={`g1y-${i}`} x1={0} y1={i*s} x2={W*s} y2={i*s} stroke="#94a3b8" strokeWidth={0.4} />
          ))}
        </g>

        {/* Original hole */}
        <rect x={ORIGINAL_HOLE.x*s} y={ORIGINAL_HOLE.y*s} width={ORIGINAL_HOLE.w*s} height={ORIGINAL_HOLE.h*s}
              fill="#ffffff" stroke="#0066cc" strokeDasharray="6 4" strokeWidth={1.5} />
        <text x={(ORIGINAL_HOLE.x+1)*s} y={(ORIGINAL_HOLE.y-1)*s} fontSize={12} fill="#0066cc">Original 25×25 Hole</text>

        {/* Placements with outside-cut indication */}
        {placements.map(p=> {
          const ov = overflowInfo(p);
          return (
            <g key={p.id}>
              {/* inside (clipped to patio) */}
              <clipPath id={`clip-${p.id}`}><rect x={0} y={0} width={W*s} height={H*s} /></clipPath>
              <rect x={p.x*s} y={p.y*s} width={p.w*s} height={p.h*s} fill={p.color} stroke={p.id===selectedId?"#111":"#555"} strokeWidth={p.id===selectedId?2:0.8} clipPath={`url(#clip-${p.id})`} />
              {/* outside bands */}
              {ov && ov.left>0 && (
                <rect x={p.x*s} y={p.y*s} width={ov.left*s} height={p.h*s} fill="url(#outsideHatch)" opacity={0.75} />
              )}
              {ov && ov.right>0 && (
                <rect x={(Math.max(p.x, W))*s} y={p.y*s} width={ov.right*s} height={p.h*s} fill="url(#outsideHatch)" opacity={0.75} />
              )}
              {ov && ov.top>0 && (
                <rect x={(Math.max(p.x,0))*s} y={p.y*s} width={Math.max(0, Math.min(p.x+p.w, W) - Math.max(p.x,0))*s} height={ov.top*s} fill="url(#outsideHatch)" opacity={0.75} />
              )}
              {ov && ov.bottom>0 && (
                <rect x={(Math.max(p.x,0))*s} y={(Math.max(p.y, H))*s} width={Math.max(0, Math.min(p.x+p.w, W) - Math.max(p.x,0))*s} height={ov.bottom*s} fill="url(#outsideHatch)" opacity={0.75} />
              )}
              {/* label */}
              <text x={(p.x+0.3)*s} y={(p.y+0.8)*s} fontSize={10} fill="#111">{p.key}{p.auto?"*":""}{ov?" (CUT)":""}</text>
            </g>
          );
        })}

        {/* Side panel */}
        <g transform={`translate(${W*s + 16}, 16)`} fontSize={12} fill="#111">
          <text fontSize={14} fontWeight="bold">Legend & Tools</text>
          {TILE_TYPES.map((t,i)=> (
            <g key={t.key} transform={`translate(0, ${20 + i*18})`}>
              <rect width={14} height={10} fill={t.color} stroke="#444" />
              <text x={22} y={9}>{i+1}. {t.key} — remain {remaining[t.key]??0}</text>
            </g>
          ))}
          <g transform={`translate(0, ${20 + TILE_TYPES.length*18 + 12})`}>
            <rect width={14} height={10} fill="url(#outsideHatch)" stroke="#cc0000" />
            <text x={22} y={9}>Outside grid → needs cut</text>
          </g>

          {/* Cuts summary */}
          <g transform={`translate(0, ${20 + TILE_TYPES.length*18 + 40})`}>
            <text fontSize={13} fontWeight="bold">Cuts Required (outside)</text>
            {overflowList.length===0 && <text y={18}>None</text>}
            {overflowList.slice(0,18).map((i,idx)=> (
              <text key={i.id} y={18 + idx*16}>
                • {i.key}: L{i.left}\" R{i.right}\" T{i.top}\" B{i.bottom}\" (area {i.area}\"²)
              </text>
            ))}
            {overflowList.length>18 && (
              <text y={18 + 18*16}>… +{overflowList.length-18} more</text>
            )}
            <text y={18 + Math.min(overflowList.length,18)*16 + 12} fontWeight="bold">Total trim area: {Math.round(totalTrimArea)}\"²</text>
          </g>
        </g>
      </svg>

      {/* Tile picker buttons */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:8 }}>
        {TILE_TYPES.map(t=> (
          <button key={t.key} onClick={()=>setSelectedKey(t.key)} style={{ border: selectedKey===t.key? '2px solid #111':'1px solid #ccc', background:'#fff', padding:6, borderRadius:8, display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ width:18, height:12, background:t.color, border:'1px solid #444', display:'inline-block' }} />
            {t.key}
          </button>
        ))}
        <button onClick={()=>rotateSelected()}>Rotate (R)</button>
        <button onClick={deleteSelected} disabled={!selectedId}>Delete</button>
      </div>
    </div>
  );
}
