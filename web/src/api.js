export const apiBase = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');
let ownerToken = '';
export function setOwnerToken(value) { ownerToken = value; }
export async function requestApi(path, options = {}) {
  const headers = new Headers(options.headers);
  if (ownerToken) headers.set('Authorization', `Bearer ${ownerToken}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(apiBase + path, { ...options, headers, cache: 'no-store' });
  let data;
  try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
  if (!response.ok || data.success === false) {
    const error = new Error(data.error || data.reason || 'Request failed');
    error.code = data.code; error.status = response.status; throw error;
  }
  return data;
}
export async function downloadApi(path, name) {
  const response = await fetch(apiBase + path, { headers: ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}, cache: 'no-store' });
  if (!response.ok) throw new Error('Calendar download unavailable. Select an exact tour time first.');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
