const { createHash, randomUUID } = require('node:crypto');

const COLLECTION = 'conversation_messages';
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const text = (value, limit = 1500) => String(value || '').slice(0, limit);
const address = value => text(value, 254).trim().toLowerCase();
const refs = value => (Array.isArray(value) ? value : String(value || '').match(/<[^>]+>|\S+/g) || []).map(value => String(value).trim().toLowerCase()).filter(Boolean);
const problem = (status, message) => Object.assign(new Error(message), { status });
const flatten = row => ({ id: row.id, ...row.data, revision: row.revision });

function createConversationService({ store, repository, now = Date.now }) {
    const all = async () => (await store.list(COLLECTION)).map(row => {
        const message = flatten(row);
        // A process can die between provider acceptance and saving the receipt.
        // An old in-flight claim is reviewable uncertainty, never a resend job.
        if (message.outcome === 'sending' && now() - Date.parse(message.at) > 120000) message.outcome = 'uncertain';
        return message;
    });
    const listing = async id => {
        const row = (await repository.getListing(id)).rows[0];
        if (!row) throw problem(404, 'Listing not found');
        return row;
    };
    async function match(message, inquiries) {
        const messages = await all();
        const references = new Set([...refs(message.inReplyTo), ...refs(message.references)]);
        const linked = messages.filter(row => row.listingId);
        const threadMatches = message.threadId ? linked.filter(row => row.threadId === message.threadId) : [];
        const referenceMatches = linked.filter(row => refs(row.rfcMessageId).some(id => references.has(id)));
        const strong = [...new Set([...threadMatches, ...referenceMatches].map(row => row.listingId))];
        if (strong.length === 1) return { listingId: strong[0], match: threadMatches.length ? 'thread' : 'references', candidateListingIds: strong };
        if (strong.length > 1) return { listingId: null, match: 'ambiguous', candidateListingIds: strong };
        const sender = address(message.fromAddress || message.sender || message.from?.match(/<([^>]+)>/)?.[1] || message.from);
        const candidates = [...new Set([
            ...inquiries.filter(row => address(row.broker_email) === sender).map(row => row.id),
            ...messages.filter(row => row.direction === 'outbound' && row.listingId && address(row.recipient) === sender).map(row => row.listingId)
        ])];
        return { listingId: candidates.length === 1 ? candidates[0] : null,
            match: candidates.length === 1 ? 'sender' : candidates.length ? 'ambiguous' : 'unassigned', candidateListingIds: candidates };
    }
    async function recordInbound(identity, message, inquiries = []) {
        const id = 'in_' + digest(identity);
        const existing = await store.get(COLLECTION, id);
        if (existing) return flatten(existing);
        const matched = await match(message, inquiries);
        const received = Date.parse(message.receivedAt);
        return flatten(await store.create(COLLECTION, id, { direction: 'inbound', ...matched,
            providerMessageId: text(message.id, 300) || null, threadId: text(message.threadId, 300) || null,
            rfcMessageId: text(message.rfcMessageId || message.messageId, 998) || null,
            inReplyTo: refs(message.inReplyTo).slice(-20), references: refs(message.references).slice(-50),
            sender: address(message.fromAddress || message.sender || message.from?.match(/<([^>]+)>/)?.[1] || message.from),
            recipient: null, subject: text(message.subject, 300),
            summary: text(String(message.body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()),
            at: Number.isFinite(received) && received <= now() + 300000 ? new Date(received).toISOString() : new Date(now()).toISOString(),
            outcome: 'received', tourId: null }));
    }
    async function sendOutgoing({ listingId = null, recipient, subject, body, purpose = 'inquiry', operationId, sender, tourId = null }, send) {
        if (listingId) listingId = (await listing(listingId)).id;
        const recipientAddress = address(recipient);
        if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipientAddress)) throw problem(400, 'A single broker email address is required');
        const key = operationId || `${purpose}:${listingId || digest(recipientAddress + '\n' + subject + '\n' + body)}`;
        const id = 'out_' + digest(key), attemptId = randomUUID();
        const rfcMessageId = `<${digest(key)}@housing-ai.local>`;
        const row = await store.create(COLLECTION, id, { direction: 'outbound', listingId, recipient: recipientAddress,
            sender: address(sender), subject: text(subject, 300), summary: text(body), at: new Date(now()).toISOString(),
            purpose: text(purpose, 80), outcome: 'sending', attemptId, rfcMessageId, providerMessageId: null, threadId: null,
            match: listingId ? 'explicit' : 'unassigned', candidateListingIds: listingId ? [listingId] : [], tourId });
        if (row.data.attemptId !== attemptId) {
            if (row.data.outcome === 'sent') return { ...row.data.receipt, alreadySent: true, conversationId: row.id };
            throw problem(409, row.data.outcome === 'failed'
                ? 'Previous email attempt failed. Review the conversation before sending a new request.'
                : 'Email delivery is uncertain. Check Sent mail before sending again.');
        }
        let receipt;
        try { receipt = await send({ messageId: rfcMessageId }); }
        catch (error) {
            // Only an explicit rejection proves that the provider did not accept
            // the email. Timeouts, connection loss and crashes remain uncertain.
            const status = Number(error?.status), smtp = Number(error?.responseCode);
            const outcome = (status >= 400 && status < 500) || (smtp >= 400 && smtp < 600) ? 'failed' : 'uncertain';
            await store.put(COLLECTION, id, { ...row.data, outcome, error: outcome === 'failed' ? 'provider_rejected' : 'delivery_unknown' }, { expectedRevision: row.revision });
            throw problem(outcome === 'failed' ? 502 : 409, outcome === 'failed' ? 'Email provider rejected the message.' : 'Email delivery is uncertain. Check Sent mail before sending again.');
        }
        const safeReceipt = { messageId: text(receipt?.messageId, 998) || rfcMessageId,
            providerMessageId: text(receipt?.providerMessageId || receipt?.id, 300) || null,
            threadId: text(receipt?.threadId, 300) || null, rfcMessageId };
        // Persist acceptance before a caller updates listing/tour state. If this
        // write fails, the retained sending record prevents an unsafe replay.
        await store.put(COLLECTION, id, { ...row.data, outcome: 'sent', ...safeReceipt, receipt: safeReceipt }, { expectedRevision: row.revision });
        return { ...safeReceipt, conversationId: id };
    }
    async function linkTour(messageId, tourId) {
        let row = await store.get(COLLECTION, messageId);
        if (!row) throw problem(404, 'Conversation message not found');
        if (row.data.tourId !== tourId) row = await store.put(COLLECTION, messageId, { ...row.data, tourId }, { expectedRevision: row.revision });
        const link = await store.get('tour_links', tourId);
        const value = { conversationId: messageId, listingId: row.data.listingId };
        if (!link) await store.create('tour_links', tourId, value);
        else if (link.data.conversationId !== messageId || link.data.listingId !== value.listingId)
            await store.put('tour_links', tourId, value, { expectedRevision: link.revision });
        return flatten(row);
    }
    async function assign(messageId, { listingId, expectedRevision }) {
        if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw problem(400, 'Expected revision is required');
        if (listingId !== null && (typeof listingId !== 'string' || !listingId)) throw problem(400, 'Choose a listing or null');
        if (listingId) listingId = (await listing(listingId)).id;
        const row = await store.get(COLLECTION, messageId);
        if (!row) throw problem(404, 'Conversation message not found');
        if (row.data.direction !== 'inbound') throw problem(400, 'Only incoming messages can be reassigned');
        const updated = await store.put(COLLECTION, messageId, { ...row.data, listingId, match: listingId ? 'manual' : 'unassigned',
            assignedAt: new Date(now()).toISOString(), candidateListingIds: listingId ? [listingId] : row.data.candidateListingIds }, { expectedRevision });
        if (updated.data.tourId) await linkTour(messageId, updated.data.tourId);
        return flatten(updated);
    }
    async function followUpStatus(listingId, sender, appliedAt) {
        const messages = await all();
        return messages.some(row => row.direction === 'inbound' && Date.parse(row.at) >= Number(appliedAt) &&
            (row.listingId === listingId || (!row.listingId && row.sender === address(sender)))) ? 'cancel' : 'ready';
    }
    return { recordInbound, sendOutgoing, linkTour, assign, followUpStatus, matchMessage: match,
        async timeline(id) {
            const current = await listing(id), messages = await all();
            return { listingId: current.id, messages: messages.filter(row => row.listingId === current.id).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
                unassignedCount: messages.filter(row => row.direction === 'inbound' && !row.listingId).length };
        },
        async unassigned() { return { messages: (await all()).filter(row => row.direction === 'inbound' && !row.listingId).sort((a, b) => b.at.localeCompare(a.at)) }; },
        async inboundReplies() { return (await all()).filter(row => row.direction === 'inbound'); }
    };
}

let shared;
const getConversationService = () => shared ||= createConversationService({ store: require('./feature_store').createFeatureStore(), repository: require('./repository').repository });
module.exports = { createConversationService, getConversationService, COLLECTION };
