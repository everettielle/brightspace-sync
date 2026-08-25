import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventDiff, EventStore, NormalizedAcademicEvent } from "./types.js";

export function diffEvents(
  previous: NormalizedAcademicEvent[],
  current: NormalizedAcademicEvent[],
): EventDiff {
  const oldById = new Map(previous.map((event) => [event.id, event]));
  const newById = new Map(current.map((event) => [event.id, event]));
  const added: NormalizedAcademicEvent[] = [];
  const updated: NormalizedAcademicEvent[] = [];
  const removed: NormalizedAcademicEvent[] = [];
  let unchanged = 0;

  for (const event of current) {
    const old = oldById.get(event.id);
    if (!old) added.push(event);
    else if (old.fingerprint !== event.fingerprint) updated.push(event);
    else unchanged += 1;
  }
  for (const event of previous) {
    if (!newById.has(event.id)) removed.push(event);
  }

  return { added, updated, removed, unchanged };
}

export async function readEventStore(path: string): Promise<EventStore | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as EventStore;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.events)) {
      throw new Error(`Unsupported event store format in ${path}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeEventStore(path: string, store: EventStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
