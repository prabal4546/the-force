import SwiftUI
import UIKit

@MainActor
final class AgentMemoryViewModel: ObservableObject {
    @Published private(set) var snapshot: AgentMemorySnapshot?
    @Published private(set) var photos: [String: Data] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

    private var loadID = 0

    func load(address: String, token: String, deviceID: String) async {
        loadID += 1
        let currentLoad = loadID
        isLoading = false
        errorMessage = nil
        snapshot = nil
        photos = [:]
        let trimmedAddress = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedDeviceID = deviceID.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let url = URL(string: trimmedAddress),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil else {
            errorMessage = "Enter a valid HTTP API address."
            return
        }
        guard !trimmedDeviceID.isEmpty else {
            errorMessage = "Enter a band device ID."
            return
        }

        let client = AgentMemoryClient(baseURL: url, token: token)
        isLoading = true
        errorMessage = nil
        do {
            let result = try await client.memory(for: trimmedDeviceID)
            guard currentLoad == loadID else { return }
            snapshot = result
            photos = [:]

            for artifactID in Set(result.recentTurns.compactMap(\.imageArtifactID)) {
                let data = try? await client.photo(for: artifactID)
                guard currentLoad == loadID else { return }
                if let data { photos[artifactID] = data }
            }
        } catch {
            guard currentLoad == loadID else { return }
            errorMessage = error.localizedDescription
        }
        if currentLoad == loadID { isLoading = false }
    }
}

struct MemoryView: View {
    private struct SelectedPhoto: Identifiable {
        let id: String
        let data: Data
    }

    @AppStorage("bodyos.memoryDeviceID") private var deviceID = "vexo-76"
    @StateObject private var memory = AgentMemoryViewModel()
    @State private var apiAddress: String
    @State private var sessionToken = ""
    @State private var selectedPhoto: SelectedPhoto?

    init(macHost: String) {
        _apiAddress = State(initialValue: Self.defaultAddress(for: macHost))
    }

    var body: some View {
        List {
            Section("Device API") {
                TextField("http://Mac-IP:8000", text: $apiAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                TextField("Band device ID", text: $deviceID)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Session token (if configured)", text: $sessionToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Refresh memory") {
                    Task { await refresh() }
                }
                .disabled(memory.isLoading)
                if memory.isLoading {
                    ProgressView("Loading memory")
                }
                if let errorMessage = memory.errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }

            Section("Remembered facts") {
                if let facts = memory.snapshot?.facts, !facts.isEmpty {
                    ForEach(Array(facts.enumerated()), id: \.offset) { _, fact in
                        Text(fact)
                    }
                } else {
                    Text("No facts remembered yet.")
                        .foregroundStyle(.secondary)
                }
            }

            Section("Recent conversations") {
                if let turns = memory.snapshot?.recentTurns, !turns.isEmpty {
                    ForEach(turns) { turn in
                        turnRow(turn)
                    }
                } else {
                    Text("No completed commands yet.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Memory")
        .refreshable { await refresh() }
        .task { await refresh() }
        .sheet(item: $selectedPhoto) { selected in
            NavigationStack {
                ScrollView {
                    if let image = UIImage(data: selected.data) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: .infinity)
                    }
                }
                .navigationTitle("Glasses photo")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { selectedPhoto = nil }
                    }
                }
            }
        }
    }

    private func turnRow(_ turn: AgentMemoryTurn) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(turn.createdAt)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let tool = turn.tool {
                    Text(tool.capitalized)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
            HStack(alignment: .top, spacing: 12) {
                if let artifactID = turn.imageArtifactID {
                    if let bytes = memory.photos[artifactID],
                       let image = UIImage(data: bytes) {
                        Button {
                            selectedPhoto = SelectedPhoto(id: artifactID, data: bytes)
                        } label: {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 88, height: 88)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Open glasses photo")
                    } else {
                        Image(systemName: "photo")
                            .frame(width: 88, height: 88)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Photo unavailable")
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("You: \(turn.command)")
                    if let understanding = turn.understanding, !understanding.isEmpty {
                        Text("Saw: \(understanding)")
                            .foregroundStyle(.secondary)
                    }
                    if let answer = turn.answer, !answer.isEmpty {
                        Text("Agent: \(answer)")
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func refresh() async {
        await memory.load(address: apiAddress, token: sessionToken, deviceID: deviceID)
    }

    private static func defaultAddress(for macHost: String) -> String {
        let host = macHost.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = host.contains("://") ? host : "http://\(host)"
        guard let source = URLComponents(string: candidate), let name = source.host else {
            return "http://127.0.0.1:8000"
        }
        var api = URLComponents()
        api.scheme = source.scheme == "wss" || source.scheme == "https" ? "https" : "http"
        api.host = name
        api.port = 8000
        return api.url?.absoluteString ?? "http://127.0.0.1:8000"
    }
}
