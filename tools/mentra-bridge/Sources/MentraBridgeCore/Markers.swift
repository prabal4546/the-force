import CoreGraphics
import Foundation
import ImageIO
import Vision

/// The five printed QR markers (docs/mentra-markers) and the target id each one stands for.
/// Same texts and ids as `TargetMarker` in the iOS app and `target.detected` in the Mac runtime.
public enum TargetMarker {
    public static let targets: [String: String] = [
        "bodyos://device/mac": "mac",
        "bodyos://device/external-display": "externalDisplay",
        "bodyos://device/gimbal": "gimbal",
        "bodyos://person/red": "personRed",
        "bodyos://person/blue": "personBlue",
    ]

    /// The target a decoded QR text stands for, or nil for any other QR code.
    /// Only exact marker texts count; scheme and host are case-insensitive, spaces around are ignored.
    public static func target(for payload: String) -> String? {
        let text = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text),
              url.scheme?.lowercased() == "bodyos",
              let host = url.host?.lowercased(),
              url.query == nil, url.fragment == nil
        else { return nil }
        var path = url.path
        while path.hasSuffix("/") { path.removeLast() }
        return targets["bodyos://\(host)\(path)"]
    }
}

/// One QR code found in a photo.
public struct DetectedCode: Equatable {
    public let payload: String
    /// The marker's target id, or nil when the QR code is not one of the five markers.
    public let target: String?
    /// Normalized image coordinates (0...1, origin bottom-left, as Vision reports).
    public let boundingBox: CGRect

    public init(payload: String, target: String?, boundingBox: CGRect) {
        self.payload = payload
        self.target = target
        self.boundingBox = boundingBox
    }
}

public struct UnreadablePhoto: Error, CustomStringConvertible {
    public var description: String { "The glasses sent something that is not a photo." }
}

/// Local QR decoding with Apple Vision. No network.
public enum MarkerDecoder {
    public static func decode(_ imageData: Data) throws -> [DetectedCode] {
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              CGImageSourceGetCount(source) > 0
        else { throw UnreadablePhoto() }

        // Respect the JPEG's EXIF orientation so "center of the image" means what the wearer saw.
        var orientation = CGImagePropertyOrientation.up
        if let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let raw = props[kCGImagePropertyOrientation] as? UInt32,
           let value = CGImagePropertyOrientation(rawValue: raw) {
            orientation = value
        }

        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        try VNImageRequestHandler(data: imageData, orientation: orientation, options: [:]).perform([request])
        return (request.results ?? []).compactMap { observation in
            guard let text = observation.payloadStringValue else { return nil }
            return DetectedCode(payload: text, target: TargetMarker.target(for: text), boundingBox: observation.boundingBox)
        }
    }
}

/// Decides which marker the wearer is looking at when a photo shows more than one.
///
/// The glasses' camera points where the head points, so the marker nearest the middle of the
/// photo wins. A clearly bigger marker (closer to the wearer) wins a near-tie.
public enum TargetPicker {
    public static func pick(_ codes: [DetectedCode]) -> DetectedCode? {
        codes.filter { $0.target != nil }.min { score($0) < score($1) }
    }

    /// Lower is better: distance from the photo's center, made a little smaller for bigger markers.
    static func score(_ code: DetectedCode) -> CGFloat {
        let box = code.boundingBox
        let dx = box.midX - 0.5
        let dy = box.midY - 0.5
        return (dx * dx + dy * dy).squareRoot() - 0.25 * max(box.width, box.height)
    }
}
