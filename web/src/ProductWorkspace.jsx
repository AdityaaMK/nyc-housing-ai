import { useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, Check, LockKeyhole, X, ArrowUpRight, RefreshCw } from 'lucide-react';
import { requestApi, setOwnerToken } from './api';
import { SettingsView } from './SettingsView';
import { SelectionView, CostsEditor, ReviewsEditor } from './SelectionView';
import { ToursWorkspace } from './ToursWorkspace';
import { ApplicationsWorkspace, ApplicationEditor } from './ApplicationsWorkspace';
import './product.css';

import { ProductContext, useProduct } from './productState';
import { nyTime, money } from './productHelpers';
import { useResource } from './useResource';

export function Field({ label, children, ...props }) { return <label className="product-label">{label}{children || <input className="product-input" {...props} />}</label>; }
export function Notice({ children }) { return <div className="product-notice">{children}</div>; }
export function ErrorNotice({ error }) { return error ? <div role="alert" className="product-error">{error}</div> : null; }
export function OwnerRequired({ children }) {
  const { unlocked } = useProduct();
  return unlocked ? children : <Notice>Unlock owner access above to view or edit this part of your search. Your token stays in this tab’s memory.</Notice>;
}
export function ProductProvider({ children }) {
  const [unlocked, setUnlocked] = useState(false), [session, setSession] = useState(null), [selected, setSelected] = useState(null);
  const [saved, setSaved] = useState([]), [saveError, setSaveError] = useState('');
  const refreshSaved = useCallback(async () => {
    if (!unlocked) { setSaved([]); return; }
    try { const result = await requestApi('/api/watchlist'); setSaved(result.listings || result.items || result); setSaveError(''); }
    catch (error) { setSaveError(error.message); }
  }, [unlocked]);
  useEffect(() => { queueMicrotask(() => void refreshSaved()); }, [refreshSaved]);
  useEffect(() => { requestApi('/api/owner/session').then(setSession).catch(() => setSession(null)); }, []);
  const isSaved = id => saved.some(item => String(item.listing_id ?? item.listingId ?? item.id) === String(id));
  async function toggleSaved(listing) {
    if (!unlocked) { setSaveError('Unlock owner access to save apartments.'); return; }
    try {
      await requestApi(`/api/watchlist/${encodeURIComponent(listing.id)}`, { method: 'PUT', body: JSON.stringify({ saved: !isSaved(listing.id) }) });
      await refreshSaved();
    } catch (error) { setSaveError(error.message); }
  }
  const value = { unlocked, setUnlocked, session, setSession, selected, setSelected, saved, refreshSaved, isSaved, toggleSaved, saveError };
  return <ProductContext.Provider value={value}>{children}<ListingDrawer /></ProductContext.Provider>;
}
export function OwnerAccess() {
  const { unlocked, setUnlocked, session, setSession, saveError } = useProduct();
  const [token, setToken] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function unlock(event) {
    event.preventDefault(); setBusy(true); setError(''); setOwnerToken(token);
    try {
      const result = await requestApi('/api/owner/session');
      if (!result.authenticated) throw new Error(result.configured ? 'That owner token was not accepted.' : 'Owner access is not configured on this server.');
      setSession(result); setUnlocked(true); setToken('');
    } catch (err) { setOwnerToken(''); setError(err.message); }
    finally { setBusy(false); }
  }
  return <section aria-label="Owner access" className="mb-5 product-notice">
    {unlocked ? <div className="product-row justify-between"><span className="product-row"><Check size={16} className="text-emerald-600" /> Owner access unlocked for this tab</span><button className="product-button" onClick={() => { setOwnerToken(''); setUnlocked(false); }}>Lock</button></div> :
      <form onSubmit={unlock} className="product-row"><LockKeyhole size={17} /><span className="font-semibold">Owner access</span><input aria-label="Owner token" type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Enter owner token" autoComplete="off" className="product-input !w-auto flex-1 max-w-sm" /><button className="product-button" disabled={busy || !token}>Unlock</button><span className="text-xs">Session only · never saved in browser storage</span>{session?.configured === false && <span className="text-amber-800">Owner access needs server configuration.</span>}</form>}
    <ErrorNotice error={error || saveError} />
  </section>;
}
export function ProductNavigation({ activeTab, onSelect }) {
  return <nav aria-label="Search workspace" className="product-tabs mb-5">
    {[['watchlist', 'Saved & compare'], ['decisions', 'Decisions'], ['applications', 'Applications'], ['conversations', 'Broker inbox'], ['settings', 'Search preferences'], ['health', 'Worker health']].map(([id, label]) => <button key={id} className="product-button" aria-selected={activeTab === id} onClick={() => onSelect(id)}>{label}</button>)}
  </nav>;
}
export function ProductPage({ activeTab, listings, onRefresh, onConfirm }) {
  const { unlocked } = useProduct();
  if (activeTab === 'health') return <HealthView />;
  if (activeTab === 'settings') return <OwnerRequired><SettingsView onSaved={onRefresh} /></OwnerRequired>;
  if (activeTab === 'watchlist' || activeTab === 'decisions') return <OwnerRequired><SelectionView decisionMode={activeTab === 'decisions'} listings={listings} /></OwnerRequired>;
  if (activeTab === 'conversations') return <OwnerRequired><ConversationView listings={listings} /></OwnerRequired>;
  if (activeTab === 'applications') return <OwnerRequired><ApplicationsWorkspace listings={listings} /></OwnerRequired>;
  if (activeTab === 'tours') return <ToursWorkspace listings={listings} onConfirm={onConfirm} unlocked={unlocked} />;
  return null;
}
export function ListingActions({ listing }) {
  const { setSelected, isSaved, toggleSaved, unlocked } = useProduct();
  return <div className="mt-3 border-t border-slate-100 pt-3 space-y-2">
    <div className="product-row text-xs"><span className={`product-badge ${listing.availability === 'active' ? 'good' : listing.availability === 'unavailable' ? 'bad' : 'warn'}`}>{listing.availability || 'Unverified'}</span><span className="text-slate-500">Verified {nyTime(listing.last_verified_at || listing.last_seen_at)}</span>{(listing.score_outdated || listing.preferences_outdated || listing.assessment_outdated) && <span className="product-badge warn">Score needs refresh</span>}</div>
    <div className="product-row"><button className="product-button flex-1" onClick={() => setSelected(listing)}>Details & decisions <ArrowUpRight size={14} /></button><button aria-label={`${isSaved(listing.id) ? 'Unsave' : 'Save'} ${listing.title}`} disabled={!unlocked} className="product-button" onClick={() => toggleSaved(listing)}><Bookmark size={15} fill={isSaved(listing.id) ? 'currentColor' : 'none'} />{isSaved(listing.id) ? 'Saved' : 'Save'}</button></div>
  </div>;
}
function ListingDrawer() {
  const { selected, setSelected, unlocked } = useProduct();
  const [tab, setTab] = useState('evidence');
  const closeRef = useRef(null);
  useEffect(() => {
    if (!selected) return;
    queueMicrotask(() => setTab('evidence')); const previous = document.activeElement; closeRef.current?.focus();
    const handler = event => {
      if (event.key === 'Escape') setSelected(null);
      if (event.key === 'Tab') {
        const dialog = closeRef.current?.closest('[role=dialog]');
        const controls = [...(dialog?.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler); const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handler); document.body.style.overflow = overflow; previous?.focus?.(); };
  }, [selected, setSelected]);
  if (!selected) return null;
  return <div className="product-overlay" onClick={event => { if (event.target === event.currentTarget) setSelected(null); }}><section role="dialog" aria-modal="true" aria-label={`Apartment details: ${selected.title}`} className="product-drawer">
    <header className="product-drawer-header"><div className="product-row justify-between"><div><p className="product-muted">Apartment workspace</p><h2 className="text-xl font-extrabold">{selected.title}</h2></div><button ref={closeRef} className="product-button" onClick={() => setSelected(null)} aria-label="Close apartment details"><X size={18} /></button></div><nav className="product-tabs mt-4" aria-label="Apartment details tabs">{[['evidence','Freshness & price'],['costs','Costs'],['conversation','Conversation'],['review','Viewing & decision'],['application','Application']].map(([id,label]) => <button key={id} aria-selected={tab === id} className="product-button" onClick={() => setTab(id)}>{label}</button>)}</nav></header>
    <div className="p-4 md:p-6">{tab === 'evidence' && <EvidenceView listing={selected} />}{tab === 'costs' && <OwnerRequired><CostsEditor listing={selected} /></OwnerRequired>}{tab === 'conversation' && <OwnerRequired><ConversationView listing={selected} /></OwnerRequired>}{tab === 'review' && <OwnerRequired><ReviewsEditor listing={selected} /></OwnerRequired>}{tab === 'application' && <OwnerRequired><ApplicationEditor key={selected.id} listing={selected} /></OwnerRequired>}{!unlocked && <p className="product-muted mt-4">Close this panel and unlock owner access to edit your apartment research.</p>}</div>
  </section></div>;
}
function EvidenceView({ listing }) {
  const { unlocked } = useProduct();
  const { data, error, loading, refresh } = useResource(`/api/listings/${encodeURIComponent(listing.id)}/insights`);
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState(''), [notice, setNotice] = useState('');
  async function recheck() { setBusy(true); setActionError(''); try { const result = await requestApi(`/api/listings/${encodeURIComponent(listing.id)}/recheck`, { method: 'POST', body: '{}' }); setNotice(result.message || 'Recheck requested. Source evidence will update when the check finishes.'); await refresh(); } catch (err) { setActionError(err.message); } finally { setBusy(false); } }
  const observations = data?.sources || [], snapshots = data?.price_history || [];
  return <div className="product-stack"><section className="product-panel product-stack"><h2>Listing evidence</h2><p className="product-muted">Each source keeps its own observations. Missing search results never prove an apartment is unavailable.</p><div className="product-row"><span className="product-badge">{data?.availability || listing.availability || 'Unverified'}</span><button className="product-button" disabled={busy || !unlocked} onClick={recheck}><RefreshCw size={14} />{busy ? 'Checking…' : 'Recheck listing'}</button></div><ErrorNotice error={error || actionError} />{notice && <Notice>{notice}</Notice>}{data?.explanation && <Notice>{data.explanation}</Notice>}{data?.conflicting_evidence && <Notice>Sources disagree about availability. Review each source below.</Notice>}{data?.assessment_outdated && <Notice>Rent terms changed; the AI assessment needs refresh.</Notice>}{loading && <p className="product-muted">Loading source evidence…</p>}
    {!loading && observations.length === 0 && <Notice>No source observations yet. Historical listings start unverified.</Notice>}
    <div className="product-timeline">{observations.map((item, index) => <article key={item.id || index}><div className="product-row"><strong>{item.source || 'Listing source'}</strong><span className="product-badge">{item.availability || item.status || item.outcome}</span></div><p className="product-muted">{nyTime(item.observedAt || item.observed_at || item.at)}</p><p className="text-sm mt-1">{item.evidence || item.reason || item.note || 'Observed on source page'}</p>{item.url && <a className="text-sm text-indigo-700 underline" href={item.url} target="_blank" rel="noreferrer">Source evidence</a>}</article>)}</div></section>
    <section className="product-panel product-stack"><h2>Price & concession history</h2><p className="product-muted">Advertised, gross and effective rents stay separate so pricing changes remain comparable.</p>{!snapshots.length ? <Notice>No historical rent snapshots yet.</Notice> : <div className="overflow-x-auto"><table className="product-table"><thead><tr><th>Observed</th><th>Advertised</th><th>Verified gross</th><th>Effective</th><th>Terms</th></tr></thead><tbody>{snapshots.map((item,index) => <tr key={item.id || index}><td>{nyTime(item.observedAt || item.observed_at || item.at)}</td><td>{money(item.advertised_rent)}<div className="product-muted">{item.advertised_basis?.replaceAll('_',' ') || 'Basis unknown'}</div></td><td>{money(item.verified_gross_rent)}</td><td>{money(item.effectiveRent ?? item.effective_rent ?? item.effective_monthly_rent)}</td><td>{`${item.terms_status || 'unverified'}${item.rent_terms?.lease_months ? ` · ${item.rent_terms.lease_months} month lease` : ''}${item.rent_terms?.free_months != null ? ` · ${item.rent_terms.free_months} months free` : ''}`}</td></tr>)}</tbody></table></div>}</section></div>;
}
export function ConversationView({ listing, listings = [] }) {
  const { unlocked } = useProduct();
  const resource = useResource(listing ? `/api/listings/${encodeURIComponent(listing.id)}/conversation` : '/api/conversations/unassigned', unlocked);
  const [assignments, setAssignments] = useState({}), [busy, setBusy] = useState(null), [actionError, setActionError] = useState('');
  async function assign(message) { setBusy(message.id); setActionError(''); try { await requestApi(`/api/conversations/${encodeURIComponent(message.id)}/assignment`, { method: 'PUT', body: JSON.stringify({ listingId: assignments[message.id] || null, expectedRevision: message.revision }) }); await resource.refresh(); } catch (err) { setActionError(err.message); } finally { setBusy(null); } }
  return <section className="product-panel product-stack"><h2>{listing ? 'Broker conversation' : 'Unassigned broker replies'}</h2><p className="product-muted">{listing ? 'Messages linked by thread, reply reference, or your manual assignment.' : 'Choose the apartment an ambiguous reply belongs to. Assignments only organize your inbox.'}</p><ErrorNotice error={resource.error || actionError} />{resource.loading && <p>Loading messages…</p>}{!resource.loading && !resource.data?.messages?.length && <Notice>{listing ? 'No messages linked to this apartment yet.' : 'No unassigned replies to review.'}</Notice>}<div className="product-timeline">{resource.data?.messages?.map(message => <article key={message.id}><div className="product-row"><span className="product-badge">{message.direction === 'outbound' ? 'Sent inquiry' : 'Broker reply'}</span><span className="product-badge">{message.outcome}</span></div><h3 className="mt-2">{message.subject || 'Apartment conversation'}</h3><p className="product-muted">{nyTime(message.at)} · {message.sender || message.recipient} · {message.match}</p><p className="text-sm mt-2 whitespace-pre-wrap">{message.summary}</p>{message.outcome === 'uncertain' && <Notice>Delivery uncertain. Check Sent mail before retrying.</Notice>}{message.tourId && <p className="product-muted">Linked tour: {message.tourId}</p>}{!listing && <div className="product-row mt-3"><select aria-label={`Assign apartment for ${message.subject}`} className="product-input flex-1" value={assignments[message.id] || ''} onChange={event => setAssignments(previous => ({ ...previous, [message.id]: event.target.value }))}><option value="">Keep unassigned</option>{listings.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select><button disabled={busy === message.id || !assignments[message.id]} className="product-button" onClick={() => assign(message)}>Assign reply</button></div>}</article>)}</div></section>;
}
function HealthView() {
  const { data, error, loading, refresh } = useResource('/api/health');
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15000); return () => clearInterval(timer); }, [refresh]);
  return <section className="product-panel product-stack"><div className="product-row justify-between"><div><h2>Worker & source health</h2><p className="product-muted">Last check {nyTime(data?.checkedAt)} · Refreshes every 15 seconds while visible.</p></div><button className="product-button" disabled={loading} onClick={refresh}>Refresh health</button></div><ErrorNotice error={error} /><div className="product-grid">{data?.workers?.map(worker => <article key={worker.name} className="rounded-xl border border-slate-200 p-4 product-stack"><div className="product-row justify-between"><h3>{worker.name}</h3><span className={`product-badge ${worker.status === 'healthy' ? 'good' : worker.status === 'degraded' || worker.status === 'stale' ? 'warn' : ''}`}>{worker.status}</span></div><div className="product-muted">Heartbeat: {nyTime(worker.heartbeatAt)}<br />Last success: {nyTime(worker.lastSuccessAt)}</div>{worker.error && <p className="text-sm text-amber-800">{worker.error}</p>}{worker.backlog != null && <p className="product-muted">Backlog: {typeof worker.backlog === 'object' ? Object.entries(worker.backlog).map(([key,value]) => `${key}: ${value}`).join(' · ') : worker.backlog}</p>}<details className="text-sm"><summary className="cursor-pointer font-semibold text-indigo-700">Recent operations ({worker.recentRuns?.length || 0})</summary>{worker.recentRuns?.length ? <ol className="mt-3 space-y-3">{worker.recentRuns.slice(0,10).map((run,index) => <li key={run.at + ':' + index} className="border-t border-slate-100 pt-2"><div className="product-row"><span className={`product-badge ${run.status === 'healthy' || run.status === 'success' ? 'good' : 'warn'}`}>{run.status}</span><span className="product-muted">{nyTime(run.at)}</span></div>{run.error && <p className="mt-1 text-amber-800">{run.error}</p>}{run.lastSuccessAt && <p className="product-muted">Last success: {nyTime(run.lastSuccessAt)}</p>}{run.backlog != null && <p className="product-muted">Backlog: {typeof run.backlog === 'object' ? Object.entries(run.backlog).map(([key,value]) => `${key}: ${value}`).join(' · ') : run.backlog}</p>}</li>)}</ol> : <p className="product-muted mt-2">No completed operations recorded yet.</p>}</details></article>)}</div><h3>Collection sources</h3>{!data?.sources?.length && <Notice>No source runs recorded yet.</Notice>}<div className="overflow-x-auto"><table className="product-table"><thead><tr><th>Source / feed</th><th>Outcome</th><th>Last run</th><th>Observed</th><th>Details</th></tr></thead><tbody>{data?.sources?.map((source,index) => <tr key={`${source.source}-${source.feed}-${index}`}><td>{source.source}<div className="product-muted">{source.feed}</div></td><td>{source.status}</td><td>{nyTime(source.at)}</td><td>{source.count ?? 'Unknown'}</td><td>{source.error || '—'}</td></tr>)}</tbody></table></div><Notice>A stopped or suspended host cannot report new progress. This view reports health; recurring jobs run in their workers.</Notice></section>;
}
