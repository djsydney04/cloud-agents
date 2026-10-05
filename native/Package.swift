// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "CloudAgents", platforms: [.macOS(.v14)], products: [.executable(name: "CloudAgents", targets: ["CloudAgents"])], targets: [.executableTarget(name: "CloudAgents")])
