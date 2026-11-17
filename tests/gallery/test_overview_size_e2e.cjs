"use strict";
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {chromium} = require('playwright');
const {startFixtureServer,closeServer} = require('../test_import_picker_e2e.cjs');

test('overview size buttons preserve virtual scrolling selection reorder and keyboard operation',{timeout:60000},async()=>{
  const fixture=await startFixtureServer();
  fixture.setCatalog(Array.from({length:20000},(_,index)=>({id:`size-${index}`,relativePath:`size-${index}.png`,sourceKind:'filesystem',width:800,height:1000,candidateCount:0,reviewed:false})));
  const browser=await chromium.launch(); const context=await browser.newContext({viewport:{width:1600,height:900}});
  try{
    const page=await context.newPage();page.setDefaultTimeout(15000);
    const requests=new Map();page.on('request',request=>{const p=new URL(request.url()).pathname;if(p.startsWith('/api/thumbnail/'))requests.set(p,(requests.get(p)||0)+1);});
    await page.goto(fixture.url,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>state.images.length===20000 && state.settings);
    await page.locator('#overviewButton').click();
    const larger=page.locator('#overviewLargerButton'),smaller=page.locator('#overviewSmallerButton');
    await page.locator('#overviewFilterButton').click();
    await page.locator('[data-overview-filter="unreviewed"]').check();
    await page.locator('#overviewFilterButton').click();
    const frame=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const geometry=()=>page.locator('.overview-item').first().evaluate(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}));
    await larger.click();await frame();
    assert.equal(await page.locator('#overviewGrid').evaluate(grid=>grid.scrollTop),0,'enlarging at the top does not add a padding jump');
    await smaller.click();await frame();
    assert.equal(await page.locator('#overviewGrid').evaluate(grid=>grid.scrollTop),0,'shrinking at the top stays at zero');
    await page.locator('#batchModeButton').click();await page.locator('.overview-item').first().click();
    const selected=await page.evaluate(()=>[...state.selectedImageIds]);
    await page.locator('#overviewGrid').evaluate(grid=>{grid.scrollTop=grid.scrollHeight*.8;});await frame();
    await page.waitForFunction(()=>[...document.querySelectorAll('#overviewGrid img')].every(image=>image.complete));
    const anchor=await page.locator('#overviewGrid').evaluate(grid=>{const r=grid.getBoundingClientRect();return [...grid.querySelectorAll('.overview-item')].find(node=>node.getBoundingClientRect().bottom>r.top+14).dataset.id;});
    const before=await geometry();const oldIds=await page.locator('.overview-item').evaluateAll(nodes=>nodes.map(n=>n.dataset.id));const oldRequests=new Map(requests);
    await larger.click();await frame();const after=await geometry();
    assert.ok(after.width>before.width && after.height>before.height,'plus enlarges both card dimensions');
    const anchorBox=await page.locator(`.overview-item[data-id="${anchor}"]`).boundingBox();const gridBox=await page.locator('#overviewGrid').boundingBox();
    assert.ok(anchorBox && anchorBox.y<gridBox.y+gridBox.height && anchorBox.y+anchorBox.height>gridBox.y,'deep-scroll anchor stays visible after the total height grows');
    assert.deepEqual(await page.evaluate(()=>[...state.selectedImageIds]),selected);
    assert.equal(await page.locator('[data-overview-filter="unreviewed"]').isChecked(),true,'zoom keeps image filters');
    const common=await page.locator('.overview-item').evaluateAll((nodes,ids)=>nodes.map(n=>n.dataset.id).filter(id=>ids.includes(id)),oldIds);
    for(const id of common)assert.equal(requests.get(`/api/thumbnail/${id}`),oldRequests.get(`/api/thumbnail/${id}`),'mounted unchanged thumbnails are not fetched again');
    await smaller.click();await frame();const restored=await geometry();assert.ok(Math.abs(restored.width-before.width)<1 && Math.abs(restored.height-before.height)<1);
    for(let index=0;index<30 && !(await larger.evaluate(button=>document.activeElement===button));index++) await page.keyboard.press('Tab');
    assert.equal(await larger.evaluate(button=>document.activeElement===button),true,'Tab reaches the native enlarge button');
    await page.keyboard.press('Enter');await frame();assert.ok((await geometry()).width>before.width,'keyboard Enter activates zoom');
    await page.evaluate(()=>{state.projectReadOnly=true;updateActionButtons();});assert.equal(await larger.isEnabled(),true,'read-only projects allow view resizing');
    await page.evaluate(()=>{state.projectReadOnly=false;updateActionButtons();});
    await page.locator('#reorderImagesButton').click();const order=await page.evaluate(()=>state.reorder.ids.slice());
    await smaller.click();await frame();assert.deepEqual(await page.evaluate(()=>state.reorder.ids),order,'zoom preserves the reorder draft');
    const cards=page.locator('.overview-item');
    const [from,to]=await page.locator('#overviewGrid').evaluate(grid=>{const bounds=grid.getBoundingClientRect();return [...grid.querySelectorAll('.overview-item')].map(node=>node.getBoundingClientRect()).filter(r=>r.top>=bounds.top && r.bottom<=bounds.bottom).slice(0,2).map(r=>({x:r.x,y:r.y,width:r.width,height:r.height}));});
    await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:3});
    await page.waitForFunction(()=>state.reorder?.drag?.moved);
    assert.equal(await larger.isDisabled(),true);assert.equal(await smaller.isDisabled(),true);
    assert.notDeepEqual(await page.evaluate(()=>state.reorder.ids),order,'drag hit testing follows the resized grid');
    await page.mouse.up();await page.waitForFunction(()=>!state.reorder?.drag && !state.reorder?.settle);assert.equal(await larger.isEnabled(),true);
    await page.locator('#reorderCancel').click();
    assert.deepEqual(await page.evaluate(()=>state.images.map(image=>image.id)),order,'cancel restores the original order after zoomed dragging');
    for(let index=0;index<20 && await larger.isEnabled();index++){await larger.click();await frame();assert.ok(await cards.count()<500);}
    assert.equal(await larger.isDisabled(),true,'one-column view stops growing');
    for(let index=0;index<30 && await smaller.isEnabled();index++){await smaller.click();await frame();assert.ok(await cards.count()<500);}
    assert.equal(await smaller.isDisabled(),true,'minimum readable card width stops shrinking');
    await larger.click();assert.equal(await smaller.isEnabled(),true,'buttons recover when leaving a size limit');
    await page.setViewportSize({width:800,height:900});await frame();
    assert.ok(await page.locator('#overviewLargerButton').isVisible());
    assert.ok(await page.locator('.overview-toolbar').evaluate(toolbar=>toolbar.scrollWidth<=toolbar.clientWidth),'overview toolbar fits its narrow viewport');
    assert.ok(await cards.count()<500,'20k images remain virtualized at every zoom and viewport size');
    if(await smaller.isEnabled()) await smaller.click();await frame();assert.equal(await smaller.isDisabled(),true,'narrow view stops at the existing responsive default when readable width is unavailable');
  }finally{await context.close();await browser.close();await closeServer(fixture.server);}
});
