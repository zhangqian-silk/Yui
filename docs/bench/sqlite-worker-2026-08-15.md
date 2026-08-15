# SQLite WAL + Worker control-plane benchmark (task-21 work-item-7)

Date: 2026-08-15
Command: `node --expose-gc scripts/bench/controller-sqlite-worker.mjs --real-home /data00/home/zhangqian.0326/.yui --rounds 2 --agents 25`

## Configuration

- **Backend**: SQLite WAL + persistence Worker Thread + resource-inventory Worker Thread
- **Env**: `YUI_STORE_BACKEND=sqlite`, `YUI_STORE_WORKER=1`
- **Agents**: 25 (20 claude, 5 codex)
- **Rounds**: 2
- **Load duration**: 4.2 s (baseline: 104 s)
- **state.json source**: 38.1 MB (real Home copy, read-only)
- **yui.db after migration**: 37.0 MB
- **Migration time**: 1400.49 ms

## Control-socket command latency (`controller.identity`)

| Metric | SQLite + Worker | File-store baseline | Improvement |
|--------|----------------|--------------------:|-------------|
| samples | 11320 | 122 | |
| mean | 0.37 ms | 909.73 ms | 2456.5x faster (100.0% lower) |
| p50 | 0.21 ms | — | |
| p95 | 0.33 ms | — | |
| **p99** | **3.44 ms** | **7454.10 ms** | **2166.2x faster (100.0% lower)** |
| max | 121.51 ms | 78643.67 ms | 647.2x faster (99.8% lower) |
| timeouts | 0 | — | |

## Main-thread event-loop delay

| Metric | SQLite + Worker | File-store baseline | Improvement |
|--------|----------------|--------------------:|-------------|
| mean | 12.79 ms | — | |
| p50 | 0.00 ms | — | |
| p99 | 0.00 ms | 0.0 ms | |
| **max** | **129.89 ms** | **71739.40 ms** | **552.3x faster (99.8% lower)** |

## setImmediate drift probe (cross-check)

| Metric | SQLite + Worker | File-store baseline |
|--------|----------------|--------------------:|
| p50 | 0.00 ms | 0.01 ms |
| p99 | 0.07 ms | 5.38 ms |
| **max** | **120.71 ms** | **71691.15 ms** |

## Resource usage

| Metric | SQLite + Worker | File-store baseline |
|--------|----------------|--------------------:|
| RSS before | 264 MB | 548 MB |
| RSS after | 245 MB | 814 MB |
| **RSS max** | **264 MB** | **1373 MB** |
| CPU user | 3889 ms | 112665 ms |
| CPU system | 1347 ms | 21806 ms |
| CPU total | 5236 ms | 134471 ms |

## Load accounting

- progress events: 50
- lifecycle events: 25
- prompt-accepted events: 5
- task messages: 2
- scheduler signals: 2
- event apply errors: 0
- inbox files remaining: 0

## Interpretation

The file-store baseline blocks the main event loop for the full
read-parse-validate-mutate-stringify-write cycle (~3.5 s per transaction under
load, up to 71.7 s of event-loop stall). The SQLite + Worker control plane
moves all db-touching observer folds into the persistence Worker Thread; the
main thread only handles socket I/O, command validation, arbitration, and
lightweight scheduling. The event-loop delay and socket latency improvements
above quantify that decoupling.

## Safety

- The real Yui Home (`/data00/home/zhangqian.0326/.yui`) was opened **read-only**
  (readFileSync / statSync). All writes ran against a temp Home copy.
- The temp Home was migrated to SQLite and removed after the benchmark.
- The real Home was not migrated, opened with a store, or modified.
