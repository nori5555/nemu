import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  NemuButton,
  NemuInlineEmptyState,
  NemuPressable,
  NemuText,
  createNemuNativeScreenOptions,
  createNemuShadowStyle,
  nemuFontWeight,
  radius,
  useNemuTheme,
} from "@/design-system";
import { ExploreCoverImage } from "@/components/explore/ExploreCoverImage";
import {
  ExploreGlass,
  ExploreGlassButton,
  ExploreGlassChip,
} from "@/components/explore/ExploreGlass";
import { buildMobileCoverTintPalette } from "@/lib/mobileCoverTint";
import { MOBILE_EXPLORE_RADIUS as R, concentricMobileExploreRadius } from "@/lib/mobileExploreRadius";
import { useMobileCoverTint } from "@/lib/useMobileCoverTint";
import { ServerMangaGridCard } from "@/components/ServerMangaGridCard";
import { useMobileDataStore } from "@/data/mobileDataContext";
import { emitMobileDataChanged } from "@/data/mobileDataEvents";
import {
  useInstalledSources,
  useLibraryEntries,
  useMobileLanguageSettings,
} from "@/data/mobileHooks";
import { formatMobileString, getMobileStrings } from "@/lib/mobileI18n";
import { mobileInstalledSourceMatchesRoute } from "@/lib/mobileInstalledSourceKeys";
import {
  findLibraryEntryForLiveSearchResult,
  makeLiveSearchLibraryImport,
} from "@/lib/mobileLibraryImport";
import { toSearchSourceDisplay } from "@/lib/mobileSearch";
import { setMobileSourceDetailSeed } from "@/lib/mobileSourceDetailSeed";
import {
  getMobileSourceMangaHref,
  normalizeMobileSourceRouteParam,
} from "@/lib/mobileSourceRoutes";
import {
  filterServerSourcesByLanguage,
  isSuwayomiServerSource,
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
  | {
      status: "loading";
      items: ServerBrowserSearchItem[];
      page: number;
      /** Sources that have answered so far (aggregated search shows progress). */
      doneSources: number;
      totalSources: number;
    }
  | {
      status: "ready";
      items: ServerBrowserSearchItem[];
      page: number;
      hasMore: boolean;
    }
  | { status: "error"; items: ServerBrowserSearchItem[]; detail: string };

/**
 * A search hit tagged with the extension source it came from: the server
 * identifies a manga by one id across sources, so the same title can
 * appear once per source — the tag is what tells them apart in the grid
 * and what makes each row's FlatList key unique.
 */
type ServerBrowserSearchItem = MobileLiveSearchManga & {
  sourceId: string;
  sourceName: string;
};

type HomeSectionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; items: MobileLiveSearchManga[] }
  | { status: "error"; detail: string };

type BrowseState =
  | { status: "idle" }
  | { status: "loading"; items: MobileLiveSearchManga[]; page: number }
  | { status: "ready"; items: MobileLiveSearchManga[]; page: number; hasMore: boolean }
  | { status: "error"; items: MobileLiveSearchManga[]; detail: string };

type BrowseMode = "home" | "popular" | "latest";

const FEATURED_LIMIT = 8;
const UPDATES_LIMIT = 10;

/**
 * Extra bottom space so list content clears the floating bottom tab bar
 * (the tabs use disableAutomaticContentInsets, so nothing adds it).
 */
const TAB_BAR_CLEARANCE = 96;

/**
 * Corner radius of the big glass panels (featured card, updates list):
 * visibly rounded like the reference's large cards and the tab bar, not
 * the square corners a radius-less surface gets.
 */
const GLASS_CARD_RADIUS = 20;

/**
 * A white tint over the updates panel in dark mode: liquid glass over a
 * uniformly black page has almost nothing to refract, so without it the
 * panel reads as a flat dark card. The tint makes it a visibly lighter
 * frosted panel, the way the reference's updates list reads. Light mode
 * keeps the glass default, which is already a light panel there.
 */
const UPDATES_GLASS_TINT_DARK = "rgba(255,255,255,0.14)";

