import { describe, expect, test } from "bun:test";
import type { InstalledSource, LibraryEntry } from "@/data/schema";
import type { MobileDataStore } from "@/data/storeTypes";
import { toSearchSourceDisplay, type SearchSourceDisplay } from "@/lib/mobileSearch";
import { makeLiveSearchLibraryImport } from "@/lib/mobileLibraryImport";
import type { MobileLiveSearchManga } from "@/sources/mobileSourceSearch";
import type { SelfHostedReadySession } from "./serverSession";
import {
  planSuwayomiLibrarySync,
  syncSuwayomiLibrary,
} from "./syncSuwayomiLibrary";

const serverSource = toSearchSourceDisplay({
  id: "self-hosted:suwayomi",
  registryId: "self-hosted",
  sourceId: "suwayomi",
  name: "Suwayomi",
  version: 1,
} as InstalledSource);

const otherSource: SearchSourceDisplay = {
  id: "aidoku-community:en.other",
  registryId: "aidoku-community",
  rawSourceId: "en.other",
  name: "Other",
};

const serverManga = (id: string, title: string): MobileLiveSearchManga => ({
  id,
  title,
});

function localEntry(display: SearchSourceDisplay, manga: MobileLiveSearchManga): LibraryEntry {
  const imported = makeLiveSearchLibraryImport(display, manga, 1000);
  return { item: imported.item, sources: [imported.sourceLink] };
}

function removedEntry(display: SearchSourceDisplay, manga: MobileLiveSearchManga): LibraryEntry {
  const entry = localEntry(display, manga);
  return { ...entry, item: { ...entry.item, inLibrary: false } };
}

describe("planSuwayomiLibrarySync", () => {
  test("adds server items missing locally and pushes local-only entries", () => {
    const plan = planSuwayomiLibrarySync(
      [serverManga("114", "特聘公务员"), serverManga("115", "海贼王")],
      [localEntry(serverSource, serverManga("114", "特聘公务员"))],
      serverSource,
    );
    expect(plan.toAddLocal.map((item) => item.id)).toEqual(["115"]);
    expect(plan.toPushToServer).toEqual([]);
  });

  test("pushes a local entry the server library does not have", () => {
    const plan = planSuwayomiLibrarySync(
      [serverManga("114", "特聘公务员")],
      [
        localEntry(serverSource, serverManga("114", "特聘公务员")),
        localEntry(serverSource, serverManga("331", "我独自升级")),
      ],
      serverSource,
    );
    expect(plan.toAddLocal).toEqual([]);
    expect(plan.toPushToServer).toEqual([
      { sourceMangaId: "331", title: "我独自升级" },
    ]);
  });

  test("ignores local entries linked to other sources", () => {
    const plan = planSuwayomiLibrarySync(
      [serverManga("114", "特聘公务员")],
      [localEntry(otherSource, serverManga("999", "Other Title"))],
      serverSource,
    );
    expect(plan.toAddLocal.map((item) => item.id)).toEqual(["114"]);
    expect(plan.toPushToServer).toEqual([]);
  });

  test("adds a duplicated server item only once", () => {
    const plan = planSuwayomiLibrarySync(
      [serverManga("114", "特聘公务员"), serverManga("114", "特聘公务员")],
      [],
      serverSource,
    );
    expect(plan.toAddLocal.map((item) => item.id)).toEqual(["114"]);
  });

  test("does not resurrect a locally removed title: un-libraries it on the server instead", () => {
    const plan = planSuwayomiLibrarySync(
      [serverManga("114", "特聘公务员"), serverManga("115", "海贼王")],
      [],
      serverSource,
      [removedEntry(serverSource, serverManga("114", "特聘公务员"))],
    );
    expect(plan.toAddLocal.map((item) => item.id)).toEqual(["115"]);
    expect(plan.toRemoveFromServer).toEqual([
      { sourceMangaId: "114", title: "特聘公务员" },
    ]);
    expect(plan.toPushToServer).toEqual([]);
  });

  test("a removed title that was added back is neither re-added nor un-libraried", () => {
    const plan = planSuwayomiLibrarySync(
      [serverManga("114", "特聘公务员")],
      [localEntry(serverSource, serverManga("114", "特聘公务员"))],
      serverSource,
      [removedEntry(serverSource, serverManga("114", "特聘公务员"))],
    );
    expect(plan.toAddLocal).toEqual([]);
    expect(plan.toRemoveFromServer).toEqual([]);
    expect(plan.toPushToServer).toEqual([]);
  });

  test("ignores removed entries linked to other sources", () => {
    const plan = planSuwayomiLibrarySync(
      [serverManga("114", "特聘公务员")],
      [],
      serverSource,
      [removedEntry(otherSource, serverManga("114", "特聘公务员"))],
    );
    expect(plan.toAddLocal.map((item) => item.id)).toEqual(["114"]);
    expect(plan.toRemoveFromServer).toEqual([]);
  });
});

