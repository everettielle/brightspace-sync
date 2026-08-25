export interface ApiVersionInfo {
  ProductCode: string;
  LatestVersion: string;
  SupportedVersions?: string[];
}

export interface OrgUnitTypeInfo {
  Id?: number;
  Code?: string;
  Name?: string;
}

export interface OrgUnitInfo {
  Id: number;
  Type?: OrgUnitTypeInfo;
  Name: string;
  Code: string;
}

export interface EnrollmentAccessInfo {
  IsActive?: boolean;
  CanAccess?: boolean;
  StartDate?: string | null;
  EndDate?: string | null;
  LastAccessed?: string | null;
}

export interface MyEnrollmentInfo {
  OrgUnit: OrgUnitInfo;
  Access?: EnrollmentAccessInfo;
}

export interface MyEnrollmentsResponse {
  Items: MyEnrollmentInfo[];
  PagingInfo?: {
    Bookmark?: string;
    HasMoreItems?: boolean;
  };
}

export interface AssociatedEntityInfo {
  AssociatedEntityId?: number;
  AssociatedEntityType?: string;
  Link?: string | null;
}

export interface CalendarEventInfo {
  CalendarEventId: number;
  OrgUnitId: number;
  OrgUnitCode?: string;
  OrgUnitName?: string;
  Title: string;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
  StartDay?: string | null;
  EndDay?: string | null;
  IsAllDayEvent?: boolean;
  IsRecurring?: boolean;
  EventType?: number;
  CalendarEventViewUrl?: string | null;
  AssociatedEntity?: AssociatedEntityInfo | null;
}

export interface CalendarEventsResponse {
  Objects: CalendarEventInfo[];
  Next?: string | null;
}

export interface RichTextInfo {
  Text?: string;
  Html?: string;
}

export interface ContentTopicInfo {
  TopicId: number;
  Identifier?: string;
  TypeIdentifier?: string;
  ActivityType?: number;
  Title: string;
  Url?: string | null;
  SortOrder?: number;
  IsHidden?: boolean;
  IsLocked?: boolean;
  IsBroken?: boolean;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
  LastModifiedDate?: string | null;
  Description?: RichTextInfo;
}

export interface ContentModuleInfo {
  ModuleId: number;
  Title: string;
  SortOrder?: number;
  IsHidden?: boolean;
  IsLocked?: boolean;
  LastModifiedDate?: string | null;
  Description?: RichTextInfo;
  Modules?: ContentModuleInfo[];
  Topics?: ContentTopicInfo[];
}

export interface ContentTocResponse {
  Modules: ContentModuleInfo[];
}

export type AcademicEventKind =
  | "assignment"
  | "quiz"
  | "exam"
  | "project"
  | "lab"
  | "content"
  | "class"
  | "other";

export interface NormalizedAcademicEvent {
  id: string;
  calendarEventId: number;
  courseId: number;
  courseCode: string | null;
  courseName: string | null;
  title: string;
  kind: AcademicEventKind;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  recurring: boolean;
  eventType: number | null;
  associatedEntityType: string | null;
  associatedEntityId: number | null;
  url: string | null;
  fingerprint: string;
}

export interface EventStore {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    baseUrl: string;
    from: string;
    to: string;
  };
  events: NormalizedAcademicEvent[];
}

export interface EventDiff {
  added: NormalizedAcademicEvent[];
  updated: NormalizedAcademicEvent[];
  removed: NormalizedAcademicEvent[];
  unchanged: number;
}
