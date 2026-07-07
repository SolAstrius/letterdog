import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { DOMImplementation, DOMParser as XmlDomParser, XMLSerializer } from "@xmldom/xmldom";
import xpathModule from "xpath";
import type { ActorContext } from "./auth.ts";
import type { EnvConfig } from "./config.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  removeNSPrefix: true,
});

const xpath = xpathModule as any;

export class CalDavClient {
  private libraryClientPromise?: Promise<any>;

  constructor(
    private readonly config: EnvConfig,
    private readonly auth: ActorContext["auth"],
  ) {}

  async connect(): Promise<any> {
    if (!this.libraryClientPromise) {
      this.libraryClientPromise = this.createLibraryClient();
    }
    return await this.libraryClientPromise;
  }

  async discover(): Promise<Record<string, unknown>> {
    const client = await this.connect();
    return {
      rootUrl: this.rootUrl(),
      currentUserPrincipal: summarizeDavObject(client.currentUserPrincipal),
      principalCollections: client.principalCollections ?? [],
      calendarHomes: (client.calendarHomes ?? []).map(summarizeDavObject),
      advertisedFeatures: client.advertisedFeatures ?? [],
      publicCalendarHome: summarizeDavObject(client.publicCalendarHome),
    };
  }

  async listCalendarCollections(homePath?: string): Promise<Record<string, unknown>> {
    const client = await this.connect();
    const homes = homePath
      ? (client.calendarHomes ?? []).filter((home: any) =>
        normalizePath(home.url) === normalizePath(homePath)
      )
      : (client.calendarHomes ?? []);
    const groups = [];
    for (const home of homes) {
      const grouped = await home.findAllCalDAVCollectionsGrouped();
      groups.push({
        home: summarizeDavObject(home),
        calendars: grouped.calendars.map(summarizeDavObject),
        deletedCalendars: grouped.deletedCalendars.map(summarizeDavObject),
        trashBins: grouped.trashBins.map(summarizeDavObject),
        subscriptions: grouped.subscriptions.map(summarizeDavObject),
        scheduleInboxes: grouped.scheduleInboxes.map(summarizeDavObject),
        scheduleOutboxes: grouped.scheduleOutboxes.map(summarizeDavObject),
      });
    }
    return { rootUrl: this.rootUrl(), homes: groups };
  }

  async listCalendarObjects(calendarPath: string): Promise<Record<string, unknown>> {
    const calendar = await this.findCalendar(calendarPath);
    const objects = await calendar.findAllVObjects();
    return { calendar: summarizeDavObject(calendar), objects: objects.map(summarizeDavObject) };
  }

  async queryCalendarObjects(
    calendarPath: string,
    options: { component?: string; start?: string; end?: string },
  ): Promise<Record<string, unknown>> {
    const calendar = await this.findCalendar(calendarPath);
    const component = options.component ?? "VEVENT";
    const objects = options.start && options.end
      ? await calendar.findByTypeInTimeRange(
        component,
        new Date(options.start),
        new Date(options.end),
      )
      : await calendar.findByType(component);
    return { calendar: summarizeDavObject(calendar), objects: objects.map(summarizeDavObject) };
  }

  async multigetCalendarObjects(
    calendarPath: string,
    hrefs: string[],
  ): Promise<Record<string, unknown>> {
    const calendar = await this.findCalendar(calendarPath);
    const objects = await calendar.calendarMultiget(hrefs);
    return { calendar: summarizeDavObject(calendar), objects: objects.map(summarizeDavObject) };
  }

  async propfind(path: string, depth: "0" | "1" | "infinity", body: string): Promise<unknown> {
    return await this.xmlRequest("PROPFIND", path, depth, body);
  }

  async report(path: string, depth: "0" | "1", body: string): Promise<unknown> {
    return await this.xmlRequest("REPORT", path, depth, body);
  }

