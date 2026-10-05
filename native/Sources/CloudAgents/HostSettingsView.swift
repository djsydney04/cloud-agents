import SwiftUI

struct HostSettingsView: View {
    let client: Client
    @Environment(\.dismiss) private var dismiss
    @State private var draft = HostSettings(cpus: 1, memory_mb: 2048, max_jobs: 1, min_free_gb: 5, paused: false, revision: 0)
    @State private var loaded = false
    @State private var saving = false
    @State private var message = ""
    func load() async {
        do { draft = try await client.loadSettings(); loaded = true; message = "" }
        catch { message = error.localizedDescription }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack { Text("Host settings").font(.title2); Spacer(); Button("Close") { dismiss() } }
            if let health = client.host?.health { Text("Docker offers \(health.docker_cpus ?? 0) CPUs and \(Double(health.docker_memory_mb ?? 0) / 1024, specifier: "%.1f") GiB.").foregroundStyle(.secondary) }
            Form {
                TextField("CPU budget", value: $draft.cpus, format: .number)
                TextField("Memory budget · MB", value: $draft.memory_mb, format: .number)
                TextField("Concurrent runs", value: $draft.max_jobs, format: .number)
                TextField("Keep free · GiB", value: $draft.min_free_gb, format: .number)
                Toggle("Pause new runs", isOn: $draft.paused)
            }.disabled(!loaded || saving)
            Text("Saved on the host without restarting. Running containers retain their limits. To exceed Docker’s available capacity, resize the VM or Docker Desktop allocation first.").font(.caption).foregroundStyle(.secondary)
            if !message.isEmpty { Text(message).font(.callout).textSelection(.enabled) }
            HStack {
                Button("Save settings") { saving = true; Task { do { draft = try await client.saveSettings(draft); message = "Saved on host. New runs use this budget."; await client.refresh() } catch { message = error.localizedDescription }; saving = false } }.buttonStyle(.borderedProminent).disabled(!loaded || saving)
                Button("Reload") { Task { await load() } }.disabled(saving)
            }
        }.padding(30).frame(width: 480).task { await load() }
    }
}
