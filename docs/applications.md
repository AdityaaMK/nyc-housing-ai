# Application tracking

Open **Applications** in the owner workspace, or **Application** in an apartment's details. Select an apartment and save its checklist to begin. Reading an unsaved application provides a draft without writing to the database. There is one application record per canonical apartment, shared across browsers and listing ID aliases.

## Stages and document readiness

Stages are `preparing`, `submitted`, `approved`, `rejected`, `lease_signed`, and `withdrawn`. Set a stage when that action or outcome has actually happened. The app records the change and time; it does not submit forms, send messages, transfer money, sign a lease, or change the listing's existing pipeline state. A historical `applied` listing is not automatically treated as a submitted application.

The default document checklist contains suggestions rather than verified broker requirements. Mark an item required only after confirming the requirement. Each item has a label, required flag, status (`missing`, `ready`, `submitted`, or `not_needed`), and a note. Add or remove items to match the apartment. Store readiness metadata only; secure document uploads are deferred.

All reads and edits require owner access. The public listing API does not expose application documents, offer terms, notes, or history. Edits use optimistic revisions; a 409 conflict keeps the newer database record intact. Reload the current record before applying a revised draft. Application changes and their audit entry commit in one operation, and a save with no changes creates no extra history. Stage timestamps record the latest entry into each stage; the activity history retains earlier transitions and changed fields.

Linked broker replies and decision reasons are available as related activity. They retain their original source records and do not become editable application events. Application notes and stages remain independent of the AI score, advertised rent, and post-tour review.

## Deadlines and reminders

Add application, deposit, follow-up, lease, or other deadlines with an exact New York time. The API accepts an explicit New York UTC offset or a UTC instant. The editor rejects nonexistent daylight-saving times and requires a specific offset for repeated times.

Choose up to four reminder intervals between one minute and seven days. An empty interval list disables reminders, including overdue notices. The existing Telegram worker queues and delivers reminders; there is no additional worker to activate.

- Only preparing, submitted, and approved applications can receive reminders.
- Application submission deadlines stop reminding after the stage leaves preparing.
- Completed deadlines, passed listings, and rejected, withdrawn, or signed applications stop reminding.
- When several intervals elapsed while offline, only the closest useful interval is queued. A missed deadline can produce one overdue notice within 24 hours; older deadlines remain visible in the tracker without generating a catch-up burst.
- Changing a deadline invalidates messages for its old time. Notes and checklist edits retain the reminder identity and do not resend it.
- Correcting a completion or closed stage can restore a cancelled reminder if it is still due and has no delivery receipt. Delivered, uncertain, and failed alerts are not automatically replayed.
- Eligibility is checked again immediately before delivery. Confirmed delivery receipts survive restarts; uncertain outcomes remain held for review through the existing Telegram journal.

Follow-up reminders ask you to review the conversation; they never send a broker message automatically. Telegram remains subject to its existing activation and single-poller requirements.

## Offer comparison

Compare up to four apartments using owner-entered offer terms: monthly rent, lease months, free months, rent credit, monthly fees, one-time fees, refundable deposit, upfront rent months/credit, and lease start/end dates. Each offer includes a source and notes. Marking terms confirmed requires a source; this records your verification, not an independent legal assessment.

The existing housing cost calculator computes monthly outlay, effective rent plus recurring fees, nonrefundable lease expense, and upfront cash. One-time fees are included in lease expense and applicable upfront cash; they are not spread into the recurring monthly figure. Blank amounts stay unknown; enter zero explicitly when a charge or concession does not apply. Refundable deposits increase upfront cash without increasing nonrefundable lease expense. Concessions apply once, and upfront rent remains part of total lease rent rather than an additional rent charge.

Upfront cash assumes the first monthly fee payment, all entered one-time fees and deposits, and the specified upfront rent are due before moving. Lease months are entered separately from dates; confirm partial-month billing with the broker. These assumptions are shown with comparisons. Editing an offer does not overwrite advertised prices, source evidence, or the separate housing-cost assumptions.

## API and persistence

| Method and route | Behavior |
| --- | --- |
| `GET /api/applications` | Saved application records only |
| `GET /api/listings/:id/application` | Saved record or an unsaved draft with revision zero |
| `PUT /api/listings/:id/application` | Save `{revision, application}` with the complete editable object |
| `GET /api/applications/compare?ids=a,b` | Comparison of one to four distinct canonical apartments |

The editable object contains `stage`, `documents`, `deadlines`, `offer`, and `notes`. Unknown fields and malformed amounts, dates, IDs, or flags are rejected. Responses include the current revision, listing summary, calculations, timestamps, activity, and related activity. The `applications` collection in `feature_records` stores the record and its audit trail. No additional SQL migration is required after `003_product_features.sql`. The history size limit rejects a new edit with an explicit error instead of silently discarding earlier history.

## Rollout

The API requires the shared feature migration before starting. On a PostgreSQL admin connection with permitted network access:

```sh
node scripts/backup-scoring.js
npm run db:migrate:features -- /private/path/to/verified-backup
```

Alternatively, take and verify a private backup through your existing database administration tools, then apply `migrations/003_product_features.sql` transactionally in the Supabase SQL editor. A Supabase service REST key does not provide a general SQL migration endpoint. A successful base schema check alone does not establish that the feature schema is installed.

Configure a private `HOUSING_OWNER_TOKEN` of 24–512 characters and run `npm run cloud:check:products`. The checker performs only version RPCs and bounded table reads, prints sanitized results, and exits nonzero if anything is missing. It imports no migration, Gmail, or worker modules.

In the current workspace, an owner token has been prepared in the ignored private file `.state/owner/owner.env` (mode 0600). It has not been printed or committed. After installing the migration, use it with Node 24:

```sh
node --env-file=.state/owner/owner.env scripts/check-product-rollout.js
npm run build --prefix web
node --env-file=.state/owner/owner.env src/server.js
```

Read that private file in your own terminal to unlock the dashboard. Other deployments should use their own secret configuration. Start only the API for this rollout; the combined ecosystem file also contains the live daemon. Telegram activation remains deferred. Cloud suspension can still stop the API; this does not change the hosting choice.

## Verification

`npm test` includes real SQLite service and API coverage for application persistence, owner isolation, concurrent edits, offers, and deadline delivery/recovery. All external message, submission, and payment operations are blocked in fixtures.

```sh
npm run build --prefix web
npm run lint --prefix web
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node scripts/test-applications-dashboard.js
```

The application browser checks use fixture data and cover owner access, checklist/stage edits, deadlines, offer comparison, conflict handling, history, and mobile presentation. Existing selection/tour browser suites remain separate regressions.
