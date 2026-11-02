# Containers, deployment tools, and private networks

The host can run in a container and launch sibling agent containers through
Docker. An optional deployment sandbox adds Wrangler, gcloud, kubectl, the GKE
authentication plugin, and OpenSSH. Agents can deploy to any reachable service
using those tools or tools installed in your own sandbox image.

Choose where the **host** runs separately from where an **agent deploys code**:

| Host location | Setup | State |
| --- | --- | --- |
| Linux VM / local Docker | [Compose](#docker-compose) | Bind-mounted directory |
| GKE Standard / trusted Kubernetes | [Dedicated Docker sidecar](#gke-and-kubernetes) | Two persistent volumes |
| Cloudflare Workers + Containers | [Experimental profile](../deploy/cloudflare/README.md) | Disposable; lost when the instance stops |
| CI runner with local Docker | [Container smoke test](#ci) or Compose | Runner storage; archive results before teardown |

Workers run the Cloudflare gateway; Cloudflare Containers run the Linux host and
nested Docker daemon. A standalone Worker cannot run this Docker-based host.
No cloud resources or credentials are created by building these images.

## Docker Compose

Run these commands from a checkout with Docker Engine and Compose installed.
This profile uses Linux host networking so the host API can stay on loopback.
Docker Desktop requires its **Enable host networking** setting. Without that
setting, use the existing native host or the shared-Pod Kubernetes profile.
Publishing `7420:7420` cannot reach an API bound to container loopback.

On Linux:

```sh
export CLOUD_AGENTS_DATA_DIR="$(pwd -P)/state"
mkdir -p "$CLOUD_AGENTS_DATA_DIR"
chmod 700 "$CLOUD_AGENTS_DATA_DIR"
export CLOUD_AGENTS_UID="$(id -u)" CLOUD_AGENTS_GID="$(id -g)"
export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
sh scripts/build-containers.sh
export CLOUD_AGENTS_IMAGE=cloud-agents-deploy:0.1.0
docker compose up -d host
docker compose exec host cloud-agents doctor
docker compose exec host cloud-agents smoke
```

On macOS with Docker Desktop, retain `DOCKER_SOCKET=/var/run/docker.sock` and set
`DOCKER_GID=0` for the daemon socket inside Desktop's Linux VM. The context's
client socket under your macOS home is a different socket. The data directory
must be shared with Docker Desktop. Run the commands as an ordinary user; the host
rejects root. The directory must already belong to that user.

Open `http://127.0.0.1:7420`, then use `docker compose exec host cloud-agents token`
to retrieve your private connection token. A successful smoke run writes
`result.txt` in its workspace. `docker compose logs host` shows startup failures.
Stop with `docker compose down`; the bind-mounted data remains. Avoid running the
native host and container host on the same port or data directory.

The host mounts `/data`, while Docker resolves job mounts on the daemon's
filesystem. `CLOUD_AGENTS_DOCKER_DATA_DIR` translates `/data/jobs/...` to your real
absolute state directory. Use a canonical path without commas or control
characters. This mapping does not synchronize a remote Docker daemon's storage;
the daemon must see the same underlying files. The Docker socket gives the host
control of that daemon. Jobs never receive the socket.

Use `CLOUD_AGENTS_IMAGE` to select a custom sandbox. Container startup pulls a
missing custom image; authenticate to a private registry on the controller first
or pre-load it into the daemon. `CLOUD_AGENTS_CPUS`, `CLOUD_AGENTS_MEMORY_MB`,
`CLOUD_AGENTS_MAX_JOBS`, and `CLOUD_AGENTS_MIN_FREE_GB` set initial budgets.
Saved Host settings take precedence after the first setup.

## Give agents deployment credentials

Import credentials through stdin, on the controller. These are separate from the
host connection token. For example:

```sh
docker compose exec -T host cloud-agents credential cloudflare-api-token < /secure/cloudflare-token
docker compose exec -T host cloud-agents credential cloudflare-account-id < /secure/cloudflare-account-id
docker compose exec -T host cloud-agents credential google-credentials-json < /secure/google-credentials.json
docker compose exec -T host cloud-agents credential kubeconfig < /secure/kubeconfig
docker compose exec -T host cloud-agents credential ssh-key < /secure/deployment-key
docker compose exec -T host cloud-agents credential ssh-known-hosts < /secure/verified-known-hosts
```

Only import the credentials you need. Like the existing GitHub token, imported
deployment credentials are available to **every subsequent Codex/Claude run** on
that host. Use separate hosts for different trust scopes. A run can use or copy
its credentials; a read-only secret mount does not prevent that. The local smoke
provider receives none. Removing a credential affects future snapshots, not
already admitted jobs. Use `credential NAME --remove` to remove it.

Google accepts a supported credential JSON object, including Workload Identity
Federation configuration. A federation configuration must reference a token
source that is actually available in the job; importing JSON does not create a CI
OIDC token or refresh a missing subject token. Avoid long-lived service-account
keys where a working federation setup is available.

The sandbox sets Cloudflare and Google authentication environment variables,
copies kubeconfig to writable private home storage, and configures SSH with a
private key and **strict** known-host verification. Verify SSH fingerprints using
a trusted channel before importing known_hosts. Encrypted SSH keys that require
an interactive passphrase are not supported by this unattended flow. Kubeconfig
may execute an auth plugin, so import only a trusted configuration. Nothing reads
your laptop's credentials automatically.

Ask an agent to use the repository's locked tooling when present. Example commands
inside a deployment job:

```sh
npm ci
npx wrangler deploy --dry-run
# Publish when the task calls for it:
npx wrangler deploy

gcloud container clusters get-credentials YOUR_CLUSTER \
  --location YOUR_LOCATION --project YOUR_PROJECT
kubectl apply --dry-run=server -f deploy/
kubectl apply -f deploy/

ssh -J jump-user@bastion deploy-user@private-host 'hostname'
```

Dry runs need appropriate account/cluster access; server dry run contacts the
cluster. Agents can install other deployment clients in the writable workspace,
or you can extend `sandbox/deploy.Dockerfile`. Docker image builds inside jobs
need a separate builder service; the controller's Docker socket is deliberately
unavailable to jobs.

## Tailscale, SSH, and other VPNs

For incoming private HTTPS access, enable tailnet HTTPS and allow this node in
your tailnet policy. Set `TS_AUTHKEY` through your environment or secret manager,
then run:

```sh
docker compose --profile tailscale up -d host tailscale
docker compose exec tailscale tailscale status
```

Open the node's HTTPS name and enter the host token. Serve forwards to loopback;
Funnel is disabled. Tailnet identity persists in a separate Docker volume. This
profile needs no TUN device or `NET_ADMIN` capability.

You can instead SSH to the **machine hosting Docker**, through Tailscale, a
corporate VPN, WireGuard, or a reachable bastion, and use the existing desktop
SSH tunnel. No SSH daemon is installed in the controller container. Standard
OpenSSH configuration, `ProxyJump`, and verified host keys remain supported.

Incoming Tailscale access does not route separate agent containers through the
VPN. To give jobs outgoing tailnet access, the optional proxy runs on a named
Docker network without publishing its proxy ports:

```sh
export CLOUD_AGENTS_DOCKER_NETWORK=cloud-agents-vpn
# Set TS_VPN_AUTHKEY through your environment or secret manager.
docker compose --profile vpn up -d host tailscale-proxy
docker compose exec tailscale-proxy tailscale status
```

Import `deployment-env` from a private JSON file containing the proxy settings:

```json
{
  "HTTP_PROXY": "http://tailscale-proxy:1056",
  "HTTPS_PROXY": "http://tailscale-proxy:1056",
  "ALL_PROXY": "socks5h://tailscale-proxy:1055",
  "NO_PROXY": "localhost,127.0.0.1"
}
```

```sh
docker compose exec -T host cloud-agents credential deployment-env < /secure/proxies.json
```

Use a separate reusable/tagged key for the proxy node and restrict tailnet grants
to the intended destinations. Clients differ in proxy support. SSH needs an
explicit SOCKS proxy command, even when HTTP proxy variables are configured:

```sh
ssh -o 'ProxyCommand=nc -X 5 -x tailscale-proxy:1055 %h %p' deploy-user@private-host
```

Other VPNs can supply an HTTP/SOCKS proxy or a routed Docker network selected by
`CLOUD_AGENTS_DOCKER_NETWORK`. Native WireGuard/OpenVPN needs host-managed routing
or a dedicated VPN sidecar; jobs do not receive privileged network capabilities.
The `host` network mode shares the controller/daemon network stack and should be
reserved for trusted jobs, including the Cloudflare profile that requires it.

## GKE and Kubernetes

[`deploy/kubernetes.yaml`](../deploy/kubernetes.yaml) is a single-host template
for **GKE Standard**, with a privileged Docker sidecar. GKE nodes use containerd;
a node's Docker socket is not available. GKE Autopilot and restricted namespaces
reject privileged Docker-in-Docker. Use a dedicated trusted node pool/namespace.

Build and push the controller and deployment images to your registry. Replace
`YOUR_REGISTRY` with an authenticated registry path that your cluster can pull:

```sh
docker buildx build --platform linux/amd64 -t YOUR_REGISTRY/cloud-agents:container --push .
docker build -t cloud-agents-sandbox:0.1.0 sandbox
docker build -f sandbox/deploy.Dockerfile -t YOUR_REGISTRY/cloud-agents-sandbox:deploy .
docker push YOUR_REGISTRY/cloud-agents-sandbox:deploy
```

Before applying the template, replace the host image in the manifest with
`YOUR_REGISTRY/cloud-agents:container` and add `CLOUD_AGENTS_IMAGE` to the host's
environment with value `YOUR_REGISTRY/cloud-agents-sandbox:deploy`. Ensure the
nested Docker daemon can pull the sandbox image; Kubernetes imagePullSecrets
authenticate Pod image pulls, not that separate daemon. A public sandbox image
or a daemon pre-load avoids importing registry credentials into the controller.
Match the sandbox architecture to your nodes; use an AMD64 builder for AMD64
nodes. The template's default without that variable builds the basic sandbox.

```sh
kubectl apply -f deploy/kubernetes.yaml
kubectl -n cloud-agents rollout status deployment/cloud-agents --timeout=600s
kubectl -n cloud-agents exec deployment/cloud-agents -c host -- cloud-agents doctor
kubectl -n cloud-agents exec deployment/cloud-agents -c host -- cloud-agents smoke
kubectl -n cloud-agents port-forward deployment/cloud-agents 7420:7420
```

Open localhost and retrieve the token using the same `kubectl exec` command with
`token` in place of `doctor`. The Pod has no public Service or Ingress. Both
containers mount the state volume at `/data`; Docker's image/container state has
its own volume. One replica and `Recreate` avoid simultaneous SQLite schedulers.
Persistent disk retains files, but node/Pod loss can interrupt running jobs.
Back up the private state volume while the host and its jobs are stopped.

For remote access without a port-forward, add a Tailscale sidecar using the same
Serve configuration and Kubernetes Secrets for its key. All Pod containers share
loopback; no public API bind is required.

## CI

The repository's existing owner-only workflow builds the host and deployment
images and runs `tests/container.py` against real Docker. That test starts a
temporary controller, submits a real smoke job, checks daemon-side mount paths,
and verifies state/token preservation after restart. It removes its own test
containers. It does not call a model or deploy cloud resources.

A trusted Linux CI runner with a local Docker socket can run Compose with a
temporary state directory using the same setup above. Import short-lived
credentials only for the job; archive workspace results before deleting its
state. Do not expose self-hosted runners, the Docker socket, or deployment
credentials to unreviewed pull requests. CI execution is not an always-on host.

## Validation and limits

Local fixture checks: `cargo test --locked`, `npm run test:desktop`,
`python3 tests/setup.py`, `python3 tests/container_entrypoint.py`, and
`python3 tests/deployment_sandbox.py`. Cloudflare's gateway has separate checks
under `deploy/cloudflare`.

The container profiles require real image-build/startup verification on the
target runtime. No live Cloudflare/GKE deployment, paid model call, or real
tailnet traversal is established by fixture tests. Cloudflare persistence and
live workload migration are not implemented.

Sources: [Cloudflare DinD and disk lifecycle](https://developers.cloudflare.com/containers/faq/),
[Tailscale Docker parameters](https://tailscale.com/docs/features/containers/docker/docker-params),
[Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking),
[GKE access and auth plugin](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl),
[Autopilot restrictions](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-security).
