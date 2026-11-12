import { memo, useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { ZoomSource } from "../../modules/nemu-window-layout";
import {
  createNemuShadowStyle,
  MobileCachedImage,
  nemuFontWeight,
  NemuText,
  useNemuTheme,
} from "@/design-system";
import { MobileExploreCoverPlaceholder } from "@/components/explore/MobileExploreCoverPlaceholder";
import {
  pushMobileExploreDetail,
  useMobileExploreEntryCover,
} from "@/components/explore/mobileExploreCover";
import { getEntryTitle, type InstalledSource, type LibraryEntry } from "@/data/schema";
import { useSuperResolvedCover } from "@/lib/mobileSuperResolution";
import pagekinCoverGrain from "../../assets/pagekin-cover-grain.png";
import type { MobileStrings } from "@/lib/mobileI18n";
import {
  mobileLibraryReadFraction,
  pickMobileLibraryFeaturedEntry,
  type MobileLibraryCardProgress,
  type MobileLibraryProgressIndex,
} from "@/lib/mobileLibraryPresentation";

type PagekinCoverSource = ReturnType<typeof useMobileExploreEntryCover>;

// The Pagekin home: one big currently-reading cover (author, title, progress)
// over a fanned deck of the rest of the library. The deck is a horizontal
// scroller whose covers tilt away from the viewport centre, like a hand fan:
// each card's rotation follows the scroll offset, so the fan re-centres as
// the user scrolls instead of freezing at one angle per index.

const FEATURED_COVER_WIDTH_RATIO = 0.54;
const FEATURED_COVER_MAX_WIDTH = 240;
// Paper grain over the featured cover only: a tileable noise tile at low
// opacity breaks up the smooth upscaling blur of a small source cover,
// the way a printed cover's grain does. The fan covers stay clean.
const FEATURED_GRAIN_OPACITY = 0.15;
const FAN_CARD_WIDTH_RATIO = 0.3;
const FAN_CARD_OVERLAP_RATIO = 0.34;
const FAN_TILT_DEGREES = 9;
const FAN_ARC_DROP = 7;
const FAN_CONTENT_PADDING = 20;
// Room for the floating tab bar, as the server browser's clearance.
const PAGEKIN_BOTTOM_CLEARANCE = 96;

function openPagekinEntry(
  entry: LibraryEntry,
  cover: PagekinCoverSource,
  zoomId: string,
) {
  pushMobileExploreDetail(entry, cover, zoomId);
}

const PagekinCover = memo(function PagekinCover({
  entry,
  installedSources,
  width,
  radius,
  onOpen,
  onLongPress,
  zoomId,
  superResolve,
  grain,
}: {
  entry: LibraryEntry;
  installedSources: InstalledSource[];
  width: number;
  radius: number;
  onOpen: (entry: LibraryEntry, cover: PagekinCoverSource) => void;
  /** Long-press opens the entry's quick menu (edit info, collections…). */
  onLongPress?: (entry: LibraryEntry) => void;
  zoomId: string;
  /** Upscale the cover 4x on-device (featured cover only; the fan stays raw). */
  superResolve?: boolean;
  /** Paper grain over the cover (featured cover only; the fan stays clean). */
  grain?: boolean;
}) {
  const { tokens } = useNemuTheme();
  // The same cover the grid cells and the detail page paint, so the home
  // shares their cached image.
  const coverSource = useMobileExploreEntryCover(entry, installedSources);
  const uri = coverSource?.uri;
  // The upscaled file swaps in when it is ready; until then (and when the
  // build has no model) the original cover shows, so the upscale never
  // blocks the shelf from painting.
  const upscaledUri = useSuperResolvedCover(superResolve ? uri : null, coverSource?.headers);
  const displayCover = upscaledUri ? { uri: upscaledUri } : coverSource;
  // Which cover URI has actually painted. The grain only renders on top of
  // a loaded cover: over an empty slot it would read as a lone dark grain
  // rectangle, and keyed by URI it hides again when the featured book
  // changes until the new cover lands.
  const [loadedUri, setLoadedUri] = useState<string | null>(null);
  const height = width * 1.5;
  return (
    <Pressable
      accessibilityLabel={getEntryTitle(entry)}
      accessibilityRole="button"
      onPress={() => onOpen(entry, displayCover)}
      onLongPress={onLongPress ? () => onLongPress(entry) : undefined}
    >
      <ZoomSource zoomId={zoomId} style={{ width, height, borderRadius: radius }}>
        {displayCover ? (
          <MobileCachedImage
            uriOwnership={upscaledUri ? "app" : "source"}
            source={displayCover}
            onLoad={() => setLoadedUri(uri ?? null)}
            onError={() => setLoadedUri(null)}
            style={{
              width,
              height,
              borderRadius: radius,
              borderWidth: 1,
              borderColor: tokens.coverBorder,
            }}
          />
        ) : (
          <MobileExploreCoverPlaceholder title={getEntryTitle(entry)} width={width} />
        )}
        {grain && displayCover && loadedUri === uri ? (
          <Image
            source={pagekinCoverGrain}
            resizeMode="repeat"
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width,
              height,
              borderRadius: radius,
              opacity: FEATURED_GRAIN_OPACITY,
            }}
          />
        ) : null}
      </ZoomSource>
    </Pressable>
  );
});

