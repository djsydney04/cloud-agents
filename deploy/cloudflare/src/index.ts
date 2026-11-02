import { DurableObject } from "cloudflare:workers";
import {
  HostGateway,
  keepHostAlive,
  routeRequest,
  unavailable,
} from "./gateway.ts";

export class CloudAgentsHost extends DurableObject<Env> {
  private gateway: HostGateway | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        keepHostAlive(container, ctx.storage),
      );
    }
  }

  async alarm(): Promise<void> {
    const container = this.ctx.container;
    // A manual stop or platform failure must not start a new empty workspace.
    if (container?.running) await keepHostAlive(container, this.ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) return unavailable("Container binding is missing");
    this.gateway ??= new HostGateway(
      container,
      this.env.CLOUD_AGENTS_TOKEN,
      this.ctx.storage,
    );
    return this.gateway.fetch(request);
  }
}

export default { fetch: routeRequest } satisfies ExportedHandler<Env>;
