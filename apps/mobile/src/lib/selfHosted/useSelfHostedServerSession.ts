import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMobileDataStore } from "@/data/mobileDataContext";
import { useSourceSettings } from "@/data/mobileHooks";
import type { InstalledSource } from "@/data/schema";
import { getMobileInstalledSourceSettingsKeys } from "@/lib/mobileInstalledSourceKeys";
import { makeMobileSourceKey } from "@/lib/mobileSourceSettings";
import { normalizeInstalledSource } from "@/sources/mobileSourceRuntime";
import {
  runWithSuwayomiServerSession,
  type SelfHostedReadySession,
} from "./serverSession";

export type { SelfHostedReadySession };

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
    async <T,>(fn: (session: SelfHostedReadySession) => Promise<T>): Promise<T> =>
      runWithSuwayomiServerSession(store, installedSource, fn, {
        unsupportedMessage,
        fallbackSettings: liveSourceSettingsRef.current,
      }),
    [installedSource, store, unsupportedMessage],
  );

  return { runWithSession };
}
