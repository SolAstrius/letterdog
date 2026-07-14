# Stalwart conformance quirks & deviations

A single working record of every place live Stalwart diverges from the JMAP / RFC 8984 / RFC 9661
specs, discovered by probing `mail.astrius.ink` (**v0.16.11** unless noted). Each item cost a live
probe to find. **We do not pursue upstream fixes** — the MCP works around these at the tool layer
instead; this file is the authoritative list of what to work around and why.

Legend: **[MCP-fixed]** = the connector papers over it; **[schema/normalize]** = handled in the
Zod/projection layer; **[caller-beware]** = no workaround, callers must know. Per-topic detail lives
in `docs/rfc-notes/*.md`; this is the index + the session findings.

A recurring root cause underlies most of these: **Stalwart silently ignores unknown `/set`
arguments and swallows a whole class of internal errors instead of surfacing them.** So a request
that is subtly wrong (or hits an unimplemented path) frequently returns success with the operation
partially or wholly not performed, and no error. Assume nothing worked until you re-`get` and check.

---

## Calendar & scheduling (JMAP Calendars / RFC 8984 JSCalendar)

1. **No `uid` assigned on JMAP create.** RFC 8984 makes `uid` mandatory/server-assigned; Stalwart
   leaves it null (`assert_is_unique_uid` only *checks*, never *mints*). A UID-less event makes iTIP
   scheduling silently no-op — `itip_snapshot` returns `MissingUid`, which is **not** in
   `ItipError::is_jmap_error()`, so the create path swallows it: event saved, `send_invitations`
   sends nothing, no error. **[MCP-fixed]** `create_events` mints `crypto.randomUUID()` on every
   event (`applyEventCreateDefaults`, commit 781f627). Probed 2026-07-14.

2. **No `organizer` derived from the owner participant on JMAP create.** An event with participants
   but no `organizerCalendarAddress`/`replyTo` is stored with no `ORGANIZER` property, so
   `itip_snapshot` returns `NoSchedulingInfo` (also swallowed) → no invite. Note `isOrigin` can read
   `true` while `organizerCalendarAddress` is still null. **[MCP-fixed]** `create_events` injects the
   account's default `ParticipantIdentity` calendarAddress as `organizerCalendarAddress` when an
   event has participants and no organizer (781f627). Probed 2026-07-14.

3. **Participants in the RFC-8984 `sendTo`/`replyTo` MAP form are silently dropped on create.** Only
   the JSCalendar-bis STRING form persists: participant `calendarAddress` + event
   `organizerCalendarAddress`. Matches upstream discussion #2700 ("Unable to use iMIP with JMAP"),
   which the maintainer left unresolved. **[schema/normalize]** emit the `calendarAddress` form.
   Probed 2026-07-14. Together, items 1–3 are why calendar invitations to external addresses
   appeared completely broken; all three must be right for an iMIP to fire.

4. **`calendarIds` is required on create** ("Event has to belong to at least one calendar") with no
   server default. Not a spec violation, but a UX cliff. **[MCP-fixed]** `create_events` defaults to
   the account's default calendar when omitted (`defaultCalendarId`). Probed 2026-07-14.

5. **bis property renames — plural RFC 8984 names REJECTED.** `recurrenceRules` →
   `recurrenceRule`, `excludedRecurrenceRules` → `excludedRecurrenceRule` (singular). The plural
   spec names get `invalidProperties` on create and are never returned by `/get`. **[schema]** use
   the singular bis names. Probed 2026-07-09.

6. **Synthetic instance ids for non-recurring events too** (`eaaa<base>` observed). A
   `CalendarEvent/set` targeting a synthetic id is rejected "not yet supported" (discussion #2923,
   unmerged) — occurrence-scoped edits must patch the base event's `recurrenceOverrides`.
   **[caller-beware / MCP routes to overrides]** Probed 2026-07-09.

7. **`Link.blobId` silently dropped on create/update** — despite the #2431 fix claiming an error is
   returned (regression on the calendar Links path). **[caller-beware]** Probed 2026-07-09.

8. **`updateScope` / `destroyScope` are fiction** — not in any draft nor Stalwart. Because unknown
   `/set` args are silently ignored, passing them yields **whole-series** modification when the
   caller expected single-occurrence. **[caller-beware]** Never rely on them; scope via synthetic
   ids / `recurrenceOverrides`.

9. **`organizerCalendarAddress` requested but not returned** — the hybrid serves `replyTo.imip` (map)
   on read instead; `roles` includes the non-registry key `"required"`. **[schema union]** accept
   both organizer shapes and unknown role keys. Probed 2026-07-08.

