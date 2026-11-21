# sokoban-solver

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-22-green.svg)](https://nodejs.org)
[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, built for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121).

## How it works

Every level the competition draws is a hallway with 1–4 rooms off it, and a box pushed out
of its room can never come back — so a level splits into independent per-room problems whose
push-optima add up. Each room is solved on its own in push space (a state is the boxes'
squares plus the player's reachable region):

- **A\* over pushes**, with an admissible min-cost-assignment heuristic: push distances from
  each box to each goal, computed over floor alone, matched box-to-goal at minimum total cost.
- **Dead-square pruning**: reverse pull-reachability from the goals marks every square a box
  can still be pushed home from; a push onto any other square is pruned.
- **Frozen 2×2 pruning**: a box pushed into a 2×2 block of walls and boxes holding a box off
  its goal is pruned.
- **Fallbacks**: if A\* exhausts its fixed expansion budget, plain push BFS runs, then greedy
  best-first — so a hard room still yields a valid answer instead of an empty one.

Budgets are counted in expansions, never in wall-clock time, and there is no randomness, so
two runs on one set write byte-identical outputs. One run answers the whole 5-instance set
well inside the 60-second wall budget.

## Run

```sh
node main.ts            # reads /input/<id>/level.txt, writes /output/<id>/solution.txt
```

Node 22 (type stripping, erasable TypeScript only — the file is plain JavaScript). No
dependencies, no network, no files outside `/input`, `/output`, `/bot`, `/tmp`.

## Layout

- `main.ts` — the solver (entry point)
- `LICENSE` — MIT
