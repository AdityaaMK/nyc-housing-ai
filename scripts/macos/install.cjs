'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function startupPaths({ home = os.homedir(), username = os.userInfo().username, pm2Home = process.env.PM2_HOME || path.join(home, '.pm2') } = {}) {
    const label = `com.${username.replace(/[^a-zA-Z0-9.-]/g, '-')}.nyc-housing-ai`;
    const directory = path.join(home, 'Library/Application Support/NYC Housing AI');
    return { label, directory, pm2Home, script: path.join(directory, 'ensure-running.cjs'), plist: path.join(home, 'Library/LaunchAgents', `${label}.plist`) };
}

function renderLaunchAgent(paths, nodePath = process.execPath) {
    const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const string = value => `<string>${escape(value)}</string>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${string(paths.label)}
  <key>ProgramArguments</key><array>${string(nodePath)}${string(paths.script)}</array>
  <key>WorkingDirectory</key>${string(paths.directory)}
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key>${string(path.dirname(nodePath) + ':/usr/bin:/bin:/usr/sbin:/sbin')}
    <key>PM2_HOME</key>${string(paths.pm2Home)}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key><dict/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key>${string(path.join(paths.pm2Home, 'logs/housing-autostart-out.log'))}
  <key>StandardErrorPath</key>${string(path.join(paths.pm2Home, 'logs/housing-autostart-error.log'))}
</dict></plist>
`;
}

function launchctl(...args) {
    const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || `launchctl ${args[0]} failed`);
}

function main(args = process.argv.slice(2)) {
    if (args.some(arg => !['--print', '--uninstall'].includes(arg)) || args.length > 1) throw new Error('Usage: node scripts/macos/install.cjs [--print | --uninstall]');
    const paths = startupPaths();
    if (args.includes('--print')) { console.log(renderLaunchAgent(paths)); return; }
    if (process.platform !== 'darwin') throw new Error('Automatic login startup is supported on macOS only.');
    const domain = `gui/${process.getuid()}`, target = `${domain}/${paths.label}`;
    const loaded = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8' }).status === 0;
    if (args.includes('--uninstall')) {
        launchctl('disable', target);
        if (loaded) launchctl('bootout', target);
        fs.rmSync(paths.plist, { force: true });
        console.log('Automatic recovery disabled. Existing PM2 services have not been stopped.');
        return;
    }
    const dump = path.join(paths.pm2Home, 'dump.pm2');
    if (!fs.existsSync(dump)) throw new Error('Start the desired housing services and run pm2 save before installing automatic startup.');
    const saved = JSON.parse(fs.readFileSync(dump, 'utf8'));
    if (!saved.some(app => ['housing-daemon', 'housing-scraper', 'housing-api', 'housing-scorer', 'housing-telegram', 'housing-inbox'].includes(app.name) && app.status !== 'stopped')) {
        throw new Error('No active housing services in the saved PM2 list. Start them and run pm2 save first.');
    }
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.mkdirSync(path.dirname(paths.plist), { recursive: true });
    fs.mkdirSync(path.join(paths.pm2Home, 'logs'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'ensure-running.cjs'), paths.script);
    fs.chmodSync(paths.script, 0o644);
    fs.writeFileSync(paths.plist, renderLaunchAgent(paths), { mode: 0o644 });
    if (loaded) launchctl('bootout', target);
    launchctl('enable', target);
    launchctl('bootstrap', domain, paths.plist);
    console.log(`Enabled ${paths.label}: automatic recovery at login, every minute, and after wake.`);
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { startupPaths, renderLaunchAgent };
