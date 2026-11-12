import type { NemuSuperResolutionNativeModule } from "./NemuSuperResolution.types";

/** Web and the Bun test runner have no native engines. */
const NemuSuperResolutionModule: NemuSuperResolutionNativeModule | null = null;
export default NemuSuperResolutionModule;
