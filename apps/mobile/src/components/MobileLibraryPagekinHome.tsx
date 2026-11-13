import { memo, useMemo, useState } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { ZoomSource } from "../../modules/nemu-window-layout";
import {
  createNemuShadowStyle,
  MobileCachedImage,
  nemuFontWeight,
  NemuText,
  useMobilePageBleedStyles,
  useNemuTheme,
} from "@/design-system";
import { MobileExploreCoverPlaceholder } from "@/components/explore/MobileExploreCoverPlaceholder";
import {
  pushMobileExploreDetail,
  useMobileExploreEntryCover,
} from "@/components/explore/mobileExploreCover";
import {
  getEntryTitle,
  type InstalledSource,
  type LibraryEntry,
} from "@/data/schema";
import { useSuperResolvedCover } from "@/lib/mobileSuperResolution";
import pagekinCoverGrain from "../../assets/pagekin-cover-grain.png";
import type { MobileStrings } from "@/lib/mobileI18n";
import {
  mobileLibraryReadFraction,
  pickMobileLibraryFeaturedEntry,
  type MobileLibraryCardProgress,
  type MobileLibraryProgressIndex,
} from "@/lib/mobileLibraryPresentation";
import {
  mobileGridGlideAppearing,
  mobileGridGlideTransition,
  mobileGridGlideVanishing,
} from "@/lib/mobilePoseLayoutAnimations";
import { ExploreDissolveTarget } from "@/components/explore/ExploreDissolveTarget";

type PagekinCoverSource = ReturnType<typeof useMobileExploreEntryCover>;

// The Pagekin home: one big currently-reading cover (author, title, progress)
// over a row of the rest of the library. The row rests gathered — overlapping,
// staggered like books on a shelf — and spreads out while it scrolls: a gap
// between neighbours, tops aligned, then gathers again once the scroll
// settles. (An earlier fan — tilted, overlapping cards — read as one grey
// block, because the tilted shadows merged and the scroller clipped them;
// the fan is gone. A later always-leaning row read as stuck together,
// because it never opened up while scrolling. Frame-by-frame measurement
// of the reference (2026-11-13) showed its cards do not rotate at all —
// the left edge of a resting card is vertical to the pixel over 300 px —
// the shelf look is stagger plus overlap alone, so this row does not tilt
// either; the earlier ±5° tilt, driven by one shared withTiming value, is
// what read as stiff.)

