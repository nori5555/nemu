import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ReaderSegmentedChipRow } from "@/components/reader/ReaderSegmentedChipRow";
import { useInstalledSources, useMobileLanguageSettings } from "@/data/mobileHooks";
import {
  createNemuNativeScreenOptions,
  useNemuTheme,
} from "@/design-system";
import { getMobileStrings } from "@/lib/mobileI18n";
import { mobileInstalledSourceMatchesRoute } from "@/lib/mobileInstalledSourceKeys";
import { normalizeMobileSourceRouteParam } from "@/lib/mobileSourceRoutes";
import { ServerLibraryScreen } from "@/screens/ServerLibraryScreen";
import { ServerSourceBrowserScreen } from "@/screens/ServerSourceBrowserScreen";

type ServerPage = "library" | "sources";

/**
 * One bottom-bar tab for the Suwayomi server: its Library and its
 * extension-source browser live under one header, switched with a
 * segmented control. Both pages stay mounted so a search (or a library
 * scroll position) survives switching back and forth.
 */
export function ServerScreen({
  registryId,
  sourceId,
}: {
  registryId?: string;
  sourceId?: string;
}) {
  const { tokens } = useNemuTheme();
  const insets = useSafeAreaInsets();
  const { appLanguage } = useMobileLanguageSettings();
  const strings = getMobileStrings(appLanguage);
  const installed = useInstalledSources();
  const [page, setPage] = useState<ServerPage>("library");

  const installedSource = useMemo(
    () =>
      installed.data.find((item) =>
        mobileInstalledSourceMatchesRoute(
          item,
          normalizeMobileSourceRouteParam(registryId),
          normalizeMobileSourceRouteParam(sourceId),
        ),
      ) ?? null,
    [installed.data, registryId, sourceId],
  );

  const screenTitle = installedSource?.name ?? strings.nav.server;
  const nativeHeaderOptions = createNemuNativeScreenOptions(tokens, screenTitle);

  return (
    <>
      <Stack.Screen options={{ ...nativeHeaderOptions, title: screenTitle }} />
      <View style={[styles.root, { backgroundColor: tokens.background }]}>
        <View style={[styles.segments, { paddingTop: insets.top + 12 }]}>
          <ReaderSegmentedChipRow<ServerPage>
            accessibilityLabel={strings.nav.server}
            options={[
              { value: "library", label: strings.nav.serverLibrary },
              { value: "sources", label: strings.nav.serverSources },
            ]}
            value={page}
            onChange={setPage}
          />
        </View>
        <View style={page === "library" ? styles.page : styles.pageHidden}>
          <ServerLibraryScreen registryId={registryId} sourceId={sourceId} showHeader={false} />
        </View>
        <View style={page === "sources" ? styles.page : styles.pageHidden}>
          <ServerSourceBrowserScreen
            registryId={registryId}
            sourceId={sourceId}
            showHeader={false}
          />
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  segments: {
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  page: {
    flex: 1,
  },
  pageHidden: {
    display: "none",
  },
});
