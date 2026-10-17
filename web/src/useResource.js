import { useCallback, useEffect, useRef, useState } from 'react';
import { requestApi } from './api';
export function useResource(path, enabled = true) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    if (!enabled || !path) { setData(null); return; }
    setLoading(true); setError('');
    try { const next = await requestApi(path); if (seq === sequence.current) setData(next); }
    catch (err) { if (seq === sequence.current) setError(err.message); }
    finally { if (seq === sequence.current) setLoading(false); }
  }, [path, enabled]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void refresh(); });
    return () => { active = false; };
  }, [refresh]);
  return { data, error, loading, refresh, setData };
}
