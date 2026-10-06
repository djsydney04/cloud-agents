/* One renderer shared by the browser and the isolated Electron window. */
const $ = (id) => document.getElementById(id);
let token = "",
  endpoint = location.origin,
  jobs = [],
  selected = null,
  connected = false,
  configured = false,
  connectionGeneration = 0,
  polling = false,
  credentialSaving = false;
const desktop = window.cloudAgents;
$("remember").parentElement.hidden = !desktop;
$("transport-fields").hidden = !desktop;
function transportFields() {
  const mode = desktop ? $("transport").value : "direct";
  const ssh = mode === "ssh",
    local = mode === "local";
  $("local-fields").hidden = !local;
  $("ssh-fields").hidden = !ssh;
  $("direct-fields").hidden = local || ssh;
  $("token-fields").hidden = local;
  $("token").required = !local;
  $("endpoint").required = mode === "direct";
  $("ssh-host").required = ssh;
  $("ssh-user").required = ssh;
  $("connect-submit").textContent = local ? "Set up this computer" : "Connect";
}
$("get-docker").onclick = () => desktop?.getDocker();
$("transport").onchange = transportFields;
transportFields();
$("endpoint").value = desktop ? "http://127.0.0.1:7420" : location.origin;
$("endpoint").readOnly = !desktop;
async function api(path, method = "GET", body) {
  if (desktop) return desktop.request({ path, method, body });
  const res = await fetch("/api" + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || `Host returned ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}
function notice(message = "") {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
function connection(ok) {
  connected = ok;
  $("disconnect").hidden = !configured;
  $("accounts").hidden = !ok;
  $("status-dot").classList.toggle("connected", ok);
  $("connection-status").textContent = ok
    ? "Host connected"
    : configured
      ? "Reconnecting…"
      : "Not connected";
  $("submit").disabled = !ok;
  $("host-settings-button").disabled = !ok;
  $("save-credential").disabled = !ok || credentialSaving;
  $("remove-credential").disabled = !ok || credentialSaving;
  $("account-choice").disabled = !ok;
}
function renderList() {
  $("run-count").textContent = jobs.length;
  $("runs").replaceChildren();
  if (!jobs.length) {
    const p = document.createElement("p");
    p.className = "muted empty-list";
    p.textContent = "Your runs will appear here.";
    $("runs").append(p);
  }
  for (const j of jobs) {
    const b = document.createElement("button");
    b.className = "run-item" + (j.id === selected ? " selected" : "");
    const strong = document.createElement("strong");
    strong.textContent = j.prompt;
    const small = document.createElement("small");
    const provider = document.createElement("span");
    provider.textContent = j.provider;
    const state = document.createElement("span");
    state.textContent = j.status;
    small.append(provider, state);
    b.append(strong, small);
    b.onclick = () => select(j.id);
    $("runs").append(b);
  }
}
function select(id) {
  window.scrollTo({ top: 0, behavior: "instant" });
  selected = id;
  $("composer").hidden = !!id;
  $("run-detail").hidden = !id;
  renderList();
  if (id) renderDetail();
}
async function renderDetail() {
  const id = selected,
    j = jobs.find((j) => j.id === id);
  if (!j) return;
  const active = ["queued", "starting", "running", "cancelling"].includes(
    j.status,
  );
  $("run-provider").textContent = j.provider + " / " + j.id.slice(0, 8);
  $("run-title").textContent = j.prompt;
  $("run-state").textContent = j.status;
  $("run-meta").textContent =
    `${j.cpus} CPU · ${j.memory_mb} MB · ${new Date(j.created_at * 1000).toLocaleString()}${j.repository ? " · " + j.repository : ""}`;
  $("run-error").hidden = !j.error;
  $("run-error").textContent = j.error || "";
  $("cancel").hidden = !active;
  $("cancel").disabled = j.status === "cancelling";
  $("delete").hidden = active;
  $("download").disabled = active;
  $("output-live").textContent = active ? " / LIVE" : "";
  try {
    const r = await api(`/jobs/${id}/logs`);
    if (selected === id) {
      const nearBottom =
        $("output").scrollHeight -
          $("output").scrollTop -
          $("output").clientHeight <
        50;
      $("output").textContent = r.output;
      if (nearBottom) $("output").scrollTop = $("output").scrollHeight;
    }
  } catch (e) {
    notice(e.message);
  }
}
async function refresh() {
  if (!configured || polling) return;
  const generation = connectionGeneration;
  polling = true;
  try {
    const [host, runs] = await Promise.all([api("/host"), api("/jobs")]);
    if (generation !== connectionGeneration) return;
    connection(true);
    $("tunnel-status").textContent = "";
    jobs = runs;
    renderList();
    $("host-name").textContent = host.name;
    $("version").textContent = "CLOUD AGENTS / " + host.version;
    $("capacity").textContent =
      `${host.used_cpus} / ${host.cpus} CPU · ${Math.round((host.used_memory_mb / 1024) * 10) / 10} / ${Math.round(host.memory_mb / 1024)} GB`;
    $("credential-status").textContent =
      `Codex: ${host.credentials.codex ? "ready" : "not connected"} · Claude: ${host.credentials.claude ? "ready" : "not connected"} · GitHub: ${host.credentials.github ? "token configured" : "public repositories"}`;
    notice(
      host.paused
        ? "New runs are paused. Resume them in Host settings."
        : !host.health.docker_ready
          ? "Docker is unavailable on your host. Start Docker to continue."
          : !host.health.image_ready
            ? "Build the sandbox image on your host before starting runs."
            : "",
    );
    if (selected) await renderDetail();
  } catch (e) {
    if (generation !== connectionGeneration) return;
    connection(false);
    const status = desktop ? await desktop.status().catch(() => null) : null;
    const raw = (status?.error || e.message).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      "",
    );
    const message = /fetch failed|Failed to fetch/.test(raw)
      ? "The host is offline or unreachable. Waiting for it to return."
      : raw;
    notice("Reconnecting automatically. " + message);
    $("tunnel-status").textContent = message;
  } finally {
    polling = false;
  }
}
$("connect-form").onsubmit = async (event) => {
  event.preventDefault();
  $("connect-error").textContent = "";
  $("connect-submit").disabled = true;
  $("connect-submit").textContent =
    $("transport").value === "local" ? "Preparing workspace…" : "Connecting…";
  try {
    endpoint = $("endpoint").value;
    token = $("token").value.trim();
    if (desktop)
      await desktop.connect({
        mode: $("transport").value,
        ssh: {
          host: $("ssh-host").value.trim(),
          user: $("ssh-user").value.trim(),
          port: Number($("ssh-port").value),
          remotePort: Number($("remote-port").value),
          identityFile: $("ssh-key").value.trim(),
        },
        endpoint,
        token,
        remember: $("remember").checked,
      });
    configured = true;
    connectionGeneration++;
    connection(false);
    $("settings").close();
    $("token").value = "";
    $("credential-value").value = "";
    await refresh();
  } catch (e) {
    connection(false);
    $("connect-error").textContent = e.message;
  } finally {
    $("connect-submit").disabled = false;
    transportFields();
  }
};
$("settings-button").onclick = () => $("settings").showModal();
$("close-settings").onclick = () => $("settings").close();
$("disconnect").onclick = async () => {
  if (desktop) await desktop.disconnect();
  token = "";
  configured = false;
  connectionGeneration++;
  connection(false);
  jobs = [];
  notice("");
  $("tunnel-status").textContent = "";
  $("host-name").textContent = "No host connected";
  $("capacity").textContent = "";
  $("credential-status").textContent = "";
  select(null);
  $("token").value = "";
  $("settings").close();
};
$("new-run").onclick = () => select(null);
$("smoke-choice").onclick = () => {
  $("provider").value = "smoke";
  $("prompt").value = "Verify this host and its sandbox isolation.";
  $("memory").value = "256";
  $("prompt").focus();
};
$("run-form").onsubmit = async (event) => {
  event.preventDefault();
  $("submit").disabled = true;
  try {
    const j = await api("/jobs", "POST", {
      provider: $("provider").value,
      prompt: $("prompt").value,
      repository: $("repository").value.trim(),
      cpus: Number($("cpus").value),
      memory_mb: Number($("memory").value),
      timeout_secs: Number($("timeout").value) * 60,
    });
    jobs.unshift(j);
    select(j.id);
    notice();
  } catch (e) {
    notice(e.message);
  } finally {
    $("submit").disabled = !connected;
  }
};
$("cancel").onclick = async () => {
  try {
    await api(`/jobs/${selected}/cancel`, "POST");
    await refresh();
  } catch (e) {
    notice(e.message);
  }
};
$("delete").onclick = async () => {
  if (!confirm("Delete this run and its workspace permanently?")) return;
  try {
    await api(`/jobs/${selected}`, "DELETE");
    jobs = jobs.filter((j) => j.id !== selected);
    select(null);
  } catch (e) {
    notice(e.message);
  }
};
$("download").onclick = async () => {
  try {
    if (desktop) {
      await desktop.exportWorkspace(selected);
      return;
    }
    const r = await fetch(`/api/jobs/${selected}/archive`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error("Export failed");
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `cloud-agents-${selected}.tar.gz`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    notice(e.message);
  }
};
connection(false);
(async () => {
  const initialToken =
    !desktop && new URLSearchParams(location.hash.slice(1)).get("token");
  if (initialToken) {
    history.replaceState(null, "", location.pathname + location.search);
    token = initialToken;
    configured = true;
    await refresh();
    return;
  }
  if (desktop) {
    try {
      const saved = await desktop.restore();
      if (saved) {
        $("endpoint").value = saved.endpoint;
        $("transport").value = saved.mode || "direct";
        if (saved.ssh) {
          $("ssh-host").value = saved.ssh.host;
          $("ssh-user").value = saved.ssh.user;
          $("ssh-port").value = saved.ssh.port;
          $("remote-port").value = saved.ssh.remotePort;
          $("ssh-key").value = saved.ssh.identityFile || "";
        }
        transportFields();
        configured = true;
        connection(false);
        await refresh();
        return;
      }
    } catch (e) {
      notice(e.message);
    }
  }
  $("settings").showModal();
})();
setInterval(refresh, 2500);

let settingsDraft = null;
async function loadHostSettings() {
  try {
    const [settings, host] = await Promise.all([
      api("/settings"),
      api("/host"),
    ]);
    settingsDraft = settings;
    $("budget-cpus").value = settings.cpus;
    $("budget-memory").value = settings.memory_mb / 1024;
    $("budget-jobs").value = settings.max_jobs;
    $("budget-disk").value = settings.min_free_gb;
    $("budget-paused").checked = settings.paused;
    $("available-capacity").textContent =
      `Docker offers ${host.health.docker_cpus ?? "unknown"} CPUs and ${host.health.docker_memory_mb ? (host.health.docker_memory_mb / 1024).toFixed(1) : "unknown"} GiB. In use: ${host.used_cpus} CPUs / ${(host.used_memory_mb / 1024).toFixed(1)} GiB.`;
    $("budget-cpus").max = host.health.docker_cpus || 1024;
    $("budget-memory").max = host.health.docker_memory_mb
      ? Math.floor(host.health.docker_memory_mb / 256) / 4
      : 16384;
    $("settings-result").textContent = "";
  } catch (e) {
    $("settings-result").textContent = e.message;
  }
}
$("host-settings-button").onclick = () => {
  $("host-settings").showModal();
  loadHostSettings();
};
$("close-host-settings").onclick = () => $("host-settings").close();
$("reload-host-settings").onclick = loadHostSettings;
$("host-settings-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!settingsDraft) return;
  $("save-host-settings").disabled = true;
  try {
    settingsDraft = await api("/settings", "PUT", {
      revision: settingsDraft.revision,
      cpus: Number($("budget-cpus").value),
      memory_mb: Math.round(Number($("budget-memory").value) * 1024),
      max_jobs: Number($("budget-jobs").value),
      min_free_gb: Number($("budget-disk").value),
      paused: $("budget-paused").checked,
    });
    $("settings-result").textContent =
      "Saved on host. New runs use this budget.";
    await refresh();
  } catch (e) {
    $("settings-result").textContent = e.message;
  } finally {
    $("save-host-settings").disabled = false;
  }
};

$("account-choice").onclick = () => {
  $("settings").showModal();
  $("accounts").open = true;
  $("credential-kind").focus();
};
async function saveCredential(remove = false) {
  if (credentialSaving) return;
  credentialSaving = true;
  $("save-credential").disabled = true;
  $("remove-credential").disabled = true;
  try {
    await api("/credentials", "PUT", {
      kind: $("credential-kind").value,
      value: remove ? null : $("credential-value").value,
    });
    $("credential-value").value = "";
    $("credential-result").textContent = remove
      ? "Removed from host. Existing runs keep their current access."
      : "Saved on host. You can now start a run.";
    await refresh();
  } catch (error) {
    $("credential-result").textContent = error.message;
  } finally {
    credentialSaving = false;
    $("save-credential").disabled = !connected;
    $("remove-credential").disabled = !connected;
  }
}
$("credential-form").onsubmit = (event) => {
  event.preventDefault();
  saveCredential();
};
$("remove-credential").onclick = () => saveCredential(true);
