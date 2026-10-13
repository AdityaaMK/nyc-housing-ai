function required(env, names, backend) {
    const missing = names.filter(name => !env[name]);
    if (missing.length) throw new Error(`${backend} requires ${missing.join(', ')}`);
}
function databaseBackend(env = process.env) {
    const backend = env.DB_BACKEND || (env.DATABASE_URL ? 'postgres' : 'sqlite');
    if (!['postgres', 'sqlite', 'supabase'].includes(backend)) throw new Error('DB_BACKEND must be postgres, sqlite, or supabase');
    if (backend === 'postgres') required(env, ['DATABASE_URL'], 'postgres');
    if (backend === 'supabase') required(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'], 'supabase');
    return backend;
}
function mailBackend(env = process.env) {
    const backend = env.MAIL_BACKEND || 'smtp-imap';
    if (!['smtp-imap', 'gmail-api'].includes(backend)) throw new Error('MAIL_BACKEND must be smtp-imap or gmail-api');
    return backend;
}
module.exports = { required, databaseBackend, mailBackend };
