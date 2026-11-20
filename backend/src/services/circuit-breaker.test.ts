import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, type CircuitBreakerSnapshot, type CircuitBreakerStorage } from "./circuit-breaker.js";

function memoryStorage(initial: CircuitBreakerSnapshot | null = null): {
  storage: CircuitBreakerStorage;
  snapshots: CircuitBreakerSnapshot[];
} {
  let current = initial;
  const snapshots: CircuitBreakerSnapshot[] = [];
  return {
    snapshots,
    storage: {
      async load() {
        return current;
      },
      async save(snapshot) {
        current = { ...snapshot };
        snapshots.push({ ...snapshot });
      },
    },
  };
}

test("CircuitBreaker starts in CLOSED state", () => {
  const cb = new CircuitBreaker();
  assert.equal(cb.getState(), "CLOSED");
});

test("CircuitBreaker executes function successfully in CLOSED state", async () => {
  const cb = new CircuitBreaker();
  const result = await cb.execute(async () => "success");
  assert.equal(result, "success");
  assert.equal(cb.getState(), "CLOSED");
});

test("CircuitBreaker transitions to OPEN after threshold consecutive failures", async () => {
  const cb = new CircuitBreaker(3, 99999);
  let failures = 0;

  for (let i = 0; i < 3; i++) {
    try {
      await cb.execute(async () => {
        failures++;
        throw new Error("fail");
      });
      assert.fail("Expected execute to throw");
    } catch {
      // Expected
    }
  }

  assert.equal(failures, 3);
  assert.equal(cb.getState(), "OPEN");
});

test("CircuitBreaker resets failure count on success", async () => {
  const cb = new CircuitBreaker(5, 99999);

  // Two failures
  for (let i = 0; i < 2; i++) {
    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {
      // Expected
    }
  }

  // One success resets counter
  await cb.execute(async () => "ok");

  // Two more failures should NOT open (counter reset)
  for (let i = 0; i < 2; i++) {
    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {
      // Expected
    }
  }

  assert.equal(cb.getState(), "CLOSED");
});

test("CircuitBreaker throws when OPEN and timeout not expired", async () => {
  const cb = new CircuitBreaker(1, 99999);

  try {
    await cb.execute(async () => {
      throw new Error("fail");
    });
  } catch {
    // Expected
  }

  assert.equal(cb.getState(), "OPEN");

  await assert.rejects(
    cb.execute(async () => "should not run"),
    /Circuit breaker is OPEN/,
  );
});

test("CircuitBreaker transitions to HALF_OPEN after resetTimeout expires", async () => {
  const cb = new CircuitBreaker(1, 99999);

  // Open the breaker
  try {
    await cb.execute(async () => {
      throw new Error("fail");
    });
  } catch {
    // Expected
  }
  assert.equal(cb.getState(), "OPEN");

  // Deterministically expire the reset timeout by backdating nextAttempt
  // instead of relying on a real wall-clock wait that can flake under CI load.
  (cb as unknown as { nextAttempt: number }).nextAttempt = Date.now() - 1;

  // Should transition to HALF_OPEN and attempt execution
  const result = await cb.execute(async () => "recovered");
  assert.equal(result, "recovered");
  assert.equal(cb.getState(), "CLOSED");
});

test("CircuitBreaker HALF_OPEN success transitions to CLOSED", async () => {
  const cb = new CircuitBreaker(1, 99999);

  // Open the breaker
  try {
    await cb.execute(async () => {
      throw new Error("fail");
    });
  } catch {
    // Expected
  }
  assert.equal(cb.getState(), "OPEN");

  // Deterministically expire the reset timeout by backdating nextAttempt
  // instead of relying on a real wall-clock wait that can flake under CI load.
  (cb as unknown as { nextAttempt: number }).nextAttempt = Date.now() - 1;

  // Success in HALF_OPEN should go to CLOSED
  await cb.execute(async () => "ok");
  assert.equal(cb.getState(), "CLOSED");

  // Subsequent calls should work normally
  await cb.execute(async () => "also ok");
  assert.equal(cb.getState(), "CLOSED");
});

test("CircuitBreaker HALF_OPEN failure transitions back to OPEN", async () => {
  const cb = new CircuitBreaker(1, 99999);

  // Open the breaker
  try {
    await cb.execute(async () => {
      throw new Error("fail");
    });
  } catch {
    // Expected
  }
  assert.equal(cb.getState(), "OPEN");

  // Force HALF_OPEN by overriding nextAttempt
  (cb as unknown as { nextAttempt: number }).nextAttempt = 0;

  // Fail in HALF_OPEN
  try {
    await cb.execute(async () => {
      throw new Error("fail again");
    });
  } catch {
    // Expected
  }

  assert.equal(cb.getState(), "OPEN");
});

test("CircuitBreaker respects custom failure threshold and timeout", async () => {
  const THRESHOLD = 2;
  const TIMEOUT = 5000;
  const cb = new CircuitBreaker(THRESHOLD, TIMEOUT);

  for (let i = 0; i < THRESHOLD; i++) {
    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {
      // Expected
    }
  }

  assert.equal(cb.getState(), "OPEN");
  assert.equal(
    (cb as unknown as { failureThreshold: number }).failureThreshold,
    THRESHOLD,
  );
  assert.equal(
    (cb as unknown as { resetTimeout: number }).resetTimeout,
    TIMEOUT,
  );
});

test("CircuitBreaker does not open before threshold is reached", async () => {
  const cb = new CircuitBreaker(5, 99999);

  for (let i = 0; i < 4; i++) {
    try {
      await cb.execute(async () => {
        throw new Error(`fail ${i}`);
      });
    } catch {
      // Expected
    }
  }

  assert.equal(cb.getState(), "CLOSED");
});

test("CircuitBreaker re-throws the original error from the function", async () => {
  const cb = new CircuitBreaker();
  const originalError = new Error("custom error message");

  await assert.rejects(
    cb.execute(async () => {
      throw originalError;
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error).message, "custom error message");
      return true;
    },
  );
});

test("CircuitBreaker persists OPEN state after threshold failures", async () => {
  const { storage, snapshots } = memoryStorage();
  const cb = new CircuitBreaker(1, 99999, storage);

  await assert.rejects(
    cb.execute(async () => {
      throw new Error("upstream down");
    }),
  );

  assert.equal(cb.getState(), "OPEN");
  assert.equal(snapshots.at(-1)?.state, "OPEN");
  assert.equal(snapshots.at(-1)?.failureCount, 1);
  assert.ok((snapshots.at(-1)?.nextAttempt ?? 0) > Date.now());
});

test("CircuitBreaker restores persisted OPEN state and blocks calls before reset", async () => {
  const { storage } = memoryStorage({
    state: "OPEN",
    failureCount: 5,
    nextAttempt: Date.now() + 99999,
  });
  const cb = new CircuitBreaker(5, 30000, storage);
  let executed = false;

  await assert.rejects(
    cb.execute(async () => {
      executed = true;
      return "should not run";
    }),
    /Circuit breaker is OPEN/,
  );

  assert.equal(executed, false);
  assert.equal(cb.getState(), "OPEN");
});
