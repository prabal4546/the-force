import SwiftUI

struct ContentView: View {
    @ObservedObject var model: DemoViewModel

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    connectionCard
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
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding()
            }
            .navigationTitle("The Force")
        }
    }

    private var connectionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Hardware")
                .font(.headline)

            statusRow("Mac runtime", value: model.macConnection.description, active: model.macConnection.isConnected)
            statusRow("Mentra", value: model.mentraStatus, active: true)
            statusRow("Flow 2 Pro", value: model.gimbalStatus, active: true)

            TextField("Mac IP or ws:// address", text: $model.macHost)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)

            HStack {
                Button("Connect Mac") { model.connectMac() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.macConnection.isConnected)
                Button("Disconnect") { model.disconnectMac() }
                    .buttonStyle(.bordered)
                    .disabled(!model.macConnection.isConnected)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Coordinator")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(model.state.description)
                .font(.title2.bold())
            Text("Selected: \(model.selectedTarget.label)")
                .foregroundStyle(.secondary)
            if let error = model.lastError {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private func statusRow(_ label: String, value: String, active: Bool) -> some View {
        HStack {
            Circle()
                .fill(active ? Color.green : Color.orange)
                .frame(width: 9, height: 9)
            Text(label)
            Spacer()
            Text(value)
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
    }
}
