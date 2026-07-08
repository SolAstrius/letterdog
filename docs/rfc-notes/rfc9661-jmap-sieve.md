# RFC 9661 JMAP for Sieve Scripts — Reference + Live-Stalwart Findings

Source: RFC 9661 (September 2024, Standards Track, Murchison, Fastmail). Digest for op/schema
design, verified against the full spec text and live-probed against Stalwart (see last section).
JMAP mapping of ManageSieve (RFC 5804): /get ≈ LISTSCRIPTS+GETSCRIPT, /set ≈
PUTSCRIPT/DELETESCRIPT/RENAMESCRIPT/SETACTIVE, /validate ≈ CHECKSCRIPT.

## 1. Capability — `urn:ietf:params:jmap:sieve`

**Session-level** capabilities object: `implementation: String` (name + version of the Sieve
engine) — that's the only session-level key.

**Account-level** (`accountCapabilities`):

| Property | Type | Semantics |
|---|---|---|
| `maxSizeScriptName` | UnsignedInt | Octet limit for script names; MUST be ≥512 (ManageSieve compat: 128 Unicode chars) |
| `maxSizeScript` | UnsignedInt\|null | Max script size in octets; null = unlimited |
| `maxNumberScripts` | UnsignedInt\|null | Max stored scripts; null = unlimited |
| `maxNumberRedirects` | UnsignedInt\|null | Max `redirect` actions **per evaluation** (not per script text); null = unlimited |
| `sieveExtensions` | String[] | Case-sensitive capability strings as used in `require` |
| `notificationMethods` | String[]\|null | URI scheme parts for `enotify`; null = enotify unsupported |
| `externalLists` | String[]\|null | URI scheme parts for `extlists`; null = extlists unsupported |

## 2. SieveScript object

| Property | Type | Notes |
|---|---|---|
| `id` | Id, immutable, server-set | |
| `name` | String\|null (default server-dependent) | Net-Unicode, ≥1 char, unique per account. Servers MUST reject U+0000–001F, U+007F–009F, U+2028, U+2029; MAY reject policy violations (e.g. `/`) |
| `blobId` | Id | Blob holding the raw script octets |
| `isActive` | Boolean, **server-set**, default false | At most ONE active script per account; only changeable via the /set activation args, never by patching `isActive` |

**Script content**: UTF-8, ≥1 char, valid RFC 5228 syntax. MUST NOT `require` capability strings
absent from `sieveExtensions` — except unrecognized extensions are allowed inside `ihave` tests
when `ihave` is supported. Content moves as a blob: RFC 8620 upload/download endpoints or RFC 9404
`Blob/upload`/`Blob/get` (`data:asText`). Download ≈ ManageSieve GETSCRIPT.

## 3. Methods

