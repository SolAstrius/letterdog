export const CAPABILITIES = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  calendars: "urn:ietf:params:jmap:calendars",
  calendarsParse: "urn:ietf:params:jmap:calendars:parse",
  contacts: "urn:ietf:params:jmap:contacts",
  contactsParse: "urn:ietf:params:jmap:contacts:parse",
  principals: "urn:ietf:params:jmap:principals",
  principalsAvailability: "urn:ietf:params:jmap:principals:availability",
  blob: "urn:ietf:params:jmap:blob",
  fileNode: "urn:ietf:params:jmap:filenode",
  stalwart: "urn:stalwart:jmap",
} as const;

export const READ_ONLY_METHOD_RE =
  /\/(get|query|changes|queryChanges|parse|lookup)$|^Core\/echo$|^Principal\/getAvailability$/;
