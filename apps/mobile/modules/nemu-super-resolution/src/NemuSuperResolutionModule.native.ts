import { requireOptionalNativeModule } from "expo";
import type { NemuSuperResolutionNativeModule } from "./NemuSuperResolution.types";

/** Null in binaries built before this module existed. */
export default requireOptionalNativeModule<NemuSuperResolutionNativeModule>(
  "NemuSuperResolution",
);
