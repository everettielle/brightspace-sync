import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectContentFileTopics,
  contentDispositionFilename,
  downloadCourseContent,
  sanitizePathSegment,
} from "../content.js";
import type { ContentTocResponse } from "../types.js";

function toc(lastModifiedDate = "2026-08-24T00:00:00.000Z"): ContentTocResponse {
  return {
    Modules: [
      {
        ModuleId: 1,
        Title: "Root/Module",
        Topics: [
          {
            TopicId: 10,
            Title: "Visible file",
            ActivityType: 1,
            Url: "/content/enforced/course/file.bin",
            LastModifiedDate: lastModifiedDate,
            SortOrder: 2,
          },
          {
            TopicId: 14,
            Title: "Brightspace video",
            ActivityType: 1,
            TypeIdentifier: "ContentService",
            Url: "d2l:brightspace:content:video:example/latest",
          },
          { TopicId: 11, Title: "Link", ActivityType: 2, Url: "https://example.com" },
          { TopicId: 12, Title: "Hidden file", ActivityType: 1, IsHidden: true },
        ],
        Modules: [
          {
            ModuleId: 2,
            Title: "Child",
            Topics: [
              {
                TopicId: 13,
                Title: "Type identifier file",
                TypeIdentifier: "File",
                Url: "/content/enforced/course/child.pdf",
                SortOrder: 1,
              },
            ],
          },
          {
            ModuleId: 3,
            Title: "Hidden module",
            IsHidden: true,
            Topics: [
              {
                TopicId: 15,
                Title: "File inside hidden module",
                TypeIdentifier: "File",
                Url: "/content/enforced/course/hidden.pdf",
              },
            ],
          },
        ],
      },
    ],
  };
}

test("collects learner-visible files recursively with module breadcrumbs", () => {
  const files = collectContentFileTopics(toc());
  assert.deepEqual(
    files.map((item) => ({ id: item.topic.TopicId, path: item.modulePath })),
    [
      { id: 10, path: ["Root/Module"] },
      { id: 13, path: ["Root/Module", "Child"] },
    ],
  );
});

test("sanitizes path traversal characters and parses UTF-8 disposition filenames", () => {
  assert.equal(sanitizePathSegment(" ../bad/name?.pdf "), ".._bad_name_.pdf");
  assert.equal(
    contentDispositionFilename(
      "attachment; filename*=UTF-8''Lecture%201%20%E2%80%93%20Notes.pdf; filename=notes.pdf",
    ),
    "Lecture 1 – Notes.pdf",
  );
});

test("downloads atomically, records a manifest, and skips an unchanged verified file", async () => {
  const root = await mkdtemp(join(tmpdir(), "brightspace-content-test-"));
  let calls = 0;
  let payload = Uint8Array.from([0, 1, 2, 255]);
  const client = {
    baseUrl: new URL("https://example.edu"),
    async getContentTopicFile(): Promise<Response> {
      calls += 1;
      return new Response(payload, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(payload.length),
          "content-disposition": 'attachment; filename="download.bin"',
        },
      });
    },
  };
  const course = { id: 100, code: "PHY/133", name: "Physics Lab" };
  const first = await downloadCourseContent(client, "1.96", course, toc(), {
    outputRoot: root,
    maxBytes: 1024,
    maxFiles: 1,
  });
  assert.equal(first.downloaded, 1);
  assert.equal(first.failed, 0);
  assert.equal(calls, 1);
  const manifest = JSON.parse(await readFile(first.manifest, "utf8")) as {
    files: Array<{ localPath: string; size: number; sha256: string }>;
  };
  assert.equal(manifest.files[0]?.size, payload.length);
  assert.match(manifest.files[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  const filePath = join(first.outputDirectory, manifest.files[0]!.localPath);
  assert.deepEqual(new Uint8Array(await readFile(filePath)), payload);
  if (process.platform !== "win32") assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const second = await downloadCourseContent(client, "1.96", course, toc(), {
    outputRoot: root,
    maxBytes: 1024,
    maxFiles: 1,
  });
  assert.equal(second.unchanged, 1);
  assert.equal(calls, 1);

  payload = Uint8Array.from([9, 8, 7]);
  const third = await downloadCourseContent(
    client,
    "1.96",
    course,
    toc("2026-08-25T00:00:00.000Z"),
    { outputRoot: root, maxBytes: 1024, maxFiles: 1 },
  );
  assert.equal(third.updated, 1);
  assert.equal(calls, 2);
  assert.deepEqual(new Uint8Array(await readFile(filePath)), payload);
});

test("rejects a response larger than the configured per-file limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "brightspace-content-size-test-"));
  const client = {
    baseUrl: new URL("https://example.edu"),
    async getContentTopicFile(): Promise<Response> {
      return new Response(Uint8Array.from([1, 2, 3, 4]), {
        headers: {
          "content-length": "4",
          "content-disposition": 'attachment; filename="large.bin"',
        },
      });
    },
  };
  const result = await downloadCourseContent(
    client,
    "1.96",
    { id: 100, code: "TEST", name: "Test" },
    toc(),
    { outputRoot: root, maxBytes: 3, maxFiles: 1 },
  );
  assert.equal(result.failed, 1);
  assert.match(result.errors[0]?.message ?? "", /exceeds --max-bytes/);
});

test("rejects a pre-existing symbolic link inside the content output tree", async (context) => {
  if (process.platform === "win32") {
    context.skip("symlink behavior and permissions vary on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "brightspace-content-symlink-test-"));
  const outside = await mkdtemp(join(tmpdir(), "brightspace-content-outside-test-"));
  await mkdir(root, { recursive: true });
  await symlink(outside, join(root, "TEST__100"));
  const client = {
    baseUrl: new URL("https://example.edu"),
    async getContentTopicFile(): Promise<Response> {
      throw new Error("file request should not be reached");
    },
  };
  await assert.rejects(
    downloadCourseContent(
      client,
      "1.96",
      { id: 100, code: "TEST", name: "Test" },
      toc(),
      { outputRoot: root, maxBytes: 1024, maxFiles: 1 },
    ),
    /symbolic link/,
  );
});
