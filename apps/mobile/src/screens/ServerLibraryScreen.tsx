import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ServerMangaGridCard } from "@/components/ServerMangaGridCard";
import {
  useInstalledSources,
  useMobileLanguageSettings,
} from "@/data/mobileHooks";
import {
  createNemuNativeScreenOptions,
  NemuButton,
  NemuInlineEmptyState,
  useNemuTheme,
} from "@/design-system";
import { getMobileStrings } from "@/lib/mobileI18n";
import { mobileInstalledSourceMatchesRoute } from "@/lib/mobileInstalledSourceKeys";
import { setMobileSourceDetailSeed } from "@/lib/mobileSourceDetailSeed";
import {
  getMobileSourceMangaHref,
  normalizeMobileSourceRouteParam,
} from "@/lib/mobileSourceRoutes";
import { isSuwayomiServerSource } from "@/lib/selfHosted/serverSources";
import { useSelfHostedServerSession } from "@/lib/selfHosted/useSelfHostedServerSession";
import {
  mapAidokuMangasToLiveSearchMangaWithImageRequests,
  type MobileLiveSearchManga,
} from "@/sources/mobileSourceSearch";

type LibraryState =
  | { status: "idle" }
  | { status: "loading"; items: MobileLiveSearchManga[] }
  | {
      status: "ready";
      items: MobileLiveSearchManga[];
      page: number;
      hasMore: boolean;
    }
  | { status: "error"; items: MobileLiveSearchManga[]; detail: string };

/**
 * Extra bottom space so list content clears the floating bottom tab bar
 * (the tabs use disableAutomaticContentInsets, so nothing adds it).
 */
const TAB_BAR_CLEARANCE = 96;

/**
 * A Suwayomi server's Library listing, one tap from the bottom bar: the
 * same listing the Browse page shows under Library, without drilling in
 * through Browse first. Tap a cover to open the existing detail/reader.
 */