/**
 * Browse a Suwayomi server's own extension sources from inside Nemu: pick
 * a source, browse its popular/latest pages, add a match to the Library,
 * or open its detail page. This never touches the global search (which
 * still searches the Library); it is a separate entry from a Suwayomi
 * source's browse page.
 *
 * Search is aggregated: one query goes to every source on the server in
 * parallel (the server has no cross-source search of its own — the
 * WebUI does the same fan-out), and hits stream in source by source,
 * each card labelled with its source. A source that errors or needs a
 * login just contributes nothing; only when every source fails does the
 * search itself report an error. A source search is slow by nature —
 * the server fetches the source live, 5–60s — so it only runs from the
 * Search button, with a Cancel button that aborts every in-flight
 * request, and never per keystroke. Load-more fetches the next page
 * from every source and appends it.
 *
 * The home page is a source, not an empty state: once the source list
 * loads, the first Chinese source (else the first source) is selected
 * automatically and its home sections load.
 *
 * The layout follows the MangaDex-style reference (a featured carousel
 * plus a latest-updates list), and every surface is Nemu's own: the chips
 * are ExploreGlassChip, the mode row is three ExploreGlassButtons (the
 * selected one tinted with the primary colour), the featured card is
 * tinted from its cover like the Explore home's, and the updates list
 * is an ExploreGlass panel — not the reference's dark solid pills and
 * cards, and not the flat BlurView surface, which reads as a solid dark
 * card on this page.
 */
