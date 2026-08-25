import { createHash } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { BrightspaceClient } from "./client.js";
import type { ContentModuleInfo, ContentTocResponse, ContentTopicInfo } from "./types.js";

export interface ContentCourse {
  id: number;
  code: string;
  name: string;
}

export interface ContentFileTopic {
  topic: ContentTopicInfo;
  modulePath: string[];
}

export interface ContentManifestEntry {
  topicId: number;
  title: string;
  modulePath: string[];
  sourceUrl: string | null;
  lastModifiedDate: string | null;
  localPath: string;
  fileName: string;
  contentType: string | null;
  size: number;
  sha256: string;
}

export interface ContentManifest {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    baseUrl: string;
    courseId: number;
    courseCode: string;
    courseName: string;
  };
  files: ContentManifestEntry[];
}

export interface ContentDownloadOptions {
  outputRoot: string;
  maxBytes: number;
  maxFiles?: number;
}

export interface ContentDownloadError {
  topicId: number;
  title: string;
  message: string;
}

export interface ContentDownloadSummary {
  courseId: number;
  courseCode: string;
  courseName: string;
  modules: number;
  topics: number;
  fileTopics: number;
  selectedFiles: number;
  downloaded: number;
  updated: number;
  unchanged: number;
  skippedUnavailable: number;
  failed: number;
  errors: ContentDownloadError[];
  outputDirectory: string;
  manifest: string;
}

interface ContentFileClient {
  readonly baseUrl: URL;
  getContentTopicFile(leVersion: string, orgUnitId: number, topicId: number): Promise<Response>;
}

interface TocCounts {
  modules: number;
  topics: number;
  unavailableFileTopics: number;
}

function isDownloadableFileTopic(topic: ContentTopicInfo): boolean {
  if (topic.TypeIdentifier === "File") return true;
  return (
    topic.TypeIdentifier == null &&
    topic.ActivityType === 1 &&
    typeof topic.Url === "string" &&
    topic.Url.startsWith("/content/")
  );
}

function countToc(modules: ContentModuleInfo[]): TocCounts {
  const counts: TocCounts = { modules: 0, topics: 0, unavailableFileTopics: 0 };
  const visit = (module: ContentModuleInfo, parentUnavailable = false): void => {
    counts.modules += 1;
    const moduleUnavailable =
      parentUnavailable || module.IsHidden === true || module.IsLocked === true;
    for (const topic of module.Topics ?? []) {
      counts.topics += 1;
      const isFile = isDownloadableFileTopic(topic);
      if (
        isFile &&
        (moduleUnavailable ||
          topic.IsHidden === true ||
          topic.IsLocked === true ||
          topic.IsBroken === true)
      ) {
        counts.unavailableFileTopics += 1;
      }
    }
    for (const child of module.Modules ?? []) visit(child, moduleUnavailable);
  };
  for (const module of modules) visit(module);
  return counts;
}

export function collectContentFileTopics(toc: ContentTocResponse): ContentFileTopic[] {
  const files: ContentFileTopic[] = [];
  const visit = (module: ContentModuleInfo, parents: string[]): void => {
    if (module.IsHidden === true || module.IsLocked === true) return;
    const modulePath = [...parents, module.Title];
    const topics = [...(module.Topics ?? [])].sort(
      (left, right) => (left.SortOrder ?? 0) - (right.SortOrder ?? 0),
    );
    for (const topic of topics) {
      const isFile = isDownloadableFileTopic(topic);
      if (
        isFile &&
        topic.IsHidden !== true &&
        topic.IsLocked !== true &&
        topic.IsBroken !== true
      ) {
        files.push({ topic, modulePath });
      }
    }
    const children = [...(module.Modules ?? [])].sort(
      (left, right) => (left.SortOrder ?? 0) - (right.SortOrder ?? 0),
    );
    for (const child of children) visit(child, modulePath);
  };
  const rootModules = [...(toc.Modules ?? [])].sort(
    (left, right) => (left.SortOrder ?? 0) - (right.SortOrder ?? 0),
  );
  for (const module of rootModules) visit(module, []);
  return files;
}

