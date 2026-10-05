import SwiftUI
import Security

struct Run: Codable, Identifiable, Hashable {
    let id: String
    let provider: String
    let prompt: String
    let repository: String
    let cpus: Int
    let memory_mb: Int
    let status: String
    let error: String?
    var active: Bool { ["queued", "starting", "running", "cancelling"].contains(status) }
}
struct Host: Decodable {
    struct Health: Decodable { let docker_ready: Bool; let image_ready: Bool }
    let cpus: Int; let memory_mb: Int; let used_cpus: Int; let used_memory_mb: Int
    let health: Health
}
struct Log: Decodable { let output: String }
struct Failure: Decodable { let error: String }
enum ClientError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
enum Keychain {
    static let service = "dev.cloudagents.native"
    static func save(_ value: String) throws {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "host"]
        SecItemDelete(q as CFDictionary)
        var add = q; add[kSecValueData as String] = Data(value.utf8)
        let result = SecItemAdd(add as CFDictionary, nil)
        guard result == errSecSuccess else { throw ClientError.message("Could not save connection to Keychain (\(result)).") }
    }
    static func load() -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "host", kSecReturnData as String: true]
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func clear() { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary) }
}
final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor @Observable final class Client {
    var endpoint = "http://127.0.0.1:7420"
    var token = ""
    var connected = false
    var runs: [Run] = []
    var selected: String?
    var output = ""
    var message = ""
    var host: Host?
    var refreshing = false
    private let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
    var current: Run? { runs.first { $0.id == selected } }
    func validatedURL(_ path: String) throws -> URL {
        guard let c = URLComponents(string: endpoint), let host = c.host,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/",
              c.scheme == "https" || (c.scheme == "http" && ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host)),
              let url = URL(string: endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api" + path)
        else { throw ClientError.message("Use HTTPS for remote hosts, or HTTP localhost through an SSH tunnel.") }
        return url
    }
    func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        var r = URLRequest(url: try validatedURL(path)); r.httpMethod = method; r.httpBody = body; r.timeoutInterval = 60
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization"); r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: r)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ClientError.message((try? JSONDecoder().decode(Failure.self, from: data).error) ?? "Host request failed.")
        }
        return data
    }
    func connect(save: Bool) async {
        do {
            token = token.trimmingCharacters(in: .whitespacesAndNewlines)
            host = try JSONDecoder().decode(Host.self, from: await request("/host"))
            if save { let data = try JSONSerialization.data(withJSONObject: ["endpoint": endpoint, "token": token]); try Keychain.save(String(decoding: data, as: UTF8.self)) } else { Keychain.clear() }
            connected = true; message = ""; await refresh()
        } catch { connected = false; message = error.localizedDescription }
    }
    func restore() async {
        if let s = Keychain.load(), let data = s.data(using: .utf8), let c = try? JSONDecoder().decode([String: String].self, from: data), let e = c["endpoint"], let t = c["token"] { endpoint = e; token = t; await connect(save: true) }
    }
    func refresh() async {
        guard connected, !refreshing else { return }; refreshing = true; defer { refreshing = false }
        do {
            runs = try JSONDecoder().decode([Run].self, from: await request("/jobs"))
            host = try JSONDecoder().decode(Host.self, from: await request("/host"))
            if let id = selected { let log = try JSONDecoder().decode(Log.self, from: await request("/jobs/\(id)/logs")); if selected == id { output = log.output } }
            message = host?.health.docker_ready == false ? "Start Docker on the host." : host?.health.image_ready == false ? "Build the sandbox image on the host." : ""
        } catch { message = error.localizedDescription }
    }
    func submit(prompt: String, provider: String, repository: String, cpus: Int, memory: Int, minutes: Int) async {
        do {
            let body = try JSONSerialization.data(withJSONObject: ["prompt": prompt, "provider": provider, "repository": repository, "cpus": cpus, "memory_mb": memory, "timeout_secs": minutes * 60])
            let run = try JSONDecoder().decode(Run.self, from: await request("/jobs", method: "POST", body: body)); runs.insert(run, at: 0); selected = run.id; await refresh()
        } catch { message = error.localizedDescription }
    }
    func cancel(_ run: Run) async { do { _ = try await request("/jobs/\(run.id)/cancel", method: "POST"); await refresh() } catch { message = error.localizedDescription } }
    func delete(_ run: Run) async { do { _ = try await request("/jobs/\(run.id)", method: "DELETE"); selected = nil; await refresh() } catch { message = error.localizedDescription } }
    func export(_ run: Run) async {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "cloud-agents-\(run.id).tar.gz"
        guard await panel.begin() == .OK, let destination = panel.url else { return }
        do {
            var r = URLRequest(url: try validatedURL("/jobs/\(run.id)/archive")); r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (file, response) = try await session.download(for: r)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw ClientError.message("Export failed.") }
            if FileManager.default.fileExists(atPath: destination.path) { _ = try FileManager.default.replaceItemAt(destination, withItemAt: file) } else { try FileManager.default.moveItem(at: file, to: destination) }
        } catch { message = error.localizedDescription }
    }
}

