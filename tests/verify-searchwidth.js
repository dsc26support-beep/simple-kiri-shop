const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  await ctx.route('**/macros/s/**', (route) => {
    let a=''; try{a=new URL(route.request().url()).searchParams.get('action')||'';}catch(e){}
    let body={ok:true,products:[],stores:[]};
    if(a==='listProducts')body={ok:true,storeName:'S',storeSlug:'x',products:[],storePhone:''};
    route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  const results=[]; const ok=(n,c,e)=>results.push([c?'PASS':'FAIL',n,e||'']);
  const pages=['index.html','search.html','store.html?store=x','stores.html'];

  async function widths(page){
    return page.evaluate(()=>{
      const b=document.querySelector('.search-box');
      const c=b.closest('.container');
      const bb=b.getBoundingClientRect(), cc=c.getBoundingClientRect();
      // centered = roughly equal left/right margins within container
      const leftGap=Math.round(bb.left-cc.left), rightGap=Math.round(cc.right-bb.right);
      return { w: Math.round(bb.width), maxw: getComputedStyle(b).maxWidth, leftGap, rightGap };
    });
  }

  // Desktop: ~640px, centered
  for(const p of pages){
    const page=await ctx.newPage();
    await page.setViewportSize({width:1000,height:800});
    await page.goto(BASE+'/'+p,{waitUntil:'load'});
    await page.waitForSelector('.search-box');
    const w=await widths(page);
    ok(`desktop ${p}: ~640px width`, w.w>=630 && w.w<=650, JSON.stringify(w));
    ok(`desktop ${p}: centered`, Math.abs(w.leftGap-w.rightGap)<=2, JSON.stringify(w));
    await page.close();
  }
  // Mobile: fills width (near viewport minus padding)
  {
    const page=await ctx.newPage();
    await page.setViewportSize({width:390,height:800});
    await page.goto(BASE+'/index.html',{waitUntil:'load'});
    await page.waitForSelector('.search-box');
    const w=await widths(page);
    ok('mobile index: fills width (>300px)', w.w > 300, JSON.stringify(w));
    await page.close();
  }
  await browser.close();
  console.log('\n--- search box width ---');
  let failed=0; for(const [s,n,e] of results){if(s==='FAIL')failed++; console.log(`${s}  ${n}${e?'  ['+e+']':''}`);}
  console.log(`\n${results.length-failed}/${results.length} passed`);
  process.exit(failed?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
