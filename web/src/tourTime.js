export const nyParts = value => {
  if (!value) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(new Date(value)).map(p => [p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
export function resolveNYTime(local,offset = '') {
  if (!local) return null;
  const candidates = ['-04:00','-05:00'].map(zone => ({ zone,date:new Date(local + ':00' + zone) })).filter(({date}) => Number.isFinite(date.getTime()) && nyParts(date) === local);
  const chosen = offset ? candidates.find(candidate => candidate.zone === offset) : candidates.length === 1 ? candidates[0] : null;
  if (!chosen) throw new Error(candidates.length > 1 ? 'This time occurs twice during the daylight-saving change. Choose EDT or EST explicitly.' : 'This New York time does not exist, or the selected UTC offset does not match the date.');
  return chosen.date.toISOString();
}
