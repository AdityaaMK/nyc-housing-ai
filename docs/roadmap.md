# Development Roadmap

The next application workflow is also implemented: document readiness, application stages, deadline reminders, owner-entered offer comparison, and activity linked to broker replies and decisions. See [application tracking](applications.md). Secure document storage remains deferred.

The original phases below record the earlier feature roadmap. All [ten feature implementations](#next-ten-feature-implementations) are now implemented in the API, workers, and dashboard. See [setup, behavior, and verification](product-features.md). Deployment and Telegram activation are separate from implementation.

### Phase 1: Ingestion & Multi-Source Listing Monitor
- [x] Multi-source stealth scrapers (StreetEasy & RentHop)
- [x] Local SQLite and Supabase PostgreSQL dual database support
- [x] Address normalization and cross-platform deduplication engine
- [x] Configurable search feeds (2B2B $1,800-$5,000, 1B/Studio $1,800-$2,700, Manhattan)

### Phase 2: AI Evaluator & Scoring Engine
- [x] Gemini Flash Lite prompt pipeline for listing assessment
- [x] Net-effective vs true gross rent calculator
- [x] Transit & door-to-door commute calculator specifically to Datadog (620 8th Ave)
- [x] Automated pros & red flags extraction (railroad layouts, walk-ups, hidden broker fees)
- [x] NYC Open Data integration (HPD Violations `wvxf-dwi5` & 311 Complaints `erm2-nwe9`)
- [x] Building Health scoring (+5 Grade A, -5 Grade B, -20 Grade C)

### Phase 3: Mobile Bot & Real-Time Alerts
- [x] Telegram Bot with instant push alerts for high-scoring listings (score >= 75)
- [x] Interactive inline action buttons (View Listing, Send Intro Packet, Pass)
- [x] Instant Tenant Resume generator (Adityaa Magesh Kumar, 800+ credit, 40x income, clean paperwork)
- [x] HTML entity sanitization and rich metadata cards

### Phase 4: Outreach Automation & Inbound Tour Coordinator
- [x] Direct broker email dispatch via Gmail SMTP (`adityaa.magesh@gmail.com`)
- [x] Public broker contact discovery and automatic BCC audit trail
- [x] Inbound reply listener via Gmail IMAP with automated spam/newsletter filtering
- [x] Gemini AI tour proposal extractor (date, time, access notes, broker details)
- [x] 1-Click Google Calendar URL generator
- [x] 1-Tap tour confirmation back to broker via Telegram

### Phase 5: Compass & Web Dashboard Upgrades
- [x] Compass direct listing feed with AWS WAF stealth bypass (`src/compass.js`)
- [x] Web dashboard upgrade (`web/src/App.jsx`) with Kanban, Tours & Calendar, and Commute Map Guide
- [x] Web API expansion (`src/server.js`) with `/api/tours` and `/api/stats`
- [x] PM2 dual-process supervision (`housing-daemon` + `housing-api`)

### Phase 6: Nudge Engine & Smart Outreach
- [x] Automated 24-hour broker follow-up ("Nudge Engine") with Telegram 1-tap dispatch (`src/nudge_engine.js`)
- [ ] Weekend Open House walking route optimizer
- [ ] Official NYC Rent-Stabilization Detector (DHCR database lookups)
- [ ] SMS fallback notification option via Twilio

## Next ten feature implementations

Plan date: October 16, 2026. Implementation completed October 17, 2026. The original acceptance criteria below remain the reference; this is not a deployment schedule.

The baseline includes multi-source ingestion and deduplication, durable scoring, rent-concession arithmetic, building-health checks, on-demand Google commute estimates, listing/tour dashboards, Telegram delivery recovery, and the persistent inbox worker. The ten implementations preserve and extend those workflows. Telegram activation remains outside this plan.

The next work should make existing listings trustworthy, help choose apartments, and carry those choices through tours. Use the existing workers and queues throughout. Dashboard additions show results and accept user choices; recurring work stays in the workers.

| Order | Feature | First release delivers | Depends on |
| --- | --- | --- | --- |
| 1 | Listing freshness and availability | Last verified timestamps and evidence-backed availability | Existing scrapers |
| 2 | Price and concession change alerts | A price timeline and deduplicated change alerts | 1 |
| 3 | Worker and source health view | Last successful work, delays, failures, and source coverage | Existing workers; scan results from 1 |
| 4 | Editable search preferences | Saved budgets, apartment requirements, locations, and commute limits | Existing preferences and scoring |
| 5 | Watchlist and apartment comparison | Persistent shortlist and comparison of up to four listings | 1; extends with 4 and 6 |
| 6 | Total housing cost and move-in budget | Monthly cost, lease cost, and upfront cash breakdowns | Existing rent calculator; 5 for comparison |
| 7 | Broker conversation timeline | Listing-specific conversation history and reply matching | Existing mail transports and inbox worker |
| 8 | Tour scheduling and reminders | Rescheduling, conflict checks, cancellation, and reminders | 7; existing tour records |
| 9 | Tour-day route planner | A feasible walking/transit itinerary between showings | 8; bounded route lookups |
| 10 | Post-tour reviews and decision tracking | Structured viewing notes and a ranked final shortlist | 5 and 8; consumes 6 when available |

1. **Listing freshness and availability**

   **Outcome:** Know whether an apartment was recently observed, needs checking, or has explicit evidence that it is no longer available.

   **Implementation:** Add source-specific listing observations and scrape-run records, with `observed_at`, source URL, parsed price, and scan outcome. Update existing listings during ingestion instead of only inserting unseen IDs. Keep availability (`active`, `unverified`, `unavailable`) separate from the user's inbox/applied/passed state. Treat absence from a partial search feed as a reason to recheck, not proof of removal. Add bounded detail rechecks for watched or contacted listings, and show the latest evidence on each card.

   **Code areas:** All three scrapers, `repository.js`, database migrations, and listing cards. Preserve cross-posted source identities and their individual freshness.

   **Acceptance:** Repeated observations update freshness without duplicating apartments or changing application status. A blocked, incomplete, or empty parser result cannot mark listings unavailable. An explicit unavailable page updates that source; another recently active cross-post keeps the apartment visible with the conflicting evidence explained. Old records begin as unverified rather than receiving invented verification dates.

2. **Price and concession history with change alerts**

   **Outcome:** See actual changes to asking rent and lease terms, and hear about useful drops on apartments that still matter.

   **Implementation:** Store immutable rent snapshots from feature 1 and bounded detail refreshes. Compare advertised rent, verified gross rent, and calculated effective rent separately. Reuse `rent.js` for concession arithmetic. Add a listing timeline showing previous/current terms and observation dates. Queue price-drop or improved-concession alerts through the existing Telegram delivery path, keyed to the listing and snapshot change. Start with saved-search matches and later include watchlisted apartments from feature 5. Flag evaluations affected by changed terms as outdated and queue a bounded refresh through the existing scorer.

   **Acceptance:** $3,000 to $2,850 produces one $150 drop event even after repeated scans or worker restarts. A change from gross pricing to advertised net pricing is not reported as a verified gross-rent drop. Incomplete concessions stay unverified. Passed or unavailable listings do not alert; current eligibility is checked again at dispatch. No burst of historical change alerts occurs on migration.

3. **Worker and source health view**

   **Outcome:** See whether each stage is producing results and which sources need attention.

   **Implementation:** Add a common worker-status/run-history model for scraper, scorer, inbox, and Telegram. Record heartbeat, last successful operation, sanitized failure category, and relevant backlog/retry counts. Use feature 1's scan outcomes to distinguish a valid zero-result scan from a blocked page or parser failure. Expose a read-only health API and compact dashboard panel. Bridge local inbox/Telegram journal health into this common view without exposing message bodies, credentials, or private state files.

   **Acceptance:** Killing a worker eventually shows it as stale even if its last recorded state was running. A recently alive worker with repeated failed cycles shows degraded status. A failed source is distinguishable from a healthy source returning no matches. The panel does not start workers or run scoring jobs. If the entire cloud host is suspended, health becomes visible again when the API resumes; external uptime monitoring is a separate deployment task.

4. **Editable search preferences**

   **Outcome:** Change the search from the dashboard without editing source files.

   **Implementation:** Define one versioned settings schema for rent ranges by apartment type, bedrooms/bathrooms, preferred neighborhoods/regions, and the existing Manhattan-arrival and office-commute rules. Seed it from current JSON and hard-coded budget defaults. Add validated owner-only read/update endpoints and a settings screen with a preview of how saved listings would be filtered. Make feed generation, deterministic eligibility, and scorer inputs read the same active revision. Show when a score was produced under older preferences; use the scorer's existing queue and rate limits for any required re-evaluation.

   **Acceptance:** A saved budget affects both feed construction and alert eligibility on their next cycle. Invalid ranges and unsupported regions are rejected without partially changing settings. Office commute and Manhattan-arrival limits remain distinct. A revision does not reset application state or delivery receipts, and it does not automatically replay every historical alert. First release supports one active search configuration.

5. **Watchlist and side-by-side apartment comparison**

   **Outcome:** Keep promising apartments together and compare their tradeoffs directly.

   **Implementation:** Store a watchlist independently of pipeline status. Add Save/Unsave actions to listing cards and Telegram buttons, a watchlist view, and a comparison table for up to four apartments. Compare gross/effective rent, rooms, health evidence, freshness, commute source/date, and scoring pros/flags. Incorporate feature 6's cost breakdown later. Fetch saved selections from the database so they survive browser/device changes.

   **Acceptance:** Saving does not send an inquiry or mark a listing applied. A watchlisted apartment remains accessible after a preference change and explains why it is now outside the search. Missing values are displayed as unknown rather than zero; AI commute estimates remain distinguishable from Google estimates. Unavailable apartments retain their history and are clearly labeled.

6. **Total housing cost and move-in budget calculator**

   **Outcome:** Compare what an apartment costs over the lease and how much cash is needed to move in.

   **Implementation:** Extend the existing rent calculation with editable, sourced line items for utilities, recurring amenity/pet charges, known one-time fees, refundable deposits, and moving costs. Separate confirmed terms from user assumptions. Calculate recurring monthly outlay, nonrefundable lease cost, and cash due before moving. Show ranges or incomplete totals where amounts are unknown; retain the existing gross versus effective rent distinction. Add the breakdown to listing detail and comparison views.

   **Acceptance:** Refundable deposits increase upfront cash without being counted as a nonrefundable lease expense. Free-rent concessions are applied once. First-month rent is not counted twice in total lease cost. Annual fees and partial lease periods use explicit assumptions. Unconfirmed fees never appear as verified obligations or legally required charges.

7. **Broker conversation timeline and precise reply matching**

   **Outcome:** Know which listing each reply concerns and follow up only on the unanswered conversation.

   **Implementation:** Persist outgoing inquiry records with listing ID, provider message/thread IDs, recipient, timestamp, and send outcome. Expose Gmail thread IDs and standard email reply headers in the mailbox adapters. Link inbound messages by thread/reply references first, then offer manual assignment for ambiguous replies. Add a compact listing conversation timeline with delivery state, reply summaries, and linked tour proposals. Upgrade inbox follow-up suppression from its current sender-wide rule to conversation-specific matching where the evidence supports it. Existing actions continue to require the user's click.

   **Acceptance:** When one broker handles two apartments, a reply conclusively tied to apartment A suppresses A's follow-up without incorrectly suppressing B's. Ambiguous mail remains visibly unassigned and uses conservative follow-up handling. Restarting does not duplicate message records. An uncertain outbound send is displayed for review rather than blindly replayed. Reusing a parsed invitation still links to the same tour.

8. **Tour scheduling, conflict detection, and reminders**

   **Outcome:** Manage proposed and confirmed showings in one schedule and avoid incompatible bookings.

   **Implementation:** Extend tour records with listing/conversation links, duration, schedule revision, and proposed/confirmed/cancelled/completed states. Add owner actions to correct a time, reschedule, or cancel; display the proposed broker message before any send. Detect overlapping tours using user-configurable preparation/travel buffers. Add configurable reminder events to the durable notification queue. Continue supporting calendar links and offer an `.ics` download; direct calendar-account synchronization can follow separately.

   **Acceptance:** Ambiguous email times require a chosen time before scheduling. All displays and reminder calculations handle America/New_York daylight-saving transitions. Rescheduling invalidates reminders for the old revision, cancelling suppresses them, and restarting does not repeat a delivered reminder. Conflict checks cover both overlapping appointments and insufficient buffers. Updating the app schedule does not silently email a broker.

9. **Tour-day walking and transit itinerary planner**

   **Outcome:** Turn several showings into an achievable route with clear departure times and gaps.

   **Implementation:** Start with two to six scheduled tours, their addresses/time windows, a user-selected starting point, and walking/transit preferences. Build an ordered schedule locally and request route estimates only after the user asks to plan the day. Add a bounded, cached route service for travel between apartments; the existing office-commute endpoint is not sufficient for arbitrary destinations. Account for showing duration, walking/transfers, arrival buffers, and fixed appointments. Show each leg, route link, leave-by time, and incompatible stops. Recompute when a tour changes.

   **Acceptance:** The planner never labels a route feasible when travel plus buffers exceeds the next appointment window. An unknown route or uncertain appointment time stays unresolved rather than becoming a zero-minute leg. Requests have explicit caps and timeouts; repeated viewing does not trigger paid lookups. The output explains excluded stops and is described as a feasible suggested order, not a guaranteed mathematical optimum.

10. **Post-tour reviews and decision tracking**

    **Outcome:** Capture what was actually observed and use it to choose among the final apartments.

    **Implementation:** Add a mobile-friendly viewing checklist and notes for noise, daylight, condition, storage, layout, and building access, linked to the listing and completed tour. Store user ratings separately from AI scores. Show a decision view with shortlisted apartments, observed strengths/issues, current costs, and explicit next actions such as request information, apply, or pass. Record decision reasons and an activity history. Keep the first release text-based; photo/document storage can be designed separately.

    **Acceptance:** Notes survive restarts and appear on the corresponding comparison entry. User ratings do not overwrite the AI assessment or source facts. Editing a review does not send an email or change listing availability. Passing an apartment records the reason while preserving its tour and conversation history. Missing checklist answers do not silently count as bad ratings.

### Delivery sequence and shared implementation rules

- **Milestone A — trustworthy data:** Deliver features 1–3. Listing changes have evidence and collection failures are visible.
- **Milestone B — better selection:** Deliver features 4–6. Search settings, shortlist comparison, and costs work together.
- **Milestone C — outreach and tours:** Deliver features 7–10. Conversations link accurately to apartments, schedules account for conflicts, and viewing notes support decisions.
- Ship one feature per reviewable change after the inbox-worker changes are packaged. Each feature includes its schema/repository changes, worker/API behavior, relevant UI, tests, and operating notes.
- Keep SQLite, PostgreSQL, and Supabase implementations aligned. Use additive, versioned migrations; preserve existing scores, outreach state, notification receipts, and historical records. New settings and notes need server-side validation and owner access checks.
- Reuse durable event identities and the Telegram delivery journal for every new notification type. Broker messages remain explicit user actions. New API-backed calculations must have bounded attempts, timeouts, and visible data provenance.
- Verify backend behavior with fixtures and temporary databases, including restart/retry cases where applicable. For dashboard changes, run the build/lint and targeted browser checks. External credentials and service availability are rollout dependencies, not substitutes for tests.
- The earlier SMS and rent-stabilization ideas remain deferred. Stabilization research needs a verified, accessible evidence source and careful separation of building-level indicators from a unit's legal status before implementation can be specified reliably.

**Implementation status:** all ten features are implemented, including additive shared storage, owner access, optimistic edits, dashboard views, and fixture-based service/API/browser/recovery coverage. Search preferences remain publicly readable for the existing listing filter; editing and preview require owner access. Private selection, conversation, review, and schedule data require owner access. Tour routing preserves fixed appointments and reports unresolved legs rather than promising a mathematically optimal route. Live deployment requires the documented schema/configuration steps.
