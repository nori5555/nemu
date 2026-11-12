import { describe, expect, test } from "bun:test";
import {
  filterServerSourcesByLanguage,
  isChineseServerSourceLang,
  isEnglishServerSourceLang,
  isSuwayomiServerSource,
  selectSuwayomiServerSources,
} from "./serverSources";
import type { SelfHostedSource } from "./backend";
import type { InstalledSource } from "@/data/schema";

const SOURCES: SelfHostedSource[] = [
  { id: "1", name: "拷貝漫畫", lang: "zh" },
  { id: "2", name: "包子漫画", lang: "zh-Hans" },
  { id: "3", name: "禁漫天堂", lang: "zh-Hant" },
  { id: "4", name: "漫小肆韩漫", lang: "zh-TW" },
  { id: "5", name: "MangaDex", lang: "en" },
  { id: "6", name: "MangaDex EN", lang: "en-US" },
  { id: "7", name: "NoLang", lang: "" },
];

describe("server source language filter", () => {
  test("chinese matches zh and every zh variant, nothing else", () => {
    expect(isChineseServerSourceLang("zh")).toBe(true);
    expect(isChineseServerSourceLang("zh-Hans")).toBe(true);
    expect(isChineseServerSourceLang("zh-Hant")).toBe(true);
    expect(isChineseServerSourceLang("zh-TW")).toBe(true);
    expect(isChineseServerSourceLang("en")).toBe(false);
    expect(isChineseServerSourceLang("")).toBe(false);
    expect(isChineseServerSourceLang(undefined)).toBe(false);
    expect(filterServerSourcesByLanguage(SOURCES, "zh").map((s) => s.id)).toEqual(["1", "2", "3", "4"]);
  });

  test("english matches en and en variants only", () => {
    expect(isEnglishServerSourceLang("en")).toBe(true);
    expect(isEnglishServerSourceLang("en-US")).toBe(true);
    expect(isEnglishServerSourceLang("zh")).toBe(false);
    expect(filterServerSourcesByLanguage(SOURCES, "en").map((s) => s.id)).toEqual(["5", "6"]);
  });

  test("all returns every source, including ones without a language", () => {
    expect(filterServerSourcesByLanguage(SOURCES, "all")).toEqual(SOURCES);
  });
});

describe("suwayomi server selection", () => {
  const row = (overrides: Partial<InstalledSource>): InstalledSource =>
    ({
      id: "x",
      registryId: "self-hosted",
      sourceId: "suwayomi.a",
      name: "A",
      selfHosted: { kind: "suwayomi", server: "http://192.168.1.20:4567" },
      ...overrides,
    }) as InstalledSource;

  test("only self-hosted rows with kind suwayomi count", () => {
    const installed = [
      row({}),
      row({ sourceId: "suwayomi.b", name: "B" }),
      row({ sourceId: "komga.a", selfHosted: { kind: "komga", server: "http://x" } }),
      row({ sourceId: "kavita.a", selfHosted: { kind: "kavita", server: "http://x" } }),
      row({ registryId: "aidoku-community", sourceId: "zh.x", selfHosted: undefined }),
    ];
    expect(isSuwayomiServerSource(installed[0])).toBe(true);
    expect(isSuwayomiServerSource(installed[2])).toBe(false);
    expect(isSuwayomiServerSource(installed[4])).toBe(false);
    expect(isSuwayomiServerSource(null)).toBe(false);
    expect(isSuwayomiServerSource(undefined)).toBe(false);
    expect(selectSuwayomiServerSources(installed).map((s) => s.name)).toEqual(["A", "B"]);
  });
});
