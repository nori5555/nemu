import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMobileDataStore } from "@/data/mobileDataContext";
import { useSourceSettings } from "@/data/mobileHooks";
import type { InstalledSource } from "@/data/schema";
import { getMobileInstalledSourceSettingsKeys } from "@/lib/mobileInstalledSourceKeys";
import {
  loadMobileSourceSettingsByKeys,
  makeMobileSourceKey,
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
 * Run calls against the cached executor session for one installed server.
 * Settings come from the saved settings first (the login lives there) and
 * fall back to the live settings hook while it is still loading. The same
 * resolver backs the server-source browser and the server-library tab, so a
 * server's login is resolved exactly one way.
 */
export function useSelfHostedServerSession(
  installedSource: InstalledSource | null,
  unsupportedMessage: string,
) {
  const store = useMobileDataStore();
  const normalizedSource = useMemo(
    () => (installedSource ? normalizeInstalledSource(installedSource) : null),
    [installedSource],
  );
  const sourceKey = useMemo(
    () =>
      normalizedSource
        ? makeMobileSourceKey(normalizedSource.registryId, normalizedSource.sourceId)
        : null,
    [normalizedSource],
  );
  const sourceSettingsKeys = useMemo(
    () => (installedSource ? getMobileInstalledSourceSettingsKeys(installedSource) : []),
    [installedSource],
  );
  const liveSourceSettings = useSourceSettings(sourceKey, [], sourceSettingsKeys);
  const liveSourceSettingsRef = useRef(liveSourceSettings.data);
  useEffect(() => {
    liveSourceSettingsRef.current = liveSourceSettings.data;
  }, [liveSourceSettings.data]);

  const runWithSession = useCallback(
    async <T,>(fn: (session: SelfHostedReadySession) => Promise<T>): Promise<T> => {
      if (!installedSource) throw new Error(unsupportedMessage);
      const normalized = normalizeInstalledSource(installedSource);
      const runtimeSourceKey = makeMobileRuntimeSourceKey(normalized);
      const saved = await loadMobileSourceSettingsByKeys(store, [
        runtimeSourceKey,
        ...getMobileInstalledSourceSettingsKeys(installedSource),
      ]);
      const settings = mergeSourceSettingValues(
        installedSource.packageMetadata?.settings ?? [],
        saved?.values ?? liveSourceSettingsRef.current,
      );
      return defaultMobileSourceSessionCache.withSession(
        normalized,
        { settings },
        async (session) => {
          if (session.status === "blocked") throw new Error(session.detail);
          return fn(session);
        },
      );
    },
    [installedSource, store, unsupportedMessage],
  );

  return { runWithSession };
}
