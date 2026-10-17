const { mailBackend, required } = require('./backend_config');
async function openMailbox(env = process.env) {
    if (mailBackend(env) === 'gmail-api') {
        const gmail = require('./gmail_api').getGmailClient();
        await gmail.verifyIdentity();
        return { ...gmail, identity: id => `${gmail.user}:gmail:${id}` };
    }
    required(env, ['GMAIL_USER', 'GMAIL_APP_PASSWORD'], 'smtp-imap');
    const connection = await require('imap-simple').connect({ imap: {
        user: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD, host: 'imap.gmail.com', port: 993,
        tls: true, authTimeout: 10000
    } });
    try { await connection.openBox('INBOX'); } catch (error) { connection.end(); throw error; }
    const messages = new Map();
    return {
        user: env.GMAIL_USER,
        identity: id => `${env.GMAIL_USER}:${connection.imap?._box?.uidvalidity || 'inbox'}:${id}`,
        async listMessages(since, unreadOnly = false) {
            messages.clear();
            const found = await connection.search([...(unreadOnly ? ['UNSEEN'] : []), ['SINCE', since]], { bodies: [''], markSeen: false });
            for (const message of found) messages.set(message.attributes.uid, message);
            return [...messages.keys()];
        },
        async listUnread(since) { return this.listMessages(since, true); },
        async getMessage(id) {
            const message = messages.get(id) || (await connection.search([['UID', String(id)]], { bodies: [''], markSeen: false }))[0];
            if (!message) throw Object.assign(new Error('IMAP message no longer exists'), { status: 404 });
            const raw = message?.parts.find(p => p.which === '')?.body;
            if (raw == null) throw new Error('IMAP message has no raw MIME content');
            const parsed = await require('mailparser').simpleParser(raw);
            return { id, subject: parsed.subject || 'No Subject', from: parsed.from?.text || 'Unknown Sender',
                fromAddress: parsed.from?.value?.[0]?.address, body: parsed.text || parsed.html || '',
                threadId: null, rfcMessageId: parsed.messageId || null,
                inReplyTo: parsed.inReplyTo || null, references: parsed.references || [],
                receivedAt: message.attributes.date ? new Date(message.attributes.date).toISOString() : parsed.date?.toISOString() };
        },
        markRead: id => connection.addFlags(id, '\\Seen'),
        close: async () => { connection.end(); }
    };
}
module.exports = { openMailbox };