const PagekinFanCard = memo(function PagekinFanCard({
  entry,
  index,
  cardWidth,
  contentPad,
  viewportWidth,
  scrollX,
  installedSources,
  onEntryLongPress,
}: {
  entry: LibraryEntry;
  index: number;
  cardWidth: number;
  contentPad: number;
  viewportWidth: number;
  scrollX: { value: number };
  installedSources: InstalledSource[];
  onEntryLongPress?: (entry: LibraryEntry) => void;
}) {
  // The card's centre in content coordinates: rotation is 0 when it sits at
  // the viewport centre and tilts outward toward either edge.
  const center = contentPad + index * (cardWidth * (1 - FAN_CARD_OVERLAP_RATIO)) + cardWidth / 2;
  const tilt = useAnimatedStyle(() => {
    const rotate = interpolate(
      scrollX.value,
      [center - viewportWidth, center - viewportWidth / 2, center],
      [FAN_TILT_DEGREES, 0, -FAN_TILT_DEGREES],
      Extrapolation.CLAMP,
    );
    const translateY = interpolate(
      scrollX.value,
      [center - viewportWidth, center - viewportWidth / 2, center],
      [FAN_ARC_DROP, 0, FAN_ARC_DROP],
      Extrapolation.CLAMP,
    );
    return { transform: [{ rotate: `${rotate}deg` }, { translateY }] };
  });
  return (
    <Animated.View
      style={[
        tilt,
        {
          width: cardWidth,
          marginLeft: index === 0 ? 0 : -cardWidth * FAN_CARD_OVERLAP_RATIO,
          ...createNemuShadowStyle({
            color: "#000000",
            offsetY: 6,
            radius: 14,
            opacity: 0.18,
            elevation: 4,
          }),
        },
      ]}
    >
      <PagekinCover
        entry={entry}
        installedSources={installedSources}
        width={cardWidth}
        radius={10}
        zoomId={`pagekin-fan:${entry.item.libraryItemId}`}
        onOpen={(opened, cover) =>
          openPagekinEntry(opened, cover, `pagekin-fan:${opened.item.libraryItemId}`)
        }
        onLongPress={onEntryLongPress}
      />
    </Animated.View>
  );
});

