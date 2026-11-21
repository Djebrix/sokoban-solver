// sokoban-solver: a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// Strategy: every level this competition draws is a hallway with 1-4 rooms off it, and a box
// pushed out of its room can never come back, so the level splits into independent per-room
// problems whose push-optima add up. Each room is solved on its own in push space (a state is
// the boxes' squares plus the player's reachable region), with A* over pushes, an admissible
// min-cost-assignment heuristic (push distances to goals, ignoring other boxes), dead-square
// pruning (reverse pull-reachability from the goals) and frozen 2x2-block pruning. A* falls
// back to plain push BFS, then to greedy best-first, each under a fixed expansion budget, so
// the answer is a pure function of the input: no clock, no randomness, no environment reads.
//
// One run answers the whole set (i001..i005) in at most 60s wall on 1 CPU; budgets are counted
// in expansions, never in seconds, so two runs write byte-identical outputs.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed work budgets (expansions), per room. A* normally solves a room in far fewer; the
// fallbacks exist so a hard room still yields a valid answer instead of an empty one.
const ASTAR_BUDGET = 200_000;
const BFS_BUDGET = 500_000;
const GREEDY_BUDGET = 200_000;

// Directions: [dx, dy, step letter, push letter]. Fixed order everywhere: deterministic ties.
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** Parse XSB text into a level: width, height, walls (1 = wall), goals, boxes, player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Live squares: every square a box can stand on and still be pushed onto some goal. Computed by
 * reverse pulls from the goals: a square y is live when some push from y lands on a live square
 * and the player can stand on the far side (y - d) to make it.
 */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Walking distances from one square over floor alone (walls block, boxes ignored). */
function walkDistances(level, from) {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p] + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * Split the level into rooms: cut the hallway row's dead squares (a box there reaches no goal)
 * out of the floor, and each connected part left that holds boxes is a room. Returns null when
 * the level is no set of rooms (a box in the hallway, a goal cut off, boxes != goals in a part).
 */
