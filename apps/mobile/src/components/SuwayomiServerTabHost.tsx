import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useInstalledSources, useMobileLanguageSettings } from "@/data/mobileHooks";
import type { InstalledSource } from "@/data/schema";
import {
  createNemuNativeScreenOptions,
  MobileChip,
  NemuButton,
  NemuInlineEmptyState,
  useNemuTheme,
} from "@/design-system";
import { getMobileStrings } from "@/lib/mobileI18n";
import { selectSuwayomiServerSources } from "@/lib/selfHosted/serverSources";
import {
  makeMobileRuntimeSourceKey,
  normalizeInstalledSource,
} from "@/sources/mobileSourceRuntime";

function serverKey(source: InstalledSource): string {
  return makeMobileRuntimeSourceKey(normalizeInstalledSource(source));
}

/**
 * Extra bottom space so content clears the floating bottom tab bar
 * (the tabs use disableAutomaticContentInsets, so nothing adds it).
 */
const TAB_BAR_CLEARANCE = 96;

/**
 * The bottom-bar server tabs share one gate: pick the Suwayomi server to
 * show. One server goes straight in; several get a picker row on top;
 * none gets an empty state that opens the add-server form. The child
 * screen always receives a server, so it never has to resolve one itself.
 */
export function SuwayomiServerTabHost({
  title,
  children,
}: {
  title: string;
  children: (server: InstalledSource) => ReactNode;
}) {
  const { tokens } = useNemuTheme();
  const insets = useSafeAreaInsets();
  const { appLanguage } = useMobileLanguageSettings();
  const strings = getMobileStrings(appLanguage).serverSourceBrowser;
  const installed = useInstalledSources();
  const servers = useMemo(
    () => selectSuwayomiServerSources(installed.data ?? []),
    [installed.data],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected =
    servers.find((server) => serverKey(server) === selectedKey) ??
    servers[0] ??
    null;
  const nativeHeaderOptions = createNemuNativeScreenOptions(tokens, title);

  // The installed-source list starts empty and loads async: while it is
  // still loading, there is no evidence for "no server yet", so show a
  // spinner instead of the empty state (which the tab otherwise flashes
  // on every fresh launch).
  if (installed.loading) {
    return (
      <>
        <Stack.Screen options={{ ...nativeHeaderOptions, title }} />
        <View
          style={[
            styles.emptyRoot,
            {
              backgroundColor: tokens.background,
              paddingTop: insets.top,
              paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
            },
          ]}
        >
          <ActivityIndicator />
        </View>
      </>
    );
  }

  if (!selected) {
    return (
      <>
        <Stack.Screen options={{ ...nativeHeaderOptions, title }} />
        <View
          style={[
            styles.emptyRoot,
            {
              backgroundColor: tokens.background,
              paddingTop: insets.top,
              paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
            },
          ]}
        >
          <NemuInlineEmptyState
            icon="cloud-offline"
            title={strings.noServer}
            description={strings.noServerHint}
          />
          <NemuButton
            accessibilityLabel={strings.addServer}
            label={strings.addServer}
            onPress={() => router.push("/browse/server")}
            size="sm"
            variant="default"
          />
        </View>
      </>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.background }]}>
      {servers.length > 1 ? (
        <View style={[styles.picker, { paddingTop: insets.top + 12 }]}>
          <ScrollView
            horizontal
            scrollsToTop={false}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pickerContent}
          >
            {servers.map((server) => {
              const label = server.name ?? server.sourceId ?? "Suwayomi";
              const selectedKey = serverKey(server) === serverKey(selected);
              return (
                <MobileChip
                  key={serverKey(server)}
                  accessibilityLabel={label}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: selectedKey }}
                  label={label}
                  onPress={() => setSelectedKey(serverKey(server))}
                  selected={selectedKey}
                  variant="toggle"
                />
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      <View style={styles.child}>{children(selected)}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  emptyRoot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    gap: 12,
  },
  picker: {
    paddingBottom: 4,
  },
  pickerContent: {
    gap: 8,
    paddingHorizontal: 16,
  },
  child: {
    flex: 1,
  },
});
