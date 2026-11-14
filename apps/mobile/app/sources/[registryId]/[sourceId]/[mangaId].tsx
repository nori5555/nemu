import { useLocalSearchParams } from "expo-router";
import { MobileExploreZoomRoute } from "@/components/explore/MobileExploreZoomRoute";
import { SourceMangaScreen } from "@/screens/SourceMangaScreen";

export default function SourceMangaRoute() {
  const { zoom } = useLocalSearchParams<{ zoom?: string }>();
  // Design-explore: the page can grow out of the cover that opened it.
  return (
    <MobileExploreZoomRoute zoomId={zoom}>
      <SourceMangaScreen />
    </MobileExploreZoomRoute>
  );
}
