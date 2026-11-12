import { afterEach, describe, expect, test } from "bun:test";
import type { LocalCollection } from "@/data/schema";
import {
  buildMobileLibraryTitleMenu,
  getMobileLibraryCollectionSelection,
  MOBILE_LIBRARY_TITLE_MENU_ALL,
  MOBILE_LIBRARY_TITLE_MENU_CREATE,
  MOBILE_LIBRARY_TITLE_MENU_DEFAULT_ALL,
  MOBILE_LIBRARY_TITLE_MENU_DEFAULT_PREFIX,
  MOBILE_LIBRARY_TITLE_MENU_EDIT_CURRENT,
  MOBILE_LIBRARY_TITLE_MENU_MANAGE,
  mobileLibraryTitleMenuItemId,
  reconcileMobileLibraryCollectionSelection,
  resolveMobileLibraryCollectionRoute,
  resolveMobileLibraryTitleMenuAction,
  setMobileLibraryCollectionSelection,
  subscribeMobileLibraryCollectionSelection,
} from "./mobileLibraryTitleMenu";

function collection(collectionId: string, name: string): LocalCollection {
  return { collectionId, name, createdAt: 1, updatedAt: 1 };
}

const study = collection("study", "Study");
const favorites = collection("fav", "Favorites");
const collections = [study, favorites];
const membership = new Map([
  ["study", new Set(["a", "b"])],
  ["fav", new Set(["c"])],
]);
const labels = {
  all: "All",
  editCollection: "Edit Collection…",
  newCollection: "New Collection…",
  manageCollections: "Manage Collections…",
  defaultCollection: "Default collection",
  bookCount: (count: number) => `${count} books`,
};

function menu(
  selectedCollectionId: string | null,
  disabled = false,
  defaultCollectionId: string | null = null,
) {
  return buildMobileLibraryTitleMenu({
    collections,
    membership,
    libraryCount: 7,
    selectedCollectionId,
    defaultCollectionId,
    labels,
    disabled,
  });
}

describe("library title menu model", () => {
  test("All leads the switcher and is checked when no collection is shown", () => {
    const [scope, ...rest] = menu(null);
    expect(scope.id).toBe("scope");
    expect(scope.items.map((item) => [item.id, item.title, item.subtitle, item.checked])).toEqual([
      [MOBILE_LIBRARY_TITLE_MENU_ALL, "All", "7 books", true],
      [mobileLibraryTitleMenuItemId("study"), "Study", "2 books", false],
      [mobileLibraryTitleMenuItemId("fav"), "Favorites", "1 books", false],
    ]);
    // No "current collection" section on All.
    expect(rest.map((section) => section.id)).toEqual(["default", "collections"]);
    expect(rest[1].items.map((item) => item.id)).toEqual([
      MOBILE_LIBRARY_TITLE_MENU_CREATE,
      MOBILE_LIBRARY_TITLE_MENU_MANAGE,
    ]);
  });

  test("a shown collection is checked, All stays reachable, and it can be edited", () => {
    const sections = menu("study");
    const checked = sections[0].items.filter((item) => item.checked).map((item) => item.id);
    expect(checked).toEqual([mobileLibraryTitleMenuItemId("study")]);
    expect(sections[0].items[0].id).toBe(MOBILE_LIBRARY_TITLE_MENU_ALL);
    expect(sections.map((section) => section.id)).toEqual(["scope", "current", "default", "collections"]);
    expect(sections[1].items[0].id).toBe(MOBILE_LIBRARY_TITLE_MENU_EDIT_CURRENT);
  });

  test("the default section checks the default collection, not the shown one", () => {
    const sections = menu("study", false, "fav");
    const byId = Object.fromEntries(sections.map((section) => [section.id, section]));
    expect(byId.default.title).toBe("Default collection");
    expect(
      byId.default.items.map((item) => [item.id, item.title, item.checked]),
    ).toEqual([
      [MOBILE_LIBRARY_TITLE_MENU_DEFAULT_ALL, "All", false],
      [`${MOBILE_LIBRARY_TITLE_MENU_DEFAULT_PREFIX}study`, "Study", false],
      [`${MOBILE_LIBRARY_TITLE_MENU_DEFAULT_PREFIX}fav`, "Favorites", true],
    ]);
    // The scope section still checks what is shown.
    expect(byId.scope.items.filter((item) => item.checked).map((item) => item.id)).toEqual([
      mobileLibraryTitleMenuItemId("study"),
    ]);
  });

  test("no default means All is the default", () => {
    const sections = menu("study");
    const byId = Object.fromEntries(sections.map((section) => [section.id, section]));
    expect(byId.default.items[0].checked).toBe(true);
  });

  test("a missing selection renders as All (no phantom checkmark or edit section)", () => {
    const sections = menu("deleted");
    expect(sections[0].items[0].checked).toBe(true);
    expect(sections.some((section) => section.id === "current")).toBe(false);
  });

  test("empty collections still offer All plus create/manage", () => {
    const sections = buildMobileLibraryTitleMenu({
      collections: [],
      membership: new Map(),
      libraryCount: 0,
      selectedCollectionId: null,
      labels,
      disabled: false,
    });
    expect(sections[0].items.map((item) => item.id)).toEqual([MOBILE_LIBRARY_TITLE_MENU_ALL]);
    expect(sections[1].items.map((item) => item.id)).toEqual([MOBILE_LIBRARY_TITLE_MENU_DEFAULT_ALL]);
    expect(sections[2].items.map((item) => item.id)).toEqual([
      MOBILE_LIBRARY_TITLE_MENU_CREATE,
      MOBILE_LIBRARY_TITLE_MENU_MANAGE,
    ]);
  });

  test("a busy collection write disables every row", () => {
    expect(menu("study", true).flatMap((section) => section.items).every((item) => item.disabled)).toBe(true);
  });
});

