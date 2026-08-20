export type KeyedWorkItem<Key> = Readonly<{
  key: Key;
  /** Completes this lease. Every item must be completed exactly once. */
  done: () => void;
}>;

type QueuedKeyState = {
  phase: "queued";
};

type ProcessingKeyState = {
  phase: "processing";
  dirty: boolean;
  token: symbol;
};

type KeyState = QueuedKeyState | ProcessingKeyState;
type TakeWaiter<Key> = (item: KeyedWorkItem<Key> | undefined) => void;

type Completion = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

/**
 * A FIFO work queue that coalesces signals by key.
 *
 * At most one item for a key can be processing. Signals received while that
 * key is processing mark it dirty, causing exactly one replay at the FIFO tail
 * after the current item is done. Different keys can be leased concurrently by
 * multiple consumers.
 *
 * shutdown() is graceful: it stops accepting signals but preserves all work
 * accepted before shutdown, including dirty replays. abortPending() instead
 * drops queued work and dirty replays while allowing leased items to finish.
 * Consumers must complete every leased item. drain() only waits for an idle
 * queue; it does not close the queue or process work itself.
 */
export class KeyedWorkQueue<Key> {
  readonly #states = new Map<Key, KeyState>();
  readonly #ready: Key[] = [];
  readonly #takeWaiters: TakeWaiter<Key>[] = [];
  readonly #drainWaiters: Array<() => void> = [];
  #readyHead = 0;
  #takeWaiterHead = 0;
  #closed = false;
  #aborted = false;
  #closeCompletion: Completion | undefined;

  /**
   * Adds or coalesces a key. Returns false after either stop mode has started.
   */
  signal(key: Key): boolean {
    if (this.#closed) return false;

    const state = this.#states.get(key);
    if (state === undefined) {
      this.#states.set(key, { phase: "queued" });
      this.#ready.push(key);
      this.#dispatchReadyWork();
      return true;
    }

    if (state.phase === "processing") state.dirty = true;
    return true;
  }

  /**
   * Leases the next ready key. It returns undefined after graceful shutdown
   * has drained, or immediately after pending work has been aborted.
   */
  take(): Promise<KeyedWorkItem<Key> | undefined> {
    if (this.#aborted) return Promise.resolve(undefined);
    if (this.#hasReadyWork()) {
      return Promise.resolve(this.#leaseReadyWork());
    }
    if (this.#closed && this.#states.size === 0) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.#takeWaiters.push(resolve);
    });
  }

  /**
   * Resolves the next time no key is queued or processing. Later signals may
   * make the queue non-idle again unless shutdown() has already started.
   */
  drain(): Promise<void> {
    if (this.#states.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  /**
   * Stops accepting signals and resolves after all previously accepted work
   * has been completed. Calling shutdown repeatedly returns the same promise.
   */
  shutdown(): Promise<void> {
    const stopped = this.#beginClose();
    this.#settleIdleWaiters();
    return stopped;
  }

  /**
   * Stops accepting signals, drops queued keys and dirty replays, and resolves
   * after already leased items are completed. Pending and later take() calls
   * receive undefined. Repeated calls are idempotent.
   */
  abortPending(): Promise<void> {
    const stopped = this.#beginClose();
    if (this.#aborted) return stopped;
    this.#aborted = true;

    for (const [key, state] of this.#states) {
      if (state.phase === "queued") {
        this.#states.delete(key);
      } else {
        state.dirty = false;
      }
    }
    this.#ready.length = 0;
    this.#readyHead = 0;
    this.#resolveTakeWaiters();
    this.#settleIdleWaiters();
    return stopped;
  }

  #hasReadyWork(): boolean {
    return this.#readyHead < this.#ready.length;
  }

  #hasTakeWaiter(): boolean {
    return this.#takeWaiterHead < this.#takeWaiters.length;
  }

  #leaseReadyWork(): KeyedWorkItem<Key> {
    const key = this.#ready[this.#readyHead++];
    if (!this.#hasReadyWork()) {
      this.#ready.length = 0;
      this.#readyHead = 0;
    }

    const state = this.#states.get(key);
    if (state?.phase !== "queued") {
      throw new Error("Keyed work queue invariant failed: ready key was not queued.");
    }

    const token = Symbol("keyed-work-item");
    this.#states.set(key, { phase: "processing", dirty: false, token });
    let completed = false;
    return {
      key,
      done: () => {
        if (completed) throw new Error("Keyed work item was already completed.");
        completed = true;
        this.#complete(key, token);
      }
    };
  }

  #complete(key: Key, token: symbol): void {
    const state = this.#states.get(key);
    if (state?.phase !== "processing" || state.token !== token) {
      throw new Error("Keyed work queue invariant failed: completed lease is not active.");
    }

    if (state.dirty && !this.#aborted) {
      this.#states.set(key, { phase: "queued" });
      this.#ready.push(key);
      this.#dispatchReadyWork();
      return;
    }

    this.#states.delete(key);
    this.#settleIdleWaiters();
  }

  #dispatchReadyWork(): void {
    while (this.#hasReadyWork() && this.#hasTakeWaiter()) {
      const resolve = this.#takeWaiters[this.#takeWaiterHead++];
      const item = this.#leaseReadyWork();
      resolve(item);
    }
    if (!this.#hasTakeWaiter()) {
      this.#takeWaiters.length = 0;
      this.#takeWaiterHead = 0;
    }
  }

  #settleIdleWaiters(): void {
    if (this.#states.size !== 0) return;

    const drains = this.#drainWaiters.splice(0);
    for (const resolve of drains) resolve();

    if (!this.#closed) return;
    this.#resolveTakeWaiters();
    this.#closeCompletion?.resolve();
  }

  #beginClose(): Promise<void> {
    if (this.#closeCompletion === undefined) {
      this.#closeCompletion = completion();
      this.#closed = true;
    }
    return this.#closeCompletion.promise;
  }

  #resolveTakeWaiters(): void {
    while (this.#hasTakeWaiter()) {
      this.#takeWaiters[this.#takeWaiterHead++]!(undefined);
    }
    this.#takeWaiters.length = 0;
    this.#takeWaiterHead = 0;
  }
}

function completion(): Completion {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