const FEATURED_COVER_WIDTH_RATIO = 0.54;
const FEATURED_COVER_MAX_WIDTH = 240;
// Paper grain over the featured cover only: a tileable noise tile at low
// opacity breaks up the smooth upscaling blur of a small source cover,
// the way a printed cover's grain does. The row covers stay clean.
const FEATURED_GRAIN_OPACITY = 0.15;
// The featured cover reads as a physical book: a page block peeks out on
// its left edge (warm paper, two hairline page separations), the way the
// Pagekin reference renders the currently-reading book. The row stays flat.
const FEATURED_SPINE_WIDTH = 5;
const FEATURED_SPINE_PAPER = "#F5F1E6";
// Three row cards fit the viewport, with the next one peeking in at the
// edge to invite the scroll.
const ROW_VISIBLE_CARDS = 3;
const ROW_CARD_GAP = 16;
const ROW_CONTENT_PADDING = 20;
// The row's two states. At rest the cards sit like books on a shelf
// (Pagekin): overlapping slightly, tops staggered a few points. While it
// scrolls it opens up: ROW_CARD_GAP between neighbours, tops aligned.
// ROW_CARD_GAP only sizes the cards (see rowCardWidth); at rest the laid-out
// cards overlap by ROW_OVERLAP instead of leaving a gap.
// Measured from the reference (2026-11-13, full-res frames): resting tops
// differ by up to ~13 pt while bottoms sit on one line, and no card
// rotates — so the stagger carries the shelf look, not a tilt.
const ROW_OVERLAP = 12;
const ROW_Y_OFFSETS = [13, 0, 2, 9];
// The row ScrollView mounts every card at once, so upscaling the whole
// library on first open would spike the Neural Engine: only the visible
// strip plus a buffer gets the 4x upscale (the first 8 cards); further
// down the row stays raw. The cache is per URL, so each cover pays the
// cost once.
const ROW_SR_LIMIT = 8;
// Each card starts its spring this many ms after the one before it, so
// the row opens and gathers like a wave instead of all at once.
const ROW_STAGGER_MS = 30;
// Opening is quick with a breath of overshoot; gathering is slower and
// settles soft. Both are springs, not fixed-duration timings: a flick's
// momentum reversing the target mid-gather just retargets the springs.
const ROW_SPREAD_SPRING = { stiffness: 400, damping: 30 };
const ROW_GATHER_SPRING = { stiffness: 170, damping: 22 };
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
  spine,
}: {
  entry: LibraryEntry;
  installedSources: InstalledSource[];
  width: number;
  radius: number;
  onOpen: (entry: LibraryEntry, cover: PagekinCoverSource) => void;
  /** Long-press opens the entry's quick menu (edit info, collections…). */
  onLongPress?: (entry: LibraryEntry) => void;
  zoomId: string;
  /** Upscale the cover 4x on-device (featured cover always; row cards up to ROW_SR_LIMIT). */
  superResolve?: boolean;
  /** Paper grain over the cover (featured cover only; the row stays clean). */
  grain?: boolean;
  /** Page block on the cover's left edge (featured cover only). */
  spine?: boolean;
}) {
  const { tokens } = useNemuTheme();
  // The same cover the grid cells and the detail page paint, so the home
  // shares their cached image.
  const coverSource = useMobileExploreEntryCover(entry, installedSources);
  const uri = coverSource?.uri;
  // The upscaled file swaps in when it is ready; until then (and when the
  // build has no model) the original cover shows, so the upscale never
  // blocks the shelf from painting.
  const upscaledUri = useSuperResolvedCover(
    superResolve ? uri : null,
    coverSource?.headers,
  );
  const displayCover = upscaledUri ? { uri: upscaledUri } : coverSource;
  // Which cover URI has actually painted. The grain only renders on top of
  // a loaded cover: over an empty slot it would read as a lone dark grain
  // rectangle, and keyed by URI it hides again when the featured book
  // changes until the new cover lands.
  const [loadedUri, setLoadedUri] = useState<string | null>(null);
  const height = width * 1.5;
  // With a spine the frame is the cover plus the page block; without one it
  // is just the cover.
  const totalWidth = width + (spine ? FEATURED_SPINE_WIDTH : 0);
  return (
    <Pressable
      accessibilityLabel={getEntryTitle(entry)}
      accessibilityRole="button"
      onPress={() => onOpen(entry, displayCover)}
      onLongPress={onLongPress ? () => onLongPress(entry) : undefined}
    >
      <ZoomSource
        zoomId={zoomId}
        // The frame's curve has to clip its children: the spine's own
        // left radii do not round it on their own (the #17 build showed
        // the spine's top-left as a right angle), and the cover's left
        // corners are square against the spine by design. Without this
        // the whole left edge reads as a straight strip.
        style={{ width: totalWidth, height, borderRadius: radius, overflow: "hidden" }}
      >
        {displayCover ? (
          <View style={{ flexDirection: "row", width: totalWidth, height }}>
            {spine ? (
              <View
                style={{
                  width: FEATURED_SPINE_WIDTH,
                  height,
                  backgroundColor: FEATURED_SPINE_PAPER,
                  borderTopLeftRadius: radius,
                  borderBottomLeftRadius: radius,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    position: "absolute",
                    left: 1,
                    top: 0,
                    bottom: 0,
                    width: 1,
                    backgroundColor: "rgba(0,0,0,0.10)",
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    left: 3,
                    top: 0,
                    bottom: 0,
                    width: 1,
                    backgroundColor: "rgba(0,0,0,0.10)",
                  }}
                />
              </View>
            ) : null}
            <View style={{ position: "relative", width, height }}>
              <MobileCachedImage
                uriOwnership={upscaledUri ? "app" : "source"}
                source={displayCover}
                onLoad={() => setLoadedUri(uri ?? null)}
                onError={() => setLoadedUri(null)}
                style={{
                  width,
                  height,
                  borderTopRightRadius: radius,
                  borderBottomRightRadius: radius,
                  borderTopLeftRadius: spine ? 0 : radius,
                  borderBottomLeftRadius: spine ? 0 : radius,
                  borderWidth: 1,
                  borderColor: tokens.coverBorder,
                }}
              />
              {grain && loadedUri === uri ? (
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
                    borderTopRightRadius: radius,
                    borderBottomRightRadius: radius,
                    borderTopLeftRadius: spine ? 0 : radius,
                    borderBottomLeftRadius: spine ? 0 : radius,
                    opacity: FEATURED_GRAIN_OPACITY,
                  }}
                />
              ) : null}
            </View>
          </View>
        ) : (
          <MobileExploreCoverPlaceholder
            title={getEntryTitle(entry)}
            width={width}
          />
        )}
      </ZoomSource>
    </Pressable>
  );
});