export const MobileLibraryPagekinHome = memo(function MobileLibraryPagekinHome({
  entries,
  progressIndex,
  cardProgress,
  strings,
  installedSources,
  onEntryLongPress,
}: {
  /** The library in grid order; the featured title is picked from it. */
  entries: LibraryEntry[];
  progressIndex: MobileLibraryProgressIndex;
  cardProgress: ReadonlyMap<string, MobileLibraryCardProgress>;
  strings: MobileStrings;
  installedSources: InstalledSource[];
  /** Long-press on a cover opens that entry's quick menu. */
  onEntryLongPress?: (entry: LibraryEntry) => void;
}) {
  const { tokens } = useNemuTheme();
  const { width: viewportWidth } = useWindowDimensions();
  const scrollX = useSharedValue(0);
  const handleFanScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollX.value = event.contentOffset.x;
    },
  });

  const featured = useMemo(
    () => pickMobileLibraryFeaturedEntry(entries, progressIndex),
    [entries, progressIndex],
  );
  const rest = useMemo(
    () =>
      featured ? entries.filter((entry) => entry.item.libraryItemId !== featured.item.libraryItemId) : entries,
    [entries, featured],
  );
  const featuredFraction = featured ? mobileLibraryReadFraction(featured, progressIndex) : null;
  const featuredSubtitle = featured
    ? (cardProgress.get(featured.item.libraryItemId)?.subtitle ?? strings.library.progressUnread)
    : null;

  const featuredWidth = Math.min(
    viewportWidth * FEATURED_COVER_WIDTH_RATIO,
    FEATURED_COVER_MAX_WIDTH,
  );
  const fanCardWidth = viewportWidth * FAN_CARD_WIDTH_RATIO;

  if (!featured) return null;
  return (
    <View style={styles.root}>
      <View style={styles.featured}>
        <View
          style={createNemuShadowStyle({
            color: "#000000",
            offsetY: 10,
            radius: 24,
            opacity: 0.25,
            elevation: 8,
          })}
        >
          <PagekinCover
            entry={featured}
            installedSources={installedSources}
            width={featuredWidth}
            radius={14}
            zoomId={`pagekin-featured:${featured.item.libraryItemId}`}
            superResolve
            grain
            onOpen={(opened, cover) =>
              openPagekinEntry(opened, cover, `pagekin-featured:${opened.item.libraryItemId}`)
            }
            onLongPress={onEntryLongPress}
          />
        </View>
        {featured.item.metadata.authors?.[0] ? (
          <NemuText color={tokens.mutedForeground} numberOfLines={1} style={styles.author}>
            {featured.item.metadata.authors[0]}
          </NemuText>
        ) : null}
        <NemuText color={tokens.foreground} numberOfLines={2} style={styles.title}>
          {getEntryTitle(featured)}
        </NemuText>
        {featuredFraction !== null ? (
          <View style={[styles.progressRow, { width: featuredWidth }]}>
            <View style={[styles.track, { backgroundColor: tokens.border }]}>
              <View
                style={[
                  styles.fill,
                  { width: `${featuredFraction * 100}%`, backgroundColor: tokens.foreground },
                ]}
              />
            </View>
            <NemuText color={tokens.mutedForeground} style={styles.percent}>
              {`${Math.round(featuredFraction * 100)}%`}
            </NemuText>
          </View>
        ) : featuredSubtitle ? (
          <NemuText color={tokens.mutedForeground} numberOfLines={1} style={styles.progressText}>
            {featuredSubtitle}
          </NemuText>
        ) : null}
      </View>

      {rest.length > 0 ? (
        <Animated.ScrollView
          horizontal
          scrollsToTop={false}
          showsHorizontalScrollIndicator={false}
          onScroll={handleFanScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingHorizontal: FAN_CONTENT_PADDING,
            paddingVertical: 12,
          }}
          style={styles.fan}
        >
          {rest.map((entry, index) => (
            <PagekinFanCard
              key={entry.item.libraryItemId}
              entry={entry}
              index={index}
              cardWidth={fanCardWidth}
              contentPad={FAN_CONTENT_PADDING}
              viewportWidth={viewportWidth}
              scrollX={scrollX}
              installedSources={installedSources}
              onEntryLongPress={onEntryLongPress}
            />
          ))}
        </Animated.ScrollView>
      ) : null}
      <View style={{ height: PAGEKIN_BOTTOM_CLEARANCE }} />
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    paddingTop: 8,
  },
  featured: {
    alignItems: "center",
    paddingHorizontal: 20,
  },
  author: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 16,
    textAlign: "center",
  },
  title: {
    fontSize: 20,
    fontWeight: nemuFontWeight.bold,
    lineHeight: 26,
    marginTop: 4,
    textAlign: "center",
  },
  progressRow: {
    alignItems: "center",
    flexDirection: "row",
    marginTop: 10,
  },
  track: {
    borderRadius: 2,
    flex: 1,
    height: 3,
    overflow: "hidden",
  },
  fill: {
    borderRadius: 2,
    height: 3,
  },
  percent: {
    fontSize: 12,
    lineHeight: 16,
    marginLeft: 8,
  },
  progressText: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 10,
    textAlign: "center",
  },
  fan: {
    marginTop: 20,
  },
});