  async get(
    path: string,
  ): Promise<{ contentType: string | null; etag: string | null; body: string }> {
    const response = await fetch(this.urlForPath(path), {
      headers: { Authorization: `Bearer ${this.auth.bearer}` },
    });
    if (!response.ok) throw new Error(`CalDAV GET failed: HTTP ${response.status}`);
    return {
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      body: await response.text(),
    };
  }

  async put(
    path: string,
    body: string,
    options: { contentType?: string; ifMatch?: string; ifNoneMatch?: "*" } = {},
  ): Promise<{ status: number; etag: string | null; location: string | null }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.auth.bearer}`,
      "Content-Type": options.contentType ?? "text/calendar; charset=utf-8",
    };
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;
    if (options.ifNoneMatch) headers["If-None-Match"] = options.ifNoneMatch;
    const response = await fetch(this.urlForPath(path), {
      method: "PUT",
      headers,
      body,
    });
    if (!response.ok) throw new Error(`CalDAV PUT failed: HTTP ${response.status}`);
    return {
      status: response.status,
      etag: response.headers.get("etag"),
      location: response.headers.get("location"),
    };
  }

  async delete(path: string, ifMatch?: string): Promise<{ status: number }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.auth.bearer}`,
    };
    if (ifMatch) headers["If-Match"] = ifMatch;
    const response = await fetch(this.urlForPath(path), {
      method: "DELETE",
      headers,
    });
    if (!response.ok) throw new Error(`CalDAV DELETE failed: HTTP ${response.status}`);
    return { status: response.status };
  }

  private async xmlRequest(
    method: string,
    path: string,
    depth: string,
    body: string,
  ): Promise<unknown> {
    const response = await fetch(this.urlForPath(path), {
      method,
      headers: {
        Authorization: `Bearer ${this.auth.bearer}`,
        Depth: depth,
        "Content-Type": "application/xml; charset=utf-8",
      },
      body,
    });
    if (!response.ok && response.status !== 207) {
      throw new Error(`CalDAV ${method} failed: HTTP ${response.status}`);
    }
    return parser.parse(await response.text());
  }

  private async createLibraryClient(): Promise<any> {
    installDavLibraryGlobals(this.config.stalwartBaseUrl);
    const { default: DavClient } = await import("@nextcloud/cdav-library");
    const client = new DavClient({
      rootUrl: this.rootUrl(),
      defaultHeaders: { Authorization: `Bearer ${this.auth.bearer}` },
    });
    return await client.connect({ enableCalDAV: true });
  }

  private async findCalendar(calendarPath: string): Promise<any> {
    const client = await this.connect();
    const wanted = normalizePath(calendarPath);
    for (const home of client.calendarHomes ?? []) {
      const grouped = await home.findAllCalDAVCollectionsGrouped();
      const collections = [
        ...grouped.calendars,
        ...grouped.subscriptions,
        ...grouped.scheduleInboxes,
        ...grouped.scheduleOutboxes,
      ];
      const match = collections.find((collection: any) => normalizePath(collection.url) === wanted);
      if (match) return match;
    }
    throw new Error(`CalDAV calendar not found: ${calendarPath}`);
  }

  private rootUrl(): string {
    return new URL("/dav/cal/", this.config.stalwartBaseUrl).href;
  }

  private urlForPath(path: string): URL {
    if (!path.startsWith("/")) throw new Error("CalDAV paths must be server-relative");
    if (path.includes("..")) throw new Error("CalDAV path must not contain '..'");
    return new URL(path, this.config.stalwartBaseUrl);
  }
}

function installDavLibraryGlobals(origin: string): void {
  const global = globalThis as any;
  if (!global.window) {
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    global.window = {
      localStorage,
      sessionStorage,
      location: { origin },
      addEventListener() {},
      removeEventListener() {},
    };
    global.localStorage = localStorage;
    global.sessionStorage = sessionStorage;
  }

  const implementation = new DOMImplementation();
  global.DOMParser = class XPathDomParser extends XmlDomParser {
    override parseFromString(source: string, mimeType: string): any {
      return attachEvaluate(super.parseFromString(source, mimeType) as any);
    }
  };
  global.XMLSerializer = XMLSerializer;
  global.XPathResult = xpath.XPathResult;
  global.document = {
    ...(global.document ?? {}),
    head: global.document?.head ?? { dataset: { requesttoken: "" } },
    body: global.document?.body ?? { dataset: {} },
    implementation: {
      createDocument: (...args: Parameters<DOMImplementation["createDocument"]>) =>
        attachEvaluate(implementation.createDocument(...args) as any),
    },
    querySelector: global.document?.querySelector?.bind(global.document) ?? (() => null),
  };
}

