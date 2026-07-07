---
name: stalwart-mail
description: "Manage Stalwart/JMAP mail through the Stalwart MCP tools. Use when the user wants to inspect current mail, search messages, summarize threads, triage inbox or junk/marketing mail, read attachments, draft replies, forward mail, create/send drafts, archive, delete, or apply mailbox labels/keywords through Stalwart rather than Gmail."
---

# Stalwart Mail

## Core Flow

Use the Stalwart MCP mail tools when they are available. If the expected tools are missing, report
that the Stalwart MCP server is not registered or not connected before trying another mailbox
surface.

Start with `get_mail_profile`, `list_mailboxes`, or `stalwart_session_info` when the account,
capabilities, identities, mailbox roles, or backend URL matter. Use explicit `account_id` only when
the user gives one or the session exposes multiple plausible accounts; otherwise let the tools
resolve the account from the caller's JMAP session.

Prefer bounded reads. For broad mailbox analysis, search first, inspect snippets/metadata, then read
only the bodies or threads that can change the answer.

## Search And Reading

Prefer `search_emails` for most mailbox tasks because it combines `Email/query` and `Email/get`. Use
`search_email_ids` when the next operation needs explicit ids, such as labels, archive, delete, or
batch reads.

Good Stalwart search inputs include:

- Gmail-like query text for supported operators: `from:`, `to:`, `cc:`, `bcc:`, `subject:`, `body:`,
  `text:`, `has:attachment`, `is:read`, `is:unread`, `is:starred`, `is:draft`, `is:important`,
  `is:answered`, `is:forwarded`, `in:`, `label:`, `after:`, `before:`, `larger:`, `smaller:`, plus
  free text.
- Structured JMAP `filter` when the query is easier to express directly.
- `sort`, `limit`, `position`, and `collapse_threads` for paging and result shape.

Treat `unsupported` search terms in tool results as meaningful. Do not silently claim support for
Gmail-only features such as categories, filename search, or Gmail smart labels. If unsupported terms
matter, explain the limitation and refine with supported sender, subject, text, mailbox, date, size,
attachment, or keyword filters.

Use small result pages for exploratory reads, usually 10-25 messages. For broad ID-only operations,
larger pages are acceptable when the user has clearly asked for a bulk action.

Use `read_email` for one message, `batch_read_emails` for a shortlist, `read_email_thread` when
conversation context changes the answer, and `batch_read_email_threads` for several known thread
ids. Use `include_body: true` only when snippets and headers are insufficient. Use
`include_raw: true` only when MIME source, exact headers, or HTML/layout verification matter.

## Attachments And Raw MIME

Read the email first before reading an attachment. Use `read_attachment` with `email_id` plus
`blob_id` or `part_id`; the tool verifies that the blob belongs to the requested message. Set
`max_bytes` deliberately and choose `as: "base64"` for binary, `as: "text"` for text-like files, or
`as: "bytes"` when the caller expects base64 bytes but cares about the byte-count semantics.

For whole-message source, use `read_email` with `include_raw: true`; Stalwart exposes raw MIME via
the Email `blobId`, not as a Gmail-style raw field.

## Triage And Mailbox Analysis

For inbox triage, default to the Inbox-role mailbox and a clear timeframe unless the user asks for a
broader audit. Use `list_mailboxes` to resolve roles such as Inbox, Junk, Trash, Drafts, Sent, and
Archive instead of hardcoding mailbox ids.

Group results into practical buckets when useful:

- `Urgent`: direct asks with time pressure, blocking messages, decision requests with deadlines, or
  operational mail that can break if ignored.
- `Needs reply soon`: direct asks without same-day urgency or active conversations where the user is
  probably the next responder.
- `Waiting`: threads where the user already replied or the blocker belongs to someone else.
- `FYI`: announcements, newsletters, calendar churn, marketing, transactional mail, and low-action
  notifications.

For junk, marketing, newsletter, or cleanup requests, sample actual messages before labeling or
deleting. Stalwart mailboxes and keywords are explicit state; do not infer that a broad search is
safe to mutate without inspecting enough examples.

State search scope and confidence, especially when scanning a sample rather than the whole mailbox.
Avoid absolute claims like "the only urgent message" unless the search coverage supports that.

## Drafting Replies