function roomsOf(level) {
  const { w, h, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const comp = new Int32Array(w * h).fill(-1);
  const rooms = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || cut[s] || comp[s] >= 0) continue;
    const squares = [s];
    comp[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (q >= 0 && q < w * h && !wall[q] && !cut[q] && comp[q] < 0) {
          comp[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (comp[b] < 0) return null;
    rooms[comp[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (comp[g] < 0) return null;
    rooms[comp[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters
 * (u first, then d, l, r on ties). Throws when `to` is unreachable.
 */
function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/**
 * Push-space search over one (sub-)level: states are the boxes' squares plus the player's
 * reachable region (named by its lowest square). mode is 'astar' (f = pushes + heuristic),
 * 'bfs' (f = pushes, FIFO) or 'greedy' (f = heuristic). Returns {pushes, moves, endPlayer}
 * or null when the expansion budget runs out (or the level has no solution).
 *
 * Pruning, none of which removes a solvable state: a pushed box must land on a live square,
 * and must not sit in a frozen 2x2 block of walls and boxes holding a box off its goal.
 * A better route to a known state rewires that state's parent chain and requeues it, so the
 * reconstructed path always matches the state's best push count.
 */
function solvePush(sub, mode, maxExpansions) {
  const { w, wall, goals } = sub;
  const size = wall.length;
  const nB = sub.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(sub);
  if (sub.boxes.some((b) => !live[b])) return null;
  const solved = (boxes) => boxes.every((b) => goal[b]);
  if (solved(sub.boxes)) return { pushes: 0, moves: '', endPlayer: sub.player };

  // Push distance from every square to each goal, over floor alone: the heuristic's costs.
  const distToGoal = goals.map((g) => walkDistances(sub, g));
  // All assignments of boxes to goals, as permutations of goal indexes (nB <= 5 in a room).
  const perms = [];
  if (nB <= 5) {
    const idx = goals.map((_, i) => i);
    const gen = (a, k) => {
      if (k === 1) {
        perms.push(a.slice());
        return;
      }
      for (let i = 0; i < k; i++) {
        gen(a, k - 1);
        const j = k % 2 === 1 ? 0 : i;
        [a[j], a[k - 1]] = [a[k - 1], a[j]];
      }
    };
    gen(idx, idx.length);
  }
  // Admissible estimate: min-cost assignment of boxes to goals by push distance; with more
  // than 5 boxes, the sum of each box's nearest goal (still a lower bound on pushes).
  const heuristic = (boxes) => {
    if (perms.length > 0) {
      let best = Infinity;
      for (const p of perms) {
        let sum = 0;
        for (let i = 0; i < nB; i++) {
          const d = distToGoal[p[i]][boxes[i]];
          if (d < 0) {
            sum = Infinity;
            break;
          }
          sum += d;
        }
        if (sum < best) best = sum;
      }
      return best;
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let gi = 0; gi < goals.length; gi++) {
        const d = distToGoal[gi][b];
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  // State keys: numeric while size ** (nB + 1) stays exact, string otherwise.
  const numericKey = Math.pow(size, nB + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (boxes, low) => {
    if (numericKey) {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    }
    return low + ':' + boxes.join(',');
  };

  // Reachability scratch: two stamp-marked flood fills, so the expansion's region and a
  // generated state's region never overwrite each other.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let seenStamp = 0;
  let markStamp = 0;
  // Lowest square of the region reachable from `from` with `occupied` in the way, marking
  // `arr` with `stamp`.
  const regionLow = (occupied, from, arr, stamp) => {
    let low = from;
    let n = 0;
    stack[n++] = from;
    arr[from] = stamp;
    while (n > 0) {
      const p = stack[--n];
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
        if (wall[q] === 0 && occupied[q] === 0 && arr[q] !== stamp) {
          arr[q] = stamp;
          stack[n++] = q;
        }
      }
    }
    return low;
  };

  // Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a
  // box among them off its goal.
  const frozenBlock = (occupied, t) => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
    }
    return false;
  };

  // Binary heap on [f, tie, counter, state, g-at-push]: f first, deeper (higher g) first on
  // ties in astar/greedy, insertion order last, so every pop is deterministic. A heap entry
  // whose g-at-push no longer matches the state's best g is stale and skipped.
  const heap = [];
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };

  const occupied = new Uint8Array(size);
  for (const b of sub.boxes) occupied[b] = 1;
  const startLow = regionLow(occupied, sub.player, seen, ++seenStamp);
  for (const b of sub.boxes) occupied[b] = 0;

  const sBoxes = [sub.boxes.slice()];
  const sPlayer = [sub.player];
  const sParent = [-1];
  const sFrom = [-1]; // square the pushed box left
  const sTo = [-1]; // square the pushed box landed on
  const sDir = [-1]; // direction index of the push
  const sG = [0]; // pushes to reach this state
  const indexOf = new Map([[keyOf(sub.boxes, startLow), 0]]);
  let counter = 0;
  const h0 = heuristic(sub.boxes);
  if (h0 === Infinity) return null;
  heapPush([mode === 'bfs' ? 0 : h0, 0, counter++, 0, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.length > 0 && expanded < maxExpansions) {
    const [, , , s, gPush] = heapPop();
    // Stale heap entry: a better route to this state was found since it was pushed.
    if (gPush !== sG[s]) continue;
    const g = sG[s];
    const boxes = sBoxes[s];
    if (solved(boxes)) {
      found = s;
      break;
    }
    expanded++;
    for (const b of boxes) occupied[b] = 1;
    regionLow(occupied, sPlayer[s], seen, ++seenStamp);
    const here = seenStamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di];
        const d = dy * w + dx;
        const t = b + d;
        // The player must reach the square behind the box; the landing square must be open
        // floor, unoccupied, and live (a box that can still reach a goal).
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(occupied, t);
        let next = null;
        let key = -1;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          h = heuristic(next);
          if (h !== Infinity) {
            const low = regionLow(occupied, b, mark, ++markStamp);
            key = keyOf(next, low);
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || key < 0) continue;
        const g2 = g + 1;
        const f = mode === 'astar' ? g2 + h : mode === 'greedy' ? h : g2;
        const tie = mode === 'bfs' ? 0 : -g2;
        const existing = indexOf.get(key);
        if (existing !== undefined) {
          // A better route to a known state: rewire its parent chain and requeue it.
          if (sG[existing] <= g2) continue;
          sG[existing] = g2;
          sParent[existing] = s;
          sFrom[existing] = b;
          sTo[existing] = t;
          sDir[existing] = di;
          sPlayer[existing] = b;
          heapPush([f, tie, counter++, existing, g2]);
          continue;
        }
        indexOf.set(key, sBoxes.length);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(di);
        sG.push(g2);
        heapPush([f, tie, counter++, sBoxes.length - 1, g2]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Reconstruct: the pushes in order, each preceded by the walk to its push square.
  const path = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = sub.player;
  let boxes = sub.boxes.slice();
  for (const s of path) {
    const from = sFrom[s];
    const to = sTo[s];
    const [dx, dy, , pushLetter] = DIRS[sDir[s]];
    const d = dy * w + dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(sub, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += pushLetter.toLowerCase();
    player = from;
    boxes = sBoxes[s].slice();
  }
  return { pushes: path.length, moves, endPlayer: player };
}

/** Solve one room's sub-level, trying A*, then BFS, then greedy, each on a fixed budget. */
function solveRoom(sub) {
  return (
    solvePush(sub, 'astar', ASTAR_BUDGET) ??
    solvePush(sub, 'bfs', BFS_BUDGET) ??
    solvePush(sub, 'greedy', GREEDY_BUDGET)
  );
}

/** Solve a whole level: room by room, or whole-level search when it is no set of rooms. */
function solveLevel(text) {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    const r =
      solvePush(level, 'astar', ASTAR_BUDGET) ??
      solvePush(level, 'bfs', BFS_BUDGET) ??
      solvePush(level, 'greedy', GREEDY_BUDGET);
    return r ? r.moves : '';
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    // The other rooms' boxes stand as walls (on their goals once their room is done).
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const r = solveRoom(sub);
    if (r === null) return ''; // unsolved room: a valid empty answer, 0 points for the level
    moves += r.moves;
    player = r.endPlayer;
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
