import assert from "node:assert/strict";
import test from "node:test";
import { OAuthBearerAuth } from "../auth.js";
import { BrightspaceClient } from "../client.js";

test("follows official calendar pagination and de-duplicates event IDs", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push(url.toString());
    if (url.searchParams.has("bookmark")) {
      return Response.json({
        Objects: [
          { CalendarEventId: 2, OrgUnitId: 20, Title: "Second" },
          { CalendarEventId: 1, OrgUnitId: 20, Title: "Duplicate" },
        ],
        Next: null,
      });
    }
    return Response.json({
      Objects: [{ CalendarEventId: 1, OrgUnitId: 20, Title: "First" }],
      Next: "/d2l/api/le/1.96/calendar/events/myEvents/?bookmark=next",
    });
  };
  const client = new BrightspaceClient({
    baseUrl: "https://example.edu",
    auth: new OAuthBearerAuth("token"),
    fetchImpl,
  });
  const result = await client.getMyEvents("1.96", {
    orgUnitIds: [20],
    from: "2026-08-24T00:00:00.000Z",
    to: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(
    result.map((item) => item.CalendarEventId),
    [1, 2],
  );
});

test("refuses pagination links on another origin", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({
      Objects: [],
      Next: "https://attacker.example/steal",
    });
  const client = new BrightspaceClient({
    baseUrl: "https://example.edu",
    auth: new OAuthBearerAuth("token"),
    fetchImpl,
  });
  await assert.rejects(
    client.getMyEvents("1.96", {
      orgUnitIds: [20],
      from: "2026-08-24T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    }),
    /different origin/,
  );
});

test("retrieves the nested content table of contents", async () => {
  let requested = "";
  const fetchImpl: typeof fetch = async (input) => {
    requested = String(input);
    return Response.json({
      Modules: [
        {
          ModuleId: 10,
          Title: "Syllabus",
          Modules: [],
          Topics: [{ TopicId: 20, Title: "Course syllabus", ActivityType: 1 }],
        },
      ],
    });
  };
  const client = new BrightspaceClient({
    baseUrl: "https://example.edu",
    auth: new OAuthBearerAuth("token"),
    fetchImpl,
  });
  const result = await client.getContentToc("1.96", 123);
  assert.equal(requested, "https://example.edu/d2l/api/le/1.96/123/content/toc");
  assert.equal(result.Modules[0]?.Topics?.[0]?.TopicId, 20);
});

test("returns arbitrary binary topic-file responses without JSON parsing", async () => {
  const bytes = Uint8Array.from([0, 255, 10, 128, 42]);
  let requested = "";
  const fetchImpl: typeof fetch = async (input) => {
    requested = String(input);
    return new Response(bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="data.bin"',
      },
    });
  };
  const client = new BrightspaceClient({
    baseUrl: "https://example.edu",
    auth: new OAuthBearerAuth("token"),
    fetchImpl,
  });
  const response = await client.getContentTopicFile("1.96", 123, 456);
  assert.equal(
    requested,
    "https://example.edu/d2l/api/le/1.96/123/content/topics/456/file",
  );
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="data.bin"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("retries rate-limited GET requests using Retry-After", async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => {
    requests += 1;
    if (requests === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    return Response.json([
      { ProductCode: "le", LatestVersion: "1.96" },
      { ProductCode: "lp", LatestVersion: "1.62" },
    ]);
  };
  const client = new BrightspaceClient({
    baseUrl: "https://example.edu",
    auth: new OAuthBearerAuth("token"),
    fetchImpl,
    maxRetries: 1,
  });
  assert.deepEqual(await client.discoverVersions(), { le: "1.96", lp: "1.62" });
  assert.equal(requests, 2);
});

test("does not expose Brightspace error response bodies unless debug mode is explicit", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("private course details", { status: 403, headers: { "x-request-id": "abc" } });
  const client = new BrightspaceClient({
    baseUrl: "https://example.edu",
    auth: new OAuthBearerAuth("token"),
    fetchImpl,
    maxRetries: 0,
  });
  await assert.rejects(client.discoverVersions(), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    const message = (error as Error).message;
    assert.match(message, /Brightspace request failed \(403\) \[request abc\]/);
    assert.doesNotMatch(message, /private course details/);
    return true;
  });
});
