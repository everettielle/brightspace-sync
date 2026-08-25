import { createHash } from "node:crypto";
import type {
  AcademicEventKind,
  CalendarEventInfo,
  NormalizedAcademicEvent,
} from "./types.js";

const ENTITY = {
  dropbox: "D2L.LE.Dropbox.Dropbox",
  quiz: "D2L.LE.Quizzing.Quiz",
  content: "D2L.LE.Content.ContentObject.TopicCO",
} as const;

function titleMatches(title: string, pattern: RegExp): boolean {
  return pattern.test(title.normalize("NFKC"));
}

export function classifyEvent(event: CalendarEventInfo): AcademicEventKind {
  const title = event.Title ?? "";
  const entityType = event.AssociatedEntity?.AssociatedEntityType;

  if (titleMatches(title, /\b(final|midterm|exam|test)\b/i)) return "exam";
  if (titleMatches(title, /\b(project|presentation|proposal|milestone)\b/i)) return "project";
  if (titleMatches(title, /\b(quiz)\b/i)) return "quiz";
  if (titleMatches(title, /\b(homework|assignment|problem\s*set|worksheet|hw\s*\d*)\b/i)) {
    return "assignment";
  }
  if (titleMatches(title, /\b(lab|laboratory)\b/i)) return "lab";

  if (entityType === ENTITY.dropbox) return "assignment";
  if (entityType === ENTITY.quiz) return "quiz";
  if (entityType === ENTITY.content) return "content";
  if (event.IsRecurring) return "class";
  return "other";
}

function fingerprint(value: Omit<NormalizedAcademicEvent, "fingerprint">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeEvent(event: CalendarEventInfo): NormalizedAcademicEvent {
  const normalizedWithoutFingerprint: Omit<NormalizedAcademicEvent, "fingerprint"> = {
    id: `brightspace:${event.CalendarEventId}`,
    calendarEventId: event.CalendarEventId,
    courseId: event.OrgUnitId,
    courseCode: event.OrgUnitCode ?? null,
    courseName: event.OrgUnitName ?? null,
    title: event.Title,
    kind: classifyEvent(event),
    startAt: event.StartDateTime ?? event.StartDay ?? null,
    endAt: event.EndDateTime ?? event.EndDay ?? null,
    allDay: event.IsAllDayEvent ?? false,
    recurring: event.IsRecurring ?? false,
    eventType: event.EventType ?? null,
    associatedEntityType: event.AssociatedEntity?.AssociatedEntityType ?? null,
    associatedEntityId: event.AssociatedEntity?.AssociatedEntityId ?? null,
    url: event.AssociatedEntity?.Link ?? event.CalendarEventViewUrl ?? null,
  };

  return {
    ...normalizedWithoutFingerprint,
    fingerprint: fingerprint(normalizedWithoutFingerprint),
  };
}

export function normalizeEvents(events: CalendarEventInfo[]): NormalizedAcademicEvent[] {
  return events
    .map(normalizeEvent)
    .sort((left, right) =>
      (left.startAt ?? "").localeCompare(right.startAt ?? "") || left.id.localeCompare(right.id),
    );
}
