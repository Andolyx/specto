import { castArray, chunk, find } from "es-toolkit/compat";

import { matchString, t } from "~/common/helpers";
import { stores } from "~/common/stores";
import {
  Dictionary,
  HelixCategorySearchResult,
  HelixChannelSearchResult,
  HelixClip,
  HelixFollowedChannel,
  HelixGame,
  HelixResponse,
  HelixStream,
  HelixUser,
} from "~/common/types";

import { createNotification } from "./notification";

/**
 * Kick does not expose follows through its public API, so this module talks to the
 * private API used by the kick.com website, authenticated with the user's own
 * `session_token` cookie. Responses are mapped to the Helix-shaped types the UI
 * was originally built around, using channel and category slugs as identifiers.
 */

export const KICK_URL = "https://kick.com";

const SESSION_COOKIE_NAME = "session_token";

class RequestError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`Request failed with status code ${status}: GET ${url}`);
  }
}

class UnauthorizedError extends RequestError {}

interface RequestParams {
  after?: string;
  broadcasterId?: string;
  first?: number;
  gameId?: string;
  id?: string | string[];
  language?: string | string[];
  liveOnly?: boolean;
  query?: string;
  startedAt?: string | Date;
}

interface KickImage {
  src?: string;
  url?: string;
  srcset?: string;
  responsive?: string;
}

interface KickCategory {
  id: number;
  name: string;
  slug: string;
  tags?: string[];
  viewers?: number;
  banner?: KickImage | null;
}

interface KickFollowedChannel {
  is_live: boolean;
  profile_picture: string | null;
  channel_slug: string;
  viewer_count: number;
  category_name: string;
  user_username: string;
  session_title: string | null;
}

interface KickFollowedChannelsResponse {
  nextCursor: number | null;
  channels: KickFollowedChannel[];
}

interface KickChannelLivestream {
  data: {
    id: number;
    session_title: string;
    created_at: string;
    is_mature: boolean;
    viewers: number;
    category?: KickCategory | null;
    thumbnail?: KickImage | null;
  } | null;
}

interface KickChannel {
  id: number;
  slug: string;
  followers_count: number | string;
  followersCount?: number;
  verified: boolean | object | null;
  user: {
    username: string;
    bio?: string | null;
    profile_pic?: string | null;
    profilePic?: string | null;
  };
  banner_image?: KickImage | null;
  offline_banner_image?: KickImage | null;
  recent_categories?: KickCategory[];
  recentCategories?: KickCategory[];
  livestream?: {
    session_title?: string;
    is_live?: boolean;
    categories?: KickCategory[];
  } | null;
  isLive?: boolean;
}

interface KickWebLivestream {
  id: string;
  title: string;
  viewer_count: number;
  thumbnail?: KickImage | null;
  start_time: string;
  channel: {
    id: number;
    slug: string;
    profile_pic: string | null;
    username: string;
  };
  category?: KickCategory | null;
  language: string;
  is_mature: boolean;
  tags?: string[] | null;
}

interface KickWebLivestreamsResponse {
  data: {
    livestreams: KickWebLivestream[];
    pagination?: {
      next_cursor?: string;
    };
  };
}

interface KickPaginatedResponse<T> {
  current_page: number;
  last_page: number;
  data: T[];
}

interface KickClip {
  id: string;
  title: string;
  thumbnail_url: string;
  views: number;
  duration: number;
  created_at: string;
  category?: KickCategory | null;
  creator: {
    id: number;
    username: string;
    slug: string;
  };
  channel: {
    id: number;
    username: string;
    slug: string;
  };
}

interface KickClipsResponse {
  clips: KickClip[];
  nextCursor?: string | null;
}

interface KickSearchResponse {
  channels?: KickChannel[];
  categories?: KickCategory[];
}

interface KickCurrentUser {
  id?: number;
  username?: string;
  profile_pic?: string | null;
  profilepic?: string | null;
  bio?: string | null;
  streamer_channel?: {
    slug?: string;
  } | null;
}

/**
 * Cache of the latest followed channels, used to resolve users without hitting
 * the API once per channel.
 */
let followedChannelCache: KickFollowedChannel[] = [];

