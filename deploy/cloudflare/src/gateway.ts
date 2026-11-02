import { timingSafeEqual } from "node:crypto";

// Every URL belongs to the same disposable host and its in-memory scheduler.
export const HOST_NAME = "cloud-agents-single-host";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const PUBLIC_ASSETS = new Set(["/", "/app.js", "/style.css"]);

export function authorize(
  request: Request,
  token: string | undefined,
): Response | null {
  if (!token || token.length !== 64 || !TOKEN_PATTERN.test(token)) {
    return unavailable(
      "Configure a 64-character lowercase hex CLOUD_AGENTS_TOKEN secret",
    );
  }
  const path = new URL(request.url).pathname;
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    PUBLIC_ASSETS.has(path)
  ) {
    return null;
  }
  const supplied = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (
    !supplied ||
    !timingSafeEqual(
      new TextEncoder().encode(supplied),
      new TextEncoder().encode(token),
    )
  ) {
    return Response.json(
      { error: "Host token required" },
      {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
      },
    );
  }
  return null;
}

export function unavailable(
  message = "Host unavailable; check its status before retrying a write",
): Response {
  return Response.json(
    { error: message },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function routeRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const rejected = authorize(request, env.CLOUD_AGENTS_TOKEN);
  if (rejected) return rejected;
  try {
    // Never retry the caller's request: a failed connection may already have committed a write.
    return await env.CLOUD_AGENTS_HOST.getByName(HOST_NAME).fetch(request);
  } catch {
    return unavailable();
  }
}

type ContainerHandle = NonNullable<DurableObjectState["container"]>;
type Port = Pick<Fetcher, "fetch">;
type AlarmStorage = Pick<DurableObjectStorage, "getAlarm" | "setAlarm">;

export async function keepHostAlive(
  container: ContainerHandle,
  storage: AlarmStorage,
): Promise<void> {
  await container.setInactivityTimeout(6 * 60 * 60 * 1000);
  // A constructor must not replace an alarm that is about to be delivered.
  if ((await storage.getAlarm()) === null) {
    await storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }
}

export class HostGateway {
  private ready: Promise<boolean> | undefined;
  private container: ContainerHandle;
  private token: string;
  private storage: AlarmStorage;

  constructor(
    container: ContainerHandle,
    token: string,
    storage: AlarmStorage,
  ) {
    this.container = container;
    this.token = token;
    this.storage = storage;
  }

  async fetch(request: Request): Promise<Response> {
    const rejected = authorize(request, this.token);
    if (rejected) return rejected;
    try {
      // A single readiness promise serializes concurrent cold starts without replaying requests.
      this.ready ??= this.waitUntilReady();
      if (!(await this.ready)) {
        this.ready = undefined;
        return unavailable("Host is starting or failed to start");
      }
      if (!this.container.running) {
        this.ready = undefined;
        return unavailable(
          "Host stopped; reconnect to start a new disposable workspace",
        );
      }
      const url = new URL(request.url);
      url.protocol = "http:";
      url.host = "container";
      const forwarded = new Request(url, request);
      forwarded.headers.delete("Host");
      return await this.container.getTcpPort(7421).fetch(forwarded);
    } catch {
      this.ready = undefined;
      return unavailable();
    }
  }

  private async waitUntilReady(): Promise<boolean> {
    if (!this.container.running) {
      this.container.start({
        image: this.container.images.host,
        instance: "standard-2",
        enableInternet: true,
        env: { CLOUD_AGENTS_TOKEN: this.token },
      });
    }
    await keepHostAlive(this.container, this.storage);
    return waitForHost(this.container.getTcpPort(7421), this.token);
  }
}

// Probe only a read endpoint, with a strict total deadline. Never probe using a caller's body.
export async function waitForHost(
  port: Port,
  token: string,
  timeoutMs = 90_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const response = await port.fetch("http://container/api/host", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.min(2_000, remaining)),
      });
      await response.body?.cancel();
      if (response.ok) return true;
      if (response.status === 401 || response.status === 403) return false;
    } catch {
      // The port does not accept HTTP until Docker, its image, and the host are ready.
    }
    const delay = Math.min(250, deadline - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return false;
}