struct Workspace: View {
    @State private var client = Client()
    @State private var showConnection = false
    @State private var remember = true
    @State private var prompt = ""
    @State private var repository = ""
    @State private var provider = "codex"
    @State private var cpus = 1
    @State private var memory = 2048
    @State private var minutes = 30
    @State private var submitting = false
    @State private var deleting = false
    private let accent = Color(red: 0.77, green: 0.93, blue: 0.66)
    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 20) {
                Text("cloud agents  ⌁").font(.system(size: 24, weight: .semibold)).padding(.top, 15)
                Button { client.selected = nil } label: { Label("New run", systemImage: "plus").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).tint(accent).foregroundStyle(.black)
                Text("WORKSPACE").font(.caption2).tracking(2).foregroundStyle(.secondary)
                List(selection: $client.selected) {
                    ForEach(client.runs) { run in
                        VStack(alignment: .leading, spacing: 6) { Text(run.prompt).lineLimit(1); HStack { Text(run.provider); Spacer(); Text(run.status) }.font(.caption2).foregroundStyle(.secondary) }.padding(.vertical, 5).tag(run.id)
                    }
                }.listStyle(.sidebar)
                Button("Connection & credentials") { showConnection = true }.buttonStyle(.plain)
                Label(client.connected ? "Host connected" : "Not connected", systemImage: "circle.fill").font(.caption).foregroundStyle(client.connected ? accent : .secondary)
            }.padding(20).navigationSplitViewColumnWidth(min: 230, ideal: 255)
        } detail: {
            VStack(alignment: .leading, spacing: 22) {
                HStack { Text("PERSONAL COMPUTE").font(.caption2).tracking(2).foregroundStyle(.secondary); Spacer(); if let h = client.host { Text("\(h.used_cpus) / \(h.cpus) CPU · \(h.memory_mb / 1024) GB budget").font(.caption.monospaced()).foregroundStyle(.secondary) } }
                Divider()
                if !client.message.isEmpty { Text(client.message).foregroundStyle(.orange).font(.callout).textSelection(.enabled) }
                if let run = client.current {
                    Text(run.provider.uppercased() + " / " + run.status).font(.caption).foregroundStyle(accent)
                    Text(run.prompt).font(.title2).textSelection(.enabled)
                    if let error = run.error { Text(error).foregroundStyle(.orange) }
                    HStack { Text("OUTPUT").font(.caption2).tracking(2); Spacer(); if run.active { Button("Stop run") { Task { await client.cancel(run) } } } else { Button("Export workspace") { Task { await client.export(run) } }; Button("Delete run", role: .destructive) { deleting = true } } }
                    ScrollView { Text(client.output.isEmpty ? "Waiting for output…" : client.output).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(20) }.background(Color.black.opacity(0.3))
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 22) {
                            Text("What are we building?").font(.system(size: 36, weight: .regular)).padding(.top, 25)
                            Text("Give an agent a task. Your host provides the workspace.").foregroundStyle(.secondary)
                            TextEditor(text: $prompt).font(.body).frame(minHeight: 160).padding(8).overlay(RoundedRectangle(cornerRadius: 6).stroke(.gray.opacity(0.3)))
                            Picker("Agent", selection: $provider) { Text("Codex").tag("codex"); Text("Claude Code").tag("claude"); Text("Local sandbox check").tag("smoke") }
                            TextField("GitHub HTTPS repository URL (optional)", text: $repository).textFieldStyle(.roundedBorder)
                            DisclosureGroup("Run limits") { Stepper("CPU cores: \(cpus)", value: $cpus, in: 1...128); Stepper("Memory: \(memory) MB", value: $memory, in: 256...65536, step: 256); Stepper("Timeout: \(minutes) minutes", value: $minutes, in: 1...1440) }
                            HStack { Text("Isolated container · Changes stay on your host").font(.caption).foregroundStyle(.secondary); Spacer(); Button("Start run ↗") { submitting = true; Task { await client.submit(prompt: prompt, provider: provider, repository: repository, cpus: cpus, memory: memory, minutes: minutes); submitting = false } }.buttonStyle(.borderedProminent).tint(accent).foregroundStyle(.black).disabled(!client.connected || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || submitting) }
                            Divider(); Button("Run a local sandbox check") { provider = "smoke"; prompt = "Verify this host and its sandbox isolation."; memory = 256 }.buttonStyle(.plain).foregroundStyle(accent)
                        }
                    }
                }
                Spacer(minLength: 0)
            }.padding(36).frame(maxWidth: .infinity).background(Color(red: 0.065, green: 0.075, blue: 0.064))
        }
        .preferredColorScheme(.dark).frame(minWidth: 900, minHeight: 650)
        .sheet(isPresented: $showConnection) {
            VStack(alignment: .leading, spacing: 18) {
                Text("Connect to your host").font(.title2)
                TextField("Host address", text: $client.endpoint).textFieldStyle(.roundedBorder)
                SecureField("Connection token", text: $client.token).textFieldStyle(.roundedBorder)
                Toggle("Save in Keychain", isOn: $remember)
                Text("Use cloud-agents token on your host. Remote connections require HTTPS or an SSH tunnel.").font(.caption).foregroundStyle(.secondary)
                if !client.message.isEmpty { Text(client.message).foregroundStyle(.orange).font(.caption) }
                HStack { Button("Connect") { Task { await client.connect(save: remember); if client.connected { showConnection = false } } }.buttonStyle(.borderedProminent); Button("Forget") { Keychain.clear(); client.token = ""; client.connected = false; client.runs = []; client.selected = nil }; Spacer(); Button("Close") { showConnection = false } }
                Divider(); Text("Provider credentials").font(.headline)
                Text("On the host, run cloud-agents login-codex, or cloud-agents credential claude-token and paste a token from claude setup-token. See the README for API keys and GitHub access.").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }.padding(30).frame(width: 470)
        }
        .confirmationDialog("Permanently delete this run and its workspace?", isPresented: $deleting) { Button("Delete", role: .destructive) { if let run = client.current { Task { await client.delete(run) } } } }
        .onChange(of: client.selected) { _, _ in client.output = ""; Task { await client.refresh() } }
        .task { await client.restore(); showConnection = !client.connected; while !Task.isCancelled { await client.refresh(); try? await Task.sleep(for: .seconds(3)) } }
    }
}
@main struct CloudAgentsApp: App { var body: some Scene { WindowGroup { Workspace() }.windowStyle(.titleBar) } }
