import { useEffect, useState } from "react";
import { NemuSuperResolutionModule } from "../../modules/nemu-super-resolution";

/**
 * The featured cover, upscaled 4x on-device (Real-ESRGAN x4v3, Neural
 * Engine). Returns the local `file://` URI of the upscaled JPEG once it is
 * ready, or null while it is still the original cover: the caller keeps
 * showing the original and swaps in the upscaled file when it lands, so the
 * upscale never blocks the library from painting. One upscale per cover URL
 * — the native side caches the file on disk, so a second mount returns
 * immediately. A failed upscale (no model in this build, download or decode
 * error) just leaves the original cover in place.
 */
export function useSuperResolvedCover(
  uri: string | null | undefined,
  headers?: Record<string, string>,
): string | null {
  // Keyed by the URI it was upscaled from: when the cover changes, the old
  // file stops matching and the caller falls back to the original until the
  // new upscale lands — no wrong-cover flash, no synchronous reset.
  const [upscaled, setUpscaled] = useState<{ uri: string; path: string } | null>(null);
  // Headers are small (Referer, UA) and the native side returns from its
  // disk cache when the URI is unchanged, so re-running on a header change
  // is cheap.
  const headersKey = headers ? JSON.stringify(headers) : "";

  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    const module = NemuSuperResolutionModule;
    if (!module || !module.getCapabilities().available) return;
    const requestHeaders = headersKey ? (JSON.parse(headersKey) as Record<string, string>) : undefined;
    void module
      .upscaleCover({ uri, headers: requestHeaders })
      .then((result) => {
        if (!cancelled) setUpscaled({ uri, path: result.path });
      })
      .catch(() => {
        // Keep the original cover; the failure is invisible by design.
      });
    return () => {
      cancelled = true;
    };
  }, [uri, headersKey]);

  return upscaled && upscaled.uri === uri ? upscaled.path : null;
}

/** False on web, in tests, and in binaries built without the model. */
export function superResolutionAvailable(): boolean {
  return NemuSuperResolutionModule?.getCapabilities().available ?? false;
}
