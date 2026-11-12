import ExpoModulesCore
import Foundation
import OSLog
import UIKit

/// Off by default; `log stream --level debug --predicate 'subsystem == "pm.nemu.super-resolution"'`.
private let srModuleLog = Logger(subsystem: "pm.nemu.super-resolution", category: "module")

private func codedException(_ error: Error) -> Exception {
  if let exception = error as? Exception { return exception }
  if error is CancellationError {
    return Exception(name: "NemuSuperResolution", description: "Cancelled.", code: "E_CANCELLED")
  }
  if let failure = error as? NemuSuperResolutionEngine.Failure {
    return Exception(name: "NemuSuperResolution", description: failure.message, code: failure.code)
  }
  return Exception(
    name: "NemuSuperResolution", description: error.localizedDescription, code: "E_SR_ENGINE")
}

public final class NemuSuperResolutionModule: Module {
  private var memoryWarningObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("NemuSuperResolution")

    OnCreate {
      self.memoryWarningObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
      ) { _ in
        Task { await NemuSuperResolutionEngine.Store.shared.unload() }
      }
    }

    OnDestroy {
      if let observer = self.memoryWarningObserver {
        NotificationCenter.default.removeObserver(observer)
      }
    }

    Function("getCapabilities") { () -> [String: Any] in
      [
        "available": NemuSuperResolutionEngine.modelsSupported,
        "engine": "realesrgan-x4v3-coreml",
        "engineRevision": NemuSuperResolutionEngine.modelRevision,
        "tileSize": NemuSuperResolutionEngine.tileSize,
        "scale": NemuSuperResolutionEngine.scale,
      ]
    }

    AsyncFunction("upscaleCover") {
      (options: [String: Any]) async throws -> [String: Any] in
      do {
        guard let uri = options["uri"] as? String, !uri.isEmpty else {
          throw NemuSuperResolutionEngine.Failure(
            code: "E_SR_DOWNLOAD", message: "upscaleCover needs a cover uri.")
        }
        let headers = options["headers"] as? [String: String] ?? [:]
        let result = try await NemuSuperResolutionEngine.upscaleCover(uri: uri, headers: headers)
        return [
          "path": result.url.absoluteString,
          "fromCache": result.fromCache,
          "width": result.width,
          "height": result.height,
          "ms": result.ms,
        ]
      } catch {
        srModuleLog.error("upscaleCover failed: \(error.localizedDescription, privacy: .public)")
        throw codedException(error)
      }
    }
  }
}
