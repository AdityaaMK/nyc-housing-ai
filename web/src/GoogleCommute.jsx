import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
const Context = createContext(null);
const apiBase = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');
const nyTime = value => new Date(value).toLocaleString('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
});
const minutes = seconds => seconds == null ? 'time unavailable' : `${Math.ceil(seconds / 60)} min`;
const statusMessages = {
  unconfigured: 'Google commute is not configured.', configuration_error: 'Google commute is disabled until its configuration is corrected.',
  rate_limited: 'Google commute is temporarily paused after a rate limit.', allowance_exhausted: 'Google commute request allowance exhausted.',
  service_error: 'Google commute is temporarily unavailable.'
};
export function GoogleCommuteProvider({ children }) {
  const [status, setStatus] = useState(null);
  const [results, setResults] = useState({});
  const requests = useRef(new Map());
  const statusRequest = useRef(null);
  const mounted = useRef(false);
  const refreshStatus = useCallback(async () => {
    if (statusRequest.current) return;
    const controller = new AbortController();
    statusRequest.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(apiBase + '/api/commute/status', { signal: controller.signal, cache: 'no-store' });
      const data = await res.json();
      if (mounted.current) setStatus(res.ok ? data : { available: false, code: 'service_error' });
    } catch {
      if (mounted.current) setStatus({ available: false, code: 'service_error' });
    } finally { clearTimeout(timer); if (statusRequest.current === controller) statusRequest.current = null; }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const activeRequests = requests.current;
    const initial = setTimeout(() => void refreshStatus(), 0);
    const timer = setInterval(() => { if (!document.hidden) void refreshStatus(); }, 15000);
    return () => {
      mounted.current = false;
      clearTimeout(initial);
      clearInterval(timer);
      statusRequest.current?.abort(); statusRequest.current = null;
      activeRequests.forEach(controller => controller.abort()); activeRequests.clear();
    };
  }, [refreshStatus]);
  const lookup = async id => {
    if (requests.current.has(id) || !status?.available) return;
    const controller = new AbortController();
    requests.current.set(id, controller);
    setResults(previous => ({ ...previous, [id]: { loading: true } }));
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(`${apiBase}/api/listings/${encodeURIComponent(id)}/commute`, {
        method: 'POST', signal: controller.signal, cache: 'no-store'
      });
      const data = await res.json();
      if (!res.ok) {
        if (statusMessages[data.code]) setStatus(previous => ({ ...previous, available: false, code: data.code }));
        throw new Error(data.error || 'No Google Maps estimate was retrieved.');
      }
      if (mounted.current) setResults(previous => ({ ...previous, [id]: { data } }));
    } catch (error) {
      if (mounted.current) setResults(previous => ({ ...previous, [id]: {
        error: error.name === 'AbortError' ? 'Lookup cancelled or timed out. No estimate was retrieved.' : error.message
      } }));
    } finally {
      clearTimeout(timer); requests.current.delete(id);
      if (mounted.current) void refreshStatus();
    }
  };
  return <Context.Provider value={{ status, results, lookup, cancel: id => requests.current.get(id)?.abort() }}>{children}</Context.Provider>;
}
export function GoogleCommute({ listing }) {
  const { status, results, lookup, cancel } = useContext(Context);
  const result = results[listing.id];
  const data = result?.data;
  return <section className="mb-3 p-3 rounded-xl border border-slate-200 bg-white text-xs text-slate-700" aria-label="Google commute">
    <button type="button" onClick={() => lookup(listing.id)}
      disabled={!listing.commute_address_available || !status?.available || result?.loading}
      className="px-3 py-2 rounded-lg bg-indigo-600 text-white font-bold disabled:bg-slate-200 disabled:text-slate-500">
      {result?.loading ? 'Getting Google commute…' : 'Get Google commute'}
    </button>
    {result?.loading && <button type="button" onClick={() => cancel(listing.id)} className="ml-3 underline">Cancel</button>}
    <div className="mt-2" aria-live="polite">
      {!listing.commute_address_available ? <p>Address needed</p> : !status ? <p>Checking Google commute availability…</p> :
        !status.available ? <p>{statusMessages[status.code] || statusMessages.service_error}{status.retryAt && ` Try after ${nyTime(status.retryAt)}.`}</p> :
          <p>Arrive at 620 8th Avenue by 9:00 AM on the next weekday, New York time.</p>}
      {status?.remaining && <p className="mt-1 text-slate-500">Requests left: {status.remaining.daily} today · {status.remaining.rolling32Days} per rolling 32 days</p>}
      {result?.error && <p role="alert" className="mt-2 text-amber-800">{result.error}</p>}
      {data && <div className="mt-3 border-t border-slate-200 pt-3">
        <h4 className="font-bold text-slate-900">Google Maps transit estimate</h4>
        <p>Requested arrival: {nyTime(data.requestedArrivalTime)}</p>
        <p className="mt-1">{data.origin} → {data.destination}</p>
        <p className="font-semibold mt-2">{minutes(data.route.durationSeconds)} · {data.route.walkingOnly ? 'Walking only' : `${data.route.transfers} transfer${data.route.transfers === 1 ? '' : 's'}`} · Walking: {minutes(data.route.walkingSeconds)}</p>
        <ol className="list-decimal pl-4 mt-2 space-y-2">
          {data.route.steps.map((step, i) => <li key={i}>
            {step.mode === 'WALK' ? <>Walk · {minutes(step.durationSeconds)}{step.instruction && ` · ${step.instruction}`}</> : <>
              <b>{step.transit.line || step.transit.vehicle || 'Transit'}</b> · {minutes(step.durationSeconds)}
              {step.transit.headsign && ` toward ${step.transit.headsign}`}
              <div>{step.transit.departureStop} → {step.transit.arrivalStop}{step.transit.stopCount != null && ` · ${step.transit.stopCount} stops`}</div>
              {step.transit.departureTime && <div>Depart {nyTime(step.transit.departureTime)}</div>}
              {step.transit.arrivalTime && <div>Arrive {nyTime(step.transit.arrivalTime)}</div>}
              {step.transit.agencies?.map((agency, index) => <span key={index} className="mr-2">
                {/^https?:\/\//i.test(agency.uri || '') ? <a className="underline" href={agency.uri} target="_blank" rel="noopener noreferrer">{agency.name}</a> : agency.name}
              </span>)}
            </>}
          </li>)}
        </ol>
        <p className="mt-3">Retrieved {nyTime(data.retrievedAt)}. Schedules may change.</p>
        <p className="mt-2 text-[#5e5e5e] text-xs font-normal not-italic tracking-normal whitespace-nowrap" translate="no">Google Maps</p>
      </div>}
    </div>
  </section>;
}
