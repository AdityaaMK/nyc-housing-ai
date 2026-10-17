const { createHash, randomUUID } = require('node:crypto');
const { calculateRent } = require('./rent');
const DAY = 86400000;
const COLLECTIONS = { sources: 'listing_sources', snapshots: 'rent_snapshots', scans: 'source_scans', insights: 'listing_insights' };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const fail = (status, message) => Object.assign(new Error(message), { status });
const sourceKey = (listingId, source, url) => digest([listingId, source, url]);
function rentSnapshot(input) {
    const advertised = positive(input.advertised_rent);
    const basis = ['gross', 'net_effective', 'unknown'].includes(input.price_basis) ? input.price_basis : 'unknown';
    const gross = input.gross_verified === true ? positive(input.gross_rent) : null;
    let effective = null, terms = null, termsStatus = input.rent_terms ? 'unverified' : 'unknown';
    if (gross && input.terms_verified === true && input.rent_terms) {
        try {
            const result = calculateRent(gross, input.rent_terms);
            effective = result.effective_monthly_rent;
            terms = result.rent_terms;
            termsStatus = effective === null ? 'incomplete' : 'verified';
        } catch { termsStatus = 'unverified'; }
    }
    return { advertised_rent: advertised, advertised_basis: basis, verified_gross_rent: gross,
        effective_rent: effective, rent_terms: terms, terms_status: termsStatus };
}
function describeChange(previous, current) {
    if (!previous) return null; // Migration/first observation is a baseline, never an alert.
    for (const [basis, field, reason] of [['gross', 'verified_gross_rent', 'gross_rent_drop'],
        ['advertised', 'advertised_rent', 'advertised_rent_drop'], ['effective', 'effective_rent', 'improved_concession']]) {
        if (basis === 'advertised' && previous.advertised_basis !== current.advertised_basis) continue;
        if (basis === 'effective' && (previous.terms_status !== 'verified' || current.terms_status !== 'verified')) continue;
        if (positive(previous[field]) && positive(current[field]) && current[field] < previous[field]) {
            return { basis, reason, previous: previous[field], current: current[field], drop: Math.round((previous[field] - current[field]) * 100) / 100 };
        }
    }
    return null;
}
function summarizeAvailability(sources, nowMs, staleAfterMs = 3 * DAY) {
    const recentActive = sources.filter(s => s.availability === 'active' && Date.parse(s.observed_at) >= nowMs - staleAfterMs);
    const unavailable = sources.filter(s => s.availability === 'unavailable');
    const availability = recentActive.length ? 'active' : sources.length && unavailable.length === sources.length ? 'unavailable' : 'unverified';
    const sorted = sources.filter(s => s.availability !== 'unverified').map(s => s.observed_at).filter(Boolean).sort();
    return { availability, last_verified_at: sorted.at(-1) || null, needs_recheck: !recentActive.length && availability !== 'unavailable',
        conflicting_evidence: recentActive.length > 0 && unavailable.length > 0,
        explanation: recentActive.length && unavailable.length ? 'An active cross-post is still available; another source reports unavailable.' :
            availability === 'unverified' ? 'No recent reliable availability evidence. Missing search results do not establish removal.' :
            availability === 'unavailable' ? 'Every observed source explicitly reports this apartment unavailable.' : 'Recently observed on a source listing.' };
}
function classifyScan({ html = '', parsedCount = 0, status = 200, parseErrors = 0 }) {
    if ([401, 403, 429].includes(status) || /captcha|access denied|verify (?:that )?you are human|robot check|challenge-platform|awswaf/i.test(html)) return 'blocked';
    if (status >= 400) return 'failed';
    if (parseErrors) return parsedCount ? 'partial' : 'parser_failure';
    if (parsedCount > 0) return 'success';
    if (/no (?:matching )?(?:results|rentals|listings|homes|apartments)(?: found| available| match)?|0 (?:results|rentals|listings|homes)\b/i.test(html)) return 'empty';
    return 'parser_failure';
}
function safeDetailUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw fail(400, 'Invalid listing URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
        !['streeteasy.com', 'www.streeteasy.com', 'renthop.com', 'www.renthop.com', 'compass.com', 'www.compass.com'].includes(parsed.hostname) ||
        !/^\/(?:building|rental|sale|listing|listings|homedetails)\//.test(parsed.pathname)) throw fail(400, 'Detail checks require a supported listing URL');
    return parsed.href;
}
async function fetchDetail(url) {
    const { fetch } = require('undici');
    const dispatcher = require('./https_client').createDispatcher();
    try {
        const response = await fetch(safeDetailUrl(url), { dispatcher, redirect: 'error', signal: AbortSignal.timeout(12000), headers: { accept: 'text/html' } });
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > 1500000) throw fail(502, 'Detail page exceeds the size limit');
            chunks.push(Buffer.from(chunk));
        }
        return { html: Buffer.concat(chunks).toString('utf8'), status: response.status };
    } finally { await dispatcher.close(); }
}
function structuredRentTerms(apartment, offer) {
    const text = String(apartment?.description || offer?.description || '').replace(/<[^>]*>/g, ' ');
    const properties = Array.isArray(apartment?.additionalProperty) ? apartment.additionalProperty : [];
    const property = names => properties.find(item => names.includes(String(item.name || '').toLowerCase()))?.value;
    const amount = value => positive(Number(String(value ?? '').replace(/[^0-9.]/g, '')));
    const grossText = text.match(/gross (?:monthly )?rent(?: is| of|:)?\s*\$([\d,]+(?:\.\d+)?)/i) ||
        text.match(/\$([\d,]+(?:\.\d+)?)\s*(?:per month |monthly )?gross(?: rent)?/i);
    const gross = amount(property(['gross rent', 'gross monthly rent', 'monthly gross rent']) ?? grossText?.[1]);
    const leaseText = text.match(/(?:on (?:a |an )?)?(\d+)\s*[- ]month lease/i);
    const freeText = text.match(/(\d+(?:\.\d+)?|one|two|three)\s*months? free/i);
    const words = { one: 1, two: 2, three: 3 };
    const freeValue = property(['free months']) ?? (freeText ? words[freeText[1].toLowerCase()] ?? Number(freeText[1]) : null);
    const creditText = text.match(/\$([\d,]+(?:\.\d+)?)\s*(?:rent |rental )credit/i);
    const creditValue = property(['rent credit']) ?? creditText?.[1];
    const mentioned = /concession|months? free|rent(?:al)? credit/i.test(text) || freeValue !== null || creditValue !== undefined;
    const noConcessions = /no (?:rent(?:al)? )?concessions/i.test(text);
    const terms = mentioned || noConcessions ? {
        concessions_mentioned: !noConcessions,
        lease_months: amount(property(['lease months', 'lease length']) ?? leaseText?.[1]),
        free_months: noConcessions ? 0 : freeValue === null ? (creditValue !== undefined ? 0 : null) : Number(freeValue),
        rent_credit: noConcessions ? 0 : creditValue === undefined ? (freeValue !== null ? 0 : null) : Number(String(creditValue).replace(/[^0-9.]/g, ''))
    } : null;
    return { gross_rent: gross, gross_verified: gross !== null, ...(terms ? { rent_terms: terms, terms_verified: true } : {}) };
}
function parseDetail({ html = '', status = 200 }) {
    const blocked = classifyScan({ html, status, parsedCount: 1 });
    if (blocked === 'blocked' || status >= 400) return { outcome: blocked, availability: 'unverified', evidence: 'detail_fetch_unverified' };
    const plain = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const explicitUnavailable = /(?:this (?:listing|apartment|rental|property) (?:is |has been )?(?:no longer available|rented|off market)|listing (?:has been rented|is no longer available))/i.test(plain);
    const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    let apartment = null;
    const walk = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (['Apartment', 'SingleFamilyResidence', 'Residence', 'RealEstateListing'].includes(value['@type'])) apartment ||= value;
        if (value['@graph']) walk(value['@graph']);
        if (value.mainEntity) walk(value.mainEntity);
    };
    for (const script of scripts) { try { walk(JSON.parse(script[1])); } catch {} }
    const offer = Array.isArray(apartment?.offers) ? apartment.offers[0] : apartment?.offers;
    const outOfStock = /\/(?:OutOfStock|Discontinued|SoldOut)$/.test(String(offer?.availability || ''));
    if (explicitUnavailable || outOfStock) return { outcome: 'success', availability: 'unavailable', evidence: 'explicit_unavailable_detail' };
    if (!apartment) return { outcome: 'parser_failure', availability: 'unverified', evidence: 'detail_parser_unverified' };
    const raw = offer?.price ?? apartment.price ?? apartment.additionalProperty?.find?.(p => p.name === 'Monthly Rent')?.value;
    const advertised = positive(Number(String(raw ?? '').replace(/[^0-9.]/g, '')));
    return { outcome: 'success', availability: 'active', evidence: 'structured_listing_detail', advertised_rent: advertised,
        price_basis: /net[- ]effective/i.test(apartment.description || '') ? 'net_effective' : 'unknown', ...structuredRentTerms(apartment, offer) };
}
function createListingInsights({ store, repository, now = () => new Date(), fetchDetail: detailFetch = fetchDetail,
    staleAfterMs = 3 * DAY, isEligible, onTermsChanged } = {}) {
    const time = () => new Date(now()).toISOString();
    const nowMs = () => new Date(now()).getTime();
    const listings = async id => { const row = (await repository.getListing(id)).rows[0]; if (!row) throw fail(404, 'Listing not found'); return row; };
    const eligible = isEligible || (listing => {
        const preferences = require('./preferences');
        return preferences.matchesPreferences ? preferences.matchesPreferences(listing) : preferences.matchesLocation(listing);
    });
    const records = async (collection, id) => (await store.list(collection)).filter(row => row.data.listing_id === id);
    async function getInsights(id) {
        const listing = await listings(id);
        const sources = (await records(COLLECTIONS.sources, listing.id)).map(row => ({ id: row.id, ...row.data }));
        let crossPosts = [];
        try { crossPosts = JSON.parse(listing.cross_posted_sources || '[]'); } catch {}
        for (const candidate of [{ source: listing.source, url: listing.url }, ...(Array.isArray(crossPosts) ? crossPosts : [])]) {
            if (candidate && typeof candidate.url === 'string' && !sources.some(source => source.url === candidate.url)) sources.push({ source: candidate.source,
                url: candidate.url, observed_at: null, availability: 'unverified', evidence: 'not_yet_observed' });
        }
        const priceHistory = (await records(COLLECTIONS.snapshots, listing.id)).map(row => ({ id: row.id, ...row.data }))
            .sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.id.localeCompare(b.id));
        const meta = await store.get(COLLECTIONS.insights, listing.id);
        return { listing_id: listing.id, ...summarizeAvailability(sources, nowMs(), staleAfterMs), sources, price_history: priceHistory,
            assessment_outdated: meta?.data.assessment_outdated === true, assessment_changed_at: meta?.data.assessment_changed_at || null };
    }
    async function recoverSource(source, listing) {
        if (!source.current_snapshot) return;
        const current = source.current_snapshot;
        await store.create(COLLECTIONS.snapshots, current.id, current);
        if (!source.previous_snapshot) return;
        await store.create(COLLECTIONS.snapshots, source.previous_snapshot.id, source.previous_snapshot);
        if (!await store.get('listing_change_refresh', current.id)) {
            const old = await store.get(COLLECTIONS.insights, listing.id);
            if (!old || (old.data.assessment_changed_at || '') <= current.observed_at) {
                const meta = { ...old?.data, assessment_outdated: true, assessment_changed_at: current.observed_at, snapshot_id: current.id };
                try { await store.put(COLLECTIONS.insights, listing.id, meta, { expectedRevision: old?.revision || 0 }); }
                catch (error) { if (error.status !== 409) throw error; }
            }
            // Publish stale evidence before requesting a refresh: the scorer can
            // reconcile it if the request overlaps an in-flight evaluation.
            if (onTermsChanged) await onTermsChanged(listing.id, current);
            await store.create('listing_change_refresh', current.id, { listing_id: listing.id, snapshot_id: current.id, queued_at: time() });
        }
        if (!source.change || !source.change_eligible) return;
        const view = await getInsights(listing.id);
        const watched = await store.get('watchlist', listing.id);
        if (listing.status === 'passed' || view.availability === 'unavailable' || !(watched?.data.saved !== false && watched || await eligible({ ...listing, price: current.advertised_rent, true_gross_rent: current.verified_gross_rent, effective_monthly_rent: current.effective_rent }))) return;
        await store.enqueueEvent({ id: `price:${current.id}`, kind: 'price_change', reference: { listingId: listing.id, snapshotId: current.id },
            payload: { listing_id: listing.id, snapshot_id: current.id, previous_snapshot_id: source.previous_snapshot.id,
                title: listing.title, url: source.url, ...source.change }, created_at: current.observed_at });
    }
    async function observe(input, { returnInsights = true } = {}) {
        const listing = await listings(input.listingId || input.listing_id);
        if (!input.source || !input.url || !['active', 'unavailable', 'unverified'].includes(input.availability || 'active')) throw fail(400, 'Invalid source observation');
        const observedAt = input.observed_at || time();
        if (!Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) > nowMs() + 60000) throw fail(400, 'Invalid observation time');
        const key = sourceKey(listing.id, input.source, input.url);
        await store.create('listing_source_identities', digest([input.source, input.url]), { listing_id: listing.id });
        for (let attempt = 0; attempt < 5; attempt++) {
            const previous = await store.get(COLLECTIONS.sources, key), prior = previous?.data;
            if (prior && observedAt < prior.observed_at) return returnInsights ? getInsights(listing.id) : { listing_id: listing.id };
            if (prior) await recoverSource(prior, listing);
            let snapshot = rentSnapshot(input);
            const hasTerms = snapshot.advertised_rent !== null || snapshot.verified_gross_rent !== null;
            const priorSnapshot = prior?.current_snapshot || null;
            // A lightweight feed observation cannot erase better detail evidence at
            // the same asking price. A changed asking price requires fresh terms.
            if (priorSnapshot && snapshot.advertised_rent === priorSnapshot.advertised_rent && !input.gross_verified && !input.rent_terms) {
                snapshot = { ...snapshot, verified_gross_rent: priorSnapshot.verified_gross_rent, effective_rent: priorSnapshot.effective_rent,
                    rent_terms: priorSnapshot.rent_terms, terms_status: priorSnapshot.terms_status,
                    advertised_basis: input.price_basis && input.price_basis !== 'unknown' ? input.price_basis : priorSnapshot.advertised_basis };
            }
            const changed = hasTerms && (!priorSnapshot || digest(snapshot) !== priorSnapshot.terms_fingerprint);
            const current = changed ? { ...snapshot, listing_id: listing.id, source: input.source, url: input.url, observed_at: observedAt,
                terms_fingerprint: digest(snapshot), id: digest([key, priorSnapshot?.id || 'baseline', snapshot]) } : priorSnapshot;
            const watched = changed && priorSnapshot ? await store.get('watchlist', listing.id) : null;
            const changeEligible = changed ? Boolean(priorSnapshot && listing.status !== 'passed' && input.availability !== 'unavailable' &&
                (watched && watched.data.saved !== false || await eligible({ ...listing, price: snapshot.advertised_rent ?? listing.price, true_gross_rent: snapshot.verified_gross_rent, effective_monthly_rent: snapshot.effective_rent }))) : prior?.change_eligible === true;
            const source = { change_eligible: changeEligible, listing_id: listing.id, source: input.source, url: input.url, observed_at: observedAt,
                availability: input.availability || 'active', evidence: input.evidence || 'observed_in_feed', scan_id: input.scan_id || null,
                current_snapshot: current, previous_snapshot: changed ? priorSnapshot : prior?.previous_snapshot || null,
                change: changed ? describeChange(priorSnapshot, current) : prior?.change || null };
            // A blocked or unparseable recheck does not erase the last verified source evidence.
            if (source.availability === 'unverified' && prior) {
                source.availability = prior.availability; source.observed_at = prior.observed_at; source.evidence = prior.evidence;
                source.last_attempt_at = observedAt; source.last_attempt_outcome = input.evidence || 'unverified';
            } else if (source.availability === 'unverified') {
                source.observed_at = null; source.last_attempt_at = observedAt; source.last_attempt_outcome = input.evidence || 'unverified';
            }
            try { await store.put(COLLECTIONS.sources, key, source, { expectedRevision: previous?.revision || 0 }); }
            catch (error) { if (error.status === 409) continue; throw error; }
            // A cross-post never silently replaces the primary source's advertised price.
            if (snapshot.advertised_rent !== null && listing.price !== snapshot.advertised_rent && listing.url === input.url && typeof repository.updateListingObservation === 'function') {
                await repository.updateListingObservation(listing.id, { price: snapshot.advertised_rent });
                if (snapshot.advertised_rent) listing.price = snapshot.advertised_rent;
            }
            await recoverSource(source, listing);
            return returnInsights ? getInsights(listing.id) : { listing_id: listing.id };
        }
        throw fail(409, 'Concurrent observations; retry on the next scan');
    }
    async function recordScan(input) {
        const outcome = input.outcome || classifyScan(input);
        if (!['success', 'empty', 'partial', 'blocked', 'parser_failure', 'failed'].includes(outcome)) throw fail(400, 'Invalid scan outcome');
        const id = input.id || randomUUID();
        const data = { source: input.source, feed_url: input.feed_url, started_at: input.started_at || time(), completed_at: time(),
            outcome, parsed_count: Math.max(0, Number(input.parsedCount) || 0), observation_count: Math.max(0, Number(input.observationCount) || 0),
            coverage: 'search_feed_only', failure_category: ['blocked', 'parser_failure', 'failed'].includes(outcome) ? outcome : null };
        return store.create(COLLECTIONS.scans, id, data);
    }
    async function recheck(id, { background = false } = {}) {
        const listing = await listings(id);
        const prior = await store.get('listing_rechecks', listing.id);
        const cooldown = background ? 6 * 3600000 : 60000;
        if (prior && nowMs() - Date.parse(prior.data.attempted_at) < cooldown) throw fail(429, 'This listing was checked recently');
        await store.put('listing_rechecks', listing.id, { attempted_at: time(), outcome: 'checking' }, { expectedRevision: prior?.revision || 0 });
        const sources = (await records(COLLECTIONS.sources, listing.id)).map(row => row.data);
        let legacy = [];
        try { legacy = JSON.parse(listing.cross_posted_sources || '[]'); } catch {}
        const candidates = [{ source: listing.source, url: listing.url }, ...sources, ...(Array.isArray(legacy) ? legacy : [])]
            .filter(candidate => {
                if (!candidate || typeof candidate !== 'object') return false;
                try { safeDetailUrl(candidate.url); return true; } catch { return false; }
            }).map(candidate => ({ ...candidate, source: candidate.source || new URL(candidate.url).hostname.replace(/^www\./, '').split('.')[0] }));
        let attempts = 0;
        for (const candidate of candidates.filter((value, i, all) => all.findIndex(other => other.url === value.url) === i).slice(0, 3)) {
            try {
                safeDetailUrl(candidate.url);
                const parsed = parseDetail(await detailFetch(candidate.url)); attempts++;
                await observe({ listingId: listing.id, ...candidate, ...parsed, observed_at: time() }, { returnInsights: false });
                await recordScan({ source: candidate.source, feed_url: candidate.url, outcome: parsed.outcome, parsedCount: parsed.availability === 'active' ? 1 : 0 });
            } catch (error) {
                if (error.status === 400) continue;
                await recordScan({ source: candidate.source, feed_url: candidate.url, outcome: 'failed' });
            }
        }
        const current = await store.get('listing_rechecks', listing.id);
        await store.put('listing_rechecks', listing.id, { attempted_at: current.data.attempted_at, outcome: attempts ? 'complete' : 'unverified' }, { expectedRevision: current.revision });
        return getInsights(listing.id);
    }
    async function recheckTracked({ limit = 3 } = {}) {
        const watched = new Set((await store.list('watchlist')).filter(row => row.data.saved !== false).map(row => row.data.listing_id || row.id));
        const candidates = (await repository.listListings()).rows.filter(row => row.status !== 'passed' && (watched.has(row.id) || ['applied', 'contacted'].includes(row.status)));
        let checked = 0;
        for (const row of candidates) {
            if (checked >= Math.min(3, Math.max(0, limit))) break;
            try { await recheck(row.id, { background: true }); checked++; }
            catch (error) { if (![409, 429].includes(error.status)) throw error; }
        }
        return { checked };
    }
    async function getFreshness(id) {
        const { sources, price_history, ...summary } = await getInsights(id);
        return summary;
    }
    async function resolveSource(source, url) {
        return (await store.get('listing_source_identities', digest([source, url])))?.data.listing_id || null;
    }
    return { getInsights, getFreshness, observe, recordScan, recheck, recheckTracked, resolveSource };
}
let instance;
function defaultListingInsights() {
    const repository = require('./repository').repository;
    instance ||= createListingInsights({ store: require('./feature_store').createFeatureStore(), repository,
        onTermsChanged: async id => { if (repository.requeueEvaluation) await repository.requeueEvaluation(id); } });
    return instance;
}
// Shared ingestion path records repeated observations even if a listing no longer
// matches today's feed criteria. Never change the user's pipeline status here.
async function ingestObservedListing({ listing, matchesFeed = true, scanId = null, insights = defaultListingInsights(), repository = require('./repository').repository }) {
    let existing = (await repository.listingExists(listing.id)).rows[0];
    if (!existing) {
        const canonical = await insights.resolveSource?.(listing.source, listing.url);
        if (canonical) existing = (await repository.listingExists(canonical)).rows[0];
    }
    existing ||= await repository.recordDuplicate({ normalizedAddress: listing.normalized_address, newUrl: listing.url, newSource: listing.source });
    if (!existing && !matchesFeed) return { inserted: false, observed: false };
    let inserted = false;
    if (!existing) inserted = (await repository.insertListing(listing)).rowCount > 0;
    await insights.observe({ listingId: existing?.id || listing.id, source: listing.source, url: listing.url, advertised_rent: listing.price,
        availability: 'active', evidence: 'observed_in_feed', scan_id: scanId }, { returnInsights: false });
    return { inserted, observed: true };
}
module.exports = { createListingInsights, defaultListingInsights, ingestObservedListing, summarizeAvailability, rentSnapshot, describeChange,
    classifyScan, parseDetail, safeDetailUrl, structuredRentTerms, COLLECTIONS };
