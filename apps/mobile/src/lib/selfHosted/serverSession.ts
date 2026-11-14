import type { MobileDataStore } from "@/data/storeTypes";
import type { InstalledSource } from "@/data/schema";
import { getMobileInstalledSourceSettingsKeys } from "@/lib/mobileInstalledSourceKeys";
import {
  loadMobileSourceSettingsByKeys,
  mergeSourceSettingValues,
} from "@/lib/mobileSourceSettings";
import {
  defaultMobileSourceSessionCache,
} from "@/sources/mobileSourceExecutorCache";
import type { MobileSourceExecutorSession } from "@/sources/mobileSourceExecutor";
import {
  makeMobileRuntimeSourceKey,
  normalizeInstalledSource,
} from "@/sources/mobileSourceRuntime";

export type SelfHostedReadySession = Extract<
  MobileSourceExecutorSession,
  { status: "ready" }
>;

/**
 * Run calls against the cached executor session for one installed server,
 * outside React: settings come from the saved settings first (the login
 * lives there) and fall back to `fallbackSettings` when nothing is saved.
 * This is the same resolution the `useSelfHostedServerSession` hook does;
 * the hook is a thin wrapper around this so the login is resolved exactly
 * one way, in screens and in background sync alike.
 */
export async function runWithSuwayomiServerSession<T>(
  store: MobileDataStore,
  installedSource: InstalledSource | null | undefined,
  fn: (session: SelfHostedReadySession) => Promise<T>,
  options: {
    unsupportedMessage?: string;
    fallbackSettings?: Record<string, unknown>;
  } = {},
): Promise<T> {
  if (!installedSource) {
    throw new Error(options.unsupportedMessage ?? "This server does not support browsing sources.");
  }
  const normalized = normalizeInstalledSource(installedSource);
  const runtimeSourceKey = makeMobileRuntimeSourceKey(normalized);
  const saved = await loadMobileSourceSettingsByKeys(store, [
    runtimeSourceKey,
    ...getMobileInstalledSourceSettingsKeys(installedSource),
  ]);
  const settings = mergeSourceSettingValues(
    installedSource.packageMetadata?.settings ?? [],
    saved?.values ?? options.fallbackSettings,
  );
  return defaultMobileSourceSessionCache.withSession(
    normalized,
    { settings },
    async (session) => {
      if (session.status === "blocked") throw new Error(session.detail);
      return fn(session);
    },
  );
}
