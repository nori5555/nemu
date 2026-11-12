import type { Chapter, Filter, Listing, Manga, MangaPageResult } from "@/sources/aidokuContract";
import type {
  SelfHostedBackend,
  SelfHostedPageRef,
  SelfHostedSource,
  SelfHostedSourceBrowseType,
  SelfHostedSourceBrowser,
} from "./backend";
import { SelfHostedError, basicAuthHeader, buildUrl, errorForStatus, parseJson, type SelfHostedTransport } from "./http";
import type { SelfHostedCredentials } from "./policy";

/**
 * Suwayomi backend, written against the server's GraphQL API (`/api/graphql`,
 * introspectable on a running server). Auth is HTTP Basic, which is what the
 * server's BASIC_AUTH mode expects; a server with authentication off needs no
 * login. Images (`/api/v1/...`) take the same header.
 */

const PAGE_SIZE = 30;
const LISTING_LIBRARY = "library";
const LISTING_ALL = "all";

type GqlManga = {
  id: number;
  title: string;
  author?: string | null;
  artist?: string | null;
  description?: string | null;
  genre?: string[] | null;
  status?: string | null;
  thumbnailUrl?: string | null;
};
type GqlChapter = {
  id: number;
  name: string;
  chapterNumber?: number | null;
  sourceOrder?: number | null;
  uploadDate?: string | number | null;
  scanlator?: string | null;
};

/**
 * A server-side extension source. `id` is a LongString: it arrives and is
 * sent back as a string, never parsed into a JS number (some ids exceed
 * 2^53), and it is not the installed source's id.
 */
type GqlSource = {
  id: string;
  name: string;
  lang: string;
};

const STATUS: Record<string, 0 | 1 | 2 | 3 | 4> = {
  ONGOING: 1,
  COMPLETED: 2,
  LICENSED: 2,
  PUBLISHING_FINISHED: 2,
  CANCELLED: 3,
  ON_HIATUS: 4,
};

const MANGA_FIELDS = "id title author artist description genre status thumbnailUrl";

/** A manga's server id as an integer; the updateManga mutation needs an Int. */
function suwayomiMangaId(manga: { key: string }): number {
  const id = Number(manga.key);
  if (!Number.isInteger(id)) {
    throw new SelfHostedError("invalid-response", `Not a Suwayomi manga id: ${manga.key}`);
  }
  return id;
}

export type SuwayomiBackendOptions = {
  server: string;
  credentials: SelfHostedCredentials;
  transport: SelfHostedTransport;
};

export function suwayomiAuthHeaders(credentials: SelfHostedCredentials): Record<string, string> {
  if (credentials.username && credentials.password !== undefined) {
    return { Authorization: basicAuthHeader(credentials.username, credentials.password) };
  }
  return {};
}

