import assert from "node:assert/strict";
import test from "node:test";
import { diffEvents } from "../store.js";
import type { NormalizedAcademicEvent } from "../types.js";

function item(id: string, fingerprint: string): NormalizedAcademicEvent {
  return {
    id,
    calendarEventId: Number(id.replace(/\D/g, "")) || 1,
    courseId: 1,
    courseCode: null,
    courseName: null,
    title: id,
    kind: "assignment",
    startAt: null,
    endAt: null,
    allDay: false,
    recurring: false,
    eventType: null,
    associatedEntityType: null,
    associatedEntityId: null,
    url: null,
    fingerprint,
  };
}

test("diffs added, updated, removed, and unchanged events", () => {
  const result = diffEvents(
    [item("event-1", "same"), item("event-2", "old"), item("event-3", "gone")],
    [item("event-1", "same"), item("event-2", "new"), item("event-4", "added")],
  );
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.updated.map((event) => event.id), ["event-2"]);
  assert.deepEqual(result.removed.map((event) => event.id), ["event-3"]);
  assert.deepEqual(result.added.map((event) => event.id), ["event-4"]);
});