function attachEvaluate<T extends Record<string, unknown>>(document: T): T {
  Object.defineProperty(document, "evaluate", {
    configurable: true,
    value: (
      expression: string,
      contextNode: unknown,
      resolver: unknown,
      type: number,
      result: unknown,
    ) => {
      const resolved = xpath.evaluate(
        expression,
        contextNode ?? document,
        normalizeResolver(resolver),
        type ?? xpath.XPathResult.ANY_TYPE,
        result ?? null,
      );
      if (resolved && typeof (resolved as any).iterateNext === "function") {
        const original = (resolved as any).iterateNext.bind(resolved);
        (resolved as any).iterateNext = () => original() ?? null;
      }
      return resolved;
    },
  });
  return document;
}

function normalizeResolver(resolver: unknown): unknown {
  if (!resolver) return null;
  if (typeof resolver === "function") {
    return { lookupNamespaceURI: resolver as (prefix: string) => string | null };
  }
  return resolver;
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(String(key)) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(String(key), String(value));
    },
    removeItem(key: string) {
      values.delete(String(key));
    },
    clear() {
      values.clear();
    },
  };
}

function normalizePath(path: string): string {
  const normalized = path.startsWith("http") ? new URL(path).pathname : path;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function summarizeDavObject(value: any): Record<string, unknown> | null {
  if (!value) return null;
  const summary: Record<string, unknown> = {};
  for (
    const key of [
      "url",
      "displayname",
      "color",
      "enabled",
      "order",
      "source",
      "etag",
      "contenttype",
      "data",
      "components",
      "transparency",
      "syncToken",
      "currentUserPrivilegeSet",
      "resourcetype",
      "timezone",
    ]
  ) {
    if (value[key] !== undefined) summary[key] = value[key];
  }
  return summary;
}

export function propfindBody(properties: string[]): string {
  const prop: Record<string, ""> = {};
  for (const name of properties) prop[name] = "";
  return new XMLBuilder({
    ignoreAttributes: false,
    suppressEmptyNode: true,
  }).build({
    "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
    "D:propfind": {
      "@_xmlns:D": "DAV:",
      "@_xmlns:C": "urn:ietf:params:xml:ns:caldav",
      "D:prop": prop,
    },
  });
}

export function calendarMultigetBody(hrefs: string[]): string {
  return new XMLBuilder({
    ignoreAttributes: false,
    suppressEmptyNode: true,
  }).build({
    "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
    "C:calendar-multiget": {
      "@_xmlns:D": "DAV:",
      "@_xmlns:C": "urn:ietf:params:xml:ns:caldav",
      "D:prop": {
        "D:getetag": "",
        "C:calendar-data": "",
      },
      "D:href": hrefs,
    },
  });
}

export function calendarQueryBody(start?: string, end?: string): string {
  const timeRange = start && end ? { "@_start": start, "@_end": end } : undefined;
  return new XMLBuilder({
    ignoreAttributes: false,
    suppressEmptyNode: true,
  }).build({
    "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
    "C:calendar-query": {
      "@_xmlns:D": "DAV:",
      "@_xmlns:C": "urn:ietf:params:xml:ns:caldav",
      "D:prop": {
        "D:getetag": "",
        "C:calendar-data": "",
      },
      "C:filter": {
        "C:comp-filter": {
          "@_name": "VCALENDAR",
          "C:comp-filter": {
            "@_name": "VEVENT",
            ...(timeRange ? { "C:time-range": timeRange } : {}),
          },
        },
      },
    },
  });
}