describe("library title menu actions", () => {
  test("ids round-trip to actions", () => {
    expect(resolveMobileLibraryTitleMenuAction(MOBILE_LIBRARY_TITLE_MENU_ALL)).toEqual({
      type: "select",
      collectionId: null,
    });
    expect(resolveMobileLibraryTitleMenuAction(mobileLibraryTitleMenuItemId("study"))).toEqual({
      type: "select",
      collectionId: "study",
    });
    // Collection ids may contain the separator.
    expect(resolveMobileLibraryTitleMenuAction(mobileLibraryTitleMenuItemId("a:b"))).toEqual({
      type: "select",
      collectionId: "a:b",
    });
    expect(resolveMobileLibraryTitleMenuAction(MOBILE_LIBRARY_TITLE_MENU_EDIT_CURRENT)).toEqual({
      type: "edit-current",
    });
    expect(resolveMobileLibraryTitleMenuAction(MOBILE_LIBRARY_TITLE_MENU_CREATE)).toEqual({ type: "create" });
    expect(resolveMobileLibraryTitleMenuAction(MOBILE_LIBRARY_TITLE_MENU_MANAGE)).toEqual({ type: "manage" });
    expect(resolveMobileLibraryTitleMenuAction(MOBILE_LIBRARY_TITLE_MENU_DEFAULT_ALL)).toEqual({
      type: "set-default",
      collectionId: null,
    });
    expect(
      resolveMobileLibraryTitleMenuAction(`${MOBILE_LIBRARY_TITLE_MENU_DEFAULT_PREFIX}fav`),
    ).toEqual({ type: "set-default", collectionId: "fav" });
    expect(resolveMobileLibraryTitleMenuAction(MOBILE_LIBRARY_TITLE_MENU_DEFAULT_PREFIX)).toBeNull();
    expect(resolveMobileLibraryTitleMenuAction("library:collection:")).toBeNull();
    expect(resolveMobileLibraryTitleMenuAction("something-else")).toBeNull();
  });
});

describe("library collection selection", () => {
  afterEach(() => setMobileLibraryCollectionSelection(null));

  test("a collection deleted after it was loaded falls back to All", () => {
    expect(
      reconcileMobileLibraryCollectionSelection({
        previousCollections: collections,
        collections: [favorites],
        loading: false,
        selectedCollectionId: "study",
      }),
    ).toBeNull();
  });

  test("a rename keeps the selection (same id)", () => {
    expect(
      reconcileMobileLibraryCollectionSelection({
        previousCollections: collections,
        collections: [{ ...study, name: "Exam prep" }, favorites],
        loading: false,
        selectedCollectionId: "study",
      }),
    ).toBe("study");
  });

  test("a selection not loaded yet, or mid-reload, is kept", () => {
    expect(
      reconcileMobileLibraryCollectionSelection({
        previousCollections: [],
        collections: [favorites],
        loading: false,
        selectedCollectionId: "study",
      }),
    ).toBe("study");
    expect(
      reconcileMobileLibraryCollectionSelection({
        previousCollections: collections,
        collections: [],
        loading: true,
        selectedCollectionId: "study",
      }),
    ).toBe("study");
  });

  test("the deep-link route waits for collections, then selects or reports not found", () => {
    expect(
      resolveMobileLibraryCollectionRoute({ collections: [], loading: true, routeCollectionId: "study" }),
    ).toEqual({ action: "wait" });
    expect(
      resolveMobileLibraryCollectionRoute({ collections, loading: false, routeCollectionId: "study" }),
    ).toEqual({ action: "select", collectionId: "study" });
    expect(
      resolveMobileLibraryCollectionRoute({ collections, loading: false, routeCollectionId: "gone" }),
    ).toEqual({ action: "not-found" });
    expect(
      resolveMobileLibraryCollectionRoute({ collections, loading: true, routeCollectionId: null }),
    ).toEqual({ action: "select", collectionId: null });
  });

  test("the shared selection notifies subscribers once per change and trims ids", () => {
    let calls = 0;
    const unsubscribe = subscribeMobileLibraryCollectionSelection(() => {
      calls += 1;
    });
    setMobileLibraryCollectionSelection(" study ");
    setMobileLibraryCollectionSelection("study");
    expect(getMobileLibraryCollectionSelection()).toBe("study");
    setMobileLibraryCollectionSelection("");
    expect(getMobileLibraryCollectionSelection()).toBeNull();
    unsubscribe();
    setMobileLibraryCollectionSelection("fav");
    expect(calls).toBe(2);
  });
});