export function ServerSourceBrowserScreen({
  registryId: registryIdProp,
  sourceId: sourceIdProp,
  showHeader = true,
}: {
  /** Tab callers pass the server directly; the route passes it via params. */
  registryId?: string;
  sourceId?: string;
  /** The server tab renders its own header above the page. */
  showHeader?: boolean;
} = {}) {
  const params = useLocalSearchParams<{ registryId: string; sourceId: string }>();
  const registryId = registryIdProp ?? normalizeMobileSourceRouteParam(params.registryId);
  const sourceId = sourceIdProp ?? normalizeMobileSourceRouteParam(params.sourceId);
  const { tokens } = useNemuTheme();
  const insets = useSafeAreaInsets();
  const store = useMobileDataStore();
  const { width: windowWidth } = useWindowDimensions();
  const { appLanguage } = useMobileLanguageSettings();
  const strings = getMobileStrings(appLanguage).serverSourceBrowser;
  const commonStrings = getMobileStrings(appLanguage).common;
  const installed = useInstalledSources();
  const { data: libraryEntries } = useLibraryEntries();

  const [sourcesState, setSourcesState] = useState<SourcesState>({ status: "idle" });
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [mode, setMode] = useState<BrowseMode>("home");
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });
  const [browseState, setBrowseState] = useState<BrowseState>({ status: "idle" });
  const [homeState, setHomeState] = useState<{
    popular: HomeSectionState;
    latest: HomeSectionState;
  }>({ popular: { status: "idle" }, latest: { status: "idle" } });
  const [addingKeys, setAddingKeys] = useState<ReadonlySet<string>>(new Set());
  const [addedKeys, setAddedKeys] = useState<ReadonlySet<string>>(new Set());
  const searchAbortRef = useRef<AbortController | null>(null);
  const browseAbortRef = useRef<AbortController | null>(null);
  const homeAbortRef = useRef<AbortController | null>(null);
  const searchRequestRef = useRef(0);
  const browseRequestRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);

  const installedSource = useMemo(
    () =>
      installed.data.find((item) =>
        mobileInstalledSourceMatchesRoute(item, registryId, sourceId),
      ) ?? null,
    [installed.data, registryId, sourceId],
  );
  const isSuwayomi = isSuwayomiServerSource(installedSource);
  const sourceDisplay = useMemo(
    () => (installedSource ? toSearchSourceDisplay(installedSource) : null),
    [installedSource],
  );

  const { runWithSession } = useSelfHostedServerSession(installedSource, strings.unsupported);

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
  }, [loadSources]);

  // Cancel every in-flight server call when the screen unmounts.
  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      browseAbortRef.current?.abort();
      homeAbortRef.current?.abort();
    },
    [],
  );

  // Every source in one scrolling row: the language filter row used to sit
  // above it (中文/英文/全部语言), but three rows of options before any
  // content was too much — with 20 sources the single row is enough.
  const sources = useMemo(
    () => (sourcesState.status === "ready" ? sourcesState.sources : []),
    [sourcesState],
  );
  const selectedSource = useMemo(
    () =>
      sourcesState.status === "ready"
        ? (sourcesState.sources.find((source) => source.id === selectedSourceId) ?? null)
        : null,
    [sourcesState, selectedSourceId],
  );

  const setHomeSection = useCallback(
    (section: "popular" | "latest", state: HomeSectionState) => {
      setHomeState((current) => ({ ...current, [section]: state }));
    },
    [],
  );

  const loadHome = useCallback(
    async (sourceId: string) => {
      homeAbortRef.current?.abort();
      const controller = new AbortController();
      homeAbortRef.current = controller;
      setHomeState({ popular: { status: "loading" }, latest: { status: "loading" } });
      const loadSection = async (type: "POPULAR" | "LATEST") => {
        const section = type === "POPULAR" ? "popular" : "latest";
        const limit = type === "POPULAR" ? FEATURED_LIMIT : UPDATES_LIMIT;
        try {
          const items = await runWithSession(async (session) => {
            if (!session.source.browseSource) {
              throw new Error(strings.unsupported);
            }
            const pageResult = await session.source.browseSource(sourceId, type, 1, controller.signal);
            return mapAidokuMangasToLiveSearchMangaWithImageRequests(
              session.source,
              pageResult.entries,
              { signal: controller.signal },
            );
          });
          if (controller.signal.aborted) return;
          setHomeSection(section, { status: "ready", items: items.slice(0, limit) });
        } catch (error) {
          if (controller.signal.aborted) return;
          setHomeSection(section, {
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      };
      // Both sections load in parallel; each shows its own spinner/error.
      await Promise.all([loadSection("POPULAR"), loadSection("LATEST")]);
    },
    [runWithSession, setHomeSection, strings.unsupported],
  );

  const runBrowse = useCallback(
    async (
      sourceId: string,
      type: "POPULAR" | "LATEST",
      page: number,
      append: boolean,
    ) => {
      browseAbortRef.current?.abort();
      const controller = new AbortController();
      browseAbortRef.current = controller;
      const requestId = ++browseRequestRef.current;
      const previousItems =
        append && browseState.status !== "idle" ? browseState.items : [];
      setBrowseState({ status: "loading", items: previousItems, page });
      try {
        const result = await runWithSession(async (session) => {
          if (!session.source.browseSource) {
            throw new Error(strings.unsupported);
          }
          const pageResult = await session.source.browseSource(sourceId, type, page, controller.signal);
          const items = await mapAidokuMangasToLiveSearchMangaWithImageRequests(
            session.source,
            pageResult.entries,
            { signal: controller.signal },
          );
          return { items, hasMore: pageResult.hasNextPage };
        });
        if (requestId !== browseRequestRef.current || controller.signal.aborted) return;
        setBrowseState({
          status: "ready",
          items: [...previousItems, ...result.items],
          page,
          hasMore: result.hasMore,
        });
      } catch (error) {
        if (requestId !== browseRequestRef.current || controller.signal.aborted) return;
        setBrowseState({
          status: "error",
          items: previousItems,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [browseState, runWithSession, strings.unsupported],
  );

  const loadMode = useCallback(
    (nextMode: BrowseMode, sourceId: string) => {
      if (nextMode === "home") {
        void loadHome(sourceId);
        return;
      }
      void runBrowse(sourceId, nextMode === "latest" ? "LATEST" : "POPULAR", 1, false);
    },
    [loadHome, runBrowse],
  );

  const selectSource = useCallback(
    (source: SelfHostedSource) => {
      searchAbortRef.current?.abort();
      setSearchState({ status: "idle" });
      setQuery("");
      setBrowseState({ status: "idle" });
      setHomeState({ popular: { status: "idle" }, latest: { status: "idle" } });
      setSelectedSourceId(source.id);
      loadMode(mode, source.id);
    },
    [loadMode, mode],
  );

  // The home page is a source, not an empty state: once the list loads,
  // select one by default — the first Chinese source, else the first
  // source overall — and load its home sections. Only the first load
  // does this; afterwards the user's own pick stays.
  useEffect(() => {
    if (sourcesState.status !== "ready" || selectedSourceId) return;
    const preferred =
      filterServerSourcesByLanguage(sourcesState.sources, "zh")[0] ??
      sourcesState.sources[0];
    if (preferred) selectSource(preferred);
  }, [sourcesState, selectedSourceId, selectSource]);

  const handleModeChange = useCallback(
    (nextMode: BrowseMode) => {
      if (nextMode === mode) return;
      setMode(nextMode);
      // Leaving search: the mode's own content takes the list back.
      searchAbortRef.current?.abort();
      setSearchState({ status: "idle" });
      setBrowseState({ status: "idle" });
      setHomeState({ popular: { status: "idle" }, latest: { status: "idle" } });
      if (selectedSource) {
        loadMode(nextMode, selectedSource.id);
      }
    },
    [loadMode, mode, selectedSource],
  );

  const runSearch = useCallback(
    async (page: number, append: boolean) => {
      const trimmedQuery = query.trim();
      if (!trimmedQuery || sources.length === 0) return;
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const requestId = ++searchRequestRef.current;
      const previousItems =
        append && searchState.status !== "idle" ? searchState.items : [];
      setSearchState({
        status: "loading",
        items: previousItems,
        page,
        doneSources: 0,
        totalSources: sources.length,
      });
      let anyMore = false;
      let firstError: Error | null = null;
      // One query to every source in parallel; each source's hits are
      // appended the moment they arrive, so fast sources show first and
      // a slow or dead one never blocks the rest. A source that errors
      // (login-required, site down) just contributes nothing.
      await Promise.all(
        sources.map(async (source) => {
          try {
            const result = await runWithSession(async (session) => {
              if (!session.source.searchServerSource) {
                throw new Error(strings.unsupported);
              }
              const pageResult = await session.source.searchServerSource(
                source.id,
                trimmedQuery,
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
            if (result.hasMore) anyMore = true;
            const tagged: ServerBrowserSearchItem[] = result.items.map((item) => ({
              ...item,
              sourceId: source.id,
              sourceName: source.name,
            }));
            setSearchState((current) =>
              current.status === "loading"
                ? {
                    ...current,
                    items: [...current.items, ...tagged],
                    doneSources: current.doneSources + 1,
                  }
                : current,
            );
          } catch (error) {
            if (requestId !== searchRequestRef.current || controller.signal.aborted) return;
            if (!firstError && error instanceof Error) firstError = error;
            setSearchState((current) =>
              current.status === "loading"
                ? { ...current, doneSources: current.doneSources + 1 }
                : current,
            );
          }
        }),
      );
      if (requestId !== searchRequestRef.current || controller.signal.aborted) return;
      setSearchState((current) => {
        const items = current.status === "loading" ? current.items : previousItems;
        if (items.length === 0) {
          return {
            status: "error",
            items: [],
            detail: firstError ? firstError.message : strings.searchFailed,
          };
        }
        return { status: "ready", items, page, hasMore: anyMore };
      });
    },
    [query, runWithSession, searchState, sources, strings.searchFailed, strings.unsupported],
  );

  const submitSearch = useCallback(() => {
    void runSearch(1, false);
  }, [runSearch]);

  const cancelSearch = useCallback(() => {
    searchAbortRef.current?.abort();
    setSearchState({ status: "idle" });
  }, []);

  const loadMoreSearch = useCallback(() => {
    if (searchState.status !== "ready" || !searchState.hasMore) return;
    if (loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    void runSearch(searchState.page + 1, true).finally(() => {
      loadMoreInFlightRef.current = false;
    });
  }, [runSearch, searchState]);

  const loadMoreBrowse = useCallback(() => {
    if (!selectedSource || browseState.status !== "ready" || !browseState.hasMore) return;
    if (loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    void runBrowse(
      selectedSource.id,
      mode === "latest" ? "LATEST" : "POPULAR",
      browseState.page + 1,
      true,
    ).finally(() => {
      loadMoreInFlightRef.current = false;
    });
  }, [browseState, mode, runBrowse, selectedSource]);

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
        // The server library and the main Library tab share entries, so
        // the title also lands in the local library. If the local write
        // fails the server add stands (no rollback) and the button stays
        // usable so the user can retry.
        if (sourceDisplay) {
          try {
            const imported = makeLiveSearchLibraryImport(sourceDisplay, item);
            await store.saveLibraryItem(imported.item);
            await store.saveSourceLink(imported.sourceLink);
            emitMobileDataChanged("library");
            setAddedKeys((current) => new Set(current).add(item.id));
          } catch {
            setSearchState((current) =>
              current.status === "ready" || current.status === "error"
                ? { status: "error", items: current.items, detail: strings.addFailed }
                : current,
            );
          }
        } else {
          setAddedKeys((current) => new Set(current).add(item.id));
        }
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
    [addingKeys, addedKeys, runWithSession, sourceDisplay, store, strings.addFailed, strings.unsupported],
  );

  const searching = searchState.status === "loading";
  const searchItems = useMemo(
    () =>
      searchState.status === "ready" ||
      searchState.status === "loading" ||
      searchState.status === "error"
        ? searchState.items
        : [],
    [searchState],
  );
  const searchError = searchState.status === "error" ? searchState.detail : null;
  const searchHasMore = searchState.status === "ready" && searchState.hasMore;
  const searchActive = searchState.status !== "idle";
  const browseItems =
    browseState.status === "ready" || browseState.status === "loading" || browseState.status === "error"
      ? browseState.items
      : [];
  const browseError = browseState.status === "error" ? browseState.detail : null;
  const browseHasMore = browseState.status === "ready" && browseState.hasMore;
  const browseLoading = browseState.status === "loading";
  const showRows = !searchActive && mode === "latest";
  const listItems = searchActive ? searchItems : mode === "home" ? [] : browseItems;

  // The button state reflects the local library too: a title that is
  // already in the main Library tab shows as already added.
  useEffect(() => {
    if (!sourceDisplay || libraryEntries.length === 0) return;
    setAddedKeys((current) => {
      const next = new Set(current);
      let changed = false;
      for (const item of searchItems) {
        if (
          !next.has(item.id) &&
          findLibraryEntryForLiveSearchResult(libraryEntries, sourceDisplay, item)
        ) {
          next.add(item.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [libraryEntries, searchItems, sourceDisplay]);

  const renderResult = useCallback(
    ({ item }: { item: MobileLiveSearchManga & { sourceName?: string } }) => {
      const added = addedKeys.has(item.id);
      const adding = addingKeys.has(item.id);
      return (
        <View style={styles.resultCell}>
          <ServerMangaGridCard
            item={item}
            openLabel={strings.openManga}
            sourceLabel={item.sourceName}
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

  const renderUpdateRow = useCallback(
    ({ item }: { item: MobileLiveSearchManga }) => (
      <ServerSourceUpdateRow item={item} onPress={() => openManga(item)} />
    ),
    [openManga],
  );

  const featuredCardWidth = Math.round(windowWidth * 0.82);

  // One FlatList is the screen's only scroller: the source picker, the
  // search box and every state live in its header, the results are its
  // rows. (PageScaffold wraps its children in a ScrollView, so a FlatList
  // inside it would nest two virtualized scrollers.)
  const listHeader = (
    <View style={[styles.headerBlock, { paddingTop: insets.top + 12 }]}>
      {installed.loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : !isSuwayomi || !installedSource ? (
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
          <View style={styles.sourceHeaderRow}>
            <NemuText style={[styles.sectionLabel, { color: tokens.mutedForeground }]}>
              {strings.chooseSource}
            </NemuText>
            <NemuText style={[styles.sourceCount, { color: tokens.mutedForeground }]}>
              {formatMobileString(strings.sourceCount, { count: sources.length })}
            </NemuText>
          </View>
          {sources.length === 0 ? (
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
              style={styles.sourceScroll}
              contentContainerStyle={styles.sourceList}
            >
              {sources.map((source) => (
                <ExploreGlassChip
                  key={source.id}
                  accessibilityLabel={source.name}
                  ink={tokens.foreground}
                  label={source.name}
                  onPress={() => selectSource(source)}
                  selected={selectedSourceId === source.id}
                />
              ))}
            </ScrollView>
          )}
          {selectedSource ? (
            <>
              <View style={styles.modeRow}>
                {(
                  [
                    { value: "home", label: strings.home },
                    { value: "popular", label: strings.popular },
                    { value: "latest", label: strings.latest },
                  ] as const
                ).map((option) => {
                  const selected = mode === option.value;
                  return (
                    <ExploreGlassButton
                      key={option.value}
                      accessibilityLabel={option.label}
                      ink={selected ? tokens.primaryForeground : tokens.foreground}
                      label={option.label}
                      onPress={() => handleModeChange(option.value)}
                      prominent={selected}
                      style={styles.modeButton}
                      tint={tokens.primary}
                    />
                  );
                })}
              </View>
              <NemuText style={[styles.sectionLabel, { color: tokens.mutedForeground }]}>
                {strings.searchAllSources}
              </NemuText>
              <View style={styles.searchRow}>
                <ExploreGlass cornerRadius={0} style={styles.searchGlass}>
                  <TextInput
                    accessibilityLabel={strings.searchAllSources}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={setQuery}
                    onSubmitEditing={submitSearch}
                    placeholder={strings.searchPlaceholder}
                    placeholderTextColor={tokens.mutedForeground}
                    returnKeyType="search"
                    selectionColor={tokens.primary}
                    style={[styles.searchInput, { color: tokens.foreground }]}
                    value={query}
                  />
                </ExploreGlass>
                {searching ? (
                  <ExploreGlassButton
                    accessibilityLabel={strings.cancelSearch}
                    ink={tokens.foreground}
                    label={strings.cancelSearch}
                    onPress={cancelSearch}
                  />
                ) : (
                  <ExploreGlassButton
                    accessibilityLabel={strings.search}
                    disabled={!query.trim()}
                    ink={tokens.primaryForeground}
                    label={strings.search}
                    onPress={submitSearch}
                    prominent
                    tint={tokens.primary}
                  />
                )}
              </View>
              {searching ? (
                <View style={styles.searchingRow}>
                  <ActivityIndicator size="small" />
                  <NemuText style={[styles.searchingText, { color: tokens.mutedForeground }]}>
                    {searchState.status === "loading"
                      ? formatMobileString(strings.searchingProgress, {
                          done: searchState.doneSources,
                          total: searchState.totalSources,
                        })
                      : strings.searchingHint}
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

  const listFooter = (
    <>
      {mode === "home" && !searchActive && selectedSource ? (
        <View style={styles.homeSections}>
          <NemuText style={[styles.homeSectionTitle, { color: tokens.foreground }]}>
            {strings.popularNewTitles}
          </NemuText>
          {homeState.popular.status === "loading" ? (
            <ActivityIndicator size="small" color={tokens.primary} style={styles.homeSpinner} />
          ) : homeState.popular.status === "error" ? (
            <NemuInlineEmptyState
              icon="warning-outline"
              title={strings.browseFailed}
              description={homeState.popular.detail}
            />
          ) : homeState.popular.status === "ready" && homeState.popular.items.length === 0 ? (
            <NemuInlineEmptyState icon="search-outline" title={strings.noResults} />
          ) : homeState.popular.status === "ready" ? (
            <ScrollView
              horizontal
              scrollsToTop={false}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.featuredScrollContent}
              style={styles.featuredScroll}
            >
              {homeState.popular.items.map((item) => (
                <ServerSourceFeaturedCard
                  key={item.id}
                  item={item}
                  width={featuredCardWidth}
                  onPress={() => openManga(item)}
                />
              ))}
            </ScrollView>
          ) : null}
          <View style={styles.updatesHeader}>
            <NemuText style={[styles.homeSectionTitle, { color: tokens.foreground }]}>
              {strings.latestUpdates}
            </NemuText>
            <NemuPressable
              accessibilityRole="button"
              accessibilityLabel={strings.viewAll}
              hapticFeedback="selection"
              onPress={() => handleModeChange("latest")}
              pressedScale={0.97}
              style={styles.viewAllButton}
            >
              <NemuText style={[styles.viewAllLabel, { color: tokens.primary }]}>
                {strings.viewAll}
              </NemuText>
              <Ionicons name="chevron-forward" size={16} color={tokens.primary} />
            </NemuPressable>
          </View>
          {homeState.latest.status === "loading" ? (
            <ActivityIndicator size="small" color={tokens.primary} style={styles.homeSpinner} />
          ) : homeState.latest.status === "error" ? (
            <NemuInlineEmptyState
              icon="warning-outline"
              title={strings.browseFailed}
              description={homeState.latest.detail}
            />
          ) : homeState.latest.status === "ready" && homeState.latest.items.length === 0 ? (
            <NemuInlineEmptyState icon="search-outline" title={strings.noResults} />
          ) : homeState.latest.status === "ready" ? (
            <ServerSourceUpdateList items={homeState.latest.items} onOpen={openManga} />
          ) : null}
        </View>
      ) : null}
      {!searchActive && mode !== "home" && browseError && browseItems.length === 0 ? (
        <NemuInlineEmptyState
          icon="warning-outline"
          title={strings.browseFailed}
          description={browseError}
        />
      ) : null}
      {searchActive && searchHasMore ? (
        <View style={styles.loadMore}>
          <NemuButton
            accessibilityLabel={strings.loadMore}
            disabled={searching}
            label={searching ? strings.loadingMore : strings.loadMore}
            loading={searching}
            onPress={loadMoreSearch}
            size="sm"
            variant="secondary"
          />
        </View>
      ) : null}
      {!searchActive && mode !== "home" && browseHasMore ? (
        <View style={styles.loadMore}>
          <NemuButton
            accessibilityLabel={strings.loadMore}
            disabled={browseLoading}
            label={browseLoading ? strings.loadingMore : strings.loadMore}
            loading={browseLoading}
            onPress={loadMoreBrowse}
            size="sm"
            variant="secondary"
          />
        </View>
      ) : null}
    </>
  );

  const listEmpty =
    (searchActive && searchState.status === "ready" && selectedSource) ||
    (!searchActive && mode !== "home" && browseState.status === "ready") ? (
      <NemuInlineEmptyState
        icon="search-outline"
        title={strings.noResults}
        description={strings.noResultsHint}
      />
    ) : undefined;

  return (
    <>
      {showHeader ? (
        <Stack.Screen options={{ ...nativeHeaderOptions, title: screenTitle }} />
      ) : null}
      <View style={[styles.root, { backgroundColor: tokens.background }]}>
        <FlatList
          key={showRows ? "rows" : "grid"}
          data={listItems}
          // One manga id is shared across sources, so a title found in
          // two sources needs a composite key or the rows collide.
          keyExtractor={(item) => {
            const sourceId = (item as Partial<ServerBrowserSearchItem>).sourceId;
            return sourceId ? `${sourceId}:${item.id}` : item.id;
          }}
          renderItem={showRows ? renderUpdateRow : renderResult}
          numColumns={showRows ? 1 : 3}
          columnWrapperStyle={showRows ? undefined : styles.resultRow}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.resultList,
            { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE },
          ]}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          ListEmptyComponent={listEmpty}
        />
      </View>
    </>
  );
}

type ServerSourceFeaturedCardProps = {
  item: MobileLiveSearchManga;
  width: number;
  onPress: () => void;
};

/**
 * One featured card, tinted from its own cover like the Explore home's
 * featured cards (and the reference): the card's fill, rim, glow, text
 * and genre pills all come from the cover's sampled colour, so each card
 * carries its artwork's hue instead of one neutral dark panel. The card
 * and cover corners follow the Explore scale (card 26, cover concentric
 * at 14), not the small 8pt cover radius the previous version had.
 */
function ServerSourceFeaturedCard({ item, width, onPress }: ServerSourceFeaturedCardProps) {
  const { scheme } = useNemuTheme();
  const tint = useMobileCoverTint(
    item.cover ? { uri: item.cover, headers: item.coverHeaders } : null,
    `server-source:${item.id}`,
  );
  const palette = useMemo(() => buildMobileCoverTintPalette(tint, scheme), [scheme, tint]);
  const genres = (item.tags ?? []).slice(0, 3);
  return (
    <NemuPressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      hapticFeedback="selection"
      onPress={onPress}
      pressedScale={0.98}
      style={[
        styles.featuredCard,
        {
          width,
          backgroundColor: palette.card,
          borderColor: palette.cardRim,
          ...createNemuShadowStyle({
            color: palette.cardGlow,
            offsetY: 6,
            radius: 18,
            opacity: 0.6,
            elevation: 6,
          }),
        },
      ]}
    >
      <View style={styles.featuredContent}>
        <View style={styles.featuredCover}>
          <ExploreCoverImage
            source={
              item.cover
                ? { uri: item.cover, headers: item.coverHeaders, cache: "force-cache" as const }
                : null
            }
            title={item.title}
          />
        </View>
        <View style={styles.featuredText}>
          <NemuText numberOfLines={2} style={[styles.featuredTitle, { color: palette.cardInk }]}>
            {item.title}
          </NemuText>
          {item.description ? (
            <NemuText
              numberOfLines={3}
              style={[styles.featuredDescription, { color: palette.cardInkSecondary }]}
            >
              {item.description}
            </NemuText>
          ) : null}
          {genres.length > 0 ? (
            <View style={styles.featuredTags}>
              {genres.map((tag) => (
                <View
                  key={tag}
                  style={[styles.featuredTag, { backgroundColor: palette.actionSoft }]}
                >
                  <NemuText
                    numberOfLines={1}
                    style={[styles.featuredTagText, { color: palette.cardInk }]}
                  >
                    {tag}
                  </NemuText>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </NemuPressable>
  );
}

type ServerSourceUpdateListProps = {
  items: MobileLiveSearchManga[];
  onOpen: (item: MobileLiveSearchManga) => void;
};

/** The latest-updates rows in one glass surface, divided by hairlines. */
function ServerSourceUpdateList({ items, onOpen }: ServerSourceUpdateListProps) {
  const { scheme, tokens } = useNemuTheme();
  return (
    <ExploreGlass
      cornerRadius={GLASS_CARD_RADIUS}
      style={styles.updatesShell}
      tintColor={scheme === "dark" ? UPDATES_GLASS_TINT_DARK : undefined}
    >
      <View style={styles.updatesContent}>
        {items.map((item, index) => (
          <View
            key={item.id}
            style={[
              styles.updateRowWrap,
              index < items.length - 1
                ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border }
                : null,
            ]}
          >
            <ServerSourceUpdateRow item={item} onPress={() => onOpen(item)} />
          </View>
        ))}
      </View>
    </ExploreGlass>
  );
}

type ServerSourceUpdateRowProps = {
  item: MobileLiveSearchManga;
  onPress: () => void;
};

/**
 * One latest-updates row: a small cover, the title, and the author line
 * with a chevron. Suwayomi source listings carry no latest-chapter info,
 * so the row shows title + author instead of a chapter line.
 */
function ServerSourceUpdateRow({ item, onPress }: ServerSourceUpdateRowProps) {
  const { tokens } = useNemuTheme();
  return (
    <NemuPressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      hapticFeedback="selection"
      onPress={onPress}
      pressedScale={0.98}
      style={styles.updateRow}
    >
      <View
        style={[
          styles.updateCover,
          { backgroundColor: tokens.muted, borderColor: tokens.coverBorder },
        ]}
      >
        <ExploreCoverImage
          source={
            item.cover
              ? { uri: item.cover, headers: item.coverHeaders, cache: "force-cache" as const }
              : null
          }
          title={item.title}
        />
      </View>
      <View style={styles.updateText}>
        <NemuText numberOfLines={2} style={[styles.updateTitle, { color: tokens.foreground }]}>
          {item.title}
        </NemuText>
        {item.authors?.length ? (
          <NemuText
            numberOfLines={1}
            style={[styles.updateSubtitle, { color: tokens.mutedForeground }]}
          >
            {item.authors.join(", ")}
          </NemuText>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={tokens.mutedForeground} />
    </NemuPressable>
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
  sourceHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  sourceCount: {
    fontSize: 13,
    marginLeft: "auto",
  },
  // The source row bleeds to the screen edges like the featured
  // carousel: without the negative margin the list's 16pt content
  // padding clips the chips a full inset short of the edge, so the
  // last chip is cut off before it ever reaches the screen edge.
  sourceScroll: {
    marginHorizontal: -16,
  },
  sourceList: {
    gap: 8,
    paddingHorizontal: 16,
  },
  modeRow: {
    flexDirection: "row",
    gap: 8,
  },
  modeButton: {
    flex: 1,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchInput: {
    flex: 1,
    minHeight: 40,
    // The glass capsule supplies the shape and fill; the input itself is
    // transparent inside it.
    paddingHorizontal: 12,
    fontSize: 16,
  },
  searchGlass: {
    flex: 1,
    minHeight: 40,
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
    gap: 12,
  },
  resultRow: {
    gap: 12,
  },
  resultCell: {
    flex: 1,
    gap: 6,
    // Pins the Add to Library button to the bottom of the row: without
    // this, a two-line title (or a missing author) leaves the button
    // hanging higher than its row-mates.
    justifyContent: "space-between",
  },
  loadMore: {
    alignItems: "center",
    paddingVertical: 12,
  },
  retryRow: {
    alignItems: "center",
    paddingVertical: 8,
  },
  homeSections: {
    gap: 16,
    paddingTop: 4,
  },
  homeSectionTitle: {
    fontSize: 20,
    lineHeight: 25,
    fontWeight: nemuFontWeight.semibold,
  },
  homeSpinner: {
    paddingVertical: 24,
  },
  featuredScroll: {
    marginHorizontal: -16,
  },
  featuredScrollContent: {
    gap: 12,
    paddingHorizontal: 16,
  },
  featuredCard: {
    flexShrink: 0,
    // The Explore featured-card corner (26); the cover inside is concentric.
    borderRadius: R.card,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  featuredContent: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 12,
  },
  featuredCover: {
    width: 110,
    aspectRatio: 3 / 4,
    overflow: "hidden",
    // Concentric with the card (26 less the 12pt padding), like the
    // Explore home's featured covers — visibly rounder than the old 8pt.
    borderRadius: concentricMobileExploreRadius(R.card, 12),
    borderCurve: "continuous",
  },
  featuredText: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  featuredTitle: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: nemuFontWeight.semibold,
  },
  featuredDescription: {
    fontSize: 13,
    lineHeight: 18,
  },
  featuredTags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  featuredTag: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  featuredTagText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: nemuFontWeight.medium,
  },
  updatesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  viewAllButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingVertical: 4,
  },
  viewAllLabel: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: nemuFontWeight.semibold,
  },
  updatesShell: {
    width: "100%",
  },
  updatesContent: {
    flexDirection: "column",
  },
  updateRowWrap: {
    paddingHorizontal: 12,
  },
  updateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
  },
  updateCover: {
    width: 56,
    aspectRatio: 3 / 4,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    // The Explore list-cover corner (group 20 less the 12pt row inset).
    borderRadius: concentricMobileExploreRadius(R.group, 12),
  },
  updateText: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  updateTitle: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: nemuFontWeight.semibold,
  },
  updateSubtitle: {
    fontSize: 13,
    lineHeight: 17,
  },
});