export function sanitizePathSegment(value: string, fallback = "untitled"): string {
  const sanitized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === "..") return fallback;
  return sanitized.slice(0, 140);
}

export function contentDispositionFilename(value: string | null): string | null {
  if (!value) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // Fall through to the plain filename parameter.
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(value)?.[1];
  if (quoted) return quoted;
  const plain = /filename\s*=\s*([^;]+)/i.exec(value)?.[1];
  return plain?.trim() ?? null;
}

function fallbackFilename(topic: ContentTopicInfo): string {
  if (topic.Url) {
    try {
      const decoded = decodeURIComponent(basename(new URL(topic.Url, "https://example.invalid").pathname));
      if (decoded) return decoded;
    } catch {
      const raw = basename(topic.Url);
      if (raw) return raw;
    }
  }
  return `${topic.Title || "topic"}-${topic.TopicId}`;
}

function topicSuffixFilename(fileName: string, topicId: number): string {
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${stem}__topic-${topicId}${extension}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await open(path, "r");
  try {
    for await (const chunk of file.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoSymlinks(root: string, candidate: string): Promise<void> {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  assertInside(rootPath, candidatePath);
  const relativePath = relative(rootPath, candidatePath);
  const parts = relativePath ? relativePath.split(sep) : [];
  let current = rootPath;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Refusing to use a symbolic link inside content output: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

async function readManifest(path: string): Promise<ContentManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ContentManifest;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) {
      throw new Error(`Unsupported content manifest format in ${path}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeManifest(path: string, manifest: ContentManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function streamResponseToFile(
  response: Response,
  destination: string,
  maxBytes: number,
): Promise<{ size: number; sha256: string }> {
  if (!response.body) throw new Error("Brightspace returned an empty file response");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`File exceeds --max-bytes (${declaredLength} > ${maxBytes})`);
  }

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  let succeeded = false;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new Error(`File exceeds --max-bytes (${size} > ${maxBytes})`);
      hash.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
    succeeded = true;
  } finally {
    await handle.close();
    if (!succeeded) {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporary).catch(() => undefined);
    }
  }
  await rename(temporary, destination);
  return { size, sha256: hash.digest("hex") };
}

function assertInside(root: string, candidate: string): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (candidatePath !== rootPath && !candidatePath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Refusing to write outside content directory: ${candidate}`);
  }
}

export async function downloadCourseContent(
  client: Pick<BrightspaceClient, "baseUrl" | "getContentTopicFile"> | ContentFileClient,
  leVersion: string,
  course: ContentCourse,
  toc: ContentTocResponse,
  options: ContentDownloadOptions,
): Promise<ContentDownloadSummary> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error(`Invalid --max-bytes value: ${options.maxBytes}`);
  }
  if (
    options.maxFiles !== undefined &&
    (!Number.isSafeInteger(options.maxFiles) || options.maxFiles <= 0)
  ) {
    throw new Error(`Invalid --max-files value: ${options.maxFiles}`);
  }

  const courseDirectoryName = sanitizePathSegment(
    `${course.code || course.name || "course"}__${course.id}`,
    `course-${course.id}`,
  );
  const courseDirectory = resolve(options.outputRoot, courseDirectoryName);
  assertInside(options.outputRoot, courseDirectory);
  await mkdir(options.outputRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinks(options.outputRoot, options.outputRoot);
  await mkdir(courseDirectory, { recursive: true, mode: 0o700 });
  await assertNoSymlinks(options.outputRoot, courseDirectory);
  const manifestPath = join(courseDirectory, "manifest.json");
  const previous = await readManifest(manifestPath);
  const previousByTopic = new Map((previous?.files ?? []).map((item) => [item.topicId, item]));
  const counts = countToc(toc.Modules ?? []);
  const availableFiles = collectContentFileTopics(toc);
  const selectedFiles = availableFiles.slice(0, options.maxFiles ?? availableFiles.length);
  const manifestFiles: ContentManifestEntry[] = [];
  const errors: ContentDownloadError[] = [];
  let downloaded = 0;
  let updated = 0;
  let unchanged = 0;

  for (const item of selectedFiles) {
    const { topic, modulePath } = item;
    const old = previousByTopic.get(topic.TopicId);
    if (old && old.lastModifiedDate === (topic.LastModifiedDate ?? null)) {
      const oldAbsolutePath = resolve(courseDirectory, old.localPath);
      assertInside(courseDirectory, oldAbsolutePath);
      await assertNoSymlinks(courseDirectory, oldAbsolutePath);
      if (await pathExists(oldAbsolutePath)) {
        const localHash = await sha256File(oldAbsolutePath);
        if (localHash === old.sha256) {
          manifestFiles.push({
            ...old,
            title: topic.Title,
            modulePath,
            sourceUrl: topic.Url ?? null,
          });
          unchanged += 1;
          continue;
        }
      }
    }

    try {
      const response = await client.getContentTopicFile(leVersion, course.id, topic.TopicId);
      const responseFilename = contentDispositionFilename(response.headers.get("content-disposition"));
      const rawFilename = responseFilename ?? fallbackFilename(topic);
      let fileName = sanitizePathSegment(rawFilename, `topic-${topic.TopicId}`);
      const sanitizedModules = modulePath.map((part, index) =>
        sanitizePathSegment(part, `module-${index + 1}`),
      );
      const moduleDirectory = join(courseDirectory, ...sanitizedModules);
      let destination = old
        ? resolve(courseDirectory, old.localPath)
        : join(moduleDirectory, fileName);
      assertInside(courseDirectory, destination);
      if (!old && (await pathExists(destination))) {
        fileName = topicSuffixFilename(fileName, topic.TopicId);
        destination = join(moduleDirectory, fileName);
      }
      assertInside(courseDirectory, destination);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await assertNoSymlinks(courseDirectory, destination);

      const result = await streamResponseToFile(response, destination, options.maxBytes);
      const localPath = relative(courseDirectory, destination);
      manifestFiles.push({
        topicId: topic.TopicId,
        title: topic.Title,
        modulePath,
        sourceUrl: topic.Url ?? null,
        lastModifiedDate: topic.LastModifiedDate ?? null,
        localPath,
        fileName: basename(destination),
        contentType: response.headers.get("content-type"),
        size: result.size,
        sha256: result.sha256,
      });
      if (old) updated += 1;
      else downloaded += 1;
    } catch (error) {
      errors.push({
        topicId: topic.TopicId,
        title: topic.Title,
        message: error instanceof Error ? error.message : String(error),
      });
      if (old) manifestFiles.push(old);
    }
  }

  if (selectedFiles.length < availableFiles.length) {
    const selectedIds = new Set(selectedFiles.map((item) => item.topic.TopicId));
    for (const old of previous?.files ?? []) {
      if (!selectedIds.has(old.topicId) && !manifestFiles.some((item) => item.topicId === old.topicId)) {
        manifestFiles.push(old);
      }
    }
  }

  const manifest: ContentManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      baseUrl: client.baseUrl.origin,
      courseId: course.id,
      courseCode: course.code,
      courseName: course.name,
    },
    files: manifestFiles.sort((left, right) => left.topicId - right.topicId),
  };
  await writeManifest(manifestPath, manifest);

  return {
    courseId: course.id,
    courseCode: course.code,
    courseName: course.name,
    modules: counts.modules,
    topics: counts.topics,
    fileTopics: availableFiles.length + counts.unavailableFileTopics,
    selectedFiles: selectedFiles.length,
    downloaded,
    updated,
    unchanged,
    skippedUnavailable: counts.unavailableFileTopics,
    failed: errors.length,
    errors,
    outputDirectory: courseDirectory,
    manifest: manifestPath,
  };
}
