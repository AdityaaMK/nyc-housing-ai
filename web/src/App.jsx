import { useEffect, useState } from 'react';
import { Building, DollarSign, Bed, Bath, TriangleAlert, CheckCircle, Search, ThumbsDown, Mail, Activity } from 'lucide-react';

function App() {
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchListings();
  }, []);

  const fetchListings = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/listings');
      const data = await res.json();
      setListings(data);
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
      fetchListings();
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-4 animate-pulse">
        <Activity className="w-12 h-12 text-blue-500 animate-spin" />
        <div className="text-xl font-semibold text-slate-600">Loading NYC Pipeline...</div>
      </div>
    </div>
  );

  const inbox = listings.filter(l => l.status === 'inbox');
  const applied = listings.filter(l => l.status === 'applied');
  const passed = listings.filter(l => l.status === 'passed');

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-indigo-50/50 text-slate-900 p-6 md:p-10 font-sans selection:bg-indigo-100">
      <div className="max-w-[1400px] mx-auto">
        
        {/* HEADER */}
        <header className="mb-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 bg-white/80 backdrop-blur-xl p-6 rounded-3xl shadow-sm border border-white">
          <div className="flex items-center gap-5">
            <div className="p-3.5 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl shadow-lg shadow-indigo-200">
              <Building className="w-8 h-8 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight text-slate-800">NYC Housing AI</h1>
              <p className="text-slate-500 font-medium mt-1">Real-time autonomous leasing pipeline</p>
            </div>
          </div>
          <div className="flex items-center gap-6 bg-slate-50/80 px-6 py-3 rounded-2xl border border-slate-100">
            <div>
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-1">Evaluated</span>
              <div className="text-3xl font-black text-slate-700 leading-none">{listings.length}</div>
            </div>
            <div className="w-px h-10 bg-slate-200"></div>
            <div>
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-1">Inbox</span>
              <div className="text-3xl font-black text-blue-600 leading-none">{inbox.length}</div>
            </div>
          </div>
        </header>

        {/* PIPELINE GRID */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <PipelineColumn 
            title="📥 Inbox" 
            listings={inbox} 
            theme="blue"
            onPass={(id) => updateStatus(id, 'passed')} 
            onApply={(id) => updateStatus(id, 'applied')} 
          />
          <PipelineColumn 
            title="✉️ Contacted" 
            listings={applied} 
            theme="indigo"
            onPass={(id) => updateStatus(id, 'passed')} 
            onApply={null} 
          />
          <PipelineColumn 
            title="🚫 Passed" 
            listings={passed} 
            theme="slate"
            onPass={null} 
            onApply={(id) => updateStatus(id, 'inbox')} 
          />
        </div>

      </div>
    </div>
  );
}

function PipelineColumn({ title, listings, theme, onPass, onApply }) {
  const themes = {
    blue: {
      bg: "bg-blue-50/50",
      border: "border-blue-100",
      headerText: "text-blue-800",
      countBg: "bg-blue-100 text-blue-700"
    },
    indigo: {
      bg: "bg-indigo-50/50",
      border: "border-indigo-100",
      headerText: "text-indigo-800",
      countBg: "bg-indigo-100 text-indigo-700"
    },
    slate: {
      bg: "bg-slate-100/50",
      border: "border-slate-200",
      headerText: "text-slate-700",
      countBg: "bg-slate-200 text-slate-600"
    }
  };

  const t = themes[theme];

  return (
    <div className={`rounded-3xl p-5 flex flex-col gap-5 border shadow-sm min-h-[70vh] ${t.bg} ${t.border}`}>
      <div className="flex items-center justify-between px-2">
        <h2 className={`text-lg font-bold tracking-wide ${t.headerText}`}>{title}</h2>
        <span className={`px-3 py-1 rounded-full text-sm font-bold shadow-sm border border-white/50 ${t.countBg}`}>
          {listings.length}
        </span>
      </div>
      
      {listings.length === 0 && (
        <div className="m-auto text-center p-8 border-2 border-dashed border-slate-300 rounded-2xl bg-white/40">
          <div className="text-slate-400 font-medium">Nothing here yet</div>
        </div>
      )}

      <div className="flex flex-col gap-5">
        {listings.map(l => <ListingCard key={l.id} l={l} onPass={onPass} onApply={onApply} />)}
      </div>
    </div>
  );
}

