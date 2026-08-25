import assert from "node:assert/strict";
import test from "node:test";
import { classifyEvent, normalizeEvent } from "../normalize.js";
import type { CalendarEventInfo } from "../types.js";

function event(overrides: Partial<CalendarEventInfo>): CalendarEventInfo {
  return {
    CalendarEventId: 42,
    OrgUnitId: 100,
    Title: "Untitled",
    ...overrides,
  };
}

test("classifies exams before generic quiz association", () => {
  assert.equal(
    classifyEvent(
      event({
        Title: "Midterm Exam 1",
        AssociatedEntity: { AssociatedEntityType: "D2L.LE.Quizzing.Quiz" },
      }),
    ),
    "exam",
  );
});

test("classifies Dropbox items as assignments", () => {
  assert.equal(
    classifyEvent(
      event({
        Title: "Submission 1",
        AssociatedEntity: { AssociatedEntityType: "D2L.LE.Dropbox.Dropbox" },
      }),
    ),
    "assignment",
  );
});

test("normalization is stable and preserves source identifiers", () => {
  const result = normalizeEvent(
    event({
      CalendarEventId: 77,
      OrgUnitId: 88,
      OrgUnitCode: "COURSE-1",
      Title: "Project Proposal",
      StartDateTime: "2026-09-01T03:59:00.000Z",
    }),
  );
  assert.equal(result.id, "brightspace:77");
  assert.equal(result.kind, "project");
  assert.equal(result.courseId, 88);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});
