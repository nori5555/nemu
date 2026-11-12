import type { InstalledSource } from "@/data/schema";
import { SELF_HOSTED_REGISTRY_ID } from "./policy";
import type { SelfHostedSource } from "./backend";

export type ServerSourceLanguageFilter = "zh" | "en" | "all";

/** Whether an installed row is a Suwayomi server (the only kind with browsable extension sources). */
export function isSuwayomiServerSource(source: InstalledSource | null | undefined): boolean {
  return (
    source?.registryId === SELF_HOSTED_REGISTRY_ID &&
    source?.selfHosted?.kind === "suwayomi"
  );
}

/** Every installed Suwayomi server, in install order. */
export function selectSuwayomiServerSources(
  installed: InstalledSource[],
): InstalledSource[] {
  return installed.filter(isSuwayomiServerSource);
}

/** `zh`, `zh-Hans`, `zh-Hant`, `zh-TW` … — anything in the Chinese family. */
export function isChineseServerSourceLang(lang: string | null | undefined): boolean {
  return /^zh([-_]|$)/i.test((lang ?? "").trim());
}

export function isEnglishServerSourceLang(lang: string | null | undefined): boolean {
  return /^en([-_]|$)/i.test((lang ?? "").trim());
}

/**
 * The source list filtered by the language picker. Chinese is the default:
 * most Suwayomi servers carry a long tail of other-language sources the
 * user never reads. Unknown/empty langs only show under "all".
 */
export function filterServerSourcesByLanguage(
  sources: SelfHostedSource[],
  filter: ServerSourceLanguageFilter,
): SelfHostedSource[] {
  if (filter === "all") return sources;
  if (filter === "zh") return sources.filter((source) => isChineseServerSourceLang(source.lang));
  return sources.filter((source) => isEnglishServerSourceLang(source.lang));
}
