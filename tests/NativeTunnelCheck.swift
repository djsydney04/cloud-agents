import Foundation

enum ClientError: LocalizedError { case message(String) }
@main struct NativeTunnelCheck {
    @MainActor static func main() async throws {
        let args=CommandLine.arguments
        let config=SSHConnection(host:"127.0.0.1",user:"root",port:Int(args[1])!,remotePort:7420,identityFile:args[2])
        let tunnel=SSHTunnel(knownHostsFile:args[3]);defer {tunnel.stop()}
        func reaches(_ endpoint:String) async -> Bool {
            var request=URLRequest(url:URL(string:endpoint)!);request.timeoutInterval=1
            guard let (data,_)=try? await URLSession.shared.data(for:request) else{return false}
            return String(decoding:data,as:UTF8.self).trimmingCharacters(in:.whitespacesAndNewlines)=="tunnel-ok"
        }
        func waitFor(_ endpoint:String) async throws {
            for _ in 0..<100 {if await reaches(endpoint){return};try await Task.sleep(for:.milliseconds(200))}
            throw ClientError.message("Native tunnel failed: \(tunnel.error)")
        }
        let first=try tunnel.start(config);try await waitFor(first)
        let second=try tunnel.start(config);try await waitFor(second)
        assert(first != second)
        let oldAlive=await reaches(first);assert(!oldAlive)
        tunnel.stop();try await Task.sleep(for:.milliseconds(300))
        let stillAlive=await reaches(second);assert(!stillAlive)
        print("PASS: native SSH forwarding, connection replacement, and cleanup")
    }
}