Only four are defined: `/get`, `/set`, `/query`, `/validate`. **No `/changes`, no `/queryChanges`**
— RFC 8620 standard methods exist per-type only when a spec defines them (the IANA "Can Use for
State Change: Yes" registration is about StateChange push, not a /changes method).

- **SieveScript/get** — standard; `ids: null` = all scripts (≈ LISTSCRIPTS). Chain
  `Blob/get` with `#ids: {path: "/list/*/blobId"}` to fetch bodies in one request.
- **SieveScript/set** — standard, plus two request-level args:
  - `onSuccessActivateScript: Id` — activate iff every create/update/destroy succeeded; accepts a
    `#creationId` reference; currently-active script is auto-deactivated first. Invalid/nonexistent
    id ⇒ silently ignored (MUST NOT error). Activated id MUST be reported in `created`/`updated`
    with `isActive: true`; the deactivated one in `updated` with `isActive: false`.
  - `onSuccessDeactivateScript: Boolean` — deactivate the active script iff all changes succeeded.
    When both args present, deactivate is processed FIRST.
  - The active script MUST NOT be destroyed — deactivation must happen in a **separate**
    SieveScript/set call first (a same-call `onSuccessDeactivateScript` + `destroy` does not work:
    onSuccess* args run *after* the changes).
  - SetErrors: `alreadyExists` (duplicate name — MUST carry `existingId: Id`), `tooLarge`
    (> maxSizeScript), `overQuota` (script count/storage), `invalidSieve` (grammar or unsupported
    require; description SHOULD give at least the first error's line number) on create/update,
    `sieveIsActive` on destroy.
- **SieveScript/query** — standard; FilterCondition: `name` (substring), `isActive` (exact).
  Sortable on `name` and `isActive` (both MUST).
- **SieveScript/validate** — args `accountId` + `blobId`; response `error: SetError|null`
  (`invalidSieve` or null). ≈ CHECKSCRIPT. Content must be uploaded first.

## 4. VacationResponse interplay (§4)

Servers implementing RFC 8621 VacationResponse as a Sieve script stored among user scripts MUST:
let it be fetched via SieveScript/get; let it be (de)activated via `onSuccessActivateScript`;
REJECT destroy or content-update with a `forbidden` SetError (edit only via VacationResponse/set).

## 5. LLM/op-facing notes

- **The activation dance is the whole API**: `isActive` is server-set — there is no
  `update: {id: {isActive: true}}`. Activate/deactivate ONLY via the two onSuccess* request args.
  Deactivate-then-destroy requires two /set calls by spec.
- **Upload → reference in two steps**: script bodies are blobs; there is no inline `content`
  property on SieveScript. (On Stalwart the upload must even be a separate *request* — see below.)
- **Name is the only user key** and unique per account; `alreadyExists.existingId` makes
  create-or-replace idempotency easy (catch, then update the existing id).
- **Quota triple**: name-size / script-size / script-count each has its own limit and SetError.
- The `implementation` string is the only session-level datum — everything actionable is
  account-level.

## 6. Live-Stalwart observations (probed 2026-07-09 against mail.astrius.ink, v0.16.11)

Capability values served for account `b`: `maxSizeScriptName 512`, `maxSizeScript 102400`,
`maxNumberScripts 100`, `maxNumberRedirects 1` (!), 46 `sieveExtensions` (incl. `regex`,
`editheader`, `duplicate`, `include`, `foreverypart`/`mime`, `spamtest`, `virustest`, `vacation`,
`vacation-seconds`, `mailboxid`, `special-use`, `imapsieve`, and the RFC 5228 example-comparator
joke `comparator-elbonia`), `notificationMethods ["mailto"]`. Session-level `implementation` says
`"Stalwart v1.0.0"` regardless of actual server version — don't trust it.

Verified working end-to-end: create (inactive) → rename → query (name substring + isActive
filters, both fine) → activate via `onSuccessActivateScript` → destroy-guard → deactivate via
`onSuccessDeactivateScript` → destroy. `alreadyExists` carries `existingId` per spec. Blob
round-trip is byte-identical; the server **re-blobs the script on create** (the stored `blobId`
differs from the uploaded one).

Deviations & quirks (each cost a probe to find — trust this list):

1. **Error-type dialect**: validate/create errors come back as `invalidScript` (spec:
   `invalidSieve`) and destroy-guard as `scriptIsActive` (spec: `sieveIsActive`). Match BOTH
   spellings in error handling. Validate's description gives `line 0, column 0` for a first-line
   error (0-based/unhelpful positions).
2. **Silent activation**: `onSuccessActivateScript`/`onSuccessDeactivateScript` DO work, but the
   response omits the spec-MUST `updated` report of the flipped `isActive`, and the state string
   does not change — after (de)activation, re-`get` to see truth; don't rely on state bumps to
   detect it.
3. **`Blob/upload` is not a back-reference source**: `#ids`/`#blobId` pointing at a same-request
   `Blob/upload` result fail (`invalidResultReference` from Blob/get; validate silently resolves
   to null → `blobNotFound`). Upload in one request, then /set or /validate in the next.
   (Back-refs from /get and /query results work fine, e.g. SieveScript/get → Blob/get.)
4. **`validate` does not check `require` against supported extensions**: `require ["frobnicate"]`
   validates clean (error: null); only grammar errors are caught. Whether /set create enforces it
   is untested. Don't treat a clean validate as "will run".
5. `SieveScript/changes` → `unknownMethod` (conformant — the RFC defines none), but
   `SieveScript/query` returns `canCalculateChanges: true` — misleading; assume no changes/
   queryChanges support.
6. Empty-account state string is `"n"`.

Untested (probe scope): `#creationId` form of `onSuccessActivateScript`; VacationResponse-as-
script visibility (§4 — no vacation script existed); `tooLarge`/`overQuota` errors; ManageSieve
co-access.

## 7. Letterdog op-surface mapping (as of 841830c)

Existing CLI-only ops (registered under `ENABLE_ADMIN_TOOLS`): `sieve.list`, `sieve.get`,
`sieve.put` (uploads via the HTTP upload endpoint — separate request, so quirk #3 doesn't bite),
`sieve.activate` (id or null ⇒ deactivate; note it passes `onSuccessActivateScript: null` for
deactivation, but the spec says an omitted/invalid id MUST be *ignored* — the correct deactivation
arg is `onSuccessDeactivateScript: true`. Suspected no-op; not live-verified).
**Gaps**: no `sieve.delete` (destroy requires the deactivate-first dance) and no `sieve.validate`
op — both currently require raw `jmap_call`.
