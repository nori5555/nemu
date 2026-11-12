import type { MobileDataStore } from "@/data/storeTypes";
import type { InstalledSource, LibraryEntry } from "@/data/schema";
import { emitMobileDataChanged } from "@/data/mobileDataEvents";
import { makeSourceKey } from "@/sources/aidokuRegistry";
import {
  findLibraryEntryForLiveSearchResult,
  makeLiveSearchLibraryImport,
} from "@/lib/mobileLibraryImport";
import {
  toSearchSourceDisplay,
  type SearchSourceDisplay,
} from "@/lib/mobileSearch";
import {
  mapAidokuMangasToLiveSearchMangaWithImageRequests,
  type MobileLiveSearchManga,
} from "@/sources/mobileSourceSearch";
import { selectSuwayomiServerSources } from "./serverSources";
import {
  runWithSuwayomiServerSession,
  type SelfHostedReadySession,
} from "./serverSession";

/** Cap on how many server library items one sync pulls in. */
const SYNC_MAX_ITEMS = 500;

export type SuwayomiLibrarySyncPlan = {
  /** Server items with no local entry yet: create one for each. */
  toAddLocal: MobileLiveSearchManga[];
  /** Local entries linked to this server but missing from its library. */
  toPushToServer: { sourceMangaId: string; title: string }[];
  /**
   * Server items the user removed locally (soft-deleted, `inLibrary: false`)
   * and did not re-add: un-library them on the server instead of letting
   * the next sync resurrect them locally (the removal is the newer fact).
   */
  toRemoveFromServer: { sourceMangaId: string; title: string }[];
};

/**
 * The pure merge step: which server items are new locally, which local
 * entries the server does not have yet, and which server items the user
 * removed locally (so the sync un-libraries them on the server instead of
 * resurrecting them). Kept pure so it can be tested without a store or a
 * session.
 *
 * `removedEntries` are the local soft-deleted rows (`inLibrary: false`)
 * for this server's sources. A removed id that also has an in-library
 * entry (the user deleted, then added the title back) is not a removal.
 */
export function planSuwayomiLibrarySync(
  serverItems: MobileLiveSearchManga[],
  localEntries: LibraryEntry[],
  display: SearchSourceDisplay,
  removedEntries: LibraryEntry[] = [],
): SuwayomiLibrarySyncPlan {
  const sourceKeys = new Set(
    display.sourceKeys ?? [makeSourceKey(display.registryId, display.rawSourceId)],
  );
  const serverIds = new Set(serverItems.map((item) => item.id));
  const seenServerIds = new Set<string>();
  const removedIds = new Set<string>();
  for (const entry of removedEntries) {
    for (const link of entry.sources) {
      if (!sourceKeys.has(makeSourceKey(link.registryId, link.sourceId))) continue;
      removedIds.add(link.sourceMangaId);
    }
  }
  const inLibraryIds = new Set<string>();
  for (const entry of localEntries) {
    for (const link of entry.sources) {
      if (!sourceKeys.has(makeSourceKey(link.registryId, link.sourceId))) continue;
      inLibraryIds.add(link.sourceMangaId);
    }
  }
  const toAddLocal = serverItems.filter((item) => {
    if (seenServerIds.has(item.id)) return false;
    seenServerIds.add(item.id);
    // A locally removed title is not new: the removal is the newer fact,
    // and re-adding it here is what made deleted books come back.
    if (removedIds.has(item.id)) return false;
    return !findLibraryEntryForLiveSearchResult(localEntries, display, item);
  });
  const toRemoveFromServer: SuwayomiLibrarySyncPlan["toRemoveFromServer"] = [];
  for (const item of serverItems) {
    if (!removedIds.has(item.id) || inLibraryIds.has(item.id)) continue;
    if (toRemoveFromServer.some((target) => target.sourceMangaId === item.id)) continue;
    toRemoveFromServer.push({ sourceMangaId: item.id, title: item.title });
  }
  const seenPushIds = new Set<string>();
  const toPushToServer: SuwayomiLibrarySyncPlan["toPushToServer"] = [];
  for (const entry of localEntries) {
    for (const link of entry.sources) {
      if (!sourceKeys.has(makeSourceKey(link.registryId, link.sourceId))) continue;
      if (serverIds.has(link.sourceMangaId) || seenPushIds.has(link.sourceMangaId)) continue;
      seenPushIds.add(link.sourceMangaId);
      toPushToServer.push({
        sourceMangaId: link.sourceMangaId,
        title: entry.item.metadata.title,
      });
    }
  }
  return { toAddLocal, toPushToServer, toRemoveFromServer };
}

export type SuwayomiLibrarySyncResult = {
  addedLocal: number;
  pushedToServer: number;
  removedFromServer: number;
};

type SessionRunner = <T>(
  fn: (session: SelfHostedReadySession) => Promise<T>,
) => Promise<T>;

