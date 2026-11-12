import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { ServerMangaGridCard } from "@/components/ServerMangaGridCard";
import { emitMobileLibraryDataChanged } from "@/data/mobileDataEvents";
import {
  useInstalledSources,
  useMobileLanguageSettings,
} from "@/data/mobileHooks";
import {
  createNemuNativeScreenOptions,
  MobileChip,
  NemuButton,
  NemuInlineEmptyState,
  NemuText,
  nemuFontWeight,
  useNemuTheme,
} from "@/design-system";
import { formatMobileString, getMobileStrings } from "@/lib/mobileI18n";
import { mobileInstalledSourceMatchesRoute } from "@/lib/mobileInstalledSourceKeys";
import { setMobileSourceDetailSeed } from "@/lib/mobileSourceDetailSeed";
import {
  getMobileSourceMangaHref,
  normalizeMobileSourceRouteParam,
} from "@/lib/mobileSourceRoutes";
import {
  filterServerSourcesByLanguage,
  isSuwayomiServerSource,
  type ServerSourceLanguageFilter,
} from "@/lib/selfHosted/serverSources";
import type { SelfHostedSource } from "@/lib/selfHosted/backend";
import { useSelfHostedServerSession } from "@/lib/selfHosted/useSelfHostedServerSession";
import {
  mapAidokuMangasToLiveSearchMangaWithImageRequests,
  type MobileLiveSearchManga,
} from "@/sources/mobileSourceSearch";

type SourcesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; sources: SelfHostedSource[] }
  | { status: "error"; detail: string };

type SearchState =
  | { status: "idle" }
  | { status: "loading"; items: MobileLiveSearchManga[]; page: number }
  | {
      status: "ready";
      items: MobileLiveSearchManga[];
      page: number;
      hasMore: boolean;
    }
  | { status: "error"; items: MobileLiveSearchManga[]; detail: string };

/**
 * Browse a Suwayomi server's own extension sources from inside Nemu: pick a
 * source, search it, add a match to the Library, or open its detail page.
 * This never touches the global search (which still searches the Library);
 * it is a separate entry from a Suwayomi source's browse page.
 *
 * A source search is slow by nature — the server fetches the source live,
 * 5–60s — so it only runs from the Search button, with a Cancel button that
 * aborts the request, and never per keystroke.
 */
