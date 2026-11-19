'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium } = require('playwright');
const { appendBrowserCoverage, closeServer, startFixtureServer } = require('../test_import_picker_e2e.cjs');
async function scenario(run) {
  const fixture=await startFixtureServer(); let browser,context,page; const errors=[];
  try {
    browser=await chromium.launch(); context=await browser.newContext({viewport:{width:1440,height:960}}); page=await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror',error=>errors.push(error.message));
    if(process.env.MOZARIE_JS_COVERAGE==='1') await page.coverage.startJSCoverage({resetOnNavigation:false});
    const source=await page.evaluate(() => {
      const canvas=document.createElement('canvas');canvas.width=100;canvas.height=80;const ctx=canvas.getContext('2d');
      ctx.fillStyle='rgb(0,0,255)';ctx.fillRect(0,0,100,80);
      for(const [x,y,w,h,color] of [[10,10,20,20,100],[30,10,10,20,110],[40,10,10,20,111],[40,30,10,10,100],[70,10,10,10,100],[10,45,10,10,0],[21,45,10,10,0]]) {ctx.fillStyle=`rgb(${color},${color},${color})`;ctx.fillRect(x,y,w,h);}
      ctx.clearRect(20,45,1,10);return canvas.toDataURL().split(',')[1];
    });
    await page.route('**/api/image/*',route=>route.fulfill({contentType:'image/png',body:Buffer.from(source,'base64')}));
    await page.goto(fixture.url,{waitUntil:'domcontentloaded'}); await page.waitForFunction(()=>state.settings&&state.images.length===2);
    await page.locator('.gallery-item[data-id="sample"]').click(); await page.waitForFunction(()=>state.currentId==='sample'&&state.currentImage&&!currentImageActionPending());
    async function clickPixel(x,y,side='left') {
      const box=await page.locator('#editorCanvas').boundingBox();
      const p=await page.evaluate(({x,y,side,box})=>{const point=transformImagePoint({x:x+.5,y:y+.5});return{x:box.x+compareSideOffset(side)+state.view.x+point.x*state.view.scale,y:box.y+state.view.y+point.y*state.view.scale};},{x,y,side,box});
      await page.mouse.click(p.x,p.y); await page.waitForFunction(()=>!state.fillPending&&!state.drawing); await page.evaluate(()=>flushWorkspaceDraft(state.currentId));
    }
    async function tolerance(value) {
      await page.locator('#bucketTolerance').focus(); await page.keyboard.press('Home');
      for(let i=0;i<value;i++) await page.keyboard.press('ArrowRight');
      await page.evaluate(()=>fillToleranceMutation);
      assert.equal(await page.locator('#bucketTolerance').inputValue(),String(value));assert.equal(await page.locator('#bucketToleranceValue').textContent(),String(value));
      await page.waitForFunction(value=>state.settings.editing.fill_color_tolerance===value,value);
    }
    async function masks() {return page.evaluate(()=>{const alpha=canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,100,80).data).filter((_,i)=>i%4===3);return{add:alpha(addCanvas),exclude:alpha(exclusionCanvas),erase:alpha(exclusionEraseCanvas)};});}
    await run({page,fixture,clickPixel,tolerance,masks});assert.deepEqual(errors,[]);
  } finally {
    if(page&&process.env.MOZARIE_JS_COVERAGE==='1'&&process.env.MOZARIE_BROWSER_COVERAGE_FILE) await appendBrowserCoverage(process.env.MOZARIE_BROWSER_COVERAGE_FILE,await page.coverage.stopJSCoverage());
    await context?.close();await browser?.close();await closeServer(fixture.server);
  }
}
function expectedRegions(...rects) {
  const alpha=Array(8000).fill(0);for(const [x,y,w,h] of rects) for(let row=y;row<y+h;row++) for(let column=x;column<x+w;column++) alpha[row*100+column]=255;return alpha;
}
test('color buckets honor tolerance and four-neighbor connectivity for both manual roles', {timeout:60000}, async()=>scenario(async({page,clickPixel,tolerance,masks})=>{
  await page.locator('#bucketTool').click();await tolerance(9);await clickPixel(15,15);
  assert.deepEqual((await masks()).add,expectedRegions([10,10,20,20]),'nearby +10 pixels are outside tolerance nine');
  await page.locator('#bucketTool').click();
  if(await page.locator('#bucketToleranceControl').isHidden()) await page.locator('#bucketTool').click();
  await page.locator('#bucketToleranceIncrease').click();await page.evaluate(()=>fillToleranceMutation);assert.equal(await page.locator('#bucketTolerance').inputValue(),'10');
  await clickPixel(15,15);
  const expected=expectedRegions([10,10,30,20]);
  assert.deepEqual((await masks()).add,expected,'connected +10 included, +11, disconnected identical and diagonal-only pixels excluded');
  await page.locator('#excludeBucketTool').click();await clickPixel(15,15);
  assert.deepEqual((await masks()).exclude,expected);assert.deepEqual((await masks()).add,expected,'exclusion does not delete the mosaic manual mask');
  await clickPixel(15,49);
  assert.deepEqual((await masks()).exclude,expectedRegions([10,10,30,20],[10,45,10,10]),'transparent strip cannot connect identical visible patches');
  assert.deepEqual((await masks()).add,expected,'other-role pixels remain unchanged');
  await clickPixel(20,49);assert.deepEqual((await masks()).exclude,expectedRegions([10,10,30,20],[10,45,10,10]),'transparent seed has no fill');
  await page.locator('#bucketTool').click();await clickPixel(15,15);
  assert.deepEqual((await masks()).exclude,expectedRegions([10,10,30,20],[10,45,10,10]),'forced exclusions survive a mosaic color fill');
  assert.deepEqual((await masks()).erase,Array(8000).fill(0));
}));
test('flipped compare-pane color fills select source pixels and keep masks after image navigation', {timeout:60000}, async()=>scenario(async({page,clickPixel,tolerance,masks})=>{
  await page.locator('#flipHorizontalButton').click();await page.waitForFunction(()=>currentRecord().flipH&&!state.transformPending);
  await page.locator('#compareViewButton').click();await page.locator('#bucketTool').click();await tolerance(10);await clickPixel(15,15,'right');
  const expected=expectedRegions([10,10,30,20]);assert.deepEqual((await masks()).add,expected);
  await page.locator('.gallery-item[data-id="sample-two"]').click();await page.waitForFunction(()=>state.currentId==='sample-two'&&!currentImageActionPending());
  await page.locator('.gallery-item[data-id="sample"]').click();await page.waitForFunction(()=>state.currentId==='sample'&&!currentImageActionPending());
  assert.deepEqual((await masks()).add,expected,'saved local draft restores the same source-coordinate pixels');
  await page.locator('#excludeBucketTool').click();await clickPixel(75,15,'left');
  assert.deepEqual((await masks()).exclude,expectedRegions([70,10,10,10]),'flipped left pane hits the disconnected patch only');assert.deepEqual((await masks()).add,expected);
}));
test('color tolerance restores acknowledged settings after two failed queued changes and retry', {timeout:60000}, async()=>scenario(async({page})=>{
  await page.locator('#bucketTool').click();const original=await page.evaluate(()=>state.settings.editing.fill_color_tolerance);
  let releaseFirst,receivedFirst;const received=new Promise(resolve=>receivedFirst=resolve);let writes=0;
  await page.route('**/api/settings?status=0',async route=>{
    if(route.request().method()!=='POST')return route.fallback();writes++;if(writes===1){receivedFirst();await new Promise(resolve=>releaseFirst=resolve);}await route.fulfill({status:500,json:{error_code:'internal_error'}});
  });
  try {
    await page.locator('#bucketToleranceIncrease').click();await received;await page.locator('#bucketToleranceIncrease').click();releaseFirst();
    await page.waitForFunction(()=>fillTolerancePending===0);
    assert.equal(writes,2);assert.equal(await page.locator('#bucketTolerance').inputValue(),String(original));assert.equal(await page.locator('#bucketToleranceValue').textContent(),String(original));assert.equal(await page.evaluate(()=>state.settings.editing.fill_color_tolerance),original);
    await page.locator('#errorDialogClose').click();await page.unroute('**/api/settings?status=0');
    if(await page.locator('#bucketToleranceControl').isHidden())await page.locator('#bucketTool').click();
    await page.locator('#bucketToleranceDecrease').click();await page.waitForFunction(value=>!fillTolerancePending&&state.settings.editing.fill_color_tolerance===value,original-1);
    await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>state.settings&&state.images.length===2);
    assert.equal(await page.evaluate(()=>state.settings.editing.fill_color_tolerance),original-1,'retry persists through reload');
  } finally {releaseFirst?.();}
}));
test('color tolerance acknowledgements preserve a newer replacement preference', {timeout:60000}, async()=>scenario(async({page})=>{
  await page.locator('#bucketTool').click();const initial=await page.evaluate(()=>state.settings.editing.fill_color_tolerance);
  let releaseTolerance,receivedTolerance;const received=new Promise(resolve=>receivedTolerance=resolve);
  await page.route('**/api/settings?status=0',async route=>{
    if(route.request().method()!=='POST'||!Object.hasOwn(route.request().postDataJSON().editing||{},'fill_color_tolerance'))return route.fallback();
    const response=await route.fetch();const snapshot=await response.json();
    receivedTolerance();await new Promise(resolve=>releaseTolerance=resolve);
    await route.fulfill({response,json:snapshot});
  });
  try {
    await page.locator('#bucketToleranceIncrease').click();await received;
    await page.locator('#mosaicAreaBucketTool').click();await page.locator('#areaReplaceExisting').check();await page.evaluate(()=>areaFillPreferenceSave);
    releaseTolerance();await page.waitForFunction(()=>fillTolerancePending===0);
    await page.locator('#brushTool').click();await page.locator('#mosaicAreaBucketTool').click();
    const values=await page.evaluate(async()=>{const saved=await(await fetch('/api/settings?status=0')).json();return{local:state.settings.editing.area_replace_existing,checked:document.querySelector('#areaReplaceExisting').checked,server:saved.settings.editing.area_replace_existing,tolerance:state.settings.editing.fill_color_tolerance,serverTolerance:saved.settings.editing.fill_color_tolerance};});
    assert.deepEqual(values,{local:true,checked:true,server:true,tolerance:initial+1,serverTolerance:initial+1});
    await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>state.settings&&state.images.length===2);
    assert.equal(await page.evaluate(()=>state.settings.editing.area_replace_existing),true);assert.equal(await page.evaluate(()=>state.settings.editing.fill_color_tolerance),initial+1);
  }finally{releaseTolerance?.();}
}));
