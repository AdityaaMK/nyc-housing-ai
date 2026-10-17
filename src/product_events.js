const { matchesPreferences } = require('./preferences');
const escape = value => String(value || '').slice(0, 220).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
function createProductEventBridge(services, now = Date.now) {
    const { store, repository, insights, tours, preferences } = services;
    return {
        async importInto(state) {
            await preferences.get();
            await tours.queueDueReminders();
            await services.applicationReminders?.queueDueReminders();
            const events = await store.list('events');
            for (const row of events.filter(row => row.data.status === 'pending').slice(0, 100)) {
                const event = row.data;
                state.enqueueEvents([{ ...event, id: row.id, created_at: typeof event.created_at === 'number' ? event.created_at : Date.parse(event.created_at) || now() }]);
                await store.put('events', row.id, { ...event, status: 'transferred', transferred_at: now() }, { expectedRevision: row.revision });
            }
            // Correcting a completion/stage can restore an unsent deadline. Reuse
            // its durable identity; never reopen a delivery with any send receipt
            // or an uncertain outcome, nor another kind of product notification.
            const cancelled = new Set(state.cancelledApplicationEvents?.() || []);
            if (cancelled.size && services.applicationReminders) {
                for (const row of events) {
                    if (row.data.kind === 'application_reminder' && cancelled.has('event:' + row.id) &&
                        await services.applicationReminders.isReminderCurrent(row.data.reference)) state.rearmApplicationEvent('event:' + row.id);
                }
            }
        },
        enrichListings: rows => services.enrichListings(rows),
        async tourInvitationCurrent(id) {
            const current = await tours.getSchedule(id);
            if (['confirmed', 'cancelled', 'completed'].includes(current.status)) return false;
            const original = (await repository.getTour(id)).rows[0];
            return !current.revision || Date.parse(original?.proposed_datetime) === Date.parse(current.startsAt);
        },
        async prepare(delivery) {
            if (delivery.kind === 'application_reminder') {
                return services.applicationReminders ? services.applicationReminders.prepare(delivery.reference) : { status: 'wait' };
            }
            if (delivery.kind === 'tour_reminder') {
                if (!await tours.isReminderCurrent(delivery.reference)) return { status: 'cancel' };
                const tour = await tours.getSchedule(delivery.reference.tourId);
                return { status: 'ready', payload: { parse_mode: 'HTML', text: `<b>Upcoming apartment tour</b>\n${escape(tour.address)}\n` +
                    `${escape(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(tour.startsAt)))} (New York)\n` +
                    `Allow ${tour.bufferBeforeMinutes} minutes before the showing.` } };
            }
            if (delivery.kind !== 'price_change') return { status: 'cancel' };
            const listing = (await repository.getListing(delivery.reference.listingId)).rows[0];
            if (!listing || listing.status === 'passed') return { status: 'cancel' };
            const [view, watch, prefs] = await Promise.all([insights.getInsights(listing.id), store.get('watchlist', listing.id), preferences.get()]);
            const source = view.sources.find(source => source.current_snapshot?.id === delivery.reference.snapshotId);
            const snapshot = source?.current_snapshot;
            const currentListing = { ...listing, price: snapshot?.advertised_rent ?? null,
                true_gross_rent: snapshot?.verified_gross_rent ?? null, effective_monthly_rent: snapshot?.effective_rent ?? null };
            if (!source || source.availability === 'unavailable' || view.availability === 'unavailable' || (!watch?.data.saved && !matchesPreferences(currentListing, prefs))) return { status: 'cancel' };
            const change = delivery.payload;
            return { status: 'ready', payload: { parse_mode: 'HTML', text: `<b>Apartment price update</b>\n${escape(listing.title)}\n` +
                `${escape(change.basis)} rent: ${money(change.previous)} → ${money(change.current)}\nDecrease: ${money(change.drop)}\n` +
                (change.basis === 'advertised' ? 'Advertised price; verify the gross rent and lease terms.' : 'Based on the observed lease terms.'),
                reply_markup: { inline_keyboard: [[{ text: 'View listing', url: source.url }]] } } };
        }
    };
}
module.exports = { createProductEventBridge };
