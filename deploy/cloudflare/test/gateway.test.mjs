import assert from "node:assert/strict";
import test from "node:test";
import {
  authorize,
  HOST_NAME,
  HostGateway,
  routeRequest,
  waitForHost,
} from "../src/gateway.ts";

const token = "a".repeat(64);
const request = (path = "/api/host", init = {}) =>
  new Request(`https://agents.example.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });

test("missing or malformed configuration fails closed before accessing a namespace", async () => {
  for (const value of [undefined, "", "short", "A".repeat(64), `${token}\n`]) {
    let accessed = false;
    const response = await routeRequest(request("/"), {
      CLOUD_AGENTS_TOKEN: value,
      get CLOUD_AGENTS_HOST() {
        accessed = true;
        throw new Error("Must not provision");
      },
    });
    assert.equal(response.status, 503);
    assert.equal(accessed, false);
  }
});

test("all API requests require the exact Bearer token before accessing a namespace", async () => {
  for (const value of [
    "",
    "Bearer wrong",
    `Bearer ${"b".repeat(64)}`,
    `bearer ${token}`,
  ]) {
    let accessed = false;
    const response = await routeRequest(
      request("/api/jobs", {
        method: "POST",
        body: "{}",
        headers: { Authorization: value },
      }),
      {
        CLOUD_AGENTS_TOKEN: token,
        get CLOUD_AGENTS_HOST() {
          accessed = true;
          throw new Error("Must not provision");
        },
      },
    );
    assert.equal(response.status, 401);
    assert.equal(accessed, false);
  }
  assert.equal(authorize(request("/"), token), null);
  assert.equal(
    authorize(request("/api/host", { headers: { Authorization: "" } }), token)
      .status,
    401,
  );
});

test("every route selects the same named host and preserves the request authorization", async () => {
  const names = [];
  const received = [];
  const env = {
    CLOUD_AGENTS_TOKEN: token,
    CLOUD_AGENTS_HOST: {
      getByName(name) {
        names.push(name);
        return {
          async fetch(req) {
            received.push(req);
            return new Response("ok");
          },
        };
      },
    },
  };
  for (const path of ["/", "/api/jobs", "/api/host"]) {
    const req = request(path);
    assert.equal((await routeRequest(req, env)).status, 200);
    assert.equal(received.at(-1), req);
    assert.equal(
      received.at(-1).headers.get("Authorization"),
      `Bearer ${token}`,
    );
  }
  assert.deepEqual(names, [HOST_NAME, HOST_NAME, HOST_NAME]);
});

test("routing errors do not replay a write", async () => {
  let writes = 0;
  const response = await routeRequest(
    request("/api/jobs", { method: "POST", body: "{}" }),
    {
      CLOUD_AGENTS_TOKEN: token,
      CLOUD_AGENTS_HOST: {
        getByName() {
          return {
            async fetch() {
              writes++;
              throw new Error("Connection lost after commit");
            },
          };
        },
      },
    },
  );
  assert.equal(response.status, 503);
  assert.equal(writes, 1);
});

function containerFixture(forward) {
  const starts = [];
  const probes = [];
  let alarm = null;
  const storage = {
    async getAlarm() {
      return alarm;
    },
    async setAlarm(value) {
      alarm = value;
    },
  };
  const container = {
    running: false,
    images: { host: "registry.cloudflare.com/test/host@sha256:abc" },
    async setInactivityTimeout() {},
    start(options) {
      starts.push(options);
      this.running = true;
    },
    getTcpPort(port) {
      assert.equal(port, 7421);
      return {
        async fetch(input, init) {
          assert.equal(
            new URL(typeof input === "string" ? input : input.url).protocol,
            "http:",
          );
          if (typeof input === "string") {
            probes.push({ input, init });
            return new Response("{}", { status: 200 });
          }
          return forward(input);
        },
      };
    },
  };
  return { container, starts, probes, storage };
}

test("concurrent requests share a cold start, probe reads, and forward writes once", async () => {
  let writes = 0;
  const { container, starts, probes, storage } = containerFixture(
    async (req) => {
      assert.equal(req.method, "POST");
      assert.equal(await req.text(), "a new job");
      writes++;
      return new Response("created", { status: 201 });
    },
  );
  const gateway = new HostGateway(container, token, storage);
  const responses = await Promise.all(
    [1, 2].map(() =>
      gateway.fetch(
        request("/api/jobs", { method: "POST", body: "a new job" }),
      ),
    ),
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    [201, 201],
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].env.CLOUD_AGENTS_TOKEN, token);
  assert.equal(starts[0].enableInternet, true);
  assert.equal(starts[0].instance, "standard-2");
  assert.equal(probes.length, 1);
  assert.equal(probes[0].input, "http://container/api/host");
  assert.equal(probes[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(writes, 2);
});

test("container forwarding failures do not replay a write", async () => {
  let writes = 0;
  const { container, storage } = containerFixture(async () => {
    writes++;
    throw new Error("Lost connection");
  });
  const response = await new HostGateway(container, token, storage).fetch(
    request("/api/jobs", { method: "POST", body: "{}" }),
  );
  assert.equal(response.status, 503);
  assert.equal(writes, 1);
});

test("unauthorized requests cannot cold start the container", async () => {
  const { container, starts, storage } = containerFixture(
    async () => new Response(),
  );
  const response = await new HostGateway(container, token, storage).fetch(
    request("/api/jobs", { headers: { Authorization: "" } }),
  );
  assert.equal(response.status, 401);
  assert.equal(starts.length, 0);
});

test("HTTPS writes reach the HTTP-only container with path, query, auth and body preserved", async () => {
  let writes = 0;
  const { container, storage } = containerFixture(async (req) => {
    writes++;
    assert.equal(req.url, "http://container/api/jobs?source=desktop");
    assert.equal(req.method, "POST");
    assert.equal(req.headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(req.headers.get("Host"), null);
    assert.equal(await req.text(), "new job");
    return new Response("created", { status: 201 });
  });
  const response = await new HostGateway(container, token, storage).fetch(
    request("/api/jobs?source=desktop", {
      method: "POST",
      body: "new job",
      headers: { Host: "agents.example.com" },
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(writes, 1);
});

test("readiness has a total deadline and never forwards a user mutation", async () => {
  let probes = 0;
  const before = Date.now();
  const ready = await waitForHost(
    {
      async fetch(input, init) {
        probes++;
        assert.equal(input, "http://container/api/host");
        assert.equal(init.method, undefined);
        assert.equal(init.body, undefined);
        throw new Error("Not listening");
      },
    },
    token,
    20,
  );
  assert.equal(ready, false);
  assert.equal(probes, 1);
  assert.ok(Date.now() - before < 500);
});

test("readiness stops immediately on a host authentication mismatch", async () => {
  let probes = 0;
  assert.equal(
    await waitForHost(
      {
        async fetch() {
          probes++;
          return new Response("Unauthorized", { status: 401 });
        },
      },
      token,
    ),
    false,
  );
  assert.equal(probes, 1);
});
