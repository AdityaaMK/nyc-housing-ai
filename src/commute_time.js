const TIME_ZONE = 'America/New_York';
const parts = at => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).formatToParts(new Date(at)).map(p => [p.type, p.value]));
function localTimeUtc(year, month, day, hour = 0) {
    const wall = Date.UTC(year, month - 1, day, hour);
    let at = wall;
    for (let i = 0; i < 3; i++) {
        const p = parts(at);
        at += wall - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    }
    return at;
}
function dayStart(at) {
    const p = parts(at);
    return localTimeUtc(+p.year, +p.month, +p.day);
}
function nextWeekdayArrival(at = Date.now()) {
    const p = parts(at);
    const date = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
    do { date.setUTCDate(date.getUTCDate() + 1); } while ([0, 6].includes(date.getUTCDay()));
    return new Date(localTimeUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 9)).toISOString();
}
module.exports = { TIME_ZONE, dayStart, nextWeekdayArrival };
