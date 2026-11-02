import { DurableObject } from "cloudflare:workers";
import { HostGateway, routeRequest, unavailable } from "./gateway.ts";

export class CloudAgentsHost extends DurableObject<Env> {
  private gateway: HostGateway | undefined;

  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) return unavailable("Container binding is missing");
    this.gateway ??= new HostGateway(container, this.env.CLOUD_AGENTS_TOKEN);
    return this.gateway.fetch(request);
  }
}

export default { fetch: routeRequest } satisfies ExportedHandler<Env>;