function ListingCard({ l, onPass, onApply }) {
  let redFlags = [];
  let pros = [];
  try { redFlags = JSON.parse(l.red_flags || "[]"); } catch(e){}
  try { pros = JSON.parse(l.pros || "[]"); } catch(e){}

  // Score Badge Styling
  const getScoreColor = (score) => {
    if (!score) return 'from-slate-400 to-slate-500';
    if (score >= 85) return 'from-emerald-500 to-teal-600 shadow-emerald-200';
    if (score >= 70) return 'from-amber-400 to-orange-500 shadow-amber-200';
    return 'from-rose-500 to-red-600 shadow-rose-200';
  };

  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-2xl p-5 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 border border-slate-100 relative group">
      
      {/* Floating Score Badge */}
      <div className={`absolute -top-3 -right-3 bg-gradient-to-br text-white font-black px-4 py-1.5 rounded-xl shadow-lg border-2 border-white flex items-center gap-1 ${getScoreColor(l.suitability_score)}`}>
        <span className="text-[10px] uppercase tracking-wider opacity-90 mr-1">Score</span>
        {l.suitability_score || '?'}
      </div>

      <h3 className="font-extrabold text-slate-800 text-lg mb-4 pr-16 leading-tight line-clamp-2">
        {l.title}
      </h3>
      
      {/* Quick Stats Bar */}
      <div className="flex flex-wrap gap-2 text-sm font-bold text-slate-700 bg-slate-50/80 p-3 rounded-xl border border-slate-100">
        <div className="flex items-center gap-1 bg-white px-2 py-1 rounded-md shadow-sm border border-slate-100">
          <DollarSign className="w-4 h-4 text-emerald-600" />
          <span className="text-base">{l.true_gross_rent || l.price || '???'}</span>
        </div>
        <div className="flex items-center gap-1.5 bg-white px-2 py-1 rounded-md shadow-sm border border-slate-100">
          <Bed className="w-4 h-4 text-slate-400" /> {l.bedrooms}
        </div>
        <div className="flex items-center gap-1.5 bg-white px-2 py-1 rounded-md shadow-sm border border-slate-100">
          <Bath className="w-4 h-4 text-slate-400" /> {l.bathrooms}
        </div>
      </div>

      {/* Tags */}
      <div className="mt-4 flex flex-wrap gap-2">
        {l.is_fee && (
          <div className="flex items-center gap-1.5 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200/50 px-2.5 py-1 rounded-lg">
            <TriangleAlert className="w-3.5 h-3.5" /> Fee: {l.fee_estimate}
          </div>
        )}
        {redFlags.map((rf, i) => (
          <div key={`rf-${i}`} className="flex items-center gap-1.5 text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200/50 px-2.5 py-1 rounded-lg">
            <TriangleAlert className="w-3.5 h-3.5" /> {rf}
          </div>
        ))}
        {pros.map((p, i) => (
          <div key={`p-${i}`} className="flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200/50 px-2.5 py-1 rounded-lg">
            <CheckCircle className="w-3.5 h-3.5" /> {p}
          </div>
        ))}
      </div>

      {/* Action Buttons */}
      <div className="mt-6 flex gap-2 pt-4 border-t border-slate-100">
        <a href={l.url} target="_blank" rel="noreferrer" className="flex-1 bg-slate-50 hover:bg-slate-100 text-slate-600 py-2.5 rounded-xl text-sm font-bold text-center flex items-center justify-center gap-2 transition-colors border border-slate-200">
          <Search className="w-4 h-4" /> View
        </a>
        
        {onApply && (
          <button onClick={() => onApply(l.id)} className="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white py-2.5 rounded-xl text-sm font-bold text-center flex items-center justify-center gap-2 transition-all shadow-md shadow-blue-200">
            <Mail className="w-4 h-4" /> Contact
          </button>
        )}
        
        {onPass && (
          <button onClick={() => onPass(l.id)} className="flex-none bg-rose-50 hover:bg-rose-100 text-rose-600 p-2.5 rounded-xl transition-colors border border-rose-100" title="Pass">
            <ThumbsDown className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}

export default App;