export function createSuwayomiBackend(options: SuwayomiBackendOptions): SelfHostedBackend & SelfHostedSourceBrowser {
  const server = options.server.replace(/\/+$/, "");
  const headers = suwayomiAuthHeaders(options.credentials);
  const absolute = (path: string | null | undefined) =>
    path ? (/^https?:\/\//i.test(path) ? path : buildUrl(server, path)) : undefined;

  async function gql<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const response = await options.transport({
      url: buildUrl(server, "/api/graphql"),
      method: "POST",
      headers,
      json: { query, variables },
      signal,
    });
    const failure = errorForStatus(response.status);
    if (failure) throw failure;
    const body = parseJson<{ data?: T; errors?: { message?: string }[] }>(response);
    if (body.errors?.length || !body.data) {
      throw new SelfHostedError("invalid-response", body.errors?.[0]?.message ?? "No data in the response.");
    }
    return body.data;
  }

  const mapManga = (m: GqlManga): Manga => ({
    key: String(m.id),
    title: m.title,
    cover: absolute(m.thumbnailUrl),
    ...(m.author ? { authors: [m.author] } : {}),
    ...(m.artist ? { artists: [m.artist] } : {}),
    ...(m.description?.trim() ? { description: m.description.trim() } : {}),
    tags: m.genre ?? [],
    status: STATUS[m.status ?? ""] ?? 0,
  });

  async function list(page: number, inLibrary: boolean, title?: string): Promise<MangaPageResult> {
    const data = await gql<{ mangas: { nodes: GqlManga[]; pageInfo: { hasNextPage: boolean } } }>(
      `query($first:Int!,$offset:Int!,$condition:MangaConditionInput,$filter:MangaFilterInput){
        mangas(first:$first,offset:$offset,condition:$condition,filter:$filter,orderBy:TITLE,orderByType:ASC){
          nodes{id title thumbnailUrl} pageInfo{hasNextPage}}}`,
      {
        first: PAGE_SIZE,
        offset: (Math.max(page, 1) - 1) * PAGE_SIZE,
        condition: inLibrary ? { inLibrary: true } : null,
        filter: title ? { title: { includesInsensitive: title } } : null,
      },
    );
    return { entries: data.mangas.nodes.map(mapManga), hasNextPage: data.mangas.pageInfo.hasNextPage };
  }

  const mapChapter = (c: GqlChapter, position: number): Chapter => {
    const uploaded = Number(c.uploadDate);
    return {
      key: String(c.id),
      title: c.name,
      ...(c.chapterNumber != null && c.chapterNumber >= 0 ? { chapterNumber: c.chapterNumber } : {}),
      ...(Number.isFinite(uploaded) && uploaded > 0 ? { dateUploaded: uploaded } : {}),
      ...(c.scanlator ? { scanlator: c.scanlator } : {}),
      sourceOrder: c.sourceOrder ?? position,
    };
  };

  return {
    kind: "suwayomi",

    async testConnection(signal) {
      const data = await gql<{ aboutServer?: { name?: string; version?: string } }>(
        "{aboutServer{name version}}",
        {},
        signal,
      );
      if (!data.aboutServer?.name?.toLowerCase().includes("suwayomi")) {
        throw new SelfHostedError("invalid-response", "This address does not look like a Suwayomi server.");
      }
      return data.aboutServer.version ? { version: data.aboutServer.version } : {};
    },

    async getListings(): Promise<Listing[]> {
      return [
        { id: LISTING_LIBRARY, name: "Library" },
        { id: LISTING_ALL, name: "All" },
      ];
    },
    async getFilters(): Promise<Filter[]> {
      return [];
    },
    getMangaListForListing: (listing, page) => list(page, listing.id !== LISTING_ALL),
    search: (query, page) => list(page, false, query?.trim() || undefined),

    async getMangaDetails(manga) {
      const data = await gql<{ manga: GqlManga }>(`query($id:Int!){manga(id:$id){${MANGA_FIELDS}}}`, {
        id: Number(manga.key),
      });
      return { ...mapManga(data.manga), url: buildUrl(server, `/manga/${manga.key}`) };
    },

    /**
     * The server's loaded extension sources, as strings: `Source.id` is a
     * LongString, so the id is kept verbatim and passed back verbatim to
     * `searchSource`. Only sources from installed extensions appear here.
     */
    async listSources(signal): Promise<SelfHostedSource[]> {
      const data = await gql<{ sources: { nodes: GqlSource[] } }>(
        `query{ sources(first:3000){ nodes{ id name lang } } }`,
        {},
        signal,
      );
      return data.sources.nodes.map((source) => ({
        id: String(source.id),
        name: source.name,
        lang: source.lang,
      }));
    },

    /**
     * Search inside one server source. This can take 5–60s on the server
     * (it fetches the source live), so callers must only call it from a
     * submit button with a cancel path, never per keystroke. The matches
     * are written into the server's DB by this call (expected: the All
     * listing grows); `inLibrary` is untouched until `addMangaToLibrary`.
     */
    async searchSource(sourceId, query, page, signal): Promise<MangaPageResult> {
      const data = await gql<{
        fetchSourceManga: { mangas: GqlManga[]; hasNextPage: boolean };
      }>(
        `mutation($source:LongString!,$query:String!,$page:Int!){
          fetchSourceManga(input:{source:$source,type:SEARCH,page:$page,query:$query}){
            mangas{${MANGA_FIELDS}} hasNextPage}}`,
        { source: sourceId, query, page: Math.max(page, 1) },
        signal,
      );
      return {
        entries: data.fetchSourceManga.mangas.map(mapManga),
        hasNextPage: data.fetchSourceManga.hasNextPage,
      };
    },

    /**
     * A source's POPULAR / LATEST listing: the same fetchSourceManga call
     * as a search, but with no query — the server returns the source's own
     * popular or latest page instead of matches.
     */
    async browseSource(
      sourceId,
      type: SelfHostedSourceBrowseType,
      page,
      signal,
    ): Promise<MangaPageResult> {
      const data = await gql<{
        fetchSourceManga: { mangas: GqlManga[]; hasNextPage: boolean };
      }>(
        `mutation($source:LongString!,$page:Int!){
          fetchSourceManga(input:{source:$source,type:${type},page:$page}){
            mangas{${MANGA_FIELDS}} hasNextPage}}`,
        { source: sourceId, page: Math.max(page, 1) },
        signal,
      );
      return {
        entries: data.fetchSourceManga.mangas.map(mapManga),
        hasNextPage: data.fetchSourceManga.hasNextPage,
      };
    },

    async addMangaToLibrary(manga): Promise<void> {
      const id = suwayomiMangaId(manga);
      await gql<{ updateManga: { manga: { id: number; title: string; inLibrary: boolean } } }>(
        `mutation($id:Int!){updateManga(input:{id:$id,patch:{inLibrary:true}}){manga{id title inLibrary}}}`,
        { id },
      );
    },

    async removeMangaFromLibrary(manga): Promise<void> {
      const id = suwayomiMangaId(manga);
      await gql<{ updateManga: { manga: { id: number; title: string; inLibrary: boolean } } }>(
        `mutation($id:Int!){updateManga(input:{id:$id,patch:{inLibrary:false}}){manga{id title inLibrary}}}`,
        { id },
      );
    },

    async getChapterList(manga) {
      const id = Number(manga.key);
      const read = () =>
        gql<{ chapters: { nodes: GqlChapter[] } }>(
          `query($id:Int!){chapters(condition:{mangaId:$id},orderBy:SOURCE_ORDER,orderByType:ASC){
            nodes{id name chapterNumber sourceOrder uploadDate scanlator}}}`,
          { id },
        ).then((data) => data.chapters.nodes);
      let nodes = await read();
      if (nodes.length === 0) {
        // Never fetched from the source yet.
        nodes = (
          await gql<{ fetchChapters: { chapters: GqlChapter[] } }>(
            `mutation($id:Int!){fetchChapters(input:{mangaId:$id}){chapters{id name chapterNumber sourceOrder uploadDate scanlator}}}`,
            { id },
          )
        ).fetchChapters.chapters;
      }
      return nodes.map(mapChapter);
    },

    async getPageList(_manga, chapter): Promise<SelfHostedPageRef[]> {
      const data = await gql<{ fetchChapterPages: { pages: string[] } }>(
        `mutation($id:Int!){fetchChapterPages(input:{chapterId:$id}){pages}}`,
        { id: Number(chapter.key) },
      );
      return data.fetchChapterPages.pages.map((path, index) => ({ index, url: absolute(path)! }));
    },

    async imageRequest(url) {
      return { url, headers: { ...headers } };
    },
    isServerUrl: (url) => url === server || url.startsWith(`${server}/`),
    dispose() {},
  };
}
