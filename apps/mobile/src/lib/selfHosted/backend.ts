import type {
  Chapter,
  Filter,
  FilterValue,
  Listing,
  Manga,
  MangaPageResult,
} from "@/sources/aidokuContract";
import type { SelfHostedKind } from "./policy";

/** A page the server will serve; `index` is the zero-based reading position. */
export type SelfHostedPageRef = {
  index: number;
  url: string;
  /** Pixel size of the page when the server knows it (Komga after analysis). */
  width?: number;
  height?: number;
};

/**
 * One extension source loaded on a server. `id` is the server's own source
 * id: for Suwayomi a LongString, so it stays a string end to end — never a
 * JS number — and must not be confused with the installed source's id.
 */
export type SelfHostedSource = {
  id: string;
  name: string;
  lang: string;
};

export type SelfHostedSourceBrowseType = "POPULAR" | "LATEST";

/**
 * Optional capability: browse the server's own extension sources and search
 * inside one of them. Only Suwayomi implements it; Komga/Kavita have no
 * extension sources, so they simply omit it. Callers must use the
 * `hasSelfHostedSourceBrowser` guard instead of assuming it exists.
 */
export interface SelfHostedSourceBrowser {
  listSources(signal?: AbortSignal): Promise<SelfHostedSource[]>;
  searchSource(
    sourceId: string,
    query: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<MangaPageResult>;
  /**
   * A source's listing without a query: POPULAR is the source's popular
   * page, LATEST its latest page. Same fetchSourceManga call as a search,
   * only with no query variable.
   */
  browseSource(
    sourceId: string,
    type: SelfHostedSourceBrowseType,
    page: number,
    signal?: AbortSignal,
  ): Promise<MangaPageResult>;
  addMangaToLibrary(manga: Manga): Promise<void>;
  removeMangaFromLibrary(manga: Manga): Promise<void>;
}

export function hasSelfHostedSourceBrowser(
  backend: SelfHostedBackend,
): backend is SelfHostedBackend & SelfHostedSourceBrowser {
  const candidate = backend as Partial<SelfHostedSourceBrowser>;
  return (
    typeof candidate.listSources === "function" &&
    typeof candidate.searchSource === "function" &&
    typeof candidate.browseSource === "function" &&
    typeof candidate.addMangaToLibrary === "function" &&
    typeof candidate.removeMangaFromLibrary === "function"
  );
}

/**
 * What the app needs from a server, independent of the server's API. Komga,
 * Kavita and Suwayomi each implement it from their own official HTTP API; the
 * executor adapter turns it into the source interface the library, reader and
 * updates already use. Everything here talks to the one server the user entered.
 */
export interface SelfHostedBackend {
  readonly kind: SelfHostedKind;
  /** Verifies reachability and the login. Throws a `SelfHostedError` with a specific code. */
  testConnection(signal?: AbortSignal): Promise<{ version?: string }>;
  getListings(): Promise<Listing[]>;
  getFilters(): Promise<Filter[]>;
  getMangaListForListing(listing: Listing, page: number): Promise<MangaPageResult>;
  search(query: string | null, page: number, filters: FilterValue[]): Promise<MangaPageResult>;
  getMangaDetails(manga: Manga): Promise<Manga>;
  getChapterList(manga: Manga): Promise<Chapter[]>;
  getPageList(manga: Manga, chapter: Chapter): Promise<SelfHostedPageRef[]>;
  /**
   * The request that fetches an image of this server (cover or page): the URL
   * (a server that wants its key in the query adds it here, so it is never
   * stored in a persisted cover or cached page list) plus the auth headers.
   */
  imageRequest(url: string): Promise<{ url: string; headers: Record<string, string> }>;
  /** Whether `url` is an image URL of the server this backend talks to. */
  isServerUrl(url: string): boolean;
  /** Called when the user's saved login changes; drops any cached session. */
  dispose(): void;
}
