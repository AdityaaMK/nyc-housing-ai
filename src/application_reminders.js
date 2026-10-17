const { createHash } = require('node:crypto');

const MINUTE = 60000;
const OVERDUE_WINDOW = 24 * 60 * MINUTE;
const ACTIVE_STAGES = new Set(['preparing', 'submitted', 'approved']);
const escape = value => String(value || '').slice(0, 220).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function isDeadlineActive(application, deadline) {
    return Boolean(application && deadline && ACTIVE_STAGES.has(application.stage) && !deadline.completed &&
        (deadline.type !== 'application' || application.stage === 'preparing'));
}

function dueReminder(application, deadline, at) {
    if (!isDeadlineActive(application, deadline)) return null;
    const dueAt = Date.parse(deadline.dueAt);
    const intervals = (deadline.reminderMinutes || []).filter(value => Number.isInteger(value) && value > 0 && value <= 10080);
    if (!Number.isFinite(dueAt) || !intervals.length) return null;
    if (at >= dueAt) {
        // Resume with one useful overdue notice, never a backlog of elapsed intervals.
        return at < dueAt + OVERDUE_WINDOW ? { phase: 'overdue', minutesBefore: 0 } : null;
    }
    const elapsed = intervals.filter(value => at >= dueAt - value * MINUTE);
    return elapsed.length ? { phase: 'upcoming', minutesBefore: Math.min(...elapsed) } : null;
}

function createApplicationReminders({ store, applications, repository, now = Date.now } = {}) {
    if (!store || !applications || !repository) throw new Error('Application reminders require store, applications and repository');

    async function current(reference) {
        if (!reference || typeof reference.listingId !== 'string' || typeof reference.deadlineId !== 'string' ||
            typeof reference.dueAt !== 'string' || !['upcoming', 'overdue'].includes(reference.phase) || !Number.isInteger(reference.minutesBefore)) return null;
        let view;
        try { view = await applications.get(reference.listingId); }
        catch (error) { if (error.status === 404) return null; throw error; }
        const listing = (await repository.getListing(reference.listingId)).rows[0];
        if (!listing || listing.status === 'passed') return null;
        const deadline = view.application.deadlines.find(item => item.id === reference.deadlineId);
        const due = deadline && dueReminder(view.application, deadline, now());
        if (!due || deadline.dueAt !== reference.dueAt || due.phase !== reference.phase || due.minutesBefore !== reference.minutesBefore) return null;
        return { listing, application: view.application, deadline, ...due };
    }

    async function queueDueReminders() {
        const { applications: views } = await applications.list();
        let queued = 0;
        for (const view of views) {
            const listing = (await repository.getListing(view.listingId)).rows[0];
            if (!listing || listing.status === 'passed') continue;
            for (const deadline of view.application.deadlines) {
                const due = dueReminder(view.application, deadline, now());
                if (!due) continue;
                const reference = { listingId: view.listingId, deadlineId: deadline.id, dueAt: deadline.dueAt, ...due };
                // Record revisions include notes/checklists. Identity depends only on
                // the deadline schedule so unrelated edits never repeat a reminder.
                const id = 'application-reminder:' + createHash('sha256').update(JSON.stringify([
                    reference.listingId, reference.deadlineId, reference.dueAt, reference.phase, reference.minutesBefore
                ])).digest('hex');
                await store.enqueueEvent({ id, kind: 'application_reminder', reference, payload: {}, created_at: now() });
                queued++;
            }
        }
        return { queued };
    }

    async function prepare(reference) {
        const value = await current(reference);
        if (!value) return { status: 'cancel' };
        const { listing, deadline, phase } = value;
        const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(deadline.dueAt));
        const followUp = deadline.type === 'follow_up' ? '\nReview the conversation before contacting the broker.' : '';
        return { status: 'ready', payload: { parse_mode: 'HTML', text:
            `<b>${phase === 'overdue' ? 'Application deadline overdue' : 'Upcoming application deadline'}</b>\n` +
            `${escape(listing.title || listing.address || 'Apartment')}\n${escape(deadline.label)}\n` +
            `Due ${escape(when)} (New York)${followUp}\nOpen your application tracker to update this deadline.` } };
    }

    return { queueDueReminders, isReminderCurrent: async reference => Boolean(await current(reference)), prepare };
}

module.exports = { createApplicationReminders, isDeadlineActive, dueReminder, OVERDUE_WINDOW };