/**
 * Cache of the users resolved by slug during the lifetime of the background script.
 */
const userCache = new Map<string, HelixUser>();

/**
 * Cache of the categories resolved by slug during the lifetime of the background script.
 */
const categoryCache = new Map<string, KickCategory>();

function imageUrl(image?: KickImage | null): string {
  return image?.src || image?.url || "";
}

function toDateString(value?: string | null): string {
  if (value == null) {
    return "";
  }

  // The private API mixes ISO strings and "YYYY-MM-DD HH:mm:ss" UTC strings.
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);

  return isNaN(date.getTime()) ? "" : date.toISOString();
}

async function getSessionToken(): Promise<string | null> {
  const cookies = await browser.cookies.getAll({
    url: `${KICK_URL}/`,
    name: SESSION_COOKIE_NAME,
  });

  if (cookies.length === 0) {
    return null;
  }

  const cookie = cookies.reduce((latest, cookie) =>
    (cookie.expirationDate ?? 0) > (latest.expirationDate ?? 0) ? cookie : latest,
  );

  return decodeURIComponent(cookie.value);
}

async function fetchJson<T>(
  input: string,
  params?: Dictionary<unknown>,
  authenticated = false,
): Promise<T> {
  const url = new URL(input, KICK_URL);

  for (const [name, value] of Object.entries(params ?? {})) {
    for (const v of castArray(value)) {
      if (v == null || v === "") {
        continue;
      }

      url.searchParams.append(name, String(v));
    }
  }

  const headers = new Headers({
    Accept: "application/json",
  });

  if (authenticated) {
    const token = await getSessionToken();

    if (token == null) {
      throw new UnauthorizedError(url.href, 401);
    }

    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(url, {
    credentials: "omit",
    headers,
  });

  if (response.status === 401 || response.status === 403) {
    if (authenticated) {
      throw new UnauthorizedError(url.href, response.status);
    }
  }

  if (!response.ok) {
    throw new RequestError(url.href, response.status);
  }

  return response.json();
}

/**
 * Runs the iteratee over the values with a bounded number of concurrent calls.
 */
async function mapLimit<T, V>(
  values: T[],
  limit: number,
  iteratee: (value: T) => Promise<V>,
): Promise<PromiseSettledResult<V>[]> {
  const results: PromiseSettledResult<V>[] = [];

  for (const group of chunk(values, limit)) {
    results.push(...(await Promise.allSettled(group.map(iteratee))));
  }

  return results;
}

function fulfilled<V>(results: PromiseSettledResult<V>[]): V[] {
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

function page<T>(data: T[], cursor?: string | number | null): HelixResponse<T> {
  return {
    data,
    pagination: {
      cursor: cursor == null || cursor === "" ? undefined : String(cursor),
    },
  };
}

function toGame(category: KickCategory): HelixGame {
  return {
    id: category.slug,
    name: category.name,
    boxArtUrl: imageUrl(category.banner),
    igdbId: "",
  };
}

function toUser(channel: KickChannel): HelixUser {
  return {
    id: channel.slug,
    login: channel.slug,
    displayName: channel.user.username,
    broadcasterType: channel.verified ? "partner" : "",
    description: channel.user.bio ?? "",
    profileImageUrl: channel.user.profile_pic ?? channel.user.profilePic ?? "",
    offlineImageUrl: imageUrl(channel.offline_banner_image),
    createdAt: "",
  };
}

function followedChannelToUser(channel: KickFollowedChannel): HelixUser {
  return {
    id: channel.channel_slug,
    login: channel.channel_slug,
    displayName: channel.user_username,
    broadcasterType: "",
    description: "",
    profileImageUrl: channel.profile_picture ?? "",
    offlineImageUrl: "",
    createdAt: "",
  };
}

function webLivestreamToStream(livestream: KickWebLivestream): HelixStream {
  return {
    id: livestream.id,
    userId: livestream.channel.slug,
    userLogin: livestream.channel.slug,
    userName: livestream.channel.username,
    gameId: livestream.category?.slug ?? "",
    gameName: livestream.category?.name ?? "",
    type: "live",
    title: livestream.title,
    tags: livestream.tags ?? null,
    viewerCount: livestream.viewer_count,
    startedAt: toDateString(livestream.start_time),
    language: livestream.language,
    thumbnailUrl: imageUrl(livestream.thumbnail),
    isMature: livestream.is_mature,
  };
}

function clipToHelix(clip: KickClip): HelixClip {
  return {
    id: clip.id,
    url: `${KICK_URL}/${clip.channel.slug}/clips/${clip.id}`,
    embedUrl: "",
    broadcasterId: clip.channel.slug,
    broadcasterName: clip.channel.username,
    creatorId: clip.creator.slug,
    creatorName: clip.creator.username,
    videoId: "",
    gameId: clip.category?.slug ?? "",
    language: "",
    title: clip.title,
    viewCount: String(clip.views),
    createdAt: toDateString(clip.created_at),
    thumbnailUrl: clip.thumbnail_url,
    duration: clip.duration,
    vodOffset: 0,
  };
}

function channelToSearchResult(channel: KickChannel): HelixChannelSearchResult {
  const categories = channel.recentCategories ?? channel.recent_categories ?? [];

  return {
    id: channel.slug,
    broadcasterLogin: channel.slug,
    displayName: channel.user.username,
    gameId: categories[0]?.slug ?? "",
    gameName: categories[0]?.name ?? "",
    isLive: channel.isLive ?? channel.livestream?.is_live ?? false,
    title: channel.livestream?.session_title ?? "",
    thumbnailUrl: channel.user.profilePic ?? channel.user.profile_pic ?? "",
    followersCount: Number(channel.followersCount ?? channel.followers_count ?? 0),
  };
}

async function getCategory(slug: string): Promise<KickCategory> {
  let category = categoryCache.get(slug);

  if (category == null) {
    category = await fetchJson<KickCategory>(`/api/v1/subcategories/${encodeURIComponent(slug)}`);

    categoryCache.set(slug, category);
  }

  return category;
}

async function getUser(slug: string): Promise<HelixUser> {
  let user = userCache.get(slug);

  if (user == null) {
    const followedChannel = find(followedChannelCache, { channel_slug: slug });

    if (followedChannel) {
      return followedChannelToUser(followedChannel);
    }

    user = toUser(await fetchJson<KickChannel>(`/api/v2/channels/${encodeURIComponent(slug)}`));

    userCache.set(slug, user);
  }

  return user;
}

export async function getUsersByIds(userIds: string[]): Promise<HelixUser[]> {
  return fulfilled(await mapLimit(userIds, 8, getUser));
}

export async function getCurrentUser(): Promise<HelixUser | null> {
  if ((await getSessionToken()) == null) {
    return null;
  }

  let user: KickCurrentUser = {};

  try {
    user = await fetchJson<KickCurrentUser>("/api/v1/user", undefined, true);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
  }

  const login = user.streamer_channel?.slug ?? user.username?.toLowerCase() ?? "";

  return {
    id: login || "me",
    login,
    displayName: user.username ?? "Kick",
    broadcasterType: "",
    description: user.bio ?? "",
    profileImageUrl: user.profile_pic ?? user.profilepic ?? "",
    offlineImageUrl: "",
    createdAt: "",
  };
}

/**
 * Fetches every followed channel, both live and offline.
 */
export async function getFollowedChannels(): Promise<KickFollowedChannel[]> {
  const channels: KickFollowedChannel[] = [];

  let cursor: number | null = null;

  for (let index = 0; index < 50; index++) {
    const response: KickFollowedChannelsResponse = await fetchJson(
      "/api/v2/channels/followed",
      { cursor },
      true,
    );

    channels.push(...response.channels);

    if (response.nextCursor == null || response.channels.length === 0) {
      break;
    }

    cursor = response.nextCursor;
  }

  followedChannelCache = channels;

  return channels;
}

async function getLivestream(slug: string): Promise<KickChannelLivestream["data"]> {
  const { data } = await fetchJson<KickChannelLivestream>(
    `/api/v2/channels/${encodeURIComponent(slug)}/livestream`,
  );

  return data;
}

async function getFollowedStream(channel: KickFollowedChannel): Promise<HelixStream> {
  const stream: HelixStream = {
    id: channel.channel_slug,
    userId: channel.channel_slug,
    userLogin: channel.channel_slug,
    userName: channel.user_username,
    gameId: "",
    gameName: channel.category_name,
    type: "live",
    title: channel.session_title ?? "",
    tags: null,
    viewerCount: channel.viewer_count,
    startedAt: "",
    language: "",
    thumbnailUrl: "",
    isMature: false,
  };

  try {
    const data = await getLivestream(channel.channel_slug);

    if (data) {
      stream.id = String(data.id);
      stream.title = data.session_title ?? stream.title;
      stream.startedAt = toDateString(data.created_at);
      stream.thumbnailUrl = imageUrl(data.thumbnail);
      stream.isMature = data.is_mature;

      if (data.category) {
        stream.gameId = data.category.slug;
        stream.gameName = data.category.name;
      }
    }
  } catch {} // eslint-disable-line no-empty

  return stream;
}

/**
 * Fetches the live followed channels with their stream details.
 */
export async function getFollowedStreams(): Promise<HelixStream[]> {
  const channels = await getFollowedChannels();

  return fulfilled(
    await mapLimit(
      channels.filter((channel) => channel.is_live),
      8,
      getFollowedStream,
    ),
  );
}

async function getStreams(params: RequestParams): Promise<HelixResponse<HelixStream>> {
  let categoryId: number | undefined;

  if (params.gameId) {
    categoryId = (await getCategory(params.gameId)).id;
  }

  const response = await fetchJson<KickWebLivestreamsResponse>(
    "https://web.kick.com/api/v1/livestreams",
    {
      limit: params.first ?? 24,
      sort: "viewer_count_desc",
      category_id: categoryId,
      language: params.language,
      after: params.after,
    },
  );

  return page(
    response.data.livestreams.map(webLivestreamToStream),
    response.data.livestreams.length > 0 ? response.data.pagination?.next_cursor : null,
  );
}

async function getTopCategories(params: RequestParams): Promise<HelixResponse<HelixGame>> {
  const currentPage = Number(params.after ?? 1);

  const response = await fetchJson<KickPaginatedResponse<KickCategory>>("/api/v1/subcategories", {
    limit: params.first ?? 32,
    page: currentPage,
  });

  for (const category of response.data) {
    categoryCache.set(category.slug, category);
  }

  return page(
    response.data.map(toGame),
    response.current_page < response.last_page ? currentPage + 1 : null,
  );
}

async function getCategories(params: RequestParams): Promise<HelixResponse<HelixGame>> {
  const slugs: string[] = castArray(params.id ?? []);

  return page(fulfilled(await mapLimit(slugs, 8, getCategory)).map(toGame));
}

function getClipPeriod(startedAt?: string | Date): string {
  if (startedAt == null) {
    return "all";
  }

  const duration = Date.now() - new Date(startedAt).getTime();

  if (duration <= 86_400_000 * 1.5) {
    return "day";
  }

  if (duration <= 604_800_000 * 1.5) {
    return "week";
  }

  return "month";
}

async function getClips(params: RequestParams): Promise<HelixResponse<HelixClip>> {
  const path = params.broadcasterId
    ? `/api/v2/channels/${encodeURIComponent(params.broadcasterId)}/clips`
    : `/api/v2/categories/${encodeURIComponent(params.gameId ?? "")}/clips`;

  const response = await fetchJson<KickClipsResponse>(path, {
    sort: "view",
    time: getClipPeriod(params.startedAt),
    cursor: params.after,
  });

  return page(response.clips.map(clipToHelix), response.nextCursor);
}

async function search(query: string): Promise<KickSearchResponse> {
  if (query.trim() === "") {
    return {};
  }

  return fetchJson<KickSearchResponse>("/api/search", {
    searched_word: query,
  });
}

async function searchChannels(
  params: RequestParams,
): Promise<HelixResponse<HelixChannelSearchResult>> {
  const { channels = [] } = await search(params.query ?? "");

  let results = channels.map(channelToSearchResult);

  if (params.liveOnly) {
    results = results.filter((channel) => channel.isLive);
  }

  // Search results lack stream details, so fill them in for the live channels.
  await mapLimit(
    results.filter((channel) => channel.isLive),
    8,
    async (channel) => {
      const data = await getLivestream(channel.broadcasterLogin);

      if (data) {
        channel.title = data.session_title;
        channel.gameId = data.category?.slug ?? channel.gameId;
        channel.gameName = data.category?.name ?? channel.gameName;
      }
    },
  );

  return page(results);
}

async function searchCategories(
  params: RequestParams,
): Promise<HelixResponse<HelixCategorySearchResult>> {
  const { categories = [] } = await search(params.query ?? "");

  return page(
    categories.map((category) => ({
      id: category.slug,
      name: category.name,
      boxArtUrl: imageUrl(category.banner),
    })),
  );
}

async function getFollowedChannelsPage(): Promise<HelixResponse<HelixFollowedChannel>> {
  const channels = await getFollowedChannels();

  return page(
    channels.map((channel) => ({
      broadcasterId: channel.channel_slug,
      broadcasterLogin: channel.channel_slug,
      broadcasterName: channel.user_username,
      followedAt: "",
    })),
  );
}

const requestHandlers: Dictionary<(params: RequestParams) => Promise<HelixResponse<unknown>>> = {
  "channels/followed": getFollowedChannelsPage,
  clips: getClips,
  games: getCategories,
  "games/top": getTopCategories,
  "search/categories": searchCategories,
  "search/channels": searchChannels,
  streams: getStreams,
  users: async (params) => page(await getUsersByIds(castArray(params.id ?? []))),
};

/**
 * Resolves a Helix-like request path against the Kick API.
 */
export async function request<T>(path: string, params?: RequestParams): Promise<HelixResponse<T>> {
  const handler = requestHandlers[path];

  if (handler == null) {
    throw new RangeError(`Unsupported request: ${path}`);
  }

  try {
    return (await handler(params ?? {})) as HelixResponse<T>;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      await handleUnauthorized();
    }

    throw error;
  }
}

export async function handleUnauthorized(): Promise<void> {
  if ((await stores.currentUser.get()) == null) {
    return;
  }

  await stores.currentUser.set(null);

  createNotification("authorize", {
    title: t("notificationTitle_accessExpired"),
    message: t("notificationMessage_accessExpired"),
  });
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof UnauthorizedError;
}

export function isSessionCookie(cookie: { domain: string; name: string }): boolean {
  return cookie.name === SESSION_COOKIE_NAME && cookie.domain.replace(/^\./, "") === "kick.com";
}

/**
 * Opens Kick so the user can sign in; the session cookie is picked up automatically.
 */
export async function authorize(): Promise<void> {
  await browser.tabs.create({
    url: KICK_URL,
  });
}

/**
 * Signs out from Kick by removing the session cookie.
 */
export async function revoke(): Promise<void> {
  const cookies = await browser.cookies.getAll({
    url: `${KICK_URL}/`,
    name: SESSION_COOKIE_NAME,
  });

  await Promise.all(
    cookies.map((cookie) =>
      browser.cookies.remove({
        url: `${KICK_URL}${cookie.path}`,
        name: cookie.name,
        storeId: cookie.storeId,
      }),
    ),
  );

  await stores.currentUser.set(null);
}

export async function filterNewStreams(streams: HelixStream[]): Promise<HelixStream[]> {
  const previousStreams = await stores.followedStreams.get();
  const settings = await stores.settings.get();

  const {
    notifications: { ignoredCategories, selectedUsers, withCategoryChanges, withFilters },
  } = settings;

  return streams.filter((stream) => {
    if (
      (withFilters && !selectedUsers.includes(stream.userId)) ||
      ignoredCategories.some((input) => matchString(stream.gameName, input))
    ) {
      return false;
    }

    const oldStream = find(previousStreams, {
      userId: stream.userId,
    });

    return oldStream == null || (withCategoryChanges && oldStream.gameId !== stream.gameId);
  });
}

export async function filterMutedStreams(streams: HelixStream[]): Promise<HelixStream[]> {
  const mutedUsers = await stores.mutedUsers.get();

  return streams.filter((stream) => {
    return !mutedUsers.includes(stream.userId);
  });
}
