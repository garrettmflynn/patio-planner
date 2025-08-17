self.onmessage = (e) => {
    const {cmd, payload} = e.data || {};
    if (cmd !== 'solve') return;
    try {
      const {W,H,holes,tileTypes,uniqueByBoardSymmetry,balance,cap} = payload;
      const holesSet = new Set(holes);

      // ---- quick infeasibility check ----
      const pf = preflight(W,H, holesSet, tileTypes);
      if (!pf.ok) {
        self.postMessage({type:'infeasible', reasons: pf.reasons});
        return;
      }

      const result = balance && balance.noBalance
        ? solveFirst(W,H, holesSet, tileTypes, uniqueByBoardSymmetry)
        : solveBalanced(W,H, holesSet, tileTypes, uniqueByBoardSymmetry, balance, cap);

      if (!result.layout) {
        // Search exhausted with no solution
        self.postMessage({type:'infeasible', reasons: ['No exact layout found after search. Consider changing tile counts, enabling rotations, or removing/adjusting holes.']});
        return;
      }

      self.postMessage({type:'result', ...result});
    } catch (err) {
      self.postMessage({type:'error', message: String(err && err.message || err)});
    }
  };

  // ---------- helpers ----------
  function normShape(cells){
    let minx=Infinity,miny=Infinity;
    for(const [x,y] of cells){ if(x<minx)minx=x; if(y<miny)miny=y; }
    return cells.map(([x,y])=>[x-minx,y-miny]).sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
  }
  function rot90(c){ return c.map(([x,y])=>[-y,x]); }
  function reflX(c){ return c.map(([x,y])=>[-x,y]); }
  function orientations(base, rot=true, refl=false){
    const seen = new Set(); const push = s => {
      const n = normShape(s); const k = n.map(([x,y])=>x+","+y).join(";");
      if(!seen.has(k)) seen.add(k);
    };
    const cand=[base]; if(rot){ let s=base; for(let i=0;i<3;i++){ s=rot90(s); cand.push(s);} }
    for(const c of cand){ push(c); if(refl) push(reflX(c)); }
    return [...seen].map(k=>k.split(";").filter(Boolean).map(p=>p.split(",").map(Number)));
  }
  function boardCells(W,H,holes){ const out=[]; for(let y=0;y<H;y++) for(let x=0;x<W;x++){ const k=`${x},${y}`; if(!holes.has(k)) out.push([x,y]); } return out; }

  function boardSymTransforms(W,H){
  const r0=(x,y)=>[x,y];
  const fx=(x,y)=>[W-1-x,y];
  const fy=(x,y)=>[x,H-1-y];

  if (W === H) {
    const r1=(x,y)=>[y,W-1-x];
    const r2=(x,y)=>[W-1-x,H-1-y];
    const r3=(x,y)=>[H-1-y,x];
    const fd=(x,y)=>[y,x];
    const fo=(x,y)=>[W-1-y,H-1-x];
    return [r0,r1,r2,r3,fx,fy,fd,fo];
  }
  // rectangular board: identity + axial flips only
  return [r0, fx, fy];
}

  function precomputePlacements(W,H,boardSet,tiles){
    const placements=[]; const byCell=new Map();
    for(let ti=0;ti<tiles.length;ti++){
      const t=tiles[ti];
      for(const o of orientations(t.base,t.allowRot,t.allowReflect)){
        const maxx=Math.max(...o.map(([x])=>x)), maxy=Math.max(...o.map(([,y])=>y));
        for(let oy=0;oy<=H-1-maxy;oy++) for(let ox=0;ox<=W-1-maxx;ox++){
          const abs = o.map(([x,y])=>[x+ox,y+oy]);
          if(abs.every(([x,y])=>boardSet.has(`${x},${y}`))){
            const pid=placements.length; placements.push({ ti,cells:abs });
            for(const [x,y] of abs){ const k=`${x},${y}`; if(!byCell.has(k)) byCell.set(k,[]); byCell.get(k).push(pid); }
          }
        }
      }
    }
    return {placements, byCell};
  }
  function canonicalKey(layout, W,H, tiles, useSym, boardSet){
    const T = useSym ? boardSymTransforms(W,H) : [ (x,y)=>[x,y] ];
    let best=null;
    outer: for(const f of T){
      if(boardSet){
        const TB=new Set();
        for(const k of boardSet){ const [x,y]=k.split(",").map(Number); const [nx,ny]=f(x,y); TB.add(`${nx},${ny}`); }
        if(TB.size!==boardSet.size) continue;
        for(const k of boardSet) if(!TB.has(k)) continue outer;
      }
      const tPlac = layout.map(p=>({ti:p.ti, cells:p.cells.map(([x,y])=>f(x,y)).sort((a,b)=>a[1]-b[1]||a[0]-b[0])}));
      tPlac.sort((A,B)=>{
        const a=A.cells, b=B.cells, n=Math.min(a.length,b.length);
        for(let i=0;i<n;i++){ if(a[i][1]!==b[i][1]) return a[i][1]-b[i][1]; if(a[i][0]!==b[i][0]) return a[i][0]-b[i][0]; }
        return a.length-b.length || A.ti-B.ti;
      });
      const s = tPlac.map(p=>p.cells.map(([x,y])=>`${x},${y}`).join(";")).join("|");
      if(best===null || s<best) best=s;
    }
    return best;
  }

  // ----------------- PRE-FLIGHT: fast impossibility tests -----------------
  function preflight(W,H, holesSet, tiles){
    const reasons = [];
    const free = boardCells(W,H, holesSet);
    const N = free.length; // required cells to cover

    // tile areas & capacity
    const areas = tiles.map(t => t.base.length);
    let maxArea = 0, allEven = true, anyTile = false;
    for (let i=0;i<tiles.length;i++){
      const t = tiles[i];
      const cnt = (t.count==null) ? Infinity : t.count;
      if (cnt <= 0) continue;
      anyTile = true;
      maxArea += (cnt===Infinity ? Infinity : cnt * areas[i]);
      if (areas[i] % 2 !== 0) allEven = false;
    }
    if (!anyTile) reasons.push("No tiles available (all counts are 0).");
    if (maxArea !== Infinity && maxArea < N) {
      reasons.push(`Insufficient total tile area: need ${N}, have at most ${maxArea}.`);
    }

    // odd board vs even tiles
    if (N % 2 === 1 && allEven) {
      reasons.push("Board has an odd number of unit cells, but all tiles cover an even number of cells.");
    }

    // gcd-of-areas divisibility (consider tiles with positive/∞ stock)
    const usableAreas = [];
    for (let i=0;i<tiles.length;i++){
      const t = tiles[i];
      const cnt = (t.count==null) ? Infinity : t.count;
      if (cnt > 0) usableAreas.push(areas[i]);
    }
    if (usableAreas.length){
      const g = gcdMany(usableAreas);
      if (N % g !== 0) {
        reasons.push(`Board free area (${N}) is not a multiple of gcd of tile areas (${g}).`);
      }
    }

    // checkerboard parity: if all tiles parity-neutral but board has B/W imbalance → impossible
    const bw = countBoardBW(free);
    const tilesBWNeutral = tiles.every(t => tileBWDelta(t.base) === 0);
    if (tilesBWNeutral && bw.delta !== 0) {
      reasons.push(`Parity mismatch: board has black/white imbalance of ${bw.delta}, but all tiles are parity-neutral (rectangles with at least one even side).`);
    }

    return {ok: reasons.length===0, reasons};
  }
  function gcd(a,b){ return b ? gcd(b, a%b) : Math.abs(a); }
  function gcdMany(arr){ return arr.reduce((g,n)=>gcd(g,n)); }

  function countBoardBW(cells){
    let black=0, white=0;
    for (const [x,y] of cells) ((x+y)&1) ? black++ : white++;
    return {black, white, delta: Math.abs(black-white)};
  }
  function tileBWDelta(shape){
    // abs(#black - #white) for the shape in its canonical position
    let black=0, white=0;
    for (const [x,y] of shape) ((x+y)&1) ? black++ : white++;
    return Math.abs(black-white);
  }

  // ----------------- Solver (same as before) -----------------
  function enumerateTilings(
  W, H, holes, tiles,
  uniqueByBoardSymmetry = true,
  capSolutions = 1,
  progressCb
){
  const b = boardCells(W, H, holes);
  const totalCells = b.length;
  const boardSet = new Set(b.map(([x,y])=>`${x},${y}`));
  const { placements, byCell } = precomputePlacements(W, H, boardSet, tiles);

  // capacity check (kept for safety)
  const allFinite = tiles.every(t => t.count != null);
  if (allFinite) {
    const maxArea = tiles.reduce((a,t)=>a + t.count * t.base.length, 0);
    if (maxArea < b.length) throw new Error("Not enough stone area to cover the patio.");
  }

  // state
  const allCells = b.map(([x,y])=>`${x},${y}`);
  const covered = new Set();
  const usedCounts = Array(tiles.length).fill(0);
  const usedPlacements = [];
  const seen = new Set();
  const solutions = [];
  let coveredCount = 0;
  let nodes = 0;

  // helpers
  function place(pid){
    const {ti, cells} = placements[pid];
    usedCounts[ti]++;
    for (const [x,y] of cells) covered.add(`${x},${y}`);
    usedPlacements.push(pid);
    coveredCount += cells.length;
  }
  function unplace(pid){
    const {ti, cells} = placements[pid];
    usedCounts[ti]--;
    for (const [x,y] of cells) covered.delete(`${x},${y}`);
    usedPlacements.pop();
    coveredCount -= cells.length;
  }
  function validPidsForCell(k){
    const list = byCell.get(k) || [];
    const out = [];
    for (const pid of list){
      const {ti, cells} = placements[pid];
      const limit = tiles[ti].count ?? Infinity;
      if (usedCounts[ti] >= limit) continue;
      let ok = true;
      for (const [x,y] of cells){
        if (covered.has(`${x},${y}`)){ ok = false; break; }
      }
      if (ok) out.push(pid);
    }
    return out;
  }
  function chooseCellAndPids(){
    let bestCell = null, bestPids = null, bestLen = 1e9;
    for (const k of allCells){
      if (covered.has(k)) continue;
      const cands = validPidsForCell(k);
      const len = cands.length;
      if (len === 0) return [k, []];     // immediate dead end
      if (len < bestLen){
        bestLen = len; bestCell = k; bestPids = cands;
        if (bestLen === 1) break;        // forced move — good enough
      }
    }
    return [bestCell, bestPids || []];
  }

  // recursive only at branches; forced moves are looped
  function rec(){
    if (solutions.length >= capSolutions) return;

    const trail = []; // forced moves we’ll undo before returning

    while (true){
      if (coveredCount === totalCells){
        // found a full layout
        const layout = usedPlacements.map(pid => ({
          ti: placements[pid].ti,
          cells: placements[pid].cells
        }));
        const key = canonicalKey(layout, W, H, tiles, uniqueByBoardSymmetry, boardSet);
        if (!seen.has(key)){ seen.add(key); solutions.push(layout); }
        break; // unwind forced moves and return to explore alternatives
      }

      const [cellK, pids] = chooseCellAndPids();
      if (pids.length === 0){
        // dead end under current forced moves
        while (trail.length) unplace(trail.pop());
        return;
      }

      if (pids.length === 1){
        // forced — apply without recursion
        place(pids[0]);
        trail.push(pids[0]);
        if (++nodes % 5000 === 0 && progressCb) progressCb({nodes, found: solutions.length});
        continue; // keep compressing
      }

      // branching point: recurse for each choice
      // small shuffle for variety
      for (let i=pids.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [pids[i],pids[j]]=[pids[j],pids[i]]; }
      for (const pid of pids){
        place(pid);
        if (++nodes % 5000 === 0 && progressCb) progressCb({nodes, found: solutions.length});
        rec();
        if (solutions.length >= capSolutions){
          while (trail.length) unplace(trail.pop());
          return;
        }
        unplace(pid);
      }
      break; // after exploring this branch set, unwind forced moves and return
    }

    while (trail.length) unplace(trail.pop());
  }

  rec();
  return { solutions, boardSet };
}

  // ---- balance & result selection (unchanged) ----
  function makeGrid(W,H, layout) {
    const g = Array.from({length:H}, _=> Array(W).fill(-1));
    layout.forEach((p, idx) => { for (const [x,y] of p.cells) g[y][x] = idx; });
    return g;
  }
  function mixError(countsByTile, desiredMix) {
    const names = Object.keys(countsByTile);
    if (names.length <= 1) return 0;
    const counts = names.map(n => countsByTile[n]);
    if (!desiredMix) {
      const mean = counts.reduce((a,b)=>a+b,0) / counts.length;
      const variance = counts.reduce((s,c)=> s + (c-mean)*(c-mean), 0) / counts.length;
      return variance / (mean*mean + 1e-6);
    } else {
      let sum = 0; const props = {};
      for (const [k,v] of Object.entries(desiredMix)) { props[k]=v; sum+=v; }
      if (sum <= 0) return 0;
      for (const k of Object.keys(props)) props[k] /= sum;
      const total = counts.reduce((a,b)=>a+b,0) || 1;
      let err = 0;
      for (const n of names) {
        const actual = (countsByTile[n] || 0) / total;
        const target = props[n] || 0;
        err += (actual - target) * (actual - target);
      }
      return err;
    }
  }
  function seamPenalty(grid) {
    const H = grid.length, W = grid[0].length;
    let cost = 0;
    for (let y=0; y<H; y++) {
      let run = 0;
      for (let x=1; x<W; x++) {
        if (grid[y][x] !== -1 && grid[y][x-1] !== -1 && grid[y][x] !== grid[y][x-1]) run++;
        else { if (run > 1) cost += run * 0.2; run = 0; }
      }
      if (run > 1) cost += run * 0.2;
    }
    for (let x=0; x<W; x++) {
      let run = 0;
      for (let y=1; y<H; y++) {
        if (grid[y][x] !== -1 && grid[y-1][x] !== -1 && grid[y][x] !== grid[y-1][x]) run++;
        else { if (run > 1) cost += run * 0.2; run = 0; }
      }
      if (run > 1) cost += run * 0.2;
    }
    return cost;
  }
  function crossJointCount(grid) {
    const H = grid.length, W = grid[0].length;
    let crosses = 0;
    for (let y=1; y<H; y++) for (let x=1; x<W; x++) {
      const a = grid[y-1][x-1], b = grid[y-1][x], c = grid[y][x-1], d = grid[y][x];
      const set = new Set([a,b,c,d]);
      if (a>=0 && b>=0 && c>=0 && d>=0 && set.size >= 3) crosses += 1;
    }
    return crosses * 0.1;
  }
  function balanceScore(W,H, tiles, layout, cfg) {
    const {weights} = cfg;
    const grid = makeGrid(W,H, layout);
    const countsByTile = {};
    let horiz = 0, vert = 0;
    for (const p of layout) {
      const name = tiles[p.ti].name;
      countsByTile[name] = (countsByTile[name] || 0) + 1;
      const xs = p.cells.map(([x])=>x), ys = p.cells.map(([,y])=>y);
      const w = Math.max(...xs) - Math.min(...xs) + 1;
      const h = Math.max(...ys) - Math.min(...ys) + 1;
      if (w !== h) { if (w > h) horiz++; else vert++; }
    }
    const mixErr = mixError(countsByTile, cfg.desiredMix);
    let orientErr = 0;
    if (horiz+vert > 0) orientErr = Math.abs(horiz - vert) / (horiz + vert);
    const seam = seamPenalty(grid);
    const crosses = crossJointCount(grid);
    return (
      weights.tileCountVariance * mixErr +
      weights.orientationBalance * orientErr +
      weights.seamPenalty * seam +
      weights.crossJoints * crosses
    );
  }
  function selectBestBalanced(W,H, tiles, layouts, cfg) {
    let best = null, bestScore = Infinity;
    for (const L of layouts) {
      const s = balanceScore(W,H, tiles, L, cfg);
      if (s < bestScore) { bestScore = s; best = L; }
    }
    return {best, bestScore};
  }

  // ---------- Exact-Cover (Algorithm X) for "first valid" ----------

