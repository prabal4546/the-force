import SwiftUI

@main
struct BodyOSApp: App {
    @StateObject private var model = DemoViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
        }
    }
}
