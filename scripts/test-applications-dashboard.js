// Browser walkthrough with the real application service and isolated SQLite; no live services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { createFeatureStore } = require('../src/feature_store');
const { createApplicationService, seedApplication } = require('../src/applications');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-application-browser-'));
  const db = new DatabaseSync(path.join(directory, 'applications.sqlite'));
  db.exec('CREATE TABLE feature_records(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(collection,id))');
  const store = createFeatureStore({ backend:'sqlite', async query(sql,params = []) {
    const values = [], converted = sql.replace(/\$(\d+)/g,(_,index) => { values.push(params[+index - 1]); return '?'; });
    const statement = db.prepare(converted);
    if (/^SELECT/.test(converted) || /RETURNING/.test(converted)) { const rows = statement.all(...values); return { rows,rowCount:rows.length }; }
    return { rows:[],rowCount:Number(statement.run(...values).changes) };
  } });
  const listings = ['A','B'].map((id,index) => ({ id,title:`Application apartment ${id}`,status:'applied',price:2500 + index * 100,bedrooms:1,bathrooms:1,suitability_score:85,availability:'active',is_preferred:true,commute_address_available:false,evaluation_status:'completed',pros:'[]',red_flags:'[]' }));
  const applications = createApplicationService({ store,repository:{ async getListing(id) { return { rows:listings.filter(listing => listing.id === id) }; } } });
  const second = seedApplication(); second.offer.monthlyRent = 2600;
  await applications.update('B',{ revision:0,application:second });
  await store.create('conversation_messages','reply-A',{ listingId:'A',direction:'inbound',at:'2026-10-17T15:00:00Z',summary:'Broker confirmed a private application detail.' });
  await store.create('decisions','A',{ history:[{id:'decision-A',listing_id:'A',created_at:'2026-10-17T14:00:00Z',action:'apply',reason:'Private decision: pursue this apartment.'}] });
  const { createServer } = await import('../web/node_modules/vite/dist/node/index.js');
  const server = await createServer({ root:path.resolve('web'),server:{host:'127.0.0.1',port:0} });
  let browser;
  try {
    await server.listen();
    browser = await require('puppeteer').launch({ headless:true,args:['--no-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({width:1440,height:1100});
    const errors = [], writes = [], privateReads = [];
    page.on('pageerror',error => errors.push(error.message));
    await page.evaluateOnNewDocument(() => localStorage.setItem('housing-neighborhood-filter','all'));
    await page.setRequestInterception(true);
    page.on('request',async request => {
      const url = new URL(request.url()), route = url.pathname;
      if (!route.startsWith('/api/')) return request.continue();
      const headers = {'access-control-allow-origin':'*','access-control-allow-headers':'Authorization,Content-Type','access-control-allow-methods':'GET,POST,PUT,OPTIONS'};
      if (request.method() === 'OPTIONS') return request.respond({status:204,headers});
      const authenticated = request.headers().authorization === 'Bearer fixture-owner-token', body = request.postData() ? JSON.parse(request.postData()) : null;
      let result, status = 200;
      try {
        if (route.includes('/application')) {
          if (!authenticated) throw Object.assign(new Error('Owner access required'),{status:401});
          privateReads.push({route,authenticated});
        }
        if (request.method() === 'PUT') writes.push({route,body,authenticated});
        if (route === '/api/owner/session') result = {configured:true,authenticated};
        else if (route === '/api/listings') result = listings;
        else if (route === '/api/tours') result = [];
        else if (route === '/api/stats') result = {evaluation:{completed:2}};
        else if (route === '/api/commute/status') result = {available:false,code:'unconfigured'};
        else if (route === '/api/preferences') result = {preferredNeighborhoods:[],includedAreas:[]};
        else if (route === '/api/watchlist') result = {listings:[]};
        else if (route === '/api/applications') result = await applications.list();
        else if (route === '/api/applications/compare') result = await applications.compare(url.searchParams.get('ids').split(','));
        else if (/^\/api\/listings\/[^/]+\/application$/.test(route)) {
          const id = route.split('/')[3];
          result = request.method() === 'PUT' ? await applications.update(id,body) : await applications.get(id);
        }
        else if (route.endsWith('/insights')) result = {sources:[],price_history:[],availability:'unverified'};
        else throw Object.assign(new Error(`Unhandled fixture ${route}`),{status:404});
      } catch (error) { status = error.status || 500; result = {error:error.message,code:error.code}; }
      await request.respond({status,contentType:'application/json',headers,body:JSON.stringify(result)});
    });
    const has = text => page.waitForFunction(text => document.body.innerText.includes(text),{},text);
    const click = async text => { await page.waitForFunction(text => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === text && !button.disabled),{},text); await page.evaluate(text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text && !button.disabled).click(),text); };
    const input = async (label,value) => {
      await page.waitForFunction(label => [...document.querySelectorAll('label')].some(node => node.firstChild?.textContent?.trim() === label && node.querySelector('input,textarea,select')),{},label);
      await page.evaluate((label,value) => {
        const element = [...document.querySelectorAll('label')].find(node => node.firstChild?.textContent?.trim() === label).querySelector('input,textarea,select');
        const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value); element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true}));
      },label,value);
    };
    const buttonDisabled = text => page.evaluate(text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text)?.disabled,text);
    await page.goto('http://127.0.0.1:' + server.httpServer.address().port);
    await has('Application apartment A'); await click('Applications'); await has('Unlock owner access above'); assert.equal(privateReads.length,0);
    await page.type('[aria-label="Owner token"]','fixture-owner-token'); await click('Unlock'); await has('Applications & offers');
    await input('Apartment to track','A'); await click('Open application tracker'); await has('Document checklist');
    await has('Broker confirmed a private application detail.'); await has('Private decision: pursue this apartment.');
    assert.equal((await applications.get('A')).revision,0,'Opening the tracker does not create a record');
    assert.equal(await page.$eval('[aria-label="Application documents"]',node => node.innerText.includes('0 required documents missing')),true);
    await page.evaluate(() => document.querySelector('[aria-label="Application documents"] input[type=checkbox]').click());
    await page.waitForFunction(() => document.querySelector('[aria-label="Application documents"]').innerText.includes('1 required documents missing'));
    await input('Readiness for Photo ID','ready');
    await page.waitForFunction(() => document.querySelector('[aria-label="Application documents"]').innerText.includes('0 required documents missing'));
    await input('Application notes','Private application note to preserve.');
    await input('Offered monthly rent','2500'); await input('Other monthly fees','0');
    await click('Add deadline'); await input('Deadline time (New York)','2026-11-01T01:30');
    await click('Create application tracker'); await has('This time occurs twice'); assert.equal((await applications.get('A')).revision,0);
    await input('Deadline daylight-saving offset','-05:00'); await click('Create application tracker'); await has('Application saved · Preparing.');
    let saved = await applications.get('A'); assert.equal(saved.application.deadlines[0].dueAt,'2026-11-01T06:30:00.000Z');
    assert.equal(saved.application.offer.monthlyFees,0); assert.equal(saved.application.offer.oneTimeFees,null); assert.equal(saved.activity.length,1);
    await input('Recorded application stage','submitted'); await has('I have already submitted this application.');
    assert.equal(await buttonDisabled('Save application'),true,'Submission requires an explicit acknowledgment');
    await page.evaluate(() => [...document.querySelectorAll('label')].find(label => label.textContent.includes('I have already submitted this application.')).querySelector('input').click());
    await click('Save application'); await has('Application saved · Submitted.'); await has('Preparing → Submitted');
    saved = await applications.get('A'); assert.equal(saved.application.stage,'submitted'); assert.equal(listings[0].status,'applied','Recorded submission does not mutate the legacy listing pipeline');
    await input('Application notes','Draft must survive a concurrent update.');
    await applications.update('A',{revision:saved.revision,application:{...saved.application,notes:'Saved externally while this tab was editing.'}});
    await click('Save application'); await has('Your unsaved draft is kept below.');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('label')].find(label => label.firstChild?.textContent?.trim() === 'Application notes').querySelector('textarea').value),'Draft must survive a concurrent update.');
    assert.equal(await buttonDisabled('Save application'),true); assert.equal((await applications.get('A')).application.notes,'Saved externally while this tab was editing.');
    await click('Reload latest and discard this draft'); await has('Latest application loaded.');
    await page.waitForFunction(() => [...document.querySelectorAll('label')].find(label => label.firstChild?.textContent?.trim() === 'Application notes').querySelector('textarea').value === 'Saved externally while this tab was editing.');
    await click('Close application editor'); await click('Refresh applications');
    await page.click('[aria-label="Compare offer for Application apartment A"]'); await page.click('[aria-label="Compare offer for Application apartment B"]'); await click('Compare 2 offers'); await has('Offer comparison');
    const row = label => page.$eval('[aria-label="Offer comparison"]', (section,label) => [...section.querySelectorAll('tr')].find(tr => tr.firstElementChild.textContent === label).innerText,label);
    assert.match(await row('Monthly fees'),/\$0/); assert.match(await row('Monthly fees'),/Unknown/); assert.match(await row('One-time fees'),/Unknown/);
    await page.setViewport({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false,'Mobile comparison scrolls inside its panel');
    await page.click('[aria-label="Edit application for Application apartment A"]'); await has('Application tracker');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false,'Mobile form fits the viewport');
    if (process.env.SCREENSHOT_DIR) { fs.mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true}); await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,'housing-applications-mobile.png')}); }
    await click('Lock'); await has('Unlock owner access above');
    let locked = await page.$eval('body',node => node.innerText);
    for (const privateText of ['Saved externally while this tab was editing.','Broker confirmed a private application detail.','Private decision: pursue this apartment.','Application tracker','Offer comparison']) assert.equal(locked.includes(privateText),false,`Lock hides ${privateText}`);
    await click('Pipeline Kanban'); await has('Application apartment A');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Details & decisions')).click());
    await click('Application'); await has('Unlock owner access above');
    assert.equal(await page.$('form button.primary'),null,'Locked drawer exposes no application editor');
    await page.click('[aria-label="Close apartment details"]');
    await page.type('[aria-label="Owner token"]','fixture-owner-token'); await click('Unlock');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Details & decisions')).click());
    await click('Application'); await has('Application tracker'); await has('Broker confirmed a private application detail.');
    assert.ok(writes.length >= 3); assert.ok(writes.every(write => write.authenticated)); assert.ok(privateReads.every(read => read.authenticated));
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('fixture-owner-token') || JSON.stringify(sessionStorage).includes('fixture-owner-token')),false);
    assert.deepEqual(errors,[]);
    console.log('Applications dashboard passed: actual SQLite service, owner access, suggested checklist, explicit stages, DST deadlines, null vs zero offers, comparison, conflict-retained drafts, activity, lock, drawer, and mobile.');
  } finally { await browser?.close(); await server.close(); db.close(); fs.rmSync(directory,{recursive:true,force:true}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
