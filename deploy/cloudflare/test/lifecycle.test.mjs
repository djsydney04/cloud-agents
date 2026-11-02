import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Substitute only the platform base class; exercise the real DO entrypoints.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});
const { CloudAgentsHost } = await import("../src/index.ts");
hooks.deregister();

test("background jobs survive a closed UI and object restart; stopping never restarts the host", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const token = "a".repeat(64);
  let scheduled = null;
  let expires = 0;
  let starts = 0;
  let renewals = 0;
  const storage = {
    async getAlarm() {
      return scheduled;
    },
    async setAlarm(value) {
      scheduled = value;
    },
  };
  const container = {
    running: false,
    images: { host: "registry.cloudflare.com/test/host@sha256:abc" },
    start() {
      this.running = true;
      starts++;
    },
    async setInactivityTimeout(duration) {
      assert.ok(
        duration > 0 && duration <= 21_600_000,
        "Cloudflare allows up to six hours",
      );
      expires = Date.now() + duration;
      renewals++;
    },
    getTcpPort() {
      return {
        async fetch() {
          return new Response("{}");
        },
      };
    },
  };
  let initialization;
  const state = {
    container,
    storage,
    blockConcurrencyWhile(callback) {
      return (initialization = callback());
    },
  };
  const env = { CLOUD_AGENTS_TOKEN: token };
  let host = new CloudAgentsHost(state, env);
  assert.equal(
    (
      await host.fetch(
        new Request("https://agents.example.com/api/jobs", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: "{}",
        }),
      )
    ).status,
    200,
  );
  assert.ok(
    expires > Date.now(),
    "Startup must set a timeout before the DO becomes inactive",
  );
  assert.ok(scheduled > Date.now() && scheduled < expires);

  // No client requests for longer than the maximum 24-hour job duration.
  for (let hour = 0; hour < 25; hour++) {
    const due = scheduled;
    assert.ok(
      due < expires,
      "The next alarm must occur before the container expires",
    );
    t.mock.timers.setTime(due);
    if (hour === 2) {
      expires = Date.now(); // The platform drops the lease on DO reconstruction.
      host = new CloudAgentsHost(state, env);
      await initialization;
      assert.ok(expires > Date.now(), "Reconstruction must restore the lease");
      assert.equal(
        scheduled,
        due,
        "A constructor must preserve an already due alarm",
      );
    }
    scheduled = null; // getAlarm returns null while the alarm handler is running.
    await host.alarm();
    assert.ok(expires > Date.now());
    assert.ok(scheduled > Date.now() && scheduled < expires);
  }
  assert.equal(starts, 1, "Renewals must keep the same workspace");
  const beforeStop = renewals;
  container.running = false;
  host = new CloudAgentsHost(state, env);
  scheduled = null;
  await host.alarm();
  assert.equal(starts, 1, "An alarm must not restart a stopped container");
  assert.equal(renewals, beforeStop);
  assert.equal(scheduled, null);
});