10. **`expandRecurrences: true` requires BOTH `after` and `before`** filter bounds (else
    `invalidArguments`). **[schema/validate]** enforce in the query builder. Probed 2026-07-08.

11. **Invalid `timeZone` strings degrade silently to floating time**; query filter text is lowercased
    server-side. **[caller-beware]** Probed 2026-07-08.

12. **`#creationId` refs in `calendarIds` silently ignored** if not permitted / not found (no error).
    **[caller-beware]** Probed 2026-07-08.

13. **Only `sendSchedulingMessages` is parsed** as a scheduling control on `CalendarEvent/set` (no
    other iTIP knobs). Default false. Probed 2026-07-08.

---

## Mail & blobs (RFC 8620 / 8621)

14. **`#creationId` back-reference to an in-request `Blob/upload` is NOT resolved inside
    `bodyStructure.blobId`.** An `Email/set` create referencing a same-request-uploaded blob as
    `blobId:"#att0"` is rejected `invalidProperties` / "Cannot set property" / `["bodyStructure/blobId"]`;
    the chained `EmailSubmission/set` then fails on `["#emailId"]` (a cascade, not a second bug).
    Swapping in the concrete blobId the same upload returned works. So all attachments must be
    uploaded to a real blobId **before** the `Email/set`. **[MCP-fixed]** `planMessageAttachments`
    always HTTP-uploads to a concrete blobId first (commit 1a9fc45). Probed 2026-07-14. See item 18
    — same root cause on the Sieve surface.

---

## Sieve (RFC 9661)

15. **Error-type dialect.** Validate/create errors are `invalidScript` (spec: `invalidSieve`) and
    the destroy guard is `scriptIsActive` (spec: `sieveIsActive`). **[MCP]** match BOTH spellings.
    Validate positions are 0-based/unhelpful (`line 0, column 0` for a first-line error). Probed
    2026-07-09.

16. **Silent (de)activation.** `onSuccessActivateScript`/`onSuccessDeactivateScript` work, but the
    response omits the spec-MUST `updated` report of the flipped `isActive` and the state string does
    not change. **[MCP]** re-`get` after the /set to read truth; don't trust state bumps. Probed
    2026-07-09.

17. **`validate` does not check `require`** against supported extensions — `require ["frobnicate"]`
    validates clean. Grammar-only; a clean validate does **not** mean "will run". **[caller-beware]**
    Probed 2026-07-09.

18. **`Blob/upload` is not a back-reference source** — `#ids`/`#blobId` pointing at a same-request
    `Blob/upload` fail (`invalidResultReference` / silent null → `blobNotFound`). Upload in one
    request, then `/set` or `/validate` in the next. **[MCP]** `sieve.put` uses the HTTP upload
    endpoint (separate request). Same family as item 14. Probed 2026-07-09.

19. **`SieveScript/changes` → `unknownMethod`** (conformant), but `SieveScript/query` advertises
    `canCalculateChanges: true` — misleading; assume no changes/queryChanges support. Probed
    2026-07-09.

20. **`maxNumberRedirects: 1`** for account `b` — unusually low; batch redirects will hit it.

---

## General / session metadata

21. **The session `implementation` string is a lie** — reports `"Stalwart v1.0.0"` regardless of the
    actual running version (which was v0.16.11). Never gate behavior on it; probe capabilities and
    re-verify on upgrades. Probed 2026-07-09.

22. **Unknown `/set` args are silently ignored, and a class of internal errors is swallowed**
    (`MissingUid`, `NoSchedulingInfo`, `NothingToSend`, `NotOrganizer`, `OtherSchedulingAgent` are
    all excluded from `ItipError::is_jmap_error()`). This is the meta-quirk behind items 1, 2, 8, and
    the general "success-with-nothing-done" failure mode. Treat every mutation as unverified until a
    follow-up `/get` confirms it.

---

## How to verify mail/calendar send behavior live

Stalwart ships rich OTel telemetry to ClickHouse. To confirm an iMIP/email actually went out:

```sh
CH_PASS=$(kubectl -n clickhouse get secret clickhouse-credentials -o jsonpath='{.data.password}' | base64 -d)
curl -s -u "admin:$CH_PASS" https://ch.sol.moe/ --data-binary "
  SELECT Timestamp, Body, LogAttributes['to'] AS rcpt, LogAttributes['code'] AS code
  FROM mail.otel_logs
  WHERE Body IN ('Calendar iTIP message sent','Message delivered','Queued message submission for delivery')
  ORDER BY Timestamp DESC LIMIT 20 FORMAT PrettyCompactMonoBlock"
```

Ingress method/path (JMAP vs CalDAV, which surface handled a request) is in `traefik.otel_traces`
(`SpanAttributes['http.request.method']`, `['url.path']`, `['server.address']`).
