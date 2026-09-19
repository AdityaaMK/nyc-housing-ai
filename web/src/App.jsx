import { useEffect, useState } from 'react';
import {
  Building,
  DollarSign,
  Bed,
  Bath,
  TriangleAlert,
  CheckCircle,
  Search,
  ThumbsDown,
  Mail,
  Activity,
  Calendar,
  Clock,
  MapPin,
  Navigation,
  ShieldCheck,
  ShieldAlert,
  ExternalLink,
  Sparkles,
  LayoutGrid
} from 'lucide-react';

function App() {
  const [activeTab, setActiveTab] = useState('pipeline'); // 'pipeline' | 'tours' | 'map'
  const [listings, setListings] = useState([]);
  const [tours, setTours] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filterNeighborhood, setFilterNeighborhood] = useState('all');

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    try {
      const [listRes, tourRes, statRes] = await Promise.all([
        fetch('http://localhost:3001/api/listings').then(r => r.json()).catch(() => []),
        fetch('http://localhost:3001/api/tours').then(r => r.json()).catch(() => []),
        fetch('http://localhost:3001/api/stats').then(r => r.json()).catch(() => null)
      ]);
      setListings(Array.isArray(listRes) ? listRes : []);
      setTours(Array.isArray(tourRes) ? tourRes : []);
      setStats(statRes);
      setLoading(false);
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  };

  const updateStatus = async (id, status) => {
    try {
      await fetch(`http://localhost:3001/api/listings/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      fetchAllData();
    } catch (err) {
      console.error(err);
    }
  };

  const confirmTour = async (tourId) => {
    try {
      await fetch(`http://localhost:3001/api/tours/${tourId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      fetchAllData();
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-4 animate-pulse">
        <Activity className="w-12 h-12 text-blue-600 animate-spin" />
        <div className="text-xl font-bold text-slate-700">Loading NYC Housing Pipeline...</div>
        <div className="text-sm text-slate-400">Syncing StreetEasy, RentHop, Compass & Open Data</div>
      </div>
    </div>
  );

  const filteredListings = filterNeighborhood === 'all'
    ? listings
    : listings.filter(l => (l.neighborhood || '').toLowerCase().includes(filterNeighborhood.toLowerCase()));

  const inbox = filteredListings.filter(l => l.status === 'inbox');
  const applied = filteredListings.filter(l => l.status === 'applied');
  const passed = filteredListings.filter(l => l.status === 'passed');

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-slate-50 to-indigo-50/40 text-slate-900 p-4 md:p-8 font-sans selection:bg-indigo-100">
      <div className="max-w-[1500px] mx-auto">
        
        {/* HEADER */}
        <header className="mb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 bg-white/90 backdrop-blur-xl p-6 rounded-3xl shadow-sm border border-white">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl shadow-lg shadow-indigo-200">
              <Building className="w-8 h-8 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl md:text-3xl font-black tracking-tight text-slate-900">NYC Housing AI Copilot</h1>
                <span className="px-2.5 py-0.5 text-xs font-bold bg-emerald-100 text-emerald-700 rounded-full border border-emerald-200">
                  Live 24/7
                </span>
              </div>
              <p className="text-slate-500 font-medium text-sm mt-0.5">
                Stealth Monitoring StreetEasy, RentHop & Compass • Datadog NYC Target
              </p>
            </div>
          </div>

          {/* QUICK STATS */}
          <div className="flex flex-wrap items-center gap-3 md:gap-5 bg-slate-50/80 px-5 py-2.5 rounded-2xl border border-slate-100 text-sm">
            <div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Listings</span>
              <div className="text-xl font-black text-slate-800 leading-tight">{listings.length}</div>
            </div>
            <div className="w-px h-8 bg-slate-200"></div>
            <div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Inbox</span>
              <div className="text-xl font-black text-blue-600 leading-tight">{inbox.length}</div>
            </div>
            <div className="w-px h-8 bg-slate-200"></div>
            <div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Tours</span>
              <div className="text-xl font-black text-indigo-600 leading-tight">{tours.length}</div>
            </div>
            <div className="w-px h-8 bg-slate-200"></div>
            <div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Grade A Buildings</span>
              <div className="text-xl font-black text-emerald-600 leading-tight">
                {stats?.health?.gradeA ?? listings.filter(l => l.building_health && l.building_health.includes('"grade":"A"')).length}
              </div>
            </div>
          </div>
        </header>

        {/* NAVIGATION TABS & FILTER BAR */}
        <div className="mb-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-white/70 backdrop-blur-md p-2 rounded-2xl border border-slate-200/60 shadow-sm">
          <div className="flex items-center gap-1.5 w-full sm:w-auto">
            <button
              onClick={() => setActiveTab('pipeline')}
              className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                activeTab === 'pipeline'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-200'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              <LayoutGrid className="w-4 h-4" /> Pipeline Kanban
            </button>

            <button
              onClick={() => setActiveTab('tours')}
              className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                activeTab === 'tours'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-200'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              <Calendar className="w-4 h-4" /> Tours & Calendar
              {tours.length > 0 && (
                <span className="px-1.5 py-0.2 bg-white text-blue-700 text-xs rounded-full font-black">
                  {tours.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('map')}
              className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                activeTab === 'map'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-200'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              <Navigation className="w-4 h-4" /> Commute & Map Guide
            </button>
          </div>

          {activeTab === 'pipeline' && (
            <div className="flex items-center gap-2 w-full sm:w-auto text-xs font-bold text-slate-500">
              <span>Filter:</span>
              <select
                value={filterNeighborhood}
                onChange={e => setFilterNeighborhood(e.target.value)}
                className="bg-white border border-slate-200 rounded-xl px-3 py-1.5 font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Neighborhoods ({listings.length})</option>
                <option value="Hell's Kitchen">Hell's Kitchen (⭐ Office Proximity)</option>
                <option value="West Village">West Village</option>
                <option value="East Village">East Village (⭐ Preferred)</option>
                <option value="Chelsea">Chelsea</option>
                <option value="Lower East Side">Lower East Side (⭐ Preferred)</option>
                <option value="Financial District">Financial District (⭐ Preferred)</option>
                <option value="Upper West Side">Upper West Side</option>
              </select>
            </div>
          )}
        </div>

        {/* TAB 1: PIPELINE KANBAN */}
        {activeTab === 'pipeline' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <PipelineColumn
              title="📥 Inbox"
              count={inbox.length}
              listings={inbox}
              theme="blue"
              onPass={id => updateStatus(id, 'passed')}
              onApply={id => updateStatus(id, 'applied')}
            />
            <PipelineColumn
              title="✉️ Contacted"
              count={applied.length}
              listings={applied}
              theme="indigo"
              onPass={id => updateStatus(id, 'passed')}
              onApply={null}
            />
            <PipelineColumn
              title="🚫 Passed"
              count={passed.length}
              listings={passed}
              theme="slate"
              onPass={null}
              onApply={id => updateStatus(id, 'inbox')}
            />
          </div>
        )}

        {/* TAB 2: TOURS & CALENDAR */}
        {activeTab === 'tours' && (
          <ToursView tours={tours} onConfirm={confirmTour} />
        )}

        {/* TAB 3: COMMUTE & MAP GUIDE */}
        {activeTab === 'map' && (
          <CommuteMapView listings={listings} />
        )}

      </div>
    </div>
  );
}

function PipelineColumn({ title, count, listings, theme, onPass, onApply }) {
  const themes = {
    blue: {
      bg: 'bg-blue-50/40',
      border: 'border-blue-100',
      headerText: 'text-blue-900',
      countBg: 'bg-blue-100 text-blue-800'
    },
    indigo: {
      bg: 'bg-indigo-50/40',
      border: 'border-indigo-100',
      headerText: 'text-indigo-900',
      countBg: 'bg-indigo-100 text-indigo-800'
    },
    slate: {
      bg: 'bg-slate-100/40',
      border: 'border-slate-200',
      headerText: 'text-slate-800',
      countBg: 'bg-slate-200 text-slate-700'
    }
  };

  const t = themes[theme];

  return (
    <div className={`rounded-3xl p-5 flex flex-col gap-4 border shadow-sm min-h-[75vh] ${t.bg} ${t.border}`}>
      <div className="flex items-center justify-between px-2">
        <h2 className={`text-base font-extrabold tracking-wide flex items-center gap-2 ${t.headerText}`}>
          {title}
        </h2>
        <span className={`px-2.5 py-0.5 rounded-full text-xs font-black shadow-xs border border-white/50 ${t.countBg}`}>
          {count}
        </span>
      </div>

      {listings.length === 0 && (
        <div className="m-auto text-center p-8 border-2 border-dashed border-slate-200 rounded-2xl bg-white/50">
          <div className="text-slate-400 font-medium text-sm">No apartments here</div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {listings.map(l => (
          <ListingCard key={l.id} l={l} onPass={onPass} onApply={onApply} />
        ))}
      </div>
    </div>
  );
}

function ListingCard({ l, onPass, onApply }) {
  let redFlags = [];
  let pros = [];
  try { redFlags = JSON.parse(l.red_flags || '[]'); } catch(e){}
  try { pros = JSON.parse(l.pros || '[]'); } catch(e){}

  let health = null;
  try {
    if (l.building_health) {
      health = typeof l.building_health === 'string' ? JSON.parse(l.building_health) : l.building_health;
    }
  } catch(e){}

  let crossPosted = [];
  try {
    if (l.cross_posted_sources) {
      crossPosted = typeof l.cross_posted_sources === 'string' ? JSON.parse(l.cross_posted_sources) : l.cross_posted_sources;
    }
  } catch(e){}

  // Score Badge Color
  const getScoreColor = (score) => {
    if (!score) return 'from-slate-400 to-slate-500';
    if (score >= 85) return 'from-emerald-500 to-teal-600 shadow-emerald-200';
    if (score >= 70) return 'from-amber-400 to-orange-500 shadow-amber-200';
    return 'from-rose-500 to-red-600 shadow-rose-200';
  };

  const sourceLabels = {
    streeteasy: { name: 'StreetEasy', color: 'bg-blue-50 text-blue-700 border-blue-200' },
    renthop: { name: 'RentHop', color: 'bg-red-50 text-red-700 border-red-200' },
    compass: { name: 'Compass', color: 'bg-black text-white border-black' }
  };

  const srcBadge = sourceLabels[l.source] || { name: l.source || 'Portal', color: 'bg-slate-100 text-slate-700' };

  return (
    <div className="bg-white/95 backdrop-blur-sm rounded-2xl p-5 shadow-sm hover:shadow-xl hover:-translate-y-0.5 transition-all duration-300 border border-slate-100 relative group">
      
      {/* Floating Score Badge */}
      <div className={`absolute -top-3 -right-2 bg-gradient-to-br text-white font-black px-3 py-1 rounded-xl shadow-md border-2 border-white flex items-center gap-1 ${getScoreColor(l.suitability_score)}`}>
        <span className="text-[9px] uppercase tracking-wider opacity-90 mr-0.5">Score</span>
        <span className="text-sm">{l.suitability_score || '?'}</span>
      </div>

      {/* Source & Neighborhood Line */}
      <div className="flex items-center gap-2 mb-2 pr-14">
        <span className={`px-2 py-0.5 text-[10px] font-black uppercase rounded-md border ${srcBadge.color}`}>
          {srcBadge.name}
        </span>
        {l.neighborhood && (
          <span className="text-xs font-bold text-slate-500 flex items-center gap-1 truncate">
            <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
            {l.neighborhood} {l.is_preferred && '⭐'}
          </span>
        )}
      </div>

      <h3 className="font-extrabold text-slate-900 text-base mb-3 leading-snug line-clamp-2">
        {l.title}
      </h3>

      {/* Quick Stats Bar */}
      <div className="flex flex-wrap gap-2 text-xs font-bold text-slate-700 bg-slate-50/90 p-2.5 rounded-xl border border-slate-100 mb-3">
        <div className="flex items-center gap-1 bg-white px-2 py-1 rounded-md shadow-xs border border-slate-100">
          <DollarSign className="w-3.5 h-3.5 text-emerald-600" />
          <span className="text-sm font-black">${Number(l.true_gross_rent || l.price || 0).toLocaleString()}</span>
          {l.true_gross_rent && l.true_gross_rent !== l.price && (
            <span className="text-[10px] text-slate-400 font-normal">(${Number(l.price).toLocaleString()} net)</span>
          )}
        </div>
        <div className="flex items-center gap-1 bg-white px-2 py-1 rounded-md shadow-xs border border-slate-100">
          <Bed className="w-3.5 h-3.5 text-slate-400" /> {l.bedrooms === 0 ? 'Studio' : `${l.bedrooms} Bed`}
        </div>
        <div className="flex items-center gap-1 bg-white px-2 py-1 rounded-md shadow-xs border border-slate-100">
          <Bath className="w-3.5 h-3.5 text-slate-400" /> {l.bathrooms} Bath
        </div>
      </div>

      {/* COMMUTE ROUTE TO DATADOG */}
      {l.commute_summary && (
        <div className="mb-2.5 p-2 bg-indigo-50/70 border border-indigo-100 rounded-xl text-xs font-medium text-indigo-900 flex items-center gap-2">
          <Navigation className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
          <span className="truncate">
            <b>{l.commute_minutes ? `${l.commute_minutes}m:` : 'Commute:'}</b> {l.commute_summary}
          </span>
        </div>
      )}

      {/* BUILDING HEALTH BADGE */}
      {health && (
        <div className="mb-3">
          {health.grade === 'A' ? (
            <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200/60 px-2.5 py-1 rounded-lg">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
              <span>HPD Building Health: Grade A (Clean — 0 Class C)</span>
            </div>
          ) : health.grade === 'B' ? (
            <div className="flex items-center gap-1.5 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200/60 px-2.5 py-1 rounded-lg">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
              <span>HPD Building Health: Grade B (Moderate History)</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200/60 px-2.5 py-1 rounded-lg">
              <ShieldAlert className="w-3.5 h-3.5 text-rose-600" />
              <span>HPD Building Health: Grade C (⚠️ {health.classC || 0} Class C Hazards)</span>
            </div>
          )}
        </div>
      )}

      {/* Tags: Broker Fee, Red Flags, Pros */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {l.is_fee ? (
          <div className="flex items-center gap-1 text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200/60 px-2 py-0.5 rounded-md">
            <TriangleAlert className="w-3 h-3" /> Fee: {l.fee_estimate || 'Yes'}
          </div>
        ) : (
          <div className="flex items-center gap-1 text-[11px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200/60 px-2 py-0.5 rounded-md">
            <Sparkles className="w-3 h-3 text-emerald-600" /> No Fee
          </div>
        )}

        {redFlags.slice(0, 2).map((rf, i) => (
          <div key={`rf-${i}`} className="flex items-center gap-1 text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-200/60 px-2 py-0.5 rounded-md">
            <TriangleAlert className="w-3 h-3 text-rose-500" /> {rf}
          </div>
        ))}

        {pros.slice(0, 2).map((p, i) => (
          <div key={`p-${i}`} className="flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200/60 px-2 py-0.5 rounded-md">
            <CheckCircle className="w-3 h-3 text-emerald-500" /> {p}
          </div>
        ))}
      </div>

      {/* Cross-Posted Links */}
      {crossPosted.length > 0 && (
        <div className="mb-3 text-[11px] text-slate-500 flex items-center gap-1.5">
          <span>Also listed on:</span>
          {crossPosted.map((cp, i) => (
            <a key={i} href={cp.url} target="_blank" rel="noreferrer" className="underline font-bold text-blue-600 hover:text-blue-800">
              {cp.source}
            </a>
          ))}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-2 pt-3 border-t border-slate-100">
        <a
          href={l.url}
          target="_blank"
          rel="noreferrer"
          className="flex-1 bg-slate-50 hover:bg-slate-100 text-slate-700 py-2 rounded-xl text-xs font-bold text-center flex items-center justify-center gap-1.5 transition-colors border border-slate-200"
        >
          <ExternalLink className="w-3.5 h-3.5" /> View Listing
        </a>

        {onApply && (
          <button
            onClick={() => onApply(l.id)}
            className="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white py-2 rounded-xl text-xs font-bold text-center flex items-center justify-center gap-1.5 transition-all shadow-sm shadow-blue-200"
          >
            <Mail className="w-3.5 h-3.5" /> Contacted
          </button>
        )}

        {onPass && (
          <button
            onClick={() => onPass(l.id)}
            className="flex-none bg-rose-50 hover:bg-rose-100 text-rose-600 p-2 rounded-xl transition-colors border border-rose-100"
            title="Pass"
          >
            <ThumbsDown className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function ToursView({ tours, onConfirm }) {
  return (
    <div className="bg-white/80 backdrop-blur-md rounded-3xl p-6 md:p-8 border border-slate-200 shadow-sm">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
            <Calendar className="w-6 h-6 text-indigo-600" /> Inbound Tour Schedules & Bookings
          </h2>
          <p className="text-slate-500 text-sm mt-1">
            Brokers replying with showings automatically trigger calendar events and acceptance emails
          </p>
        </div>
        <span className="px-3 py-1 bg-indigo-100 text-indigo-800 text-xs font-black rounded-full">
          {tours.length} Total Showings
        </span>
      </div>

      {tours.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50/50">
          <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <div className="text-slate-600 font-bold">No apartment tours scheduled yet</div>
          <div className="text-slate-400 text-sm mt-1">
            When a broker replies with available showing times, they appear right here
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {tours.map(tour => (
            <div
              key={tour.id}
              className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm hover:shadow-md transition-shadow relative"
            >
              <div className="flex items-center justify-between gap-2 mb-3">
                <span
                  className={`px-2.5 py-0.5 text-xs font-black rounded-full uppercase tracking-wider ${
                    tour.status === 'confirmed'
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                      : 'bg-amber-100 text-amber-800 border border-amber-200'
                  }`}
                >
                  {tour.status === 'confirmed' ? '✅ Confirmed' : '⏳ Tour Proposed'}
                </span>
                <span className="text-xs text-slate-400">
                  {new Date(tour.created_at || Date.now()).toLocaleDateString()}
                </span>
              </div>

              <h3 className="font-extrabold text-slate-900 text-lg mb-2">
                {tour.listing_address}
              </h3>

              <div className="space-y-1.5 text-xs text-slate-600 mb-4 bg-slate-50 p-3 rounded-xl border border-slate-100">
                <div className="flex items-center gap-2 font-bold text-slate-800">
                  <Clock className="w-3.5 h-3.5 text-indigo-600" />
                  <span>Time: {tour.proposed_time}</span>
                </div>
                {tour.broker_name && (
                  <div>
                    <b>Broker:</b> {tour.broker_name} {tour.broker_email ? `(${tour.broker_email})` : ''}
                  </div>
                )}
                {tour.special_instructions && (
                  <div className="text-amber-800">
                    <b>Buzzer / Entry:</b> {tour.special_instructions}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                <a
                  href={tour.calendar_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 py-2 rounded-xl text-xs font-bold text-center flex items-center justify-center gap-1.5 transition-colors border border-indigo-200"
                >
                  <Calendar className="w-3.5 h-3.5" /> Add to Google Calendar
                </a>

                {tour.status !== 'confirmed' && (
                  <button
                    onClick={() => onConfirm(tour.id)}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-2 rounded-xl text-xs font-bold text-center flex items-center justify-center gap-1.5 transition-all shadow-sm shadow-emerald-200"
                  >
                    <CheckCircle className="w-3.5 h-3.5" /> Confirm with Broker
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommuteMapView({ listings }) {
  const neighborhoods = [
    {
      name: "Hell's Kitchen",
      commute: "8-12 mins",
      trains: "Walk / A, C, E direct to 42 St",
      starred: true,
      tag: "Top Office Proximity",
      color: "border-emerald-500 bg-emerald-50/40"
    },
    {
      name: "Chelsea",
      commute: "14-18 mins",
      trains: "A, C, E or 1, 2, 3",
      starred: false,
      tag: "Prime Dining & High Line",
      color: "border-blue-400 bg-blue-50/40"
    },
    {
      name: "West Village",
      commute: "16-20 mins",
      trains: "A, C, E from W 4th St",
      starred: false,
      tag: "Historic & Vibrant",
      color: "border-indigo-400 bg-indigo-50/40"
    },
    {
      name: "East Village",
      commute: "22-26 mins",
      trains: "L train -> 8th Ave transfer to A/C/E",
      starred: true,
      tag: "Preferred Neighborhood",
      color: "border-purple-400 bg-purple-50/40"
    },
    {
      name: "Lower East Side",
      commute: "24-28 mins",
      trains: "F train -> A/C/E or direct B/D",
      starred: true,
      tag: "Preferred Neighborhood",
      color: "border-rose-400 bg-rose-50/40"
    },
    {
      name: "Financial District",
      commute: "22-26 mins",
      trains: "2, 3 or A, C express to Times Sq",
      starred: true,
      tag: "Preferred Neighborhood",
      color: "border-amber-400 bg-amber-50/40"
    },
    {
      name: "Upper West Side",
      commute: "15-20 mins",
      trains: "1, 2, 3 or B, C direct down",
      starred: false,
      tag: "Central Park Proximity",
      color: "border-teal-400 bg-teal-50/40"
    },
    {
      name: "Midtown West",
      commute: "5-10 mins",
      trains: "Walking distance to 620 8th Ave",
      starred: true,
      tag: "Walking Commute",
      color: "border-emerald-400 bg-emerald-50/40"
    }
  ];

  return (
    <div className="bg-white/80 backdrop-blur-md rounded-3xl p-6 md:p-8 border border-slate-200 shadow-sm space-y-8">
      <div>
        <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
          <Navigation className="w-6 h-6 text-blue-600" /> Target Workplace Commute Guide
        </h2>
        <p className="text-slate-500 text-sm mt-1">
          Target: <b>Datadog Office (620 8th Ave, NYT Building, Manhattan)</b> • Direct access via Times Sq-42 St / Port Authority (A/C/E/1/2/3/7/N/Q/R/W)
        </p>
      </div>

      {/* TARGET HUB CARD */}
      <div className="p-4 bg-gradient-to-r from-blue-900 to-indigo-900 text-white rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-md">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-white/10 rounded-xl">
            <Building className="w-6 h-6 text-indigo-200" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-indigo-200 font-bold">Commute Destination</div>
            <div className="text-lg font-black">Datadog NYC Office (620 8th Ave @ 40th/41st St)</div>
            <div className="text-xs text-indigo-100/80">Direct indoor subway portal from 8th Ave A/C/E concourse</div>
          </div>
        </div>
        <div className="text-xs bg-white/20 px-3 py-1.5 rounded-xl font-bold">
          Max Commute Threshold: 40 mins
        </div>
      </div>

      {/* NEIGHBORHOOD TRANSIT MATRIX */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {neighborhoods.map(nh => {
          const matchCount = listings.filter(l => (l.neighborhood || '').toLowerCase().includes(nh.name.toLowerCase())).length;
          return (
            <div
              key={nh.name}
              className={`p-4 rounded-2xl border-2 transition-all hover:shadow-md ${nh.color}`}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="font-extrabold text-slate-900 text-base">
                  {nh.name} {nh.starred && '⭐'}
                </span>
                <span className="text-[10px] font-black px-2 py-0.5 bg-white rounded-full text-slate-700 shadow-xs border">
                  {matchCount} Units
                </span>
              </div>

              <div className="text-xs font-bold text-slate-800 mb-1 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-blue-600" />
                <span>Commute: {nh.commute}</span>
              </div>

              <div className="text-xs text-slate-600 mb-2">
                <b>Lines:</b> {nh.trains}
              </div>

              <span className="inline-block text-[10px] font-bold text-slate-500 bg-white/80 px-2 py-0.5 rounded-md border border-slate-200/60">
                {nh.tag}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default App;