// Build rows = placements, columns = board cells
// colIndex: "x,y" -> 0..(N-1)
function buildExactCoverData(W, H, holesSet, tiles) {
  // free cells in fixed order
  const freeCells = [];
  const colIndex = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = `${x},${y}`;
    if (!holesSet.has(k)) {
      colIndex.set(k, freeCells.length);
      freeCells.push([x, y]);
    }
  }
  const boardSet = new Set(freeCells.map(([x,y]) => `${x},${y}`));

  // reuse your placement generator
  const { placements } = precomputePlacements(W, H, boardSet, tiles);

  // rows -> list of column indices that row covers
  // rowsTi -> tile type index per row
  const rows = [];
  const rowsTi = [];
  for (let pid = 0; pid < placements.length; pid++) {
    const { ti, cells } = placements[pid];
    const cols = [];
    let ok = true;
    for (const [x, y] of cells) {
      const k = `${x},${y}`;
      const ci = colIndex.get(k);
      if (ci == null) { ok = false; break; }
      cols.push(ci);
    }
    if (!ok) continue;
    rows.push({ pid, cols });
    rowsTi.push(ti);
  }

  // column -> rows that hit it
  const colToRows = Array.from({ length: freeCells.length }, () => []);
  for (let r = 0; r < rows.length; r++) {
    for (const c of rows[r].cols) colToRows[c].push(r);
  }

  return { freeCells, colIndex, rows, rowsTi, colToRows, placements };
}

