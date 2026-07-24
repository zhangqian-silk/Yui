const DEFAULT_WINDOW_MS = 100;

export type MailboxBatchHandler<Key> = (
  keys: readonly Key[]
) => void | Promise<void>;

export type MailboxSchedulerOptions<TimerHandle = ReturnType<typeof setTimeout>> = Readonly<{
  windowMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  onError?: (error: unknown) => void;
}>;

/**
 * Coalesces dirty mailbox keys over a fixed window. The first signal starts
 * the window; later signals never extend it. A signal received during a batch
 * belongs to a later batch, and batches are never processed concurrently.
 */
export class MailboxScheduler<
  Key,
  TimerHandle = ReturnType<typeof setTimeout>
> {
  readonly #windowMs: number;
  readonly #setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  readonly #clearTimer: (timer: TimerHandle) => void;
  readonly #onError: (error: unknown) => void;
  readonly #pendingKeys = new Set<Key>();
  #timer: TimerHandle | undefined;
  #current: Promise<void> | undefined;
  #drainRequested = false;
  #stopped = false;

  constructor(
    readonly processBatch: MailboxBatchHandler<Key>,
    options: MailboxSchedulerOptions<TimerHandle> = {}
  ) {
    this.#windowMs = nonNegativeFinite(options.windowMs ?? DEFAULT_WINDOW_MS);
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => (
      setTimeout(callback, delayMs) as TimerHandle
    ));
    this.#clearTimer = options.clearTimer ?? ((timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    });
    this.#onError = options.onError ?? (() => {});
  }

  signal(key: Key): void {
    if (this.#stopped) return;
    this.#pendingKeys.add(key);
    this.schedule();
  }

  schedule(): void {
    if (
      this.#stopped
      || this.#pendingKeys.size === 0
      || this.#timer !== undefined
    ) {
      return;
    }

    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      if (this.#current !== undefined) {
        this.#drainRequested = true;
        return;
      }
      void this.drain().catch(this.#onError);
    }, this.#windowMs);
  }

  drain(): Promise<void> {
    if (this.#stopped) return Promise.resolve();

    this.#cancelTimer();
    if (this.#current !== undefined) {
      this.#drainRequested = true;
      return this.#current;
    }
    if (this.#pendingKeys.size === 0) return Promise.resolve();

    // Defer invoking the callback until #current is installed. This closes the
    // small reentrancy window where a synchronous callback could call drain()
    // before the scheduler knew a drain was already active.
    const running = Promise.resolve().then(() => this.#drainDueBatches());
    this.#current = running;
    void running.finally(() => {
      if (this.#current !== running) return;
      this.#current = undefined;
      if (this.#stopped || this.#pendingKeys.size === 0) return;
      if (this.#drainRequested) {
        this.#drainRequested = false;
        void this.drain().catch(this.#onError);
      } else {
        this.schedule();
      }
    }).catch(() => {});
    return running;
  }

  stop(): void {
    this.#stopped = true;
    this.#cancelTimer();
    this.#pendingKeys.clear();
    this.#drainRequested = false;
  }

  async #drainDueBatches(): Promise<void> {
    do {
      this.#drainRequested = false;
      const keys = [...this.#pendingKeys];
      this.#pendingKeys.clear();
      if (keys.length > 0) await this.processBatch(keys);
    } while (
      !this.#stopped
      && this.#drainRequested
      && this.#pendingKeys.size > 0
    );
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }
}

function nonNegativeFinite(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Mailbox scheduler window must be a non-negative finite number.");
  }
  return value;
}
