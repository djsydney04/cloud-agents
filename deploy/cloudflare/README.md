# Experimental Cloudflare Containers host

This profile runs the Cloud Agents host and a private Docker daemon inside a
Cloudflare Container. A Worker routes every request to one named Durable Object,
which starts a `standard-2` instance with outbound Internet access. The host runs
as UID 1000, accepts one job at a time, and uses the deployment sandbox image.

**This is a disposable workspace.** Its database, credentials, repository clones,
Docker state, and job output live on ephemeral disk. Platform restarts, OOM,
replacement, or stopping the container can lose all of them. Download important
results externally. This profile does not implement snapshots or durable job
recovery. Use the persistent VM/GKE profile for work that must survive a restart.

Cloudflare supports [rootful Docker-in-Docker with networking restrictions](https://developers.cloudflare.com/containers/faq/#can-i-run-docker-inside-a-container-docker-in-docker).
This profile disables Docker iptables and IP forwarding and uses host networking
for inner jobs. An inner job can therefore reach the outer network stack. Run
only trusted jobs in this profile; it is not a multitenant isolation boundary.

## Prepare and validate

You need Docker, Node.js 22.18 or later, and an account with Cloudflare Containers
enabled. Run the repository build script from the repository root first. It
builds Linux AMD64 host/sandbox images and writes `build/cloudflare-sandbox.tar`.
Wrangler then builds this profile using that tar and the local
`cloud-agents-host:local` image.

```sh
sh scripts/build-containers.sh cloudflare
cd deploy/cloudflare
npm ci
npm run check
npm run check:container
```

`npm run check` runs gateway tests, TypeScript checking, and a Worker deployment
dry run. It does not deploy or prove that the nested Docker workload starts on
Cloudflare. `check:container` additionally builds the configured container image
and needs the prepared Docker images and tar. A real authenticated smoke job is
required after deployment.

## Deploy deliberately

1. Create a random 32-byte token, encoded as exactly 64 lowercase hexadecimal
   characters. Save it in your password manager. The same token authenticates the
   Worker and the underlying host; do not use your Cloudflare API token here.
2. In this directory, run `npx wrangler secret put CLOUD_AGENTS_TOKEN` and enter
   the host token at the private prompt. A missing or malformed secret makes the
   Worker refuse requests before starting a container.
3. Add your custom domain or route in `wrangler.jsonc` and protect it with
   Cloudflare Access before exposing it. `workers_dev` and preview URLs are
   disabled by default. No public hostname is configured in this sample.
4. Run `npm run deploy` after reviewing the account, hostname, and instance costs.
5. Open the hostname and enter the host token in the existing Cloud Agents UI.
   Import agent credentials through the UI; credentials also disappear with the
   workspace. Start a smoke run and verify it completes before real work.

The three UI assets may load without the host token. Every API request requires
the Bearer token before the Worker accesses its Durable Object namespace. The
Worker preserves that authorization header so the Rust host also validates it.
Startup readiness uses only `GET /api/host` and has a 90-second deadline. A proxy
error returns 503 without retrying a submitted write; check the job list before
resubmitting a job after an interrupted response.

The profile intentionally sets no inactivity shutdown: a background job must not
lose its container merely because the UI is closed. Running containers incur
charges. Stop the instance explicitly when finished. Cloudflare can still stop
it for platform events; no runtime is guaranteed.

To rotate the token, change the Worker secret and stop the existing container
before reconnecting. A running host retains its startup token. Updating a named
image also takes effect only on the next container start; stop the existing
instance when ready to discard that workspace and use a new image.

The [Durable Object scheduling policy](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
is a beta and has no `max_instances` setting. This gateway always selects one
fixed host name; it does not create a container per request or per job. See
[Cloudflare's lifecycle and ephemeral storage FAQ](https://developers.cloudflare.com/containers/faq/)
before using it for long-running work.