const PagekinRowCard = memo(function PagekinRowCard({
  entry,
  index,
  cardWidth,
  installedSources,
  onEntryLongPress,
  leaving,
  spread,
}: {
  entry: LibraryEntry;
  index: number;
  cardWidth: number;
  installedSources: InstalledSource[];
  onEntryLongPress?: (entry: LibraryEntry) => void;
  /** True while this card is playing its delete exit (it stays in the held list one commit). */
  leaving?: boolean;
  /** 0 at rest (gathered, overlapping) → 1 while the row scrolls (gapped, level tops). */
  spread: SharedValue<number>;
}) {
  // The outer view carries the delete animation (the grid cells' own
  // glide): a leaving card fades where it stands while the rest glide
  // into the gap. The dissolve target sits inside it, so deleting this
  // card turns it to dust — the grid's shake-and-scraps — instead of
  // only fading it: the target hides the card, shadow included, while
  // its dust flies. At rest the card sits like a book on a shelf: it
  // overlaps its neighbour and sits a few points higher or lower than
  // the next, so each shadow still belongs to one book and nothing merges
  // into a slab under the row. While the row scrolls it stands with a gap
  // and level tops, then gathers again once the scroll settles. No
  // rotation: the reference does not tilt its cards (measured vertical to
  // the pixel), and the ±5° tilt is what made this row read as stiff.
  const yOffset = ROW_Y_OFFSETS[index % ROW_Y_OFFSETS.length];
  // Each card follows the row's spread on its own spring, starting
  // ROW_STAGGER_MS after the one before it. The spring config follows the
  // target: quick with a breath of overshoot while opening, slower and
  // soft while gathering.
  const localSpread = useDerivedValue(() =>
    withDelay(
      index * ROW_STAGGER_MS,
      withSpring(
        spread.value,
        spread.value === 1 ? ROW_SPREAD_SPRING : ROW_GATHER_SPRING,
      ),
    ),
  );
  const animatedStyle = useAnimatedStyle(() => {
    const value = localSpread.value;
    return {
      width: cardWidth,
      marginLeft:
        index === 0
          ? 0
          : interpolate(value, [0, 1], [-ROW_OVERLAP, ROW_CARD_GAP]),
      transform: [{ translateY: yOffset * (1 - value) }],
    };
  });
  return (
    <Animated.View
      layout={mobileGridGlideTransition}
      exiting={leaving ? mobileGridGlideVanishing : undefined}
      style={animatedStyle}
    >
      <ExploreDissolveTarget id={entry.item.libraryItemId}>
        <View
          style={createNemuShadowStyle({
            color: "#000000",
            offsetY: 4,
            radius: 10,
            opacity: 0.15,
            elevation: 4,
          })}
        >
          <PagekinCover
            entry={entry}
            installedSources={installedSources}
            width={cardWidth}
            // Row cards share the featured cover's 18pt corners now
            // (the fan's 10pt was dropped with the fan).
            radius={18}
            // The first cards get the same 4x upscale as the featured
            // cover; further down the row stays raw (see ROW_SR_LIMIT).
            superResolve={index < ROW_SR_LIMIT}
            zoomId={`pagekin-row:${entry.item.libraryItemId}`}
            onOpen={(opened, cover) =>
              openPagekinEntry(
                opened,
                cover,
                `pagekin-row:${opened.item.libraryItemId}`,
              )
            }
            onLongPress={onEntryLongPress}
          />
        </View>
      </ExploreDissolveTarget>
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
  leavingIds,
}: {
  /** The library in grid order; the featured title is picked from it. */
  entries: LibraryEntry[];
  progressIndex: MobileLibraryProgressIndex;
  cardProgress: ReadonlyMap<string, MobileLibraryCardProgress>;
  strings: MobileStrings;
  installedSources: InstalledSource[];
  /** Long-press on a cover opens that entry's quick menu. */
  onEntryLongPress?: (entry: LibraryEntry) => void;
  /** Ids playing their delete exit this commit (the grid glide's `leaving`). */
  leavingIds?: ReadonlySet<string> | null;
}) {
  const { tokens, scheme } = useNemuTheme();
  const { width: viewportWidth } = useWindowDimensions();
  // The row is the ListHeaderComponent of a scaffold FlatList whose content
  // is gutter-padded, so without a bleed the row's frame ends one gutter
  // short of the screen edge and the peeking card is cut off 20 pt early.
  // The bleed restores the geometry rowCardWidth was sized for: first card
  // one ROW_CONTENT_PADDING in from the viewport edge, the next card peeking
  // right up to the screen edge.
  const pageBleed = useMobilePageBleedStyles();

  // The row's scroll state: 0 at rest, 1 while it scrolls. This value is
  // only the target — each card follows it on its own spring (see
  // PagekinRowCard), so there is no fixed delay and no fixed-duration
  // timing: the gather starts the moment the scroll settles, and a flick
  // whose momentum retargets the row mid-gather just bends the springs.
  const rowSpread = useSharedValue(0);
  const spreadRow = () => {
    rowSpread.value = 1;
  };
  const gatherRow = () => {
    rowSpread.value = 0;
  };

  const featured = useMemo(
    () => pickMobileLibraryFeaturedEntry(entries, progressIndex),
    [entries, progressIndex],
  );
  const rest = useMemo(
    () =>
      featured
        ? entries.filter(
            (entry) => entry.item.libraryItemId !== featured.item.libraryItemId,
          )
        : entries,
    [entries, featured],
  );
  const featuredFraction = featured
    ? mobileLibraryReadFraction(featured, progressIndex)
    : null;
  const featuredSubtitle = featured
    ? (cardProgress.get(featured.item.libraryItemId)?.subtitle ??
      strings.library.progressUnread)
    : null;

  const featuredWidth = Math.min(
    viewportWidth * FEATURED_COVER_WIDTH_RATIO,
    FEATURED_COVER_MAX_WIDTH,
  );
  // Three row cards fit the viewport (the next one peeking in at the edge
  // invites the scroll). At rest the cards overlap by ROW_OVERLAP once laid
  // out, so ROW_CARD_GAP here only sizes the cards, it is not the pitch;
  // while the row scrolls the pitch is the card width plus ROW_CARD_GAP.
  const rowCardWidth =
    (viewportWidth -
      ROW_CONTENT_PADDING * 2 -
      ROW_CARD_GAP * (ROW_VISIBLE_CARDS - 1)) /
    ROW_VISIBLE_CARDS;

  if (!featured) return null;
  return (
    <View style={styles.root}>
      {/* Keyed by the featured title: deleting it fades the whole featured
          block out and the next title in (the grid glide's window gates
          both, so a progress-driven swap stays instant). The dissolve
          target wraps the block, so deleting the featured title turns it
          to dust like a grid cell. */}
      <ExploreDissolveTarget id={featured.item.libraryItemId}>
        <Animated.View
          key={featured.item.libraryItemId}
          entering={mobileGridGlideAppearing}
          exiting={mobileGridGlideVanishing}
          style={styles.featured}
        >
          <View
            style={createNemuShadowStyle({
              color: "#000000",
              // Daytime the old shadow (offset 10, radius 24, 0.25) read as a
              // grey smudge on white; the reference shadow hugs the cover and
              // fades fast, so light mode gets a tighter, lighter one. Dark
              // mode keeps the stronger shadow, where it read fine.
              ...(scheme === "dark"
                ? { offsetY: 10, radius: 24, opacity: 0.25, elevation: 8 }
                : { offsetY: 6, radius: 16, opacity: 0.2, elevation: 6 }),
            })}
          >
            <PagekinCover
              entry={featured}
              installedSources={installedSources}
              width={featuredWidth}
              radius={18}
              zoomId={`pagekin-featured:${featured.item.libraryItemId}`}
              superResolve
              grain
              spine
              onOpen={(opened, cover) =>
                openPagekinEntry(
                  opened,
                  cover,
                  `pagekin-featured:${opened.item.libraryItemId}`,
                )
              }
              onLongPress={onEntryLongPress}
            />
          </View>
          {featured.item.metadata.authors?.[0] ? (
            <NemuText
              color={tokens.mutedForeground}
              numberOfLines={1}
              style={styles.author}
            >
              {featured.item.metadata.authors[0]}
            </NemuText>
          ) : null}
          <NemuText
            color={tokens.foreground}
            numberOfLines={2}
            style={styles.title}
          >
            {getEntryTitle(featured)}
          </NemuText>
          {featuredFraction !== null ? (
            <View
              style={[
                styles.progressRow,
                { width: featuredWidth + FEATURED_SPINE_WIDTH },
              ]}
            >
              <View style={[styles.track, { backgroundColor: tokens.border }]}>
                <View
                  style={[
                    styles.fill,
                    {
                      width: `${featuredFraction * 100}%`,
                      backgroundColor: tokens.foreground,
                    },
                  ]}
                />
              </View>
              <NemuText color={tokens.mutedForeground} style={styles.percent}>
                {`${Math.round(featuredFraction * 100)}%`}
              </NemuText>
            </View>
          ) : featuredSubtitle ? (
            <NemuText
              color={tokens.mutedForeground}
              numberOfLines={1}
              style={styles.progressText}
            >
              {featuredSubtitle}
            </NemuText>
          ) : null}
        </Animated.View>
      </ExploreDissolveTarget>

      {rest.length > 0 ? (
        <Animated.ScrollView
          horizontal
          scrollsToTop={false}
          showsHorizontalScrollIndicator={false}
          onScrollBeginDrag={spreadRow}
          onMomentumScrollBegin={spreadRow}
          onMomentumScrollEnd={gatherRow}
          onScrollEndDrag={gatherRow}
          contentContainerStyle={{
            paddingHorizontal: ROW_CONTENT_PADDING,
            // The row shadow (offset 4, radius 10) fades ~25pt past the
            // cover; 32pt of bottom room lets it fade out before the
            // scroller's edge, so no hard line ever appears under the row.
            paddingTop: 12,
            paddingBottom: 32,
          }}
          style={[styles.row, pageBleed.frame]}
        >
          {rest.map((entry, index) => (
            <PagekinRowCard
              key={entry.item.libraryItemId}
              entry={entry}
              index={index}
              cardWidth={rowCardWidth}
              installedSources={installedSources}
              onEntryLongPress={onEntryLongPress}
              leaving={leavingIds?.has(entry.item.libraryItemId) ?? false}
              spread={rowSpread}
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
  row: {
    marginTop: 20,
  },
});
