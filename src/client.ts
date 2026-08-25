import type {
  ApiVersionInfo,
  CalendarEventInfo,
  CalendarEventsResponse,
  ContentTocResponse,
  MyEnrollmentInfo,
  MyEnrollmentsResponse,
} from "./types.js";
import type { AuthProvider } from "./auth.js";
import { normalizeBrightspaceOrigin } from "./origin.js";

export interface BrightspaceClientOptions {
  baseUrl: string;
  auth: AuthProvider;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  debugHttpBodies?: boolean;
}

export interface ApiVersions {
  le: string;
  lp: string;
}

export interface EventQuery {
  orgUnitIds: number[];
  from: string;
  to: string;
  association?: 0 | 1;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export class BrightspaceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
  }
}

export class BrightspaceClient {
  readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly debugHttpBodies: boolean;

  constructor(private readonly options: BrightspaceClientOptions) {
    this.baseUrl = new URL(normalizeBrightspaceOrigin(options.baseUrl));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? "brightspace-sync/0.1";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.debugHttpBodies = options.debugHttpBodies ?? false;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new Error("maxRetries must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.maxRetryDelayMs) || this.maxRetryDelayMs <= 0) {
      throw new Error("maxRetryDelayMs must be a positive integer");
    }
  }

  private resolveUrl(pathOrUrl: string): URL {
    const url = new URL(pathOrUrl, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new Error(`Refusing to send authentication to a different origin: ${url.origin}`);
    }
    return url;
  }

  private async request(
    pathOrUrl: string,
    options: { params?: URLSearchParams; accept?: string } = {},
  ): Promise<Response> {
    const url = this.resolveUrl(pathOrUrl);
    if (options.params) url.search = options.params.toString();

    let response: Response | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const authHeaders = await this.options.auth.getHeaders();
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(this.requestTimeoutMs),
          headers: {
            Accept: options.accept ?? "application/json",
            "User-Agent": this.userAgent,
            ...authHeaders,
          },
        });
      } catch (error) {
        if ((error as Error).name === "AbortError" || (error as Error).name === "TimeoutError") {
          throw new BrightspaceHttpError(
            `Brightspace request timed out after ${this.requestTimeoutMs} ms`,
            408,
            url.pathname,
          );
        }
        throw error;
      }

      if (response.status !== 429 || attempt === this.maxRetries) break;
      await response.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs(response!, attempt)));
    }
    if (!response) throw new Error("Brightspace request did not produce a response");

    if (response.status >= 300 && response.status < 400) {
      throw new BrightspaceHttpError(
        "Brightspace redirected the request; the browser session is probably expired",
        response.status,
        url.pathname,
      );
    }
    if (!response.ok) {
      const requestId =
        response.headers.get("x-request-id") ?? response.headers.get("x-correlation-id");
      const body = this.debugHttpBodies ? `: ${(await response.text()).slice(0, 300)}` : "";
      throw new BrightspaceHttpError(
        `Brightspace request failed (${response.status})${requestId ? ` [request ${requestId}]` : ""}${body}`,
        response.status,
        url.pathname,
      );
    }

    return response;
  }

  private retryDelayMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(Math.ceil(seconds * 1_000), this.maxRetryDelayMs);
      }
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) {
        return Math.min(Math.max(0, date - Date.now()), this.maxRetryDelayMs);
      }
    }
    return Math.min(1_000 * 2 ** attempt, this.maxRetryDelayMs);
  }

  private async requestJson<T>(pathOrUrl: string, params?: URLSearchParams): Promise<T> {
    const response = await this.request(pathOrUrl, { ...(params ? { params } : {}) });

    const text = (await response.text()).replace(/^while\s*\(\s*1\s*\)\s*;\s*/, "");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BrightspaceHttpError(
        "Brightspace returned a non-JSON response; the browser session may be on a login page",
        response.status,
        this.resolveUrl(pathOrUrl).pathname,
      );
    }
  }

  async discoverVersions(): Promise<ApiVersions> {
    const versions = await this.requestJson<ApiVersionInfo[]>("/d2l/api/versions/");
    const lookup = new Map(versions.map((entry) => [entry.ProductCode, entry.LatestVersion]));
    const le = lookup.get("le");
    const lp = lookup.get("lp");
    if (!le || !lp) throw new Error("Brightspace did not report current LE and LP API versions");
    return { le, lp };
  }

  async getMyCourseOfferings(lpVersion: string): Promise<MyEnrollmentInfo[]> {
    const items: MyEnrollmentInfo[] = [];
    let bookmark: string | undefined;

    do {
      const params = new URLSearchParams({ orgUnitTypeId: "3", canAccess: "true" });
      if (bookmark) params.set("bookmark", bookmark);
      const response = await this.requestJson<MyEnrollmentsResponse>(
        `/d2l/api/lp/${encodeURIComponent(lpVersion)}/enrollments/myenrollments/`,
        params,
      );
      items.push(
        ...(response.Items ?? []).filter(
          (item) => item.OrgUnit?.Id && item.Access?.CanAccess !== false,
        ),
      );
      bookmark = response.PagingInfo?.HasMoreItems ? response.PagingInfo.Bookmark : undefined;
      if (response.PagingInfo?.HasMoreItems && !bookmark) {
        throw new Error("Enrollment response says more items exist but provides no bookmark");
      }
    } while (bookmark);

    return items;
  }

  async getMyEvents(leVersion: string, query: EventQuery): Promise<CalendarEventInfo[]> {
    if (query.orgUnitIds.length === 0) return [];
    const allEvents: CalendarEventInfo[] = [];

    for (const orgUnitIds of chunks([...new Set(query.orgUnitIds)], 100)) {
      const params = new URLSearchParams({
        orgUnitIdsCSV: orgUnitIds.join(","),
        association: String(query.association ?? 1),
        startDateTime: query.from,
        endDateTime: query.to,
      });
      let next: string | null = `/d2l/api/le/${encodeURIComponent(leVersion)}/calendar/events/myEvents/`;
      let firstPage = true;

      while (next) {
        const page: CalendarEventsResponse = await this.requestJson<CalendarEventsResponse>(
          next,
          firstPage ? params : undefined,
        );
        allEvents.push(...(page.Objects ?? []));
        next = page.Next ?? null;
        firstPage = false;
      }
    }

    const byId = new Map<number, CalendarEventInfo>();
    for (const event of allEvents) byId.set(event.CalendarEventId, event);
    return [...byId.values()];
  }

  async getContentToc(leVersion: string, orgUnitId: number): Promise<ContentTocResponse> {
    if (!Number.isSafeInteger(orgUnitId) || orgUnitId <= 0) {
      throw new Error(`Invalid organization unit ID: ${orgUnitId}`);
    }
    return this.requestJson<ContentTocResponse>(
      `/d2l/api/le/${encodeURIComponent(leVersion)}/${orgUnitId}/content/toc`,
    );
  }

  async getContentTopicFile(
    leVersion: string,
    orgUnitId: number,
    topicId: number,
  ): Promise<Response> {
    if (!Number.isSafeInteger(orgUnitId) || orgUnitId <= 0) {
      throw new Error(`Invalid organization unit ID: ${orgUnitId}`);
    }
    if (!Number.isSafeInteger(topicId) || topicId <= 0) {
      throw new Error(`Invalid content topic ID: ${topicId}`);
    }
    return this.request(
      `/d2l/api/le/${encodeURIComponent(leVersion)}/${orgUnitId}/content/topics/${topicId}/file`,
      { accept: "*/*" },
    );
  }
}