describe("syncSuwayomiLibrary", () => {
  test("pages the server library, adds missing titles locally, pushes local-only ones", async () => {
    const entries: LibraryEntry[] = [
      localEntry(serverSource, serverManga("114", "特聘公务员")),
      localEntry(serverSource, serverManga("331", "我独自升级")),
    ];
    const store = {
      getLibraryEntries: async () => entries,
      getAllLibraryItems: async () => entries.map((entry) => entry.item),
      getAllSourceLinks: async () =>
        entries.flatMap((entry) => entry.sources),
      saveLibraryItem: async (item: LibraryEntry["item"]) => {
        entries.push({ item, sources: [] });
      },
      saveSourceLink: async (link: LibraryEntry["sources"][number]) => {
        const entry = entries.find((candidate) => candidate.item.libraryItemId === link.libraryItemId);
        entry?.sources.push(link);
      },
    } as unknown as MobileDataStore;

    const pushed: string[] = [];
    const session = {
      source: {
        getMangaListForListing: async (_listing: unknown, page: number) =>
          page === 1
            ? {
                entries: [
                  { key: "114", title: "特聘公务员" },
                  { key: "115", title: "海贼王" },
                ],
                hasNextPage: true,
              }
            : { entries: [{ key: "116", title: "咒术回战" }], hasNextPage: false },
        addToLibrary: async (manga: { key: string }) => {
          if (manga.key === "331") throw new Error("server rejected");
          pushed.push(manga.key);
        },
      },
    } as unknown as SelfHostedReadySession;

    const result = await syncSuwayomiLibrary(
      store,
      {
        id: "self-hosted:suwayomi",
        registryId: "self-hosted",
        sourceId: "suwayomi",
        name: "Suwayomi",
        version: 1,
      } as InstalledSource,
      { runWithSession: async (fn) => fn(session) },
    );
    // 115 and 116 are new locally; 331 is local-only but its push fails,
    // so it must not abort the sync or count as pushed.
    expect(result).toEqual({ addedLocal: 2, pushedToServer: 0, removedFromServer: 0 });
    expect(pushed).toEqual([]);
    expect(
      entries.map((entry) => entry.item.metadata.title).sort(),
    ).toEqual(["咒术回战", "我独自升级", "海贼王", "特聘公务员"]);
  });

  test("stops paging at the item cap", async () => {
    const entries: LibraryEntry[] = [];
    const store = {
      getLibraryEntries: async () => entries,
      getAllLibraryItems: async () => entries.map((entry) => entry.item),
      getAllSourceLinks: async () =>
        entries.flatMap((entry) => entry.sources),
      saveLibraryItem: async (item: LibraryEntry["item"]) => {
        entries.push({ item, sources: [] });
      },
      saveSourceLink: async (link: LibraryEntry["sources"][number]) => {
        const entry = entries.find((candidate) => candidate.item.libraryItemId === link.libraryItemId);
        entry?.sources.push(link);
      },
    } as unknown as MobileDataStore;
    const session = {
      source: {
        getMangaListForListing: async () => ({
          entries: [
            { key: "114", title: "特聘公务员" },
            { key: "115", title: "海贼王" },
          ],
          hasNextPage: true,
        }),
        addToLibrary: async () => {},
      },
    } as unknown as SelfHostedReadySession;

    const result = await syncSuwayomiLibrary(
      store,
      {
        id: "self-hosted:suwayomi",
        registryId: "self-hosted",
        sourceId: "suwayomi",
        name: "Suwayomi",
        version: 1,
      } as InstalledSource,
      { maxItems: 1, runWithSession: async (fn) => fn(session) },
    );
    expect(result).toEqual({ addedLocal: 1, pushedToServer: 0, removedFromServer: 0 });
  });

  test("un-libraries a locally removed title on the server instead of re-adding it", async () => {
    const removed = removedEntry(serverSource, serverManga("114", "特聘公务员"));
    const entries: LibraryEntry[] = [];
    const store = {
      getLibraryEntries: async () => entries,
      getAllLibraryItems: async () => [removed.item],
      getAllSourceLinks: async () => removed.sources,
      saveLibraryItem: async (item: LibraryEntry["item"]) => {
        entries.push({ item, sources: [] });
      },
      saveSourceLink: async (link: LibraryEntry["sources"][number]) => {
        const entry = entries.find((candidate) => candidate.item.libraryItemId === link.libraryItemId);
        entry?.sources.push(link);
      },
    } as unknown as MobileDataStore;

    const removedOnServer: string[] = [];
    const session = {
      source: {
        getMangaListForListing: async () => ({
          entries: [{ key: "114", title: "特聘公务员" }],
          hasNextPage: false,
        }),
        addToLibrary: async () => {},
        removeMangaFromLibrary: async (manga: { key: string }) => {
          removedOnServer.push(manga.key);
        },
      },
    } as unknown as SelfHostedReadySession;

    const result = await syncSuwayomiLibrary(
      store,
      {
        id: "self-hosted:suwayomi",
        registryId: "self-hosted",
        sourceId: "suwayomi",
        name: "Suwayomi",
        version: 1,
      } as InstalledSource,
      { runWithSession: async (fn) => fn(session) },
    );
    expect(result).toEqual({ addedLocal: 0, pushedToServer: 0, removedFromServer: 1 });
    expect(removedOnServer).toEqual(["114"]);
    expect(entries).toEqual([]);
  });
});
