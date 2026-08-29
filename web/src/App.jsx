import { useEffect, useState } from 'react';
import { Building, MapPin, DollarSign, Bed, Bath, TriangleAlert, CheckCircle, Search, ThumbsDown, Mail } from 'lucide-react';

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

  if (loading) return <div className="flex h-screen items-center justify-center text-xl font-semibold">Loading NYC AI Pipeline...</div>;

  const inbox = listings.filter(l => l.status === 'inbox');
  const applied = listings.filter(l => l.status === 'applied');
  const passed = listings.filter(l => l.status === 'passed');

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-8 font-sans">
      <div className="max-w-7xl mx-auto">
        <header className="mb-10 flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-gray-900 flex items-center gap-3">
              <Building className="w-10 h-10 text-blue-600" />
              NYC Housing AI
            </h1>
            <p className="text-gray-500 mt-2">Autonomous real-time leasing assistant & pipeline</p>
          </div>
          <div className="bg-white px-4 py-2 rounded-lg shadow-sm border border-gray-200">
            <span className="text-sm font-semibold text-gray-500 uppercase tracking-wide">AI Evaluated</span>
            <div className="text-2xl font-bold text-gray-900">{listings.length} Units</div>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <PipelineColumn title="Inbox" listings={inbox} onPass={(id) => updateStatus(id, 'passed')} onApply={(id) => updateStatus(id, 'applied')} />
          <PipelineColumn title="Contacted / Applied" listings={applied} onPass={(id) => updateStatus(id, 'passed')} onApply={null} />
          <PipelineColumn title="Passed" listings={passed} onPass={null} onApply={(id) => updateStatus(id, 'inbox')} />
        </div>
      </div>
    </div>
  );
}

function PipelineColumn({ title, listings, onPass, onApply }) {
  return (
    <div className="bg-gray-100 rounded-xl p-4 flex flex-col gap-4 border border-gray-200 shadow-inner min-h-[500px]">
      <h2 className="text-lg font-bold text-gray-700 uppercase tracking-wider mb-2 flex items-center justify-between">
        {title}
        <span className="bg-gray-200 text-gray-600 px-3 py-1 rounded-full text-sm">{listings.length}</span>
      </h2>
      
      {listings.length === 0 && (
        <div className="text-center text-gray-400 py-10 italic">Empty</div>
      )}

      {listings.map(l => {
        let redFlags = [];
        let pros = [];
        try { redFlags = JSON.parse(l.red_flags || "[]"); } catch(e){}
        try { pros = JSON.parse(l.pros || "[]"); } catch(e){}

        const scoreColor = l.suitability_score > 85 ? 'text-green-600' : l.suitability_score > 70 ? 'text-yellow-600' : 'text-red-600';

        return (
          <div key={l.id} className="bg-white rounded-xl p-5 shadow-sm border border-gray-200 hover:shadow-md transition cursor-pointer relative group overflow-hidden">
            <div className="absolute top-0 right-0 bg-blue-600 text-white font-bold px-3 py-1 rounded-bl-lg text-sm flex items-center gap-1 shadow-sm">
              <span className="text-blue-100">AI Score:</span> {l.suitability_score || 'N/A'}
            </div>

            <h3 className="font-bold text-gray-900 text-lg mb-1 pr-24 mt-2 line-clamp-1">{l.title}</h3>
            
            <div className="flex gap-4 mt-4 text-sm font-semibold text-gray-700 bg-gray-50 p-3 rounded-lg border border-gray-100">
              <div className="flex items-center gap-1">
                <DollarSign className="w-4 h-4 text-green-600" />
                <span className="text-lg">{l.true_gross_rent || l.price || '?'}</span>
              </div>
              <div className="flex items-center gap-1 text-gray-500">
                <Bed className="w-4 h-4" /> {l.bedrooms}
              </div>
              <div className="flex items-center gap-1 text-gray-500">
                <Bath className="w-4 h-4" /> {l.bathrooms}
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {l.is_fee && (
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-1 rounded w-max">
                  <TriangleAlert className="w-3 h-3" /> Broker Fee: {l.fee_estimate}
                </div>
              )}
              {redFlags.map((rf, i) => (
                <div key={i} className="flex items-center gap-2 text-xs font-semibold text-red-600 bg-red-50 px-2 py-1 rounded w-max">
                  <TriangleAlert className="w-3 h-3" /> {rf}
                </div>
              ))}
              {pros.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-xs font-semibold text-green-700 bg-green-50 px-2 py-1 rounded w-max">
                  <CheckCircle className="w-3 h-3" /> {p}
                </div>
              ))}
            </div>

            <div className="mt-6 flex gap-2">
              <a href={l.url} target="_blank" rel="noreferrer" className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg text-sm font-semibold text-center flex items-center justify-center gap-1 transition">
                <Search className="w-4 h-4" /> View
              </a>
              {onApply && (
                <button onClick={() => onApply(l.id)} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg text-sm font-semibold text-center flex items-center justify-center gap-1 transition shadow-sm">
                  <Mail className="w-4 h-4" /> Contact
                </button>
              )}
              {onPass && (
                <button onClick={() => onPass(l.id)} className="flex-none bg-red-50 hover:bg-red-100 text-red-600 p-2 rounded-lg transition" title="Pass">
                  <ThumbsDown className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default App;
