'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium } = require('playwright');
const { appendBrowserCoverage, closeServer, startFixtureServer } = require('../test_import_picker_e2e.cjs');
async function scenario(run) {
  const fixture = await startFixtureServer(); let browser, context, page; const calls = [], errors=[];
  try {
    browser = await chromium.launch(); context = await browser.newContext({ viewport: { width: 1440, height: 960 } }); page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    if (process.env.MOZARIE_JS_COVERAGE === '1') await page.coverage.startJSCoverage({ resetOnNavigation: false });
    const source = await page.evaluate(() => { const canvas=document.createElement('canvas'); canvas.width=100; canvas.height=80; const c=canvas.getContext('2d'); c.fillStyle='#fff'; c.fillRect(0,0,100,80); return canvas.toDataURL().split(',')[1]; });
    await page.route('**/api/image/*', route => route.fulfill({ contentType:'image/png', body:Buffer.from(source,'base64') }));
    await page.route('**/api/images/*/area-fill', async route => {
      calls.push(route.request().postDataJSON()); await route.fulfill({ json: { ok:true, changed:false } });
    });
    await page.goto(fixture.url, { waitUntil:'domcontentloaded' });
    await page.waitForFunction(() => state.images.length === 2 && state.settings);
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === 'sample' && state.currentImage && !currentImageActionPending());
    const coords = async (x,y) => {
      const box = await page.locator('#editorCanvas').boundingBox();
      return page.evaluate(({x,y,box}) => { const p=transformImagePoint({x,y}); return {x:box.x+state.view.x+p.x*state.view.scale,y:box.y+state.view.y+p.y*state.view.scale}; }, {x,y,box});
    };
    const click = async (x,y) => { const p=await coords(x,y); await page.mouse.click(p.x,p.y); await page.waitForFunction(() => !state.fillPending && !state.drawing); };
    const path = async (points, finish=true) => {
      const p=await coords(...points[0]); await page.mouse.move(p.x,p.y); await page.mouse.down();
      for (const point of points.slice(1)) { const p=await coords(...point); await page.mouse.move(p.x,p.y); }
      if (finish) { await page.mouse.up(); await page.waitForFunction(() => !state.fillPending && !state.drawing); }
    };
    await run({ page,fixture,calls,coords,click,path });
    assert.deepEqual(errors,[]);
  } finally {
    if (page && process.env.MOZARIE_JS_COVERAGE === '1' && process.env.MOZARIE_BROWSER_COVERAGE_FILE) await appendBrowserCoverage(process.env.MOZARIE_BROWSER_COVERAGE_FILE, await page.coverage.stopJSCoverage());
    await context?.close(); await browser?.close(); await closeServer(fixture.server);
  }
}
test('area tools expose distinct controls persist replacement and preserve color fills', { timeout:60000 }, async () => scenario(async ({page,fixture}) => {
  assert.equal(await page.locator('#areaFillOptions').isVisible(),false);
  for (const [id,tool] of [['mosaicAreaBucketTool','area_bucket'],['mosaicEncloseTool','area_enclose'],['excludeAreaBucketTool','exclude_area_bucket'],['excludeEncloseTool','exclude_area_enclose']]) {
    await page.locator('#'+id).click(); assert.equal(await page.evaluate(() => state.tool),tool);
    assert.equal(await page.locator('#'+id).getAttribute('aria-pressed'),'true'); assert.equal(await page.locator('#areaFillOptions').isVisible(),true);
  }
  assert.equal(await page.locator('#areaReplaceExisting').isChecked(),false);
  await page.locator('#areaReplaceExisting').check();
  await page.waitForFunction(() => state.settings.editing.area_replace_existing === true);
  await page.evaluate(() => areaFillPreferenceSave);
  await page.locator('#brushTool').click(); assert.equal(await page.locator('#areaFillOptions').isVisible(),false);
  await page.locator('#mosaicEncloseTool').click(); assert.equal(await page.locator('#areaReplaceExisting').isChecked(),true);
  await page.reload({waitUntil:'domcontentloaded'}); await page.waitForFunction(() => state.settings && state.images.length===2);
  await page.locator('.gallery-item[data-id="sample"]').click(); await page.waitForFunction(() => state.currentImage && !currentImageActionPending());
  await page.locator('#mosaicAreaBucketTool').click(); assert.equal(await page.locator('#areaReplaceExisting').isChecked(),true);
  await page.locator('#areaReplaceExisting').uncheck(); await page.evaluate(() => areaFillPreferenceSave);
  await page.locator('#bucketTool').click(); assert.equal(await page.evaluate(() => state.tool),'bucket');
  assert.equal(await page.locator('#areaFillOptions').isVisible(),false); assert.equal(await page.locator('#bucketToleranceControl').isVisible(),true);
  assert.match(await page.locator('#bucketTool').getAttribute('aria-label'),/色/);
  await page.locator('#excludeBucketTool').click(); assert.equal(await page.evaluate(() => state.tool),'exclude_bucket');
  assert.equal(await page.locator('#bucketToleranceControl').isVisible(),true);
  await page.locator('.gallery-item[data-id="sample-two"]').click(); await page.waitForFunction(() => state.currentId==='sample-two' && !currentImageActionPending());
  await page.locator('#excludeAreaBucketTool').click(); assert.equal(await page.locator('#areaReplaceExisting').isChecked(),false);
}));
test('bucket reads current role masks and rejects open areas without a modal', { timeout:60000 }, async () => scenario(async ({page,calls,click,path}) => {
  await page.locator('#brushSize').focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  await page.locator('#brushTool').click(); await path([[10,10],[70,10],[70,65],[10,65],[10,10]]);
  await page.evaluate(() => flushWorkspaceDraft(state.currentId));
  await page.locator('#mosaicAreaBucketTool').click(); await click(30,30);
  assert.equal(calls.length,1); assert.equal(calls[0].role,'apply'); assert.equal(calls[0].replaceExisting,false);
  for(let i=0;i<calls[0].spans.length;i+=3) { assert.ok(calls[0].spans[i]>10 && calls[0].spans[i]<65); assert.ok(calls[0].spans[i+1]>10 && calls[0].spans[i+2]<=70); }
  await click(10,30); assert.equal(calls.length,1,'a boundary click has no effect');
  await click(90,70); assert.equal(calls.length,1,'exterior is not filled');
  assert.equal(await page.locator('#errorDialog').isVisible(),false);
  assert.equal(await page.evaluate(() => state.status.key),'editor.areaNotClosed');
  await page.locator('#excludeAreaBucketTool').click(); await click(30,30); assert.equal(calls.length,1,'mosaic wall is not an exclusion wall');
}));
test('enclosure previews closes an unfinished stroke and cancels without changes', { timeout:60000 }, async () => scenario(async ({page,calls,path}) => {
  await page.locator('#mosaicEncloseTool').click();
  await path([[15,15],[75,15],[75,65]],false);
  assert.equal(await page.evaluate(() => state.areaFill.points.length >= 3),true); assert.equal(calls.length,0);
  await page.keyboard.press('Escape'); await page.mouse.up(); assert.equal(calls.length,0); assert.equal(await page.evaluate(() => state.areaFill),null);
  await path([[15,15],[75,15],[75,65]]); assert.equal(calls.length,1);
  const spans=calls[0].spans; assert.ok(spans.length>0);
  assert.ok(spans.some((v,i) => i%3===0 && v===30),'polygon is filled despite endpoints not touching');
  await page.locator('#excludeEncloseTool').click(); await page.locator('#areaReplaceExisting').check();
  await path([[20,20],[65,20],[65,60],[20,60]]); assert.equal(calls.at(-1).role,'exclude'); assert.equal(calls.at(-1).replaceExisting,true);
  const before=calls.length; await path([[30,30],[30,30]]); assert.equal(calls.length,before,'a point does not create a polygon');
  await page.evaluate(() => { state.processing={kind:"detect"}; updateActionButtons(); });
  for(const id of ['mosaicAreaBucketTool','mosaicEncloseTool','excludeAreaBucketTool','excludeEncloseTool','areaReplaceExisting']) assert.equal(await page.locator('#'+id).isDisabled(),true);
  await page.evaluate(() => { state.processing=null; updateActionButtons(); });
  for(const id of ['mosaicAreaBucketTool','mosaicEncloseTool','excludeAreaBucketTool','excludeEncloseTool','areaReplaceExisting']) assert.equal(await page.locator('#'+id).isEnabled(),true);
}));
test('area work cancels before commit and keeps controls locked until a sent commit completes', { timeout:60000 }, async () => scenario(async ({page,calls,coords,path}) => {
  await page.locator('#mosaicAreaBucketTool').click();
  await page.evaluate(() => {
    window.areaNativeBitmap = window.createImageBitmap;
    window.areaBitmapGate = new Promise(resolve => window.areaReleaseBitmap=resolve);
    window.createImageBitmap = async (...args) => { await window.areaBitmapGate; return window.areaNativeBitmap(...args); };
  });
  try {
    const point=await coords(40,30); await page.mouse.click(point.x,point.y);
    await page.waitForFunction(() => state.areaFillOperation?.phase==='calculating');
    assert.equal(await page.locator('#mosaicEncloseTool').isDisabled(),true);
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => state.fillPending),false);
    await page.evaluate(() => { window.createImageBitmap=window.areaNativeBitmap; window.areaReleaseBitmap(); });
    await page.waitForFunction(() => !state.areaFillOperation); assert.equal(calls.length,0);
  } finally { await page.evaluate(() => { window.createImageBitmap=window.areaNativeBitmap; window.areaReleaseBitmap(); }); }
  let releaseCommit; let commitReceived;
  const received=new Promise(resolve => commitReceived=resolve);
  await page.route('**/api/images/*/area-fill', async route => {
    calls.push(route.request().postDataJSON()); commitReceived();
    await new Promise(resolve => releaseCommit=resolve);
    await route.fulfill({json:{ok:true,changed:false}});
  });
  try {
    await page.locator('#mosaicEncloseTool').click();
    const drawing=path([[10,10],[70,10],[70,60]]);
    await received;
    assert.equal(await page.evaluate(() => state.areaFillOperation.phase),'committing');
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => state.fillPending),true);
    for(const id of ['mosaicAreaBucketTool','mosaicEncloseTool','excludeAreaBucketTool','excludeEncloseTool','areaReplaceExisting']) assert.equal(await page.locator('#'+id).isDisabled(),true);
    releaseCommit(); await drawing;
    assert.equal(await page.locator('#mosaicAreaBucketTool').isEnabled(),true);
  } finally { releaseCommit?.(); }
  await page.route('**/api/images/*/area-fill', route => route.fulfill({status:409,json:{error_code:'candidate_revision_conflict'}}));
  const before=await page.evaluate(() => ({history:state.history.length, pixels:addCanvas.toDataURL()}));
  await path([[10,10],[70,10],[70,60]]);
  assert.equal(await page.locator('#errorDialog').isVisible(),true);
  assert.match(await page.locator('#errorDialog').innerText(),/候補が変更されています/);
  assert.deepEqual(await page.evaluate(() => ({history:state.history.length, pixels:addCanvas.toDataURL()})),before);
  await page.locator('#errorDialogClose').click(); assert.equal(await page.locator('#mosaicAreaBucketTool').isEnabled(),true);
}));
test('4K bitmap area worker returns compact spans while the page remains responsive', { timeout:60000 }, async () => scenario(async ({page}) => {
  const result=await page.evaluate(async () => {
    const source=new OffscreenCanvas(4096,2160); const context=source.getContext('2d');
    context.strokeStyle='#fff'; context.lineWidth=4; context.strokeRect(10,10,4076,2140);
    const bitmap=await createImageBitmap(source); source.width=1; source.height=1;
    const worker=new Worker('/js/area-fill-worker.js'); let turns=0;
    const tick=setInterval(() => turns++,0);
    try {
      const result=await new Promise((resolve,reject) => {worker.onmessage=event=>resolve(event.data);worker.onerror=reject;worker.postMessage({width:4096,height:2160,bitmap,x:2000,y:1000},[bitmap]);});
      return {turns,count:result.spans.length,bytes:result.spans.byteLength,open:result.open,first:[...result.spans.slice(0,3)]};
    } finally { clearInterval(tick); worker.terminate(); }
  });
  assert.equal(result.open,false); assert.ok(result.count>6000); assert.ok(result.bytes<30000); assert.ok(result.turns>0,'the main thread can handle tasks while the worker scans');
  assert.deepEqual(result.first,[1000,12,4084]);
}));
test('replacement preference restores the last saved value after consecutive failed requests', { timeout:60000 }, async () => scenario(async ({page}) => {
  await page.locator('#mosaicAreaBucketTool').click();
  let releaseFirst; let receivedFirst;
  const received=new Promise(resolve=>receivedFirst=resolve); let writes=0;
  await page.route('**/api/settings?status=0', async route => {
    if(route.request().method()!=='POST') return route.fallback();
    writes++;
    if(writes===1) { receivedFirst(); await new Promise(resolve=>releaseFirst=resolve); }
    await route.fulfill({status:500,json:{error_code:'settings_write_failed'}});
  });
  try {
    await page.locator('#areaReplaceExisting').check(); await received;
    await page.locator('#areaReplaceExisting').uncheck(); releaseFirst();
    await page.evaluate(() => areaFillPreferenceSave);
    assert.equal(writes,2); assert.equal(await page.locator('#areaReplaceExisting').isChecked(),false);
    assert.equal(await page.evaluate(() => state.settings.editing.area_replace_existing),false);
    await page.locator('#errorDialogClose').click();
    await page.unroute('**/api/settings?status=0');
    await page.locator('#areaReplaceExisting').check(); await page.evaluate(() => areaFillPreferenceSave);
    assert.equal(await page.locator('#areaReplaceExisting').isChecked(),true);
    await page.reload({waitUntil:'domcontentloaded'}); await page.waitForFunction(() => state.settings && state.images.length===2);
    await page.locator('.gallery-item[data-id="sample"]').click(); await page.waitForFunction(() => state.currentImage && !currentImageActionPending());
    await page.locator('#mosaicAreaBucketTool').click(); assert.equal(await page.locator('#areaReplaceExisting').isChecked(),true);
  } finally { releaseFirst?.(); }
}));
test('enclosure worker closes paths and fills self intersections with the preview rule', { timeout:60000 }, async () => scenario(async ({page}) => {
  const results=await page.evaluate(async () => {
    async function calculate(points) {
      const worker=new Worker('/js/area-fill-worker.js');
      try { return await new Promise((resolve,reject) => { worker.onmessage=({data})=>resolve([...data.spans]); worker.onerror=reject; worker.postMessage({width:100,height:100,points}); }); }
      finally { worker.terminate(); }
    }
    const closed=await calculate([{x:20,y:20},{x:80,y:20},{x:80,y:80},{x:20,y:80}]);
    const crossed=await calculate([{x:20,y:20},{x:80,y:80},{x:20,y:80},{x:80,y:20}]);
    const empty=await calculate([{x:20,y:20},{x:30,y:30},{x:40,y:40}]);
    const contains=(spans,x,y)=>{ for(let i=0;i<spans.length;i+=3) if(spans[i]===y && x>=spans[i+1] && x<spans[i+2]) return true; return false; };
    return { closedCenter:contains(closed,50,50), closedOutside:contains(closed,10,50), crossedTop:contains(crossed,50,30), crossedBottom:contains(crossed,50,70), crossedSide:contains(crossed,25,50), empty };
  });
  assert.deepEqual(results,{closedCenter:true,closedOutside:false,crossedTop:true,crossedBottom:true,crossedSide:false,empty:[]});
}));
test('area worker failures restore editor controls and show a translated error', {timeout:60000}, async()=>scenario(async({page,calls,path})=>{
  await page.evaluate(()=>{
    window.areaNativeWorker=window.Worker;
    window.Worker=class extends window.areaNativeWorker {
      constructor(url,options){super(url,options);this.areaFillWorker=String(url).endsWith('/area-fill-worker.js');}
      postMessage(payload,transfer){super.postMessage(this.areaFillWorker?{...payload,width:-1}:payload,transfer);}
    };
  });
  try {
    await page.locator('#mosaicEncloseTool').click();
    const before=await page.evaluate(()=>({history:state.history.length,add:addCanvas.toDataURL(),exclude:exclusionCanvas.toDataURL(),erase:exclusionEraseCanvas.toDataURL()}));
    await path([[10,10],[70,10],[70,60]]);
    assert.deepEqual(await page.evaluate(()=>({history:state.history.length,add:addCanvas.toDataURL(),exclude:exclusionCanvas.toDataURL(),erase:exclusionEraseCanvas.toDataURL()})),before);
    assert.equal(calls.length,0,'worker failure must not submit any mask changes');
    assert.equal(await page.locator('#errorDialog').isVisible(),true);
    const text=await page.locator('#errorDialog').innerText();assert.match(text,/操作を完了できませんでした/);assert.match(text,/予期しない問題/);assert.doesNotMatch(text,/OffscreenCanvas|RangeError|negative/);
    await page.locator('#errorDialogClose').click();
    for(const id of ['mosaicAreaBucketTool','mosaicEncloseTool','excludeAreaBucketTool','excludeEncloseTool','areaReplaceExisting'])assert.equal(await page.locator('#'+id).isEnabled(),true);
    assert.equal(await page.evaluate(()=>state.fillPending||Boolean(state.areaFillOperation)),false);
  }finally{await page.evaluate(()=>{window.Worker=window.areaNativeWorker;});}
}));