/**
 * Two-way sync between one Suwayomi server's library and the local
 * library: server items missing locally get a local entry (no chapters
 * needed — the detail page fetches them on demand), local entries
 * linked to this server but missing from it are pushed to the server,
 * and titles the user removed locally are un-libraried on the server
 * (without this third direction the next sync re-added every local
 * removal from the server's still-present copy). Per-item failures never
 * abort the sync; the library-changed event fires once at the end, only
 * if anything changed.
 */
export async function syncSuwayomiLibrary(
  store: MobileDataStore,
  installedSource: InstalledSource,
  options: {
    maxItems?: number;
    runWithSession?: SessionRunner;
  } = {},
): Promise<SuwayomiLibrarySyncResult> {
  const maxItems = options.maxItems ?? SYNC_MAX_ITEMS;
  const run: SessionRunner =
    options.runWithSession ??
    ((fn) => runWithSuwayomiServerSession(store, installedSource, fn));
  const display = toSearchSourceDisplay(installedSource);

  const serverItems = await run(async (session) => {
    const items: MobileLiveSearchManga[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && items.length < maxItems) {
      const pageResult = await session.source.getMangaListForListing(
        { id: "library", name: "Library" },
        page,
      );
      items.push(
        ...(await mapAidokuMangasToLiveSearchMangaWithImageRequests(
          session.source,
          pageResult.entries,
        )),
      );
      hasMore = pageResult.hasNextPage;
      page += 1;
    }
    return items.slice(0, maxItems);
  });

  const localEntries = await store.getLibraryEntries();
  // The soft-deleted rows (`inLibrary: false`) are the removal tombstones:
  // without them the sync cannot tell "never had it" from "the user just
  // removed it", and it re-adds the removal from the server's copy.
  const removedEntries = await readRemovedLibraryEntries(store);
  const plan = planSuwayomiLibrarySync(serverItems, localEntries, display, removedEntries);

  let addedLocal = 0;
  const now = Date.now();
  for (const item of plan.toAddLocal) {
    const imported = makeLiveSearchLibraryImport(display, item, now);
    await store.saveLibraryItem(imported.item);
    await store.saveSourceLink(imported.sourceLink);
    addedLocal += 1;
  }

  let pushedToServer = 0;
  if (plan.toPushToServer.length > 0) {
    await run(async (session) => {
      if (typeof session.source.addToLibrary !== "function") return;
      for (const target of plan.toPushToServer) {
        try {
          await session.source.addToLibrary({
            key: target.sourceMangaId,
            title: target.title,
          });
          pushedToServer += 1;
        } catch {
          // One push failing must not abort the rest of the sync.
        }
      }
    });
  }

  let removedFromServer = 0;
  if (plan.toRemoveFromServer.length > 0) {
    await run(async (session) => {
      if (typeof session.source.removeMangaFromLibrary !== "function") return;
      for (const target of plan.toRemoveFromServer) {
        try {
          await session.source.removeMangaFromLibrary({
            key: target.sourceMangaId,
            title: target.title,
          });
          removedFromServer += 1;
        } catch {
          // One removal failing must not abort the rest of the sync; the
          // tombstone stays, so the next sync retries it.
        }
      }
    });
  }

  if (addedLocal > 0 || pushedToServer > 0 || removedFromServer > 0) {
    emitMobileDataChanged("library");
  }
  return { addedLocal, pushedToServer, removedFromServer };
}

/**
 * The soft-deleted library rows (`inLibrary: false`), joined with their
 * still-present source links. Read with `includeRemoved`: the sync-merge
 * paths are the ones that need the removal markers.
 */
async function readRemovedLibraryEntries(
  store: MobileDataStore,
): Promise<LibraryEntry[]> {
  const items = await store.getAllLibraryItems({ includeRemoved: true });
  const links = await store.getAllSourceLinks({ includeRemoved: true });
  const linksByItem = new Map<string, LibraryEntry["sources"]>();
  for (const link of links) {
    if (link.removed) continue;
    const list = linksByItem.get(link.libraryItemId) ?? [];
    list.push(link);
    linksByItem.set(link.libraryItemId, list);
  }
  return items
    .filter((item) => item.inLibrary === false)
    .map((item) => ({
      item,
      sources: linksByItem.get(item.libraryItemId) ?? [],
    }));
}

/**
 * Sync every installed Suwayomi server. A server that cannot be reached
 * is skipped (its error never breaks the caller's refresh); the result
 * totals the servers that did sync.
 */
export async function syncAllSuwayomiLibraries(
  store: MobileDataStore,
  installedSources: InstalledSource[],
): Promise<SuwayomiLibrarySyncResult> {
  let addedLocal = 0;
  let pushedToServer = 0;
  let removedFromServer = 0;
  for (const server of selectSuwayomiServerSources(installedSources)) {
    try {
      const result = await syncSuwayomiLibrary(store, server);
      addedLocal += result.addedLocal;
      pushedToServer += result.pushedToServer;
      removedFromServer += result.removedFromServer;
    } catch {
      // Unreachable server: leave the local library alone and continue.
    }
  }
  return { addedLocal, pushedToServer, removedFromServer };
}
