import type { LocalCollection } from "@/data/schema";

/**
 * The default collection the Library opens on: the stored id when it still
 * names a collection, otherwise null (All). A collection deleted since the
 * default was picked falls back to All instead of naming a missing one.
 */
export function resolveMobileLibraryDefaultCollectionId(
  collections: LocalCollection[],
  storedCollectionId: string | null,
): string | null {
  const id = storedCollectionId?.trim() ? storedCollectionId.trim() : null;
  if (id === null) return null;
  return collections.some((collection) => collection.collectionId === id)
    ? id
    : null;
}
