// Isolated browser checks for the ten-feature workspace. No live backend or mail calls.
const assert = require('node:assert/strict');
const path = require('node:path');
const { calculateHousingCosts, seedCostInput } = require('../src/housing_costs');
async function main() {
  const { resolveNYTime } = await import('../web/src/tourTime.js');
  assert.equal(resolveNYTime('2026-07-01T09:00'), '2026-07-01T13:00:00.000Z');
  assert.equal(resolveNYTime('2026-11-02T09:00'), '2026-11-02T14:00:00.000Z');
  assert.throws(() => resolveNYTime('2026-03-08T02:30'), /does not exist/);
  assert.throws(() => resolveNYTime('2026-11-01T01:30'), /occurs twice/);
  assert.equal(resolveNYTime('2026-11-01T01:30', '-05:00'), '2026-11-01T06:30:00.000Z');
  const { createServer } = await import('../web/node_modules/vite/dist/node/index.js');
  const server = await createServer({ root:path.resolve('web'),server:{ host:'127.0.0.1',port:0 } });
  await server.listen(); let browser;
  const screenshotDir = process.env.SCREENSHOT_DIR;
  if (screenshotDir) await require('node:fs/promises').mkdir(screenshotDir, { recursive: true });
  try {
    browser = await require('puppeteer').launch({ headless:true,args:['--no-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width:1440,height:1100 });
    const errors = [], writes = [], routeRequests = [];
    page.on('pageerror',error => errors.push(error.message));
    await page.evaluateOnNewDocument(() => localStorage.setItem('housing-neighborhood-filter','all'));
    const listings = ['A','B'].map((id,index) => ({ id,title:`Fixture apartment ${id}`,status:'inbox',price:2500 + index*100,true_gross_rent:2500 + index*100,bedrooms:1,bathrooms:1,evaluation_status:'completed',suitability_score:85-index,availability:'active',last_verified_at:'2026-10-16T12:00:00Z',is_preferred:true,commute_address_available:false,pros:'["Daylight"]',red_flags:'[]' }));
    const preferences = { schemaVersion:1,revision:1,preferredNeighborhoods:[{name:'Chelsea',area:'Manhattan',aliases:[]}],includedAreas:['Queens'],includedAreaCommute:{ maxMinutes:20,destination:'any Manhattan arrival station' },officeCommute:{maxMinutes:null,destination:'620 8th Ave, New York, NY'},budgets:{studioOneBedroom:{enabled:true,minRent:1800,maxRent:2700,minBedrooms:0,maxBedrooms:1,minBathrooms:1},twoBedroom:{enabled:true,minRent:1800,maxRent:5000,minBedrooms:2,maxBedrooms:2,minBathrooms:2}} };
    const tours = ['A','B'].map((id,index) => ({id:`tour${id}`,revision:1,listingId:id,conversationId:null,address:`${100+index} W 23rd St, New York, NY`,brokerEmail:'fixture@example.test',startsAt:`2026-11-02T${15+index}:00:00Z`,durationMinutes:30,bufferBeforeMinutes:10,bufferAfterMinutes:10,status:index ? 'proposed':'completed',reminderMinutes:[60],conflicts:[],brokerMessagePreview:'Fixture confirmation preview'}));
    const costs = Object.fromEntries(listings.map(l => { const input = seedCostInput(l);return [l.id,{input,calculation:calculateHousingCosts(input),revision:0}]; }));
    const reviews = {A:{revision:0,review:null},B:{revision:0,review:null}};
    let saved = [], decision = null, messages = [{id:'message1',revision:1,direction:'inbound',subject:'Which apartment?',summary:'A broker manages two apartments.',sender:'fixture@example.test',at:'2026-10-16T12:00:00Z',outcome:'received',match:'ambiguous'}];
    const archivedFixtures = [
      {...listings[0],id:'passed',title:'Passed high-rated apartment',status:'passed',selection:{saved:true},activeCandidate:false,shortlist_status:'passed',review:{review:{rating:5}},decision:{action:'pass',reason:'Passed despite excellent daylight.'}},
      {...listings[0],id:'unsaved',title:'Unsaved former finalist',selection:{saved:false},activeCandidate:false,shortlist_status:'unsaved',review:{review:{rating:5}},decision:{action:'shortlist',reason:'Removed from consideration.'}}
    ];
    const archivedActivity = archivedFixtures.map(listing=>({listing_id:listing.id,action:listing.decision.action,reason:listing.decision.reason,created_at:'2026-10-16T11:00:00Z'}));
    const enrich = listing => ({...listing,selection:{saved:saved.includes(listing.id)},costs:costs[listing.id],review:reviews[listing.id],decision:listing.id === 'A' ? decision:null});
    await page.setRequestInterception(true);
    page.on('request', async req => {
      const url = new URL(req.url()), route = url.pathname;
      if (!route.startsWith('/api/')) return req.continue();
      const headers = {'access-control-allow-origin':'*','access-control-allow-headers':'Authorization,Content-Type','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS'};
      if(req.method()==='OPTIONS') return req.respond({status:204,headers});
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      const authenticated = req.headers().authorization === 'Bearer fixture-owner-token';
      let result, status=200;
      if (['POST','PUT','DELETE'].includes(req.method())) { writes.push({route,body,authenticated}); if(!authenticated) {status=401;result={error:'Owner access required'};} }
      if(!result) {
        if(route==='/api/owner/session') result={configured:true,authenticated};
        else if(route==='/api/listings') result=listings;
        else if(route==='/api/tours') result=[];
        else if(route==='/api/stats') result={evaluation:{completed:2}};
        else if(route==='/api/commute/status') result={available:false,code:'unconfigured'};
        else if(route==='/api/preferences/preview') result={revision:1,total:2,matching:1,excluded:1,listings:listings.map((l,i)=>({...l,matches:!i,reasons:i?['Rent above budget']:[],scoreOutdated:true}))};
        else if(route==='/api/preferences') {if(req.method()==='PUT')Object.assign(preferences,body,{revision:preferences.revision+1});result=preferences;}
        else if(route==='/api/watchlist') result={listings:listings.filter(l=>saved.includes(l.id)).map(enrich)};
        else if(route.startsWith('/api/watchlist/')) {const id=route.split('/').pop();saved=body.saved?[...new Set([...saved,id])]:saved.filter(value=>value!==id);result={id,saved:body.saved};}
        else if(route==='/api/compare')result={listings:url.searchParams.get('ids').split(',').map(id=>enrich(listings.find(l=>l.id===id)))};
        else if(route.endsWith('/insights')||route.endsWith('/recheck'))result={availability:'active',explanation:'Source recently observed the listing.',sources:[{id:'s1',source:'Fixture source',availability:'active',observed_at:'2026-10-16T12:00:00Z',evidence:'Listing page active'}],price_history:[{id:'p1',observed_at:'2026-10-16T12:00:00Z',advertised_rent:2500,advertised_basis:'net_effective',verified_gross_rent:null,effective_rent:2500,terms_status:'unverified'}]};
        else if(route.endsWith('/costs')) {const id=route.split('/')[3];if(req.method()==='PUT') costs[id]={input:body.input,calculation:calculateHousingCosts(body.input),revision:costs[id].revision+1};result=costs[id];}
        else if(route.endsWith('/review')) {const id=route.split('/')[3];if(req.method()==='PUT') reviews[id]={revision:reviews[id].revision+1,review:body};result=reviews[id];}
        else if(route.endsWith('/decision')) {decision={...body,revision:1,listing_id:'A',created_at:'2026-10-16T12:00:00Z'};result=decision;}
        else if(route==='/api/decisions') result={listings:[...archivedFixtures,...listings.filter(l=>saved.includes(l.id)||decision&&l.id==='A').map(l=>({...enrich(l),activeCandidate:saved.includes(l.id),shortlist_status:saved.includes(l.id)?'active':'unsaved'}))],activity:[...(decision?[decision]:[]),...archivedActivity]};
        else if(route==='/api/conversations/unassigned')result={messages};
        else if(route.endsWith('/conversation'))result={listingId:'A',messages:[],unassignedCount:messages.length};
        else if(route.endsWith('/assignment')) {result={...messages[0],listingId:body.listingId};messages=[];}
        else if(route==='/api/schedule')result={timeZone:'America/New_York',tours,conflicts:[]};
        else if(route.endsWith('/schedule')) {const tour=tours.find(t=>t.id===route.split('/')[3]);Object.assign(tour,body,{revision:tour.revision+1});result=tour;}
        else if(route==='/api/itineraries/plan') {routeRequests.push(body);result={status:'unresolved',label:'Suggested itinerary needs review',createdAt:'2026-10-16T12:00:00Z',legs:[{from:body.startAddress,to:tours[0].address,durationMinutes:null,status:'unresolved',reason:'Fixture route not available'}],excluded:[]};}
        else if(route==='/api/health')result={checkedAt:'2026-10-16T12:00:00Z',workers:[{name:'Scoring worker',status:'stale',heartbeatAt:'2026-10-16T11:00:00Z',lastSuccessAt:'2026-10-16T10:00:00Z',backlog:2,recentRuns:[{at:'2026-10-16T10:30:00Z',status:'degraded',error:'Fixture earlier cycle failure',backlog:3},{at:'2026-10-16T10:00:00Z',status:'healthy',lastSuccessAt:'2026-10-16T10:00:00Z',backlog:2}]}],sources:[{source:'Fixture source',feed:'Manhattan',status:'blocked',at:'2026-10-16T12:00:00Z',count:0,error:'Access blocked'}]};
        else {status=404;result={error:`Unhandled fixture ${route}`};}
      }
      await req.respond({status,contentType:'application/json',headers,body:JSON.stringify(result)});
    });
    const click = async (text,exact=true) => {await page.waitForFunction((text,exact)=>[...document.querySelectorAll('button')].some(b=>(exact?b.textContent.trim()===text:b.textContent.includes(text))&&!b.disabled),{},text,exact);await page.evaluate((text,exact)=>[...document.querySelectorAll('button')].find(b=>(exact?b.textContent.trim()===text:b.textContent.includes(text))&&!b.disabled).click(),text,exact);};
    const has = text=>page.waitForFunction(text=>document.body.innerText.includes(text),{},text);
    const input = async (label,value) => { await page.waitForFunction(label => [...document.querySelectorAll('label')].some(l => l.firstChild?.textContent?.trim() === label && l.querySelector('input,textarea,select')), {}, label); return page.evaluate((label,value)=>{const node=[...document.querySelectorAll('label')].find(l=>l.firstChild?.textContent?.trim()===label)?.querySelector('input,textarea,select');if(!node)throw Error('Missing field '+label);const setter=Object.getOwnPropertyDescriptor(node instanceof HTMLSelectElement?HTMLSelectElement.prototype:node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));},label,value); };
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port);
    await has('Fixture apartment A');
    assert.equal(await page.$eval('[aria-label="Save Fixture apartment A"]',e=>e.disabled),true);
    await page.type('[aria-label="Owner token"]','fixture-owner-token');await click('Unlock');await has('Owner access unlocked');
    assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('fixture-owner-token')),false);
    await page.click('[aria-label="Save Fixture apartment A"]');await page.waitForSelector('[aria-label="Unsave Fixture apartment A"]');
    await page.click('[aria-label="Save Fixture apartment B"]');await page.waitForSelector('[aria-label="Unsave Fixture apartment B"]');
    await click('Saved & compare');await has('Saving an apartment');await page.click('[aria-label="Compare Fixture apartment A"]');await page.click('[aria-label="Compare Fixture apartment B"]');await click('Compare 2 apartments');await has('Gross monthly rent');assert.equal(routeRequests.length,0);
    await click('Open apartment');await has('Listing evidence');await has('net effective');await click('Recheck listing');await has('Recheck requested');
    if (screenshotDir) await page.screenshot({ path:path.join(screenshotDir,'housing-product-desktop.png') });
    await click('Costs');await has('Total housing cost');await input('Lease length (months)','12');await input('Gross monthly rent','2500');await input('Free rent (months)','0');await input('Total rent credit','0');await input('Rent months paid before move-in','1');await input('Credit used before move-in','0');await input('Rent evidence','confirmed');await click('Save & calculate costs');await has('Cost assumptions and breakdown saved');
    await click('Viewing & decision');await has('Post-tour observations');await input('Completed tour','tourA');await input('daylight','5');await input('Viewing notes','Sunny, quiet courtyard.');await input('Your overall rating','4');await click('Save viewing review');await has('Viewing notes saved');await input('Decision reason','Strong daylight and manageable costs.');await click('Record decision');await has('Decision recorded');await page.click('[aria-label="Close apartment details"]');
    await click('Decisions'); await has('Archived decisions');
    const finalists = await page.$eval('[aria-label="Active final shortlist"]',node=>node.innerText);
    assert.ok(finalists.includes('Fixture apartment A')); assert.ok(!finalists.includes('Passed high-rated apartment')); assert.ok(!finalists.includes('Unsaved former finalist'));
    const archive = await page.$eval('[aria-label="Archived decisions"]',node=>node.innerText);
    for(const text of ['Passed high-rated apartment','Unsaved former finalist','Passed · archived','Unsaved · archived']) assert.ok(archive.includes(text),text);
    await has('Decision activity'); await has('Passed despite excellent daylight.'); await has('Removed from consideration.');
    await click('Search preferences');await has('Search preferences');await click('Preview matches');await has('1 matching');await click('Save search preferences');await has('Search revision 2 saved');
    await click('Broker inbox');await has('Which apartment?');await page.select('[aria-label="Assign apartment for Which apartment?"]','A');await click('Assign reply');await has('No unassigned replies');
    await click('Tours & Calendar',false);await has('Plan a tour day');assert.equal(routeRequests.length,0);await click('Edit schedule');await has('Edit showing');await input('Showing starts (New York)','2026-11-02T10:15');await click('Save schedule');await has('10:15');await page.click('[aria-label="Plan route to 100 W 23rd St, New York, NY"]');await page.click('[aria-label="Plan route to 101 W 23rd St, New York, NY"]');await input('Starting address','Penn Station, New York');await input('Leave starting point (New York)','2026-11-02T09:00');await click('Plan itinerary');await has('Travel time unresolved');assert.equal(routeRequests.length,1);assert.equal(routeRequests[0].departureAt,'2026-11-02T14:00:00.000Z');
    await click('Worker health');await has('Scoring worker');await has('stale');await has('Access blocked'); await page.click('details summary'); await has('Fixture earlier cycle failure'); await has('Recent operations (2)');
    await page.setViewport({width:390,height:844});await click('Saved & compare');await has('Saved apartments');const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('.product-tabs')).slice(0,8).map(el => ({tag:el.tagName,class:el.className,text:el.textContent.slice(0,50)}))); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'Mobile view fits viewport: '+JSON.stringify(overflow));
    if (screenshotDir) {
      await page.evaluate(() => [...document.querySelectorAll('h2')].find(node => node.textContent === 'Saved apartments').scrollIntoView({ block:'start' }));
      await page.screenshot({ path:path.join(screenshotDir,'housing-product-mobile.png') });
    }
    assert.ok(writes.length>=8);assert.ok(writes.every(write=>write.authenticated));assert.deepEqual(errors,[]);
    await click('Tours & Calendar',false); await has('fixture@example.test');
    await click('Edit schedule'); await click('Preview broker confirmation'); await has('Fixture confirmation preview');
    await click('Lock'); await has('Unlock owner access to change schedules');
    const lockedToursText = await page.$eval('body',node => node.innerText);
    for (const privateText of ['fixture@example.test','100 W 23rd St','101 W 23rd St','Fixture confirmation preview','Edit showing','Plan a tour day']) assert.ok(!lockedToursText.includes(privateText), `Lock hides ${privateText}`);
    for (const tab of ['Saved & compare','Decisions','Broker inbox','Search preferences']) {
      await click(tab); await has('Unlock owner access above');
      const lockedText = await page.$eval('body',node => node.innerText);
      for (const privateText of ['Sunny, quiet courtyard.','Strong daylight and manageable costs.','Which apartment?']) assert.ok(!lockedText.includes(privateText), `${tab} hides private details`);
    }
    await click('Pipeline Kanban'); await has('Fixture apartment A'); await click('Details & decisions',false); await click('Costs'); await has('Unlock owner access above');
    assert.equal(await page.$('form button.primary'),null,'Locked cost panel does not expose an editor');
    await page.click('[aria-label="Close apartment details"]');
    console.log('Product dashboard checks passed: owner token, save/compare, freshness, costs, review/decision, preferences, assignment, schedule, explicit route plan, health, mobile.');
  } finally {await browser?.close();await server.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
