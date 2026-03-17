import { FailoverConnection } from "./rpc";

describe("FailoverConnection", () => {
  it("requires at least one endpoint", () => {
    expect(() => new FailoverConnection([])).toThrow(
      "At least one RPC endpoint",
    );
  });

  it("accepts string endpoints", () => {
    const fc = new FailoverConnection(["http://rpc1.test"]);
    expect(fc.status()).toHaveLength(1);
    expect(fc.status()[0].url).toBe("http://rpc1.test");
    expect(fc.status()[0].healthy).toBe(true);
  });

  it("accepts RpcEndpointConfig objects with weights", () => {
    const fc = new FailoverConnection([
      { url: "http://rpc1.test", weight: 10 },
      { url: "http://rpc2.test", weight: 1 },
    ]);
    const s = fc.status();
    expect(s).toHaveLength(2);
    expect(s[0].healthy).toBe(true);
    expect(s[1].healthy).toBe(true);
  });

  it("returns primary connection", () => {
    const fc = new FailoverConnection(["http://rpc1.test"]);
    const conn = fc.primary;
    expect(conn).toBeDefined();
    expect(conn.rpcEndpoint).toBe("http://rpc1.test");
  });

  describe("exec — failover behavior", () => {
    it("returns result from first healthy endpoint", async () => {
      const fc = new FailoverConnection(["http://rpc1.test"]);
      const result = await fc.exec(async () => 42);
      expect(result).toBe(42);
    });

    it("falls back to next endpoint on failure", async () => {
      const fc = new FailoverConnection([
        "http://rpc1.test",
        "http://rpc2.test",
      ]);

      let callCount = 0;
      const result = await fc.exec(async (conn) => {
        callCount++;
        if (conn.rpcEndpoint === "http://rpc1.test") {
          throw new Error("rpc1 down");
        }
        return "from-rpc2";
      });

      expect(result).toBe("from-rpc2");
      expect(callCount).toBe(2);
    });

    it("throws when all endpoints fail", async () => {
      const fc = new FailoverConnection([
        "http://rpc1.test",
        "http://rpc2.test",
      ]);

      await expect(
        fc.exec(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("All 2 RPC endpoints failed");
    });

    it("resets failure count on success", async () => {
      const fc = new FailoverConnection(["http://rpc1.test"], {
        maxFailures: 2,
      });

      // Fail once
      let failOnce = true;
      await fc.exec(async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient");
        }
        return "ok";
      });

      // Endpoint should be healthy (failure was on a single-endpoint setup,
      // so it retries the same one — but since there's only 1, it should still work)
      const s = fc.status();
      // After success, failures should be reset
      expect(s[0].failures).toBe(0);
    });
  });

  describe("circuit breaker", () => {
    it("marks endpoint unhealthy after maxFailures", async () => {
      const fc = new FailoverConnection(
        ["http://rpc1.test", "http://rpc2.test"],
        { maxFailures: 2 },
      );

      // Fail rpc1 twice to trip the circuit breaker
      let rpc1Calls = 0;
      await fc.exec(async (conn) => {
        if (conn.rpcEndpoint === "http://rpc1.test") {
          rpc1Calls++;
          throw new Error("rpc1 down");
        }
        return "ok";
      });

      // After 1 failure, still healthy
      const s1 = fc.status();
      const rpc1Status = s1.find((e) => e.url === "http://rpc1.test")!;
      expect(rpc1Status.failures).toBe(1);

      // Fail rpc1 again to trip
      await fc.exec(async (conn) => {
        if (conn.rpcEndpoint === "http://rpc1.test") {
          throw new Error("rpc1 still down");
        }
        return "ok";
      });

      const s2 = fc.status();
      const rpc1After = s2.find((e) => e.url === "http://rpc1.test")!;
      expect(rpc1After.failures).toBe(2);
      expect(rpc1After.healthy).toBe(false);
    });

    it("reset() clears all circuit breakers", async () => {
      const fc = new FailoverConnection(
        ["http://rpc1.test", "http://rpc2.test"],
        { maxFailures: 1 },
      );

      // Trip rpc1
      await fc.exec(async (conn) => {
        if (conn.rpcEndpoint === "http://rpc1.test") {
          throw new Error("down");
        }
        return "ok";
      });

      expect(
        fc.status().find((e) => e.url === "http://rpc1.test")!.healthy,
      ).toBe(false);

      fc.reset();
      expect(fc.status().every((e) => e.healthy)).toBe(true);
    });
  });

  describe("timeout", () => {
    it("rejects when execution exceeds timeoutMs", async () => {
      const fc = new FailoverConnection(["http://rpc1.test"], {
        timeoutMs: 50,
      });

      await expect(
        fc.exec(
          () =>
            new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
        ),
      ).rejects.toThrow("RPC timeout");
    });

    it("succeeds when execution is within timeoutMs", async () => {
      const fc = new FailoverConnection(["http://rpc1.test"], {
        timeoutMs: 500,
      });

      const result = await fc.exec(async () => "fast");
      expect(result).toBe("fast");
    });
  });

  describe("weight-based selection", () => {
    it("prefers higher-weighted endpoints", async () => {
      const fc = new FailoverConnection([
        { url: "http://heavy.test", weight: 100 },
        { url: "http://light.test", weight: 1 },
      ]);

      const endpoints: string[] = [];
      // Run exec multiple times — the heavy endpoint should always be tried first
      for (let i = 0; i < 5; i++) {
        await fc.exec(async (conn) => {
          endpoints.push(conn.rpcEndpoint);
          return "ok";
        });
      }

      // All calls should hit the heavy endpoint since it never fails
      expect(endpoints.every((e) => e === "http://heavy.test")).toBe(true);
    });
  });
});
