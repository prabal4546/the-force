// swift-tools-version: 5.9
import PackageDescription

// Mentra Live -> target lock, over the Mentra Bluetooth SDK only (no Mentra App, no cloud).
let sdkVersion = "3.5.0-dev.1416"

let package = Package(
    name: "MentraBridge",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git", exact: Version(sdkVersion)!),
    ],
    targets: [
        // Marker reading and the wire contract. No SDK, so `swift test` needs no glasses.
        .target(name: "MentraBridgeCore"),
        .executableTarget(name: "MentraBridge", dependencies: [
            "MentraBridgeCore",
            .product(name: "MentraBluetoothSDK", package: "mentra-bluetooth-sdk-ios"),
        ]),
        .testTarget(name: "MentraBridgeCoreTests", dependencies: ["MentraBridgeCore"], exclude: ["Fixtures"]),
    ]
)
