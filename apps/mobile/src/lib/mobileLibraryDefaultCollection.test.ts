import { describe, expect, test } from "bun:test";
import { resolveMobileLibraryDefaultCollectionId } from "./mobileLibraryDefaultCollection";
import {
  readMobileLibraryDefaultCollectionText,
  writeMobileLibraryDefaultCollectionText,
} from "./mobileLibraryDefaultCollectionStorage";
import type { LocalCollection } from "@/data/schema";

function collection(collectionId: string): LocalCollection {
  return {
    collectionId,
    name: collectionId,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("resolveMobileLibraryDefaultCollectionId", () => {
  const collections = [collection("a"), collection("b")];

  test("keeps a stored id that still names a collection", () => {
    expect(resolveMobileLibraryDefaultCollectionId(collections, "b")).toBe("b");
  });

  test("falls back to All when the stored collection is gone", () => {
    expect(resolveMobileLibraryDefaultCollectionId(collections, "gone")).toBeNull();
  });

  test("falls back to All for a blank stored id", () => {
    expect(resolveMobileLibraryDefaultCollectionId(collections, "  ")).toBeNull();
    expect(resolveMobileLibraryDefaultCollectionId(collections, null)).toBeNull();
  });

  test("falls back to All when there are no collections", () => {
    expect(resolveMobileLibraryDefaultCollectionId([], "a")).toBeNull();
  });
});

describe("default collection storage", () => {
  test("round-trips the id and clears it", async () => {
    await writeMobileLibraryDefaultCollectionText("b");
    expect(await readMobileLibraryDefaultCollectionText()).toBe("b");
    await writeMobileLibraryDefaultCollectionText(null);
    expect(await readMobileLibraryDefaultCollectionText()).toBeNull();
  });
});
