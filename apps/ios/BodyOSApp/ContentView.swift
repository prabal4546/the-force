import SwiftUI

struct ContentView: View {
    @ObservedObject var model: DemoViewModel

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    statusCard

                    Text("Mock gaze target")
                        .font(.headline)

                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(TargetID.allCases, id: \.self) { target in
                            Button(target.label) {
                                model.selectedTarget = target
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(model.selectedTarget == target ? .blue : .gray)
                        }
                    }

                    HStack {
                        Button("GRAB") { model.send(.grab) }
                            .buttonStyle(.borderedProminent)
                            .tint(.yellow)
                        Button("THROW") { model.send(.throwGesture) }
                            .buttonStyle(.borderedProminent)
                            .tint(.green)
                        Button("Reset") { model.reset() }
                            .buttonStyle(.bordered)
                    }

                    Text("Event log")
                        .font(.headline)

                    ForEach(Array(model.eventLog.enumerated()), id: \.offset) { _, event in
                        Text(event)
                            .font(.system(.caption, design: .monospaced))
                    }
                }
                .padding()
            }
            .navigationTitle("BodyOS")
        }
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("State")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(model.state.description)
                .font(.title2.bold())
            Text("Selected: \(model.selectedTarget.label)")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}
