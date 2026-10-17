import { useEffect, useRef, useState } from 'react';
import { requestApi } from './api';
import { ErrorNotice, Field, Notice } from './ProductWorkspace';
import { useResource } from './useResource';
import { money, nyTime } from './productHelpers';
import { nyParts, resolveNYTime } from './tourTime';

const STAGES = { preparing:'Preparing',submitted:'Submitted',approved:'Approved',rejected:'Rejected',lease_signed:'Lease signed',withdrawn:'Withdrawn' };
const STAGE_ACKNOWLEDGMENTS = {
  submitted:'I have already submitted this application.',
  approved:'The broker or landlord has confirmed approval.',
  rejected:'The broker or landlord has confirmed rejection.',
  lease_signed:'The lease has already been signed.',
  withdrawn:'I have already withdrawn this application.',
};
const OFFER_FIELDS = [
  ['monthlyRent','Offered monthly rent'],['leaseMonths','Offered lease length (months)'],
  ['freeMonths','Free rent (months)'],['rentCredit','Total rent credit'],
  ['monthlyFees','Other monthly fees'],['oneTimeFees','One-time fees due before moving'],
  ['refundableDeposit','Refundable deposit'],['upfrontRentMonths','Rent months due before move-in'],
  ['upfrontRentCredit','Rent credit applied before move-in'],
];
const missingDocuments = application => application?.documents?.filter(item => item.required && item.status === 'missing').length || 0;
const total = value => !value ? 'Unknown' : value.complete ? money(value.amount) : `${money(value.known_amount)} known · incomplete`;
function draftFrom(application) {
  const draft = structuredClone(application);
  draft.deadlines = draft.deadlines.map(item => {
    let offset = '';
    for (const candidate of ['-04:00','-05:00']) {
      try { if (resolveNYTime(nyParts(item.dueAt),candidate) === new Date(item.dueAt).toISOString()) offset = candidate; } catch { /* The other New York offset may apply. */ }
    }
    return { ...item,localDueAt:nyParts(item.dueAt),offset };
  });
  return draft;
}
function serializedApplication(draft) {
  return { ...draft,deadlines:draft.deadlines.map(({ localDueAt,offset,...item }) => {
    if (!localDueAt) throw new Error(`Choose a deadline time for ${item.label || 'each reminder'}.`);
    return { ...item,dueAt:resolveNYTime(localDueAt,offset) };
  }) };
}