export function ServerSourceBrowserScreen({
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
  const { appLanguage } = useMobileLanguageSettings();
  const strings = getMobileStrings(appLanguage).serverSourceBrowser;
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

  const { runWithSession } = useSelfHostedServerSession(installedSource, strings.unsupported);

  const [sourcesState, setSourcesState] = useState<SourcesState>({ status: "idle" });
  const [languageFilter, setLanguageFilter] = useState<ServerSourceLanguageFilter>("zh");
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });
  const [addingKeys, setAddingKeys] = useState<ReadonlySet<string>>(new Set());
  const [addedKeys, setAddedKeys] = useState<ReadonlySet<string>>(new Set());
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRequestRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);

  const screenTitle = installedSource?.name ?? strings.title;
  const nativeHeaderOptions = createNemuNativeScreenOptions(tokens, screenTitle);

  const loadSources = useCallback(async () => {
    if (!installedSource || !isSuwayomi) return;
    setSourcesState({ status: "loading" });
    try {
      const sources = await runWithSession(async (session) => {
        if (!session.source.getServerSources) {
          throw new Error(strings.unsupported);
        }
        return session.source.getServerSources();
      });
      setSourcesState({ status: "ready", sources });
    } catch (error) {
      setSourcesState({
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }, [installedSource, isSuwayomi, runWithSession, strings.unsupported]);

  useEffect(() => {
    void loadSources();
    return () => {
      searchAbortRef.current?.abort();
    };
  }, [loadSources]);

  const filteredSources = useMemo(() => {
    if (sourcesState.status !== "ready") return [];
    return filterServerSourcesByLanguage(sourcesState.sources, languageFilter);
  }, [sourcesState, languageFilter]);

  const selectedSource = useMemo(
    () =>
      sourcesState.status === "ready"
        ? (sourcesState.sources.find((source) => source.id === selectedSourceId) ?? null)
        : null,
    [sourcesState, selectedSourceId],
  );

  const selectSource = useCallback((source: SelfHostedSource) => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setSelectedSourceId(source.id);
    setSearchState({ status: "idle" });
    setAddedKeys(new Set());
  }, []);

  const runSearch = useCallback(
    async (page: number, append: boolean) => {
      if (!selectedSource) return;
      const trimmed = query.trim();
      if (!trimmed) return;
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const requestId = ++searchRequestRef.current;
      const previousItems =
        append && searchState.status === "ready" ? searchState.items : [];
      setSearchState({ status: "loading", items: previousItems, page });
      try {
        const result = await runWithSession(async (session) => {
          if (!session.source.searchServerSource) {
            throw new Error(strings.unsupported);
          }
          const pageResult = await session.source.searchServerSource(
            selectedSource.id,
            trimmed,
            page,
            controller.signal,
          );
          const items = await mapAidokuMangasToLiveSearchMangaWithImageRequests(
            session.source,
            pageResult.entries,
            { signal: controller.signal },
          );
          return { items, hasMore: pageResult.hasNextPage };
        });
        if (requestId !== searchRequestRef.current || controller.signal.aborted) return;
        setSearchState({
          status: "ready",
          items: [...previousItems, ...result.items],
          page,
          hasMore: result.hasMore,
        });
      } catch (error) {
        if (controller.signal.aborted || requestId !== searchRequestRef.current) return;
        setSearchState({
          status: "error",
          items: previousItems,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (searchAbortRef.current === controller) searchAbortRef.current = null;
        loadMoreInFlightRef.current = false;
      }
    },
    [query, runWithSession, searchState, selectedSource, strings.unsupported],
  );

  const submitSearch = useCallback(() => {
    void runSearch(1, false);
  }, [runSearch]);

  const cancelSearch = useCallback(() => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
  }, []);

  const loadMore = useCallback(() => {
    if (searchState.status !== "ready" || !searchState.hasMore) return;
    if (loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    void runSearch(searchState.page + 1, true);
  }, [runSearch, searchState]);

  const addToLibrary = useCallback(
    async (item: MobileLiveSearchManga) => {
      if (addingKeys.has(item.id) || addedKeys.has(item.id)) return;
      setAddingKeys((current) => new Set(current).add(item.id));
      try {
        await runWithSession(async (session) => {
          if (!session.source.addToLibrary) {
            throw new Error(strings.unsupported);
          }
          await session.source.addToLibrary({ key: item.id, title: item.title });
        });
        setAddedKeys((current) => new Set(current).add(item.id));
        emitMobileLibraryDataChanged();
      } catch {
        // The button stays usable; the failure is shown on the card below
        // via the search error slot on the next render is too indirect, so
        // surface it as a search-level error without dropping the results.
        setSearchState((current) =>
          current.status === "ready" || current.status === "error"
            ? { status: "error", items: current.items, detail: strings.addFailed }
            : current,
        );
      } finally {
        setAddingKeys((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      }
    },
    [addingKeys, addedKeys, runWithSession, strings.addFailed, strings.unsupported],
  );

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

  const renderResult = useCallback(
    ({ item }: { item: MobileLiveSearchManga }) => {
      const added = addedKeys.has(item.id);
      const adding = addingKeys.has(item.id);
      return (
        <View style={styles.resultCell}>
          <ServerMangaGridCard
            item={item}
            openLabel={strings.openManga}
            onPress={() => openManga(item)}
          />
          <NemuButton
            accessibilityLabel={`${added ? strings.inLibrary : strings.addToLibrary}: ${item.title}`}
            disabled={added || adding}
            label={added ? strings.inLibrary : strings.addToLibrary}
            loading={adding}
            onPress={() => void addToLibrary(item)}
            size="sm"
            variant={added ? "secondary" : "default"}
          />
        </View>
      );
    },
    [addedKeys, addingKeys, addToLibrary, openManga, strings],
  );

  const searching = searchState.status === "loading";
  const searchItems =
    searchState.status === "ready" || searchState.status === "loading" || searchState.status === "error"
      ? searchState.items
      : [];
  const searchError = searchState.status === "error" ? searchState.detail : null;
  const hasMore = searchState.status === "ready" && searchState.hasMore;

  // One FlatList is the screen's only scroller: the source picker, the
  // search box and every state live in its header, the results are its
  // rows. (PageScaffold wraps its children in a ScrollView, so a FlatList
  // inside it would nest two virtualized scrollers.)
  const listHeader = (
    <View style={styles.headerBlock}>
      {!isSuwayomi || !installedSource ? (
        <NemuInlineEmptyState
          icon="cloud-offline"
          title={strings.unsupported}
          description={strings.noSourcesHint}
        />
      ) : sourcesState.status === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : sourcesState.status === "error" ? (
        <>
          <NemuInlineEmptyState
            icon="warning-outline"
            title={strings.loadSourcesFailed}
            description={sourcesState.detail}
          />
          <View style={styles.retryRow}>
            <NemuButton
              accessibilityLabel={commonStrings.retry}
              label={commonStrings.retry}
              onPress={() => void loadSources()}
              size="sm"
              variant="secondary"
            />
          </View>
        </>
      ) : (
        <>
          <NemuText style={[styles.sectionLabel, { color: tokens.mutedForeground }]}>
            {strings.chooseSource}
          </NemuText>
          <View style={styles.filterRow}>
            {(
              [
                { id: "zh", label: strings.chinese },
                { id: "en", label: strings.english },
                { id: "all", label: strings.allLanguages },
              ] as const
            ).map((option) => (
              <MobileChip
                key={option.id}
                accessibilityLabel={option.label}
                accessibilityRole="radio"
                accessibilityState={{ selected: languageFilter === option.id }}
                label={option.label}
                onPress={() => setLanguageFilter(option.id)}
                selected={languageFilter === option.id}
                variant="toggle"
              />
            ))}
            <NemuText style={[styles.sourceCount, { color: tokens.mutedForeground }]}>
              {formatMobileString(strings.sourceCount, { count: filteredSources.length })}
            </NemuText>
          </View>
          {filteredSources.length === 0 ? (
            <NemuInlineEmptyState
              icon="search-outline"
              title={strings.noSources}
              description={strings.noSourcesHint}
            />
          ) : (
            <ScrollView
              horizontal
              scrollsToTop={false}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.sourceList}
            >
              {filteredSources.map((source) => (
                <MobileChip
                  key={source.id}
                  accessibilityLabel={source.name}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: selectedSourceId === source.id }}
                  label={source.name}
                  onPress={() => selectSource(source)}
                  selected={selectedSourceId === source.id}
                  variant="toggle"
                />
              ))}
            </ScrollView>
          )}
          {selectedSource ? (
            <>
              <NemuText style={[styles.sectionLabel, { color: tokens.mutedForeground }]}>
                {strings.searchThisSource}
              </NemuText>
              <View style={styles.searchRow}>
                <TextInput
                  accessibilityLabel={strings.searchThisSource}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setQuery}
                  onSubmitEditing={submitSearch}
                  placeholder={strings.searchPlaceholder}
                  placeholderTextColor={tokens.mutedForeground}
                  returnKeyType="search"
                  selectionColor={tokens.primary}
                  style={[
                    styles.searchInput,
                    {
                      backgroundColor: tokens.muted,
                      borderColor: tokens.border,
                      color: tokens.foreground,
                    },
                  ]}
                  value={query}
                />
                {searching ? (
                  <NemuButton
                    accessibilityLabel={strings.cancelSearch}
                    label={strings.cancelSearch}
                    onPress={cancelSearch}
                    size="sm"
                    variant="secondary"
                  />
                ) : (
                  <NemuButton
                    accessibilityLabel={strings.search}
                    disabled={!query.trim()}
                    label={strings.search}
                    onPress={submitSearch}
                    size="sm"
                    variant="default"
                  />
                )}
              </View>
              {searching ? (
                <View style={styles.searchingRow}>
                  <ActivityIndicator size="small" />
                  <NemuText style={[styles.searchingText, { color: tokens.mutedForeground }]}>
                    {strings.searchingHint}
                  </NemuText>
                </View>
              ) : null}
            </>
          ) : (
            <NemuInlineEmptyState
              icon="list-outline"
              title={strings.chooseSource}
              description={strings.typeToSearch}
            />
          )}
          {searchError ? (
            <NemuInlineEmptyState
              icon="warning-outline"
              title={strings.searchFailed}
              description={searchError}
            />
          ) : null}
        </>
      )}
    </View>
  );

  return (
    <>
      {showHeader ? (
        <Stack.Screen options={{ ...nativeHeaderOptions, title: screenTitle }} />
      ) : null}
      <View style={[styles.root, { backgroundColor: tokens.background }]}>
        <FlatList
          data={searchItems}
          keyExtractor={(item) => item.id}
          numColumns={3}
          columnWrapperStyle={styles.resultRow}
          contentContainerStyle={styles.resultList}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={
            searchState.status === "ready" && selectedSource ? (
              <NemuInlineEmptyState
                icon="search-outline"
                title={strings.noResults}
                description={strings.noResultsHint}
              />
            ) : undefined
          }
          ListFooterComponent={
            hasMore ? (
              <View style={styles.loadMore}>
                <NemuButton
                  accessibilityLabel={strings.loadMore}
                  disabled={searching}
                  label={searching ? strings.loadingMore : strings.loadMore}
                  loading={searching}
                  onPress={loadMore}
                  size="sm"
                  variant="secondary"
                />
              </View>
            ) : undefined
          }
          renderItem={renderResult}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerBlock: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 10,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: nemuFontWeight.semibold,
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  sourceCount: {
    fontSize: 13,
    marginLeft: "auto",
  },
  sourceList: {
    gap: 8,
    paddingRight: 8,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchInput: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  searchingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchingText: {
    flex: 1,
    fontSize: 13,
  },
  resultList: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 12,
  },
  resultRow: {
    gap: 12,
  },
  resultCell: {
    flex: 1,
    gap: 6,
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
