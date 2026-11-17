"use strict";
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  let release;
  const gate = new Promise(resolve => {release=resolve;});
  try {
    const page=await context.newPage(); page.setDefaultTimeout(20000);
    await page.goto(process.argv[2],{waitUntil:'domcontentloaded'});
    await page.locator('.gallery-item').first().click();
    await page.waitForFunction(()=>state.currentImage && hasDurableHistory() && !state.pendingImageId);
    const commits=[]; let firstReached;
    const first=new Promise(resolve=>{firstReached=resolve;});
    await page.route('**/api/workspace/manual/*/commit',async route=>{
      commits.push(route.request().postDataJSON());
      const response=await route.fetch();
      if(commits.length===1){firstReached();await gate;}
      await route.fulfill({response});
    });
    const operations=[
      ['brushTool',100,100,['add']], ['eraserTool',300,100,['exclusion','exclusionErase']],
      ['brushTool',500,100,['add']], ['excludeEraserTool',700,100,['exclusionErase']],
      ['brushTool',900,100,['add']], ['eraserTool',100,400,['exclusion','exclusionErase']],
      ['brushTool',300,400,['add']], ['brushTool',500,400,['add']],
    ];
    async function paint([tool,x,y]){
      await page.locator('#'+tool).click();
      const screen=await page.evaluate(({x,y})=>{const r=canvas.getBoundingClientRect();return {x:r.left+state.view.x+x*state.view.scale,y:r.top+state.view.y+y*state.view.scale};},{x,y});
      await page.mouse.click(screen.x,screen.y);
    }
    await paint(operations[0]); await first;
    for(const operation of operations.slice(1)) await paint(operation);
    assert.equal(commits.length,1,'later strokes draw while the first durable acknowledgement is held');
    release(); await page.evaluate(()=>flushWorkspaceDraft(state.currentId));
    assert.equal(commits.length,operations.length,'each completed stroke remains independently durable');
    commits.forEach((commit,index)=>{
      const [,x,y,layers]=operations[index];
      assert.deepEqual([...commit.dirtyLayers].sort(),[...layers].sort(),'only this stroke layers are uploaded');
      assert.deepEqual(Object.keys(commit.dirtyRois).sort(),[...layers].sort());
      for(const roi of Object.values(commit.dirtyRois)){
        assert.ok(roi.left<=x && roi.right>x && roi.top<=y && roi.bottom>y);
        assert.ok(roi.right-roi.left<=100 && roi.bottom-roi.top<=100,'dirty rectangle does not accumulate older stroke regions');
      }
    });
    const pixels=()=>page.evaluate(points=>points.map(([,x,y])=>[addCtx,exclusionCtx,exclusionEraseCtx].map(c=>c.getImageData(x,y,1,1).data[3])),operations);
    const before=await pixels();
    for(let i=0;i<operations.length;i++){
      await page.locator('#undoButton').click();
      await page.waitForFunction(()=>!state.projectHistoryBusy && !state.pendingImageId);
    }
    assert.ok((await pixels()).flat().every(value=>value===0),'undo reaches the empty initial masks');
    for(let i=0;i<operations.length;i++){
      await page.locator('#redoButton').click();
      await page.waitForFunction(()=>!state.projectHistoryBusy && !state.pendingImageId);
    }
    assert.deepEqual(await pixels(),before,'redo preserves all three exact manual layers');
    await page.unroute('**/api/workspace/manual/*/commit');
    let failed=false, failReached, releaseFailure;
    const failureStarted=new Promise(resolve=>{failReached=resolve;});
    const failureGate=new Promise(resolve=>{releaseFailure=resolve;});
    const releaseSuccessful=release;
    release=()=>{releaseSuccessful();releaseFailure();};
    await page.route('**/api/workspace/manual/*/commit',async route=>{
      if(!failed){failed=true;failReached();await failureGate;await route.fulfill({status:500,json:{error_code:'workspace_write_failed'}});}
      else await route.continue();
    });
    await paint(['brushTool',700,700]);await failureStarted;
    await paint(['brushTool',900,700]);releaseFailure();
    await page.locator('#errorDialog').waitFor({state:'visible'});
    await page.locator('#errorDialogClose').click();
    await page.evaluate(()=>flushWorkspaceDraft(state.currentId));
    assert.equal(await page.evaluate(()=>state.workspaceMutationErrors.size),0,'the following stroke retries the prior failure');
    const recovered=()=>page.evaluate(()=>[700,900].map(x=>addCtx.getImageData(x,700,1,1).data[3]));
    assert.deepEqual(await recovered(),[255,255],'failed and following strokes are both saved');
    await page.locator('#undoButton').click();await page.waitForFunction(()=>!state.projectHistoryBusy && !state.pendingImageId);
    assert.deepEqual(await recovered(),[0,0],'retry history includes the earlier failed region');
    await page.locator('#redoButton').click();await page.waitForFunction(()=>!state.projectHistoryBusy && !state.pendingImageId);
    assert.deepEqual(await recovered(),[255,255],'redo restores both recovered regions');
    console.log('rapid durable strokes preserve local dirty regions layers history and retry');
  } finally {release();await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