export function ApplicationsWorkspace({ listings = [] }) {
  const resource = useResource('/api/applications');
  const [editingId,setEditingId] = useState(''), [listingId,setListingId] = useState(''), [selected,setSelected] = useState([]);
  const [comparison,setComparison] = useState(null), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const editorRef = useRef(null);
  useEffect(() => { if (editingId) { editorRef.current?.scrollIntoView({block:'start'}); editorRef.current?.focus({preventScroll:true}); } },[editingId]);
  const entries = resource.data?.applications || [];
  const editing = entries.find(entry => entry.listingId === editingId)?.listing || listings.find(listing => listing.id === editingId);
  const nextDeadlines = entries.flatMap(entry => entry.application.deadlines.filter(deadline => !deadline.completed).map(deadline => ({ ...deadline,listing:entry.listing }))).sort((a,b) => new Date(a.dueAt) - new Date(b.dueAt));
  async function compare() {
    setBusy(true); setError('');
    try { setComparison(await requestApi('/api/applications/compare?ids=' + selected.map(encodeURIComponent).join(','))); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <div className="product-stack">
    <section className="product-panel product-stack">
      <div className="product-row justify-between"><div><h2>Applications & offers</h2><p className="product-muted">Track your preparation, recorded outcomes, and lease terms in one place.</p></div><button className="product-button" onClick={resource.refresh} disabled={resource.loading}>Refresh applications</button></div>
      <ErrorNotice error={resource.error || error} />
      <div className="grid gap-3 sm:flex sm:items-end"><div className="flex-1 min-w-0"><Field label="Apartment to track"><select className="product-input" value={listingId} onChange={event => setListingId(event.target.value)}><option value="">Choose an apartment</option>{listings.map(listing => <option key={listing.id} value={listing.id}>{listing.title}</option>)}</select></Field></div><button className="product-button primary" disabled={!listingId} onClick={() => setEditingId(listingId)}>Open application tracker</button></div>
      {resource.loading && <p className="product-muted">Loading applications…</p>}
      {!resource.loading && !entries.length && <Notice>No applications tracked yet. Choose an apartment to prepare its checklist.</Notice>}
      <div className="product-grid">{entries.map(entry => <article key={entry.listingId} className="border border-slate-200 rounded-xl p-4 product-stack">
        <div className="product-row justify-between"><span className={`product-badge ${['approved','lease_signed'].includes(entry.application.stage) ? 'good' : ['rejected','withdrawn'].includes(entry.application.stage) ? 'bad' : ''}`}>{STAGES[entry.application.stage]}</span><label className="product-row text-xs"><input type="checkbox" aria-label={`Compare offer for ${entry.listing.title}`} checked={selected.includes(entry.listingId)} disabled={!selected.includes(entry.listingId) && selected.length >= 4} onChange={event => { setSelected(previous => event.target.checked ? [...previous,entry.listingId] : previous.filter(id => id !== entry.listingId)); setComparison(null); }} />Compare offer</label></div>
        <h3>{entry.listing.title}</h3><p className="text-sm">{missingDocuments(entry.application)} required documents missing</p><p className="product-muted">Offered rent {money(entry.application.offer.monthlyRent)} · {entry.application.offer.termsConfirmed ? 'Terms confirmed' : 'Terms unconfirmed'}</p>
        <button className="product-button" aria-label={`Edit application for ${entry.listing.title}`} onClick={() => setEditingId(entry.listingId)}>Edit application</button>
      </article>)}</div>
      {entries.length > 0 && <div className="product-row"><button className="product-button" disabled={selected.length < 2 || busy} onClick={compare}>Compare {selected.length} offers</button><span className="product-muted">Choose 2–4 apartments. Blank amounts remain unknown.</span></div>}
      {comparison && <OfferComparison comparison={comparison} />}
    </section>
    {editing && <section ref={editorRef} tabIndex="-1" aria-label={`Application editor for ${editing.title}`} className="product-stack outline-none"><div className="product-row justify-between"><h2 className="text-xl font-extrabold">{editing.title}</h2><button className="product-button" onClick={() => setEditingId('')}>Close application editor</button></div><ApplicationEditor key={editing.id} listing={editing} onSaved={() => { setComparison(null); void resource.refresh(); }} /></section>}
    {nextDeadlines.length > 0 && <section className="product-panel product-stack"><h2>Open deadlines</h2><p className="product-muted">Times are shown in New York time. Completed deadlines are excluded.</p>{nextDeadlines.map(deadline => <article key={`${deadline.listing.id}:${deadline.id}`} className="product-row justify-between border-t border-slate-100 pt-3"><div><h3>{deadline.label}</h3><p className="product-muted">{deadline.listing.title} · {nyTime(deadline.dueAt)}</p></div><span className={`product-badge ${new Date(deadline.dueAt) < new Date() ? 'warn' : ''}`}>{new Date(deadline.dueAt) < new Date() ? 'Overdue' : 'Upcoming'}</span></article>)}</section>}
  </div>;
}

export function ApplicationEditor({ listing,onSaved }) {
  const resource = useResource(`/api/listings/${encodeURIComponent(listing.id)}/application`);
  const [draft,setDraft] = useState(null), [error,setError] = useState(''), [notice,setNotice] = useState(''), [busy,setBusy] = useState(false);
  const [acknowledged,setAcknowledged] = useState(false), [conflict,setConflict] = useState(false);
  useEffect(() => { if (resource.data?.application) queueMicrotask(() => { setDraft(draftFrom(resource.data.application)); setAcknowledged(false); }); }, [resource.data]);
  const changedStage = draft && draft.stage !== resource.data?.application.stage;
  const acknowledgment = changedStage && STAGE_ACKNOWLEDGMENTS[draft.stage];
  const patchDocument = (id,field,value) => setDraft(previous => ({ ...previous,documents:previous.documents.map(item => item.id === id ? { ...item,[field]:value } : item) }));
  const patchDeadline = (id,patch) => setDraft(previous => ({ ...previous,deadlines:previous.deadlines.map(item => item.id === id ? { ...item,...patch } : item) }));
  const patchOffer = (key,value) => setDraft(previous => ({ ...previous,offer:{ ...previous.offer,[key]:value } }));
  async function save(event) {
    event.preventDefault(); if (acknowledgment && !acknowledged) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const application = serializedApplication(draft);
      const result = await requestApi(`/api/listings/${encodeURIComponent(listing.id)}/application`, { method:'PUT',body:JSON.stringify({ revision:resource.data.revision,application }) });
      resource.setData(result); setNotice(`Application saved · ${STAGES[result.application.stage]}.`); setConflict(false); onSaved?.(result);
    } catch (err) { setError(err.status === 409 ? 'This application changed elsewhere. Your unsaved draft is kept below. Reload the latest saved application before reapplying your edits.' : err.message); setConflict(err.status === 409); }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError('');
    try {
      const latest = await requestApi(`/api/listings/${encodeURIComponent(listing.id)}/application`);
      resource.setData(latest); setConflict(false); setNotice('Latest application loaded. The previous unsaved draft was discarded.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <section className="product-panel product-stack">
    <h2>Application tracker</h2><p className="product-muted">Record steps you have completed with the broker or landlord. Saving this tracker records your notes; you handle submissions, messages, payments, and signing separately.</p>
    <ErrorNotice error={error || resource.error} />{notice && <p role="status" className="product-success">{notice}</p>}
    {conflict && <button type="button" className="product-button" disabled={busy} onClick={reload}>Reload latest and discard this draft</button>}
    {!draft ? <Notice>{resource.loading ? 'Loading application…' : 'Application tracker unavailable.'}</Notice> : <form className="product-stack" onSubmit={save}>
      <Field label="Recorded application stage"><select className="product-input" value={draft.stage} onChange={event => { setDraft(previous => ({ ...previous,stage:event.target.value })); setAcknowledged(false); }}>{Object.entries(STAGES).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      {acknowledgment && <label className="product-row text-sm"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{acknowledgment}</label>}
      <section className="product-stack" aria-label="Application documents"><div><h3>Document checklist</h3><p className="product-muted">Suggested items; confirm requirements with the broker. Track document names and readiness here. Keep files and personal identifiers in your own secure storage.</p></div><span className={`product-badge ${missingDocuments(draft) ? 'warn' : 'good'}`}>{missingDocuments(draft)} required documents missing</span>
        {draft.documents.map(item => <fieldset key={item.id} className="border border-slate-200 rounded-xl p-3 product-stack"><div className="product-grid"><Field label="Document name" value={item.label} maxLength="120" required onChange={event => patchDocument(item.id,'label',event.target.value)} /><Field label={`Readiness for ${item.label || 'document'}`}><select className="product-input" value={item.status} onChange={event => patchDocument(item.id,'status',event.target.value)}><option value="missing">Missing</option><option value="ready">Ready to send</option><option value="submitted">Already submitted</option><option value="not_needed">Not needed</option></select></Field></div><Field label={`Checklist note for ${item.label || 'document'}`} value={item.note || ''} maxLength="1000" onChange={event => patchDocument(item.id,'note',event.target.value)} /><div className="product-row"><label className="product-row text-sm"><input type="checkbox" checked={item.required} onChange={event => patchDocument(item.id,'required',event.target.checked)} />Required for this apartment</label><button type="button" className="product-button" aria-label={`Remove document ${item.label}`} onClick={() => setDraft(previous => ({ ...previous,documents:previous.documents.filter(document => document.id !== item.id) }))}>Remove document</button></div></fieldset>)}
        <button type="button" className="product-button" disabled={draft.documents.length >= 40} onClick={() => setDraft(previous => ({ ...previous,documents:[...previous.documents,{id:crypto.randomUUID(),label:'',required:true,status:'missing',note:''}] }))}>Add checklist item</button>
      </section>
      <section className="product-stack" aria-label="Application deadlines"><h3>Deadlines & reminders</h3><p className="product-muted">Application, deposit, and follow-up reminders use your existing Telegram worker when it is running. Clear every reminder checkbox to disable reminders for a deadline. An unfinished deadline may send one overdue notice within 24 hours.</p><p className="product-muted">Application deadlines stop after submission. Rejected, withdrawn, and signed applications pause every reminder. Passing on an apartment also pauses its reminders.</p>{resource.data?.listing.status === 'passed' && <Notice>Reminders are paused because you passed on this apartment.</Notice>}
        {!draft.deadlines.length && <Notice>No deadlines recorded.</Notice>}
        {draft.deadlines.map(item => <fieldset key={item.id} className="border border-slate-200 rounded-xl p-3 product-stack"><div className="product-grid"><Field label="Deadline label" value={item.label} maxLength="120" required onChange={event => patchDeadline(item.id,{label:event.target.value})} /><Field label="Deadline type"><select className="product-input" value={item.type} onChange={event => patchDeadline(item.id,{type:event.target.value})}>{[['application','Application'],['deposit','Deposit'],['follow_up','Broker follow-up'],['lease','Lease'],['other','Other']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Deadline time (New York)" type="datetime-local" required value={item.localDueAt} onChange={event => patchDeadline(item.id,{localDueAt:event.target.value,offset:''})} /><Field label="Deadline daylight-saving offset"><select className="product-input" value={item.offset} onChange={event => patchDeadline(item.id,{offset:event.target.value})}><option value="">Automatic for this date</option><option value="-04:00">EDT (UTC−04:00)</option><option value="-05:00">EST (UTC−05:00)</option></select></Field></div><div className="product-row"><label className="product-row text-sm"><input type="checkbox" checked={item.completed} onChange={event => patchDeadline(item.id,{completed:event.target.checked})} />Deadline completed</label><button type="button" className="product-button" onClick={() => setDraft(previous => ({ ...previous,deadlines:previous.deadlines.filter(deadline => deadline.id !== item.id) }))}>Remove deadline</button></div><div className="product-row"><span className="text-sm font-semibold">Remind me</span>{[...new Set([1440,60,...item.reminderMinutes])].sort((a,b) => b-a).map(minutes => <label className="product-row text-sm" key={minutes}><input type="checkbox" aria-label={`Remind ${minutes} minutes before ${item.label || 'deadline'}`} checked={item.reminderMinutes.includes(minutes)} onChange={event => patchDeadline(item.id,{reminderMinutes:event.target.checked ? [...item.reminderMinutes,minutes] : item.reminderMinutes.filter(value => value !== minutes)})} />{minutes === 1440 ? '1 day before' : minutes === 60 ? '1 hour before' : `${minutes} minutes before`}</label>)}</div></fieldset>)}
        <button type="button" className="product-button" disabled={draft.deadlines.length >= 40} onClick={() => setDraft(previous => ({ ...previous,deadlines:[...previous.deadlines,{id:crypto.randomUUID(),type:'application',label:'Application deadline',dueAt:null,localDueAt:'',offset:'',completed:false,reminderMinutes:[1440,60]}] }))}>Add deadline</button>
      </section>
      <section className="product-stack" aria-label="Application offer"><h3>Offer & lease terms</h3><p className="product-muted">Enter the actual offer separately from advertised rent. Leave unknown amounts blank; enter 0 for a confirmed absence of a fee or concession. Move-in cash includes the first monthly fee payment, all entered one-time fees, and the deposit.</p><div className="product-grid">{OFFER_FIELDS.map(([key,label]) => <Field key={key} label={label} type="number" min={['leaseMonths','monthlyRent'].includes(key) ? '1' : '0'} max={key === 'leaseMonths' ? '120' : undefined} step={key === 'leaseMonths' ? '1' : '0.01'} value={draft.offer[key] ?? ''} onChange={event => patchOffer(key,event.target.value === '' ? null : Number(event.target.value))} />)}<Field label="Lease starts" type="date" value={draft.offer.leaseStart || ''} onChange={event => patchOffer('leaseStart',event.target.value || null)} /><Field label="Lease ends" type="date" value={draft.offer.leaseEnd || ''} onChange={event => patchOffer('leaseEnd',event.target.value || null)} /></div><Field label="Offer source" required={draft.offer.termsConfirmed} maxLength="500" placeholder="For example, broker email dated October 17" value={draft.offer.source || ''} onChange={event => patchOffer('source',event.target.value)} /><label className="product-row text-sm"><input type="checkbox" checked={draft.offer.termsConfirmed} onChange={event => patchOffer('termsConfirmed',event.target.checked)} />I verified these terms with the source above</label><Field label="Offer notes"><textarea className="product-input" rows="3" maxLength="2000" value={draft.offer.notes || ''} onChange={event => patchOffer('notes',event.target.value)} /></Field></section>
      <Field label="Application notes"><textarea className="product-input" rows="3" maxLength="4000" value={draft.notes || ''} onChange={event => setDraft(previous => ({ ...previous,notes:event.target.value }))} /></Field>
      <button className="product-button primary" disabled={busy || conflict || Boolean(acknowledgment && !acknowledged)}>{busy ? 'Saving application…' : resource.data?.revision ? 'Save application' : 'Create application tracker'}</button>
    </form>}
    {resource.data?.revision > 0 && <><section className="product-stack border-t border-slate-200 pt-4"><h3>Saved offer breakdown</h3><p className="product-muted">Calculated from saved terms. {resource.data.application.offer.termsConfirmed ? 'Source marked confirmed.' : 'Offer terms remain unconfirmed.'}</p><div className="product-grid">{[['recurring_monthly','Monthly outlay'],['effective_monthly','Effective rent + monthly fees'],['lease_nonrefundable','Nonrefundable lease cost'],['upfront_cash','Cash needed before move-in'],['refundable_deposits','Refundable deposits']].map(([key,label]) => <div key={key} className="bg-slate-50 rounded-xl p-3"><p className="product-muted">{label}</p><strong>{total(resource.data.calculation?.totals?.[key])}</strong></div>)}</div>{resource.data.calculation?.notes?.map((note,index) => <p className="product-muted" key={index}>{note}</p>)}</section><section className="product-stack" aria-label="Application activity"><h3>Application activity</h3><div className="product-timeline">{[...(resource.data.activity || [])].reverse().map(event => <article key={event.id}><strong className="text-sm">{event.type === 'created' ? 'Tracker created' : event.type === 'stage_changed' ? `${STAGES[event.fromStage] || 'Untracked'} → ${STAGES[event.toStage]}` : 'Application updated'}</strong><p className="product-muted">{nyTime(event.at)} · Recorded by you</p>{event.changes?.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-indigo-700">View recorded changes</summary><ul className="list-disc pl-5 mt-2">{event.changes.map((change,index) => <li key={index}>{change.field.replaceAll('_',' ')}: {describeChange(change.before)} → {describeChange(change.after)}</li>)}</ul></details>}</article>)}</div></section></>}
    {resource.data?.relatedActivity?.length > 0 && <section className="product-stack" aria-label="Broker replies and decisions"><h3>Broker replies & decisions</h3><div className="product-timeline">{[...resource.data.relatedActivity].reverse().map(event => <article key={event.id}><strong className="text-sm">{event.type === 'broker_reply' ? 'Broker reply' : `Decision: ${event.action?.replaceAll('_',' ') || 'recorded'}`}</strong><p className="product-muted">{nyTime(event.at)}</p><p className="text-sm whitespace-pre-wrap">{event.summary}</p></article>)}</div></section>}
  </section>;
}

function describeChange(value) {
  if (value == null || value === '') return 'Not recorded';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  return 'Updated details';
}
function OfferComparison({ comparison }) {
  const entries = comparison.applications || [];
  return <section className="product-stack min-w-0" aria-label="Offer comparison"><h3>Offer comparison</h3><div className="overflow-x-auto"><table className="product-table"><thead><tr><th>Recorded terms</th>{entries.map(entry => <th key={entry.listingId}>{entry.listing.title}</th>)}</tr></thead><tbody>{[
    ['Application stage',entry => STAGES[entry.application.stage]],['Offer evidence',entry => entry.application.offer.termsConfirmed ? 'Confirmed' : 'Unconfirmed'],
    ['Gross monthly rent',entry => money(entry.application.offer.monthlyRent)],['Lease months',entry => entry.application.offer.leaseMonths ?? 'Unknown'],
    ['Free rent months',entry => entry.application.offer.freeMonths ?? 'Unknown'],['Rent credit',entry => money(entry.application.offer.rentCredit)],
    ['Monthly fees',entry => money(entry.application.offer.monthlyFees)],['One-time fees',entry => money(entry.application.offer.oneTimeFees)],
    ['Refundable deposit',entry => money(entry.application.offer.refundableDeposit)],['Lease starts',entry => entry.application.offer.leaseStart || 'Unknown'],['Lease ends',entry => entry.application.offer.leaseEnd || 'Unknown'],
    ['Monthly outlay',entry => total(entry.calculation?.totals?.recurring_monthly)],['Effective rent + monthly fees',entry => total(entry.calculation?.totals?.effective_monthly)],
    ['Lease cost',entry => total(entry.calculation?.totals?.lease_nonrefundable)],['Move-in cash',entry => total(entry.calculation?.totals?.upfront_cash)],['Offer source',entry => entry.application.offer.source || 'Not recorded'],
  ].map(([label,value]) => <tr key={label}><th>{label}</th>{entries.map(entry => <td key={entry.listingId}>{value(entry)}</td>)}</tr>)}</tbody></table></div>{comparison.notes?.map((note,index) => <p className="product-muted" key={index}>{note}</p>)}</section>;
}