// Pick the uncovered column with the fewest candidate rows (MRV)
function chooseColumn(coveredCols, colToRows, rows, usedRow, usedCounts, tiles) {
  let best = -1, bestLen = 1e9;
  for (let c = 0; c < colToRows.length; c++) {
    if (coveredCols[c]) continue;
    let cnt = 0;
    // Count only rows still usable under counts (cheap prefilter)
    for (const r of colToRows[c]) {
      if (usedRow[r]) continue;
      const ti = rows[r]._ti;
      const cap = tiles[ti].count ?? Infinity;
      if (usedCounts[ti] >= cap) continue;
      cnt++;
    }
    if (cnt === 0) return c;      // immediate dead-end detection
    if (cnt < bestLen) { bestLen = cnt; best = c; if (cnt === 1) break; }
  }
  return best;
}

function solveFirstExactCover(W, H, holesSet, tiles, uniqueByBoardSymmetry) {
  const { freeCells, rows, rowsTi, colToRows, placements } =
    buildExactCoverData(W, H, holesSet, tiles);

  // annotate rows with ti for speed
  for (let i = 0; i < rows.length; i++) rows[i]._ti = rowsTi[i];

  const coveredCols = new Array(colToRows.length).fill(false);
  const usedRow = new Array(rows.length).fill(false);
  const usedCounts = Array(tiles.length).fill(0);
  const solutionRows = [];
  let nodes = 0;

  // quick capacity check (kept)
  {
    const N = freeCells.length;
    const maxArea = tiles.reduce((a, t) => a + (t.count == null ? Infinity : t.count * t.base.length), 0);
    if (maxArea !== Infinity && maxArea < N) return { found: 0, layout: null, score: null };
  }

  // Cover/uncover helpers
  function coverColumn(c, bannedRowsStack) {
    coveredCols[c] = true;
    // When we pick a row, we will ban every row that overlaps any of that row's columns.
    // Here we do nothing; we ban at the row level in chooseRow().
  }
  function uncoverColumn(c) {
    coveredCols[c] = false;
  }

  function chooseRow(r, bannedRowsStack) {
    usedRow[r] = true;
    const ti = rows[r]._ti;
    usedCounts[ti]++;

    // ban every row that intersects any column of r
    const bannedNow = [];
    for (const c of rows[r].cols) {
      for (const r2 of colToRows[c]) {
        if (!usedRow[r2]) {
          usedRow[r2] = true; // mark as banned
          bannedNow.push(r2);
        }
      }
    }
    bannedRowsStack.push(bannedNow);

    // cover columns of r
    for (const c of rows[r].cols) coverColumn(c, bannedRowsStack);
  }

  function unchooseRow(r, bannedRowsStack) {
    // uncover columns of r
    for (const c of rows[r].cols) uncoverColumn(c);

    // unban rows from last push
    const bannedNow = bannedRowsStack.pop();
    for (const r2 of bannedNow) usedRow[r2] = false;

    usedRow[r] = false;
    const ti = rows[r]._ti;
    usedCounts[ti]--;
  }

  function allCovered() {
    for (let c = 0; c < coveredCols.length; c++) if (!coveredCols[c]) return false;
    return true;
  }

  const bannedRowsStack = [];

  function dfs() {
    if (++nodes % 5000 === 0) self.postMessage({ type: 'progress', nodes, found: 0 });

    if (allCovered()) return true;

    const c = chooseColumn(coveredCols, colToRows, rows, usedRow, usedCounts, tiles);
    if (c === -1) return false;            // should not happen
    if (colToRows[c].length === 0) return false;

    // Gather usable candidate rows
    let candidates = [];
    for (const r of colToRows[c]) {
      if (usedRow[r]) continue;
      const ti = rows[r]._ti;
      const cap = tiles[ti].count ?? Infinity;
      if (usedCounts[ti] >= cap) continue;

      // fast check: every column of r must be currently uncovered
      let ok = true;
      for (const cc of rows[r].cols) { if (coveredCols[cc]) { ok = false; break; } }
      if (!ok) continue;
      candidates.push(r);
    }
    if (candidates.length === 0) return false;

    // small shuffle for variety
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    for (const r of candidates) {
      chooseRow(r, bannedRowsStack);
      solutionRows.push(r);
      if (dfs()) return true;
      solutionRows.pop();
      unchooseRow(r, bannedRowsStack);
    }
    return false;
  }

  const ok = dfs();
  if (!ok) return { found: 0, layout: null, score: null };

  // Build layout from chosen rows (placements)
  const layout = solutionRows.map(r => {
    const { pid } = rows[r];
    return { ti: placements[pid].ti, cells: placements[pid].cells };
  });

  // Optional uniqueness normalization (not really needed for "first")
  if (uniqueByBoardSymmetry) {
    // no-op here since we only return 1; keep layout as is
  }

  return { found: 1, layout, score: null };
}

function solveFirst(W, H, holesSet, tiles, uniqueByBoardSymmetry) {
  return solveFirstExactCover(W, H, holesSet, tiles, uniqueByBoardSymmetry);
}

//   function solveFirst(W,H, holesSet, tiles, uniqueByBoardSymmetry) {
//     const {solutions} = enumerateTilings(W,H, holesSet, tiles, uniqueByBoardSymmetry, 1, (p)=>{
//       if (p.found % 10 === 0) self.postMessage({type:'progress', ...p});
//     });
//     if (!solutions.length) return {found:0, layout:null, score:null};
//     return {found: 1, layout: solutions[0], score: null};
//   }

  function solveBalanced(W,H, holesSet, tiles, uniqueByBoardSymmetry, balance, cap) {
    const {solutions} = enumerateTilings(W,H, holesSet, tiles, uniqueByBoardSymmetry, balance.maxSolutionsToEvaluate || cap || 1000, (p) => {
      if (p.found % 10 === 0) self.postMessage({type:'progress', ...p});
    });
    if (!solutions.length) return {found:0, layout:null, score:null};
    const {best, bestScore} = selectBestBalanced(W,H, tiles, solutions, balance);
    return {found: solutions.length, layout: best, score: bestScore};
  }