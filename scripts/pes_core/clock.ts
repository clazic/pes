// UTC epoch milliseconds, per docs/plan/stage-1-db.md common rules (line 38).

export interface Clock {
  now_ms(): number;
}

export class SystemClock implements Clock {
  now_ms(): number {
    return Date.now();
  }
}

export class FakeClock implements Clock {
  #now_ms: number;

  constructor(start_ms: number) {
    if (!Number.isSafeInteger(start_ms) || start_ms < 0) {
      throw new TypeError("FakeClock start must be a non-negative safe integer");
    }
    this.#now_ms = start_ms;
  }

  now_ms(): number {
    return this.#now_ms;
  }

  advance(delta_ms: number): void {
    if (!Number.isSafeInteger(delta_ms) || delta_ms < 0) {
      throw new TypeError("FakeClock advance must be a non-negative safe integer");
    }
    this.#now_ms += delta_ms;
  }
}
