import Foundation
import SafariServices

/// Safari containing-app bridge for the shared flippy-native process.
/// Add this file to the generated Safari Web Extension target and embed the
/// release flippy-native executable in Contents/Resources.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let transport = NativeTransport()

    func beginRequest(with context: NSExtensionContext) {
        guard
            let item = context.inputItems.first as? NSExtensionItem,
            let message = item.userInfo?[SFExtensionMessageKey]
        else {
            context.cancelRequest(withError: BridgeError.invalidMessage)
            return
        }

        Self.transport.send(message) { result in
            switch result {
            case .success(let response):
                let reply = NSExtensionItem()
                reply.userInfo = [SFExtensionMessageKey: response]
                context.completeRequest(returningItems: [reply])
            case .failure(let error):
                context.cancelRequest(withError: error)
            }
        }
    }
}

private final class NativeTransport {
    private let queue = DispatchQueue(label: "au.com.otherstuff.flippy.native")
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?

    func send(_ message: Any, completion: @escaping (Result<Any, Error>) -> Void) {
        queue.async {
            do {
                try self.ensureProcess()
                let payload = try JSONSerialization.data(withJSONObject: message)
                guard payload.count > 0, payload.count <= 1_048_576 else { throw BridgeError.messageTooLarge }
                var length = UInt32(payload.count).littleEndian
                let prefix = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
                try self.input?.write(contentsOf: prefix + payload)
                let responseLength = try self.readExactly(4).withUnsafeBytes { bytes in
                    UInt32(littleEndian: bytes.loadUnaligned(as: UInt32.self))
                }
                guard responseLength > 0, responseLength <= 1_048_576 else { throw BridgeError.messageTooLarge }
                let responseData = try self.readExactly(Int(responseLength))
                let response = try JSONSerialization.jsonObject(with: responseData)
                DispatchQueue.main.async { completion(.success(response)) }
            } catch {
                self.stopProcess()
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }
    }

    private func ensureProcess() throws {
        if process?.isRunning == true { return }
        guard let executable = Bundle.main.url(forResource: "flippy-native", withExtension: nil) else {
            throw BridgeError.nativeHostMissing
        }
        let process = Process()
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.executableURL = executable
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        self.process = process
        input = stdin.fileHandleForWriting
        output = stdout.fileHandleForReading
    }

    private func readExactly(_ count: Int) throws -> Data {
        var result = Data()
        while result.count < count {
            guard let chunk = try output?.read(upToCount: count - result.count), !chunk.isEmpty else {
                throw BridgeError.nativeHostClosed
            }
            result.append(chunk)
        }
        return result
    }

    private func stopProcess() {
        try? input?.close()
        try? output?.close()
        process?.terminate()
        process = nil; input = nil; output = nil
    }
}

private enum BridgeError: LocalizedError {
    case invalidMessage, messageTooLarge, nativeHostMissing, nativeHostClosed
    var errorDescription: String? {
        switch self {
        case .invalidMessage: "Invalid Safari extension message"
        case .messageTooLarge: "Native message exceeds the 1 MiB limit"
        case .nativeHostMissing: "flippy-native is missing from the containing app"
        case .nativeHostClosed: "flippy-native closed unexpectedly"
        }
    }
}
