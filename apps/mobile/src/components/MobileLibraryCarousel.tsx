import { useCallback, useEffect, useRef } from "react";
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, { ZoomIn, ZoomOut } from "react-native-reanimated";
import type { ReactNode } from "react";
import { NemuPressable, useNemuTheme } from "@/design-system";
import { createNemuShadowStyle } from "@/design/shadows";
import { MobilePoseLayoutView } from "@/components/MobilePoseLayoutView";
import { getEntryTitle, type LibraryEntry } from "@/data/schema";
import type { MobileLibraryCardProgress } from "@/lib/mobileLibraryPresentation";

type Props = {
  entries: LibraryEntry[];
  selectedId: string | null;
  onSelect: (entry: LibraryEntry) => void;
  renderCard: (entry: LibraryEntry, width: number) => ReactNode;
  renderHeroCover: (entry: LibraryEntry) => ReactNode;
  progress: Map<string, MobileLibraryCardProgress>;
  strings: { library: { progressUnread: string } };
  reduceMotion: boolean;
};

/** Centered hero + horizontal, non-virtualizing cover rail. Selected covers remain in the rail. */
export function MobileLibraryCarousel({ entries, selectedId, onSelect, renderCard, renderHeroCover, progress, strings, reduceMotion }: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const { tokens } = useNemuTheme();
  const scroll = useRef<ScrollView>(null);
  const refs = useRef(new Map<string, View>());
  const heroWidth = Math.min(windowWidth * 0.57, 300);
  const railWidth = Math.min(windowWidth * 0.39, 172);
  const selected = entries.find((entry) => entry.item.libraryItemId === selectedId) ?? entries[0] ?? null;
  const selectedKey = selected?.item.libraryItemId ?? null;

  const centerCard = useCallback((id: string) => {
    requestAnimationFrame(() => refs.current.get(id)?.measureLayout(
      scroll.current?.getInnerViewNode?.() as never,
      (x, _y, width) => scroll.current?.scrollTo({ x: Math.max(0, x - (windowWidth - width) / 2), animated: true }),
      () => undefined,
    ));
  }, [windowWidth]);

  useEffect(() => {
    if (selectedKey) centerCard(selectedKey);
  }, [selectedKey, centerCard]);

  if (!selected) return null;
  const info = progress.get(selectedKey ?? "");
  return (
    <View style={styles.root}>
      <Animated.View key={selectedKey} entering={reduceMotion ? undefined : ZoomIn.duration(260)} exiting={reduceMotion ? undefined : ZoomOut.duration(150)} style={styles.hero}>
        <View style={{ width: heroWidth }}>
          <View style={[styles.heroCover, { borderColor: tokens.coverBorder, backgroundColor: tokens.muted, ...createNemuShadowStyle({ color: tokens.shadow, offsetY: 8, radius: 20, elevation: 7 }) }]}>
            {renderHeroCover(selected)}
          </View>
        </View>
        <View style={styles.heroText}>
          <Text style={[styles.author, { color: tokens.mutedForeground }]} numberOfLines={1}>{info?.author ?? strings.library.progressUnread}</Text>
          <Text style={[styles.title, { color: tokens.foreground }]} numberOfLines={2}>{getEntryTitle(selected)}</Text>
          {info?.badge ? <View style={[styles.progress, { backgroundColor: tokens.muted }]}><View style={[styles.progressFill, { width: `${Math.max(0, Math.min(100, Number.parseInt(info.badge, 10) || 27))}%`, backgroundColor: tokens.foreground }]} /></View> : null}
        </View>
      </Animated.View>
      <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.rail, { paddingHorizontal: Math.max(0, (windowWidth - railWidth) / 2 - 13) }]}>
        {entries.map((entry) => {
          const id = entry.item.libraryItemId;
          const isSelected = id === selectedKey;
          return (
            <MobilePoseLayoutView key={id} style={styles.railCell}>
              <View ref={(node) => { if (node) refs.current.set(id, node); else refs.current.delete(id); }} collapsable={false}>
                <NemuPressable accessibilityRole="button" accessibilityLabel={getEntryTitle(entry)} accessibilityState={{ selected: isSelected }} onPress={() => onSelect(entry)} style={[styles.railCard, { width: railWidth, opacity: isSelected ? 1 : 0.86, transform: [{ scale: isSelected ? 1 : 0.9 }] }]}>
                  {renderCard(entry, railWidth)}
                </NemuPressable>
              </View>
            </MobilePoseLayoutView>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: "100%", overflow: "visible" },
  hero: { alignItems: "center", paddingTop: 12, paddingBottom: 24 },
  heroCover: { width: "100%", aspectRatio: 2 / 3, borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, overflow: "hidden" },
  heroText: { width: "80%", marginTop: 12 },
  author: { fontSize: 15, lineHeight: 20 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "800", marginTop: 4 },
  progress: { height: 7, borderRadius: 5, marginTop: 10, overflow: "hidden" },
  progressFill: { height: "100%" },
  rail: { alignItems: "center", paddingVertical: 12 },
  railCell: { marginHorizontal: 7, width: "auto" },
  railCard: { overflow: "hidden" },
});
