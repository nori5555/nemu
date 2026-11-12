import { StyleSheet, View } from "react-native";
import { ExploreCoverImage } from "@/components/explore/ExploreCoverImage";
import {
  NemuPressable,
  NemuText,
  nemuFontWeight,
  useNemuTheme,
} from "@/design-system";
import type { MobileLiveSearchManga } from "@/sources/mobileSourceSearch";

/**
 * One manga cell in a server-driven grid (server library, server-source
 * search results): cover, title, authors. The parent owns the cell layout
 * and anything below the card (e.g. an Add to Library button).
 */
export function ServerMangaGridCard({
  item,
  onPress,
  openLabel,
}: {
  item: MobileLiveSearchManga;
  onPress: () => void;
  openLabel: string;
}) {
  const { tokens } = useNemuTheme();
  return (
    <NemuPressable
      accessibilityRole="button"
      accessibilityLabel={`${openLabel}: ${item.title}`}
      onPress={onPress}
      pressedScale={0.98}
      style={styles.card}
    >
      <View
        style={[
          styles.cover,
          { backgroundColor: tokens.muted, borderColor: tokens.coverBorder },
        ]}
      >
        <ExploreCoverImage
          source={
            item.cover
              ? {
                  uri: item.cover,
                  headers: item.coverHeaders,
                  cache: "force-cache" as const,
                }
              : null
          }
          title={item.title}
        />
      </View>
      <NemuText numberOfLines={2} style={[styles.title, { color: tokens.foreground }]}>
        {item.title}
      </NemuText>
      {/* Always rendered: a missing author must leave the same slot, or
          cards in one row end up different heights and anything below the
          card (e.g. an Add to Library button) sits uneven. */}
      <NemuText numberOfLines={1} style={[styles.subtitle, { color: tokens.mutedForeground }]}>
        {item.authors?.length ? item.authors.join(", ") : ""}
      </NemuText>
    </NemuPressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 6,
  },
  cover: {
    aspectRatio: 3 / 4,
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
  },
  title: {
    fontSize: 13,
    fontWeight: nemuFontWeight.semibold,
    // Two lines, always: a one-line title must not make its card shorter
    // than a row-mate with a two-line title.
    lineHeight: 17,
    minHeight: 34,
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 15,
    minHeight: 15,
  },
});