export function ServerLibraryScreen({
  registryId: registryIdProp,
  sourceId: sourceIdProp,
  showHeader = true,
}: {
  /** Tab callers pass the server directly; the route passes it via params. */
  registryId?: string;
  sourceId?: string;
  /** The combined server tab renders its own header above both pages. */
  showHeader?: boolean;
} = {}) {
  const params = useLocalSearchParams<{ registryId: string; sourceId: string }>();
  const registryId = registryIdProp ?? normalizeMobileSourceRouteParam(params.registryId);
  const sourceId = sourceIdProp ?? normalizeMobileSourceRouteParam(params.sourceId);
  const { tokens } = useNemuTheme();
  const insets = useSafeAreaInsets();
  const { appLanguage } = useMobileLanguageSettings();
  const strings = getMobileStrings(appLanguage).serverLibrary;
  const browserStrings = getMobileStrings(appLanguage).serverSourceBrowser;
  const commonStrings = getMobileStrings(appLanguage).common;
  const installed = useInstalledSources();

  const installedSource = useMemo(
    () =>
      installed.data.find((item) =>
        mobileInstalledSourceMatchesRoute(item, registryId, sourceId),
      ) ?? null,
    [installed.data, registryId, sourceId],
  );
  const isSuwayomi = isSuwayomiServerSource(installedSource);

  const { runWithSession } = useSelfHostedServerSession(installedSource, browserStrings.unsupported);

  const [libraryState, setLibraryState] = useState<LibraryState>({ status: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const loadMoreInFlightRef = useRef(false);
  const requestRef = useRef(0);

  const screenTitle = installedSource?.name ?? strings.title;
  const nativeHeaderOptions = createNemuNativeScreenOptions(tokens, screenTitle);

  const loadLibrary = useCallback(
    async (page: number, append: boolean) => {
      if (!installedSource || !isSuwayomi) return;
      const requestId = ++requestRef.current;
      const previousItems =
        append && libraryState.status === "ready" ? libraryState.items : [];
      if (page === 1 && !append) setRefreshing(true);
      else setLibraryState({ status: "loading", items: previousItems });
      try {
        const result = await runWithSession(async (session) => {
          const pageResult = await session.source.getMangaListForListing(
            { id: "library", name: "Library" },
            page,
          );
          const items = await mapAidokuMangasToLiveSearchMangaWithImageRequests(
            session.source,
            pageResult.entries,
          );
          return { items, hasMore: pageResult.hasNextPage };
        });
        if (requestId !== requestRef.current) return;
        setLibraryState({
          status: "ready",
          items: [...previousItems, ...result.items],
          page,
          hasMore: result.hasMore,
        });
      } catch (error) {
        if (requestId !== requestRef.current) return;
        setLibraryState({
          status: "error",
          items: previousItems,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (requestId === requestRef.current) setRefreshing(false);
        loadMoreInFlightRef.current = false;
      }
    },
    [installedSource, isSuwayomi, libraryState, runWithSession],
  );

  useEffect(() => {
    void loadLibrary(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installedSource?.id]);

  const refresh = useCallback(() => {
    void loadLibrary(1, false);
  }, [loadLibrary]);

  const loadMore = useCallback(() => {
    if (libraryState.status !== "ready" || !libraryState.hasMore) return;
    if (loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    void loadLibrary(libraryState.page + 1, true);
  }, [libraryState, loadLibrary]);

  const openManga = useCallback(
    (item: MobileLiveSearchManga) => {
      setMobileSourceDetailSeed(registryId, sourceId, item.id, item);
      router.push(
        getMobileSourceMangaHref({
          registryId,
          sourceId,
          mangaId: item.id,
          mangaTitle: item.title,
        }),
      );
    },
    [registryId, sourceId],
  );

  const renderItem = useCallback(
    ({ item }: { item: MobileLiveSearchManga }) => (
      <View style={styles.cell}>
        <ServerMangaGridCard
          item={item}
          openLabel={browserStrings.openManga}
          onPress={() => openManga(item)}
        />
      </View>
    ),
    [browserStrings.openManga, openManga],
  );

  const items =
    libraryState.status === "ready" ||
    libraryState.status === "loading" ||
    libraryState.status === "error"
      ? libraryState.items
      : [];
  const loading =
    libraryState.status === "loading" || libraryState.status === "idle";
  const error = libraryState.status === "error" ? libraryState.detail : null;
  const hasMore = libraryState.status === "ready" && libraryState.hasMore;

  return (
    <>
      {showHeader ? (
        <Stack.Screen options={{ ...nativeHeaderOptions, title: screenTitle }} />
      ) : null}
      <View style={[styles.root, { backgroundColor: tokens.background }]}>
        {installed.loading ? (
          <View style={[styles.center, { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }]}>
            <ActivityIndicator />
          </View>
        ) : !isSuwayomi || !installedSource ? (
          <NemuInlineEmptyState
            icon="cloud-offline"
            title={browserStrings.unsupported}
            description={browserStrings.noSourcesHint}
          />
        ) : loading && items.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : error && items.length === 0 ? (
          <View style={[styles.center, { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }]}>
            <NemuInlineEmptyState
              icon="warning-outline"
              title={strings.loadFailed}
              description={error}
            />
            <View style={styles.retryRow}>
              <NemuButton
                accessibilityLabel={commonStrings.retry}
                label={commonStrings.retry}
                onPress={refresh}
                size="sm"
                variant="secondary"
              />
            </View>
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            numColumns={3}
            columnWrapperStyle={styles.row}
            contentContainerStyle={[
              styles.list,
              { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE },
            ]}
            refreshing={refreshing}
            onRefresh={refresh}
            ListEmptyComponent={
              libraryState.status === "ready" ? (
                <NemuInlineEmptyState
                  icon="book-outline"
                  title={strings.emptyLibrary}
                  description={strings.emptyLibraryHint}
                />
              ) : undefined
            }
            ListFooterComponent={
              <>
                {error ? (
                  <NemuInlineEmptyState
                    icon="warning-outline"
                    title={strings.loadFailed}
                    description={error}
                  />
                ) : null}
                {hasMore ? (
                  <View style={styles.loadMore}>
                    <NemuButton
                      accessibilityLabel={browserStrings.loadMore}
                      disabled={loading}
                      label={loading ? browserStrings.loadingMore : browserStrings.loadMore}
                      loading={loading}
                      onPress={loadMore}
                      size="sm"
                      variant="secondary"
                    />
                  </View>
                ) : null}
              </>
            }
            renderItem={renderItem}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    gap: 10,
  },
  list: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 12,
  },
  row: {
    gap: 12,
  },
  cell: {
    flex: 1,
  },
  loadMore: {
    alignItems: "center",
    paddingVertical: 12,
  },
  retryRow: {
    alignItems: "center",
    paddingVertical: 8,
  },
});