Read the latest message and enough thread context before drafting. Preserve concrete facts from the
thread: recipients, names, dates, commitments, links, quoted asks, and subject intent.

If the user asks to reply but does not explicitly ask to send, default to a draft-oriented answer or
`create_draft_email`. If they clearly ask to send now, use `send_email` or `send_draft_email` with
the normal confirmation flow.

Use `get_mail_profile` when identities matter. If the sender identity is ambiguous, identify the
available identities and pick the safest obvious one only when the user's intent is clear.

For reply-all decisions, do not default to everyone just because multiple recipients are present.
Reply only to the sender when the answer is mainly for them. Reply to the wider recipient set when
the answer affects shared context, answers a group question, or avoids hiding a decision from people
who were clearly included on purpose. Call out ambiguity before sending.

## Forwarding

Use `forward_emails` for forwarding explicit message ids. Read the message or recent thread context
first so any note is accurate.

Choose the forwarding mode deliberately:

- `quote` when the recipient needs a readable inline forward.
- `attachOriginal` when preserving the original MIME source is more important.

If the user did not explain why they are forwarding, either forward without a note when the message
is self-explanatory or ask for the intended framing. For long threads, a short note with current
status, requested action, and deadline is usually more useful than forwarding without context.

Be careful when forwarding outside the user's domain or to a new audience. Avoid leaking internal
context unless the user clearly wants that recipient to see it.

## Labels, Keywords, Archive, And Delete

Stalwart's default user-visible label model is JMAP Mailboxes. Keywords are flags and lightweight
tags. Use mailbox labels for Gmail-like labels unless the user specifically asks for keyword/tag
semantics.

Use:

- `create_mail_label` to create a mailbox-backed label.
- `apply_mail_labels` to add mailbox labels or keyword tags to explicit ids.
- `batch_modify_emails` for explicit mailbox/keyword add/remove patches, read/unread/starred-like
  keyword changes, trashing, or permanent deletion.
- `bulk_label_matching_emails` only after the query is tight enough. It defaults to dry-run; keep it
  that way until the user confirms the match set.
- `archive_emails` to remove Inbox and optionally add Archive. Archiving must not destroy mail.
- `delete_emails` for Trash by default. Permanent deletion requires `permanent: true` and explicit
  user intent.

Search or inspect before bulk mutation. Prefer exact ids for destructive actions. Do not turn a
broad search into archive/delete/label changes unless the user explicitly asked for that broad
operation and the query has been checked.

## Mutation Confirmation

Draft create/update, mail-label creation, explicit-id archive, and explicit-id label application
execute directly. Sending mail, forwarding, trash/permanent delete, mailbox removals, and
query-powered bulk mutations may return a preview with `confirmationRequired`, `confirmFingerprint`,
and `expiresAt` instead of executing. Present the summary and relevant target ids. When the user
confirms, call the same tool again with the same arguments plus `confirmFingerprint` and
`confirmExpiresAt` set to the returned `expiresAt`.

Do not invent, inspect, persist, or ask for any confirmation secret. Treat the confirmation as bound
to the exact payload, account, actor, operation, and expiry.

Use `if_in_state` when a prior read gives a usable state token and concurrent mailbox changes would
matter.

## Pasted Links And External Identifiers

Stalwart tools operate on JMAP `email_id`, `thread_id`, `blob_id`, mailbox ids, and structured
search. Do not pass Gmail web URLs, webmail routes, or arbitrary browser links into Stalwart tools.
If the user provides an unsupported link, ask for fetchable identifiers such as sender, subject,
approximate date, RFC 822 `Message-ID`, or pasted email text.

## Raw JMAP Escape Hatch

Use `jmap_call` for diagnostics or temporary gaps only. It is read-only by default. Mutating raw
calls require `allow_mutation` and the same confirmation flow as typed tools. Prefer typed mail
tools for normal user-facing work because they handle account resolution, mailbox roles, attachment
verification, and safer mutation previews.

## Response Style

Lead mailbox summaries with the latest status, then decisions, open questions, and action items. For
triage, include sender, subject, why the item is in its bucket, and the likely next action.

For proposed writes, include the target message/thread ids when useful, the mailbox or keyword
changes, whether the action is draft/send/archive/trash/permanent delete, and whether confirmation
is still pending.

Keep drafts concise and ready to paste or send. If a draft depends on missing facts, provide the
best draft plus a short list of unresolved details.
