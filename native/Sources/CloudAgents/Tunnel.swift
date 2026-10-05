import Foundation
import Darwin
import Observation

struct SSHConnection: Codable {
    var host = ""
    var user = ""
    var port = 22
    var remotePort = 7420
    var identityFile = ""
    func validate() throws {
        guard host.range(of: "^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$", options: .regularExpression) != nil,
              user.range(of: "^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$", options: .regularExpression) != nil,
              (1...65535).contains(port), (1...65535).contains(remotePort),
              identityFile.isEmpty || (identityFile.hasPrefix("/") && !identityFile.contains(where: { $0.isNewline || $0 == "\0" }))
        else { throw ClientError.message("Enter a DNS/IPv4 host, SSH username, valid ports, and an optional absolute key path.") }
    }
}
@MainActor @Observable final class SSHTunnel {
    private let knownHostsFile: String?
    init(knownHostsFile: String? = nil) { self.knownHostsFile = knownHostsFile }
    private var process: Process?
    private var worker: Task<Void, Never>?
    private var generation = 0
    var error = ""
    func stop() {
        generation += 1; worker?.cancel(); worker = nil
        if let old = process, old.isRunning {
            old.terminate()
            Task { try? await Task.sleep(for: .seconds(2)); if old.isRunning { Darwin.kill(old.processIdentifier, SIGKILL) } }
        }
        process = nil
    }
    func start(_ config: SSHConnection) throws -> String {
        try config.validate(); stop(); error = ""
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ClientError.message("Cannot allocate tunnel socket.") }
        defer { Darwin.close(fd) }
        var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard result == 0 else { throw ClientError.message("Cannot bind a local tunnel port.") }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let read = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        guard read == 0 else { throw ClientError.message("Cannot read tunnel port.") }
        let port = Int(UInt16(bigEndian: address.sin_port)), current = generation
        worker = Task { [weak self] in
            var attempt = 0
            while !Task.isCancelled {
                guard let self, self.generation == current else { return }
                let child = Process(), pipe = Pipe()
                child.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
                var args = ["-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=10", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-p", String(config.port), "-L", "127.0.0.1:\(port):127.0.0.1:\(config.remotePort)"]
                if !config.identityFile.isEmpty { args += ["-i", config.identityFile] }
                if let hosts = self.knownHostsFile { args += ["-o", "UserKnownHostsFile=\(hosts)"] }
                args.append("\(config.user)@\(config.host)")
                child.arguments = args; child.standardInput = FileHandle.nullDevice; child.standardOutput = FileHandle.nullDevice; child.standardError = pipe
                pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                    let data = handle.availableData
                    guard !data.isEmpty else { return }
                    let text = String(decoding: data.suffix(2000), as: UTF8.self)
                    Task { @MainActor in if self?.generation == current { self?.error = text } }
                }
                let started = Date()
                do { try child.run(); self.process = child; while child.isRunning && !Task.isCancelled { try await Task.sleep(for: .seconds(1)) } }
                catch { if !Task.isCancelled { self.error = error.localizedDescription } }
                pipe.fileHandleForReading.readabilityHandler = nil
                if Task.isCancelled { return }
                if Date().timeIntervalSince(started) > 60 { attempt = 0 }
                let seconds = min(30, 1 << min(attempt, 5)); attempt += 1
                try? await Task.sleep(for: .seconds(seconds))
            }
        }
        return "http://127.0.0.1:\(port)"
    }
}
