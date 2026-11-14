export type NemuSuperResolutionCapabilities = {
  /** The model is bundled and this OS can load it (ML program, iOS 18+). */
  available: boolean;
  engine: "realesrgan-x4v3-coreml";
  /** Manifest revision (part of the upscale cache key). */
  engineRevision: string;
  /** Fixed model tile, pixels. */
  tileSize: 256;
  /** The model always predicts 4x. */
  scale: 4;
};

export type NemuSuperResolutionUpscaleOptions = {
  /** The cover's remote URL. Downloaded by the native side (once per URL). */
  uri: string;
  /** Request headers the source needs (Referer, …). */
  headers?: Record<string, string>;
};

export type NemuSuperResolutionUpscaleResult = {
  /** `file://` URI of the upscaled JPEG in the app's Caches directory. */
  path: string;
  /** The file was already on disk; the model did not run. */
  fromCache: boolean;
  width: number;
  height: number;
  /** Wall-clock ms of this call (0 when fromCache, model time excluded). */
  ms: number;
};

export type NemuSuperResolutionNativeModule = {
  getCapabilities: () => NemuSuperResolutionCapabilities;
  upscaleCover: (
    options: NemuSuperResolutionUpscaleOptions,
  ) => Promise<NemuSuperResolutionUpscaleResult>;
};
