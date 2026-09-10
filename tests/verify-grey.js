const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const rgb = s => s.replace(/\s+/g,'');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext();
  await ctx.route('**/macros/s/**', r => r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,products:[],stores:[]})}));
  const results=[]; const ok=(n,c,e)=>results.push([c?'PASS':'FAIL',n,e||'']);
  const pages=['index.html','search.html','store.html?store=x','stores.html'];
  for(const p of pages){
    const page=await ctx.newPage();
    await page.setViewportSize({width:390,height:800});
    await page.goto(BASE+'/'+p,{waitUntil:'load'});
    await page.waitForSelector('.search-box button[type="submit"]');
    // The grey ::after chevron this suite was written for is gone. What it was
    // really guarding - that the phone treatment is scoped to .search-box and
    // never leaks to desktop - is kept, repointed at the disc that replaced it.
    // Typed first, because at rest there is now no button to measure.
    await page.fill('.search-box input[type="search"]', 'r');
    await page.waitForTimeout(300);
    const s=await page.evaluate(()=>{
      const btn=document.querySelector('.search-box button[type="submit"]');
      const cs=getComputedStyle(btn);
      return { after: getComputedStyle(btn,'::after').content, bg: cs.backgroundColor,
               radius: cs.borderTopLeftRadius, w: Math.round(btn.getBoundingClientRect().width) };
    });
    // --color-purple #332d63 = rgb(51,45,99)
    ok(`mobile ${p}: purple disc, not a grey chevron`,
       rgb(s.bg)==='rgb(51,45,99)' && s.radius==='999px' && s.w===44, JSON.stringify(s));
    ok(`mobile ${p}: no ::after glyph left behind`, s.after==='none'||s.after==='normal', s.after);
    await page.close();
  }
  // desktop unchanged: blue "Search"
  {
    const page=await ctx.newPage();
    await page.setViewportSize({width:900,height:800});
    await page.goto(BASE+'/index.html',{waitUntil:'load'});
    await page.waitForSelector('.search-box button[type="submit"]');
    const d=await page.evaluate(()=>{const btn=document.querySelector('.search-box button[type="submit"]');return {bg:getComputedStyle(btn).backgroundColor,text:btn.textContent.trim()};});
    ok('desktop: blue Search unchanged', rgb(d.bg)==='rgb(0,63,135)' && d.text==='Search', JSON.stringify(d));
    await page.close();
  }
  await b.close();
  console.log('\n--- grey chevron ---');
  let f=0; for(const [s,n,e] of results){if(s==='FAIL')f++; console.log(`${s}  ${n}${e?'  ['+e+']':''}`);}
  console.log(`\n${results.length-f}/${results.length} passed`);
  process.exit(f?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
