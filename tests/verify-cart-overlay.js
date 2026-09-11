const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', async (route) => {
    let a=''; try{a=(route.request().postDataJSON()||{}).action;}catch(e){}
    try{if(!a)a=new URL(route.request().url()).searchParams.get('action')||'';}catch(e){}
    if(a==='getStorePublicInfo'){ await new Promise(r=>setTimeout(r,600)); route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,store:{storeName:'Bong Restaurant',phone:'+686',deliveryPickPay:true}})}); return; }
    route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})});
  });
  const results=[]; const ok=(n,c,e)=>results.push([c?'PASS':'FAIL',n,e||'']);
  const page=await ctx.newPage();
  await page.addInitScript(()=>{try{localStorage.setItem('skiri_active_store','bong');localStorage.setItem('skiri_cart_bong',JSON.stringify([{variantId:'v1',productId:'p1',label:'Rice Chop Syue — small',unitPrice:6,qty:1}]));}catch(e){}});
  await page.goto(BASE+'/cart.html',{waitUntil:'load'});
  const during=await page.evaluate(()=>{const o=document.querySelector('.loading-overlay.is-visible');if(!o)return null;const cs=getComputedStyle(o);const card=o.querySelector('.loading-overlay-card');return{vis:true,disp:cs.display,justify:cs.justifyContent,align:cs.alignItems,text:card?card.textContent:''};});
  ok('cart: overlay visible + centered during load', during && during.vis && during.disp==='flex' && during.justify==='center' && during.align==='center', JSON.stringify(during));
  ok('cart: shows "Loading" text', during && /Loading/.test(during.text), during&&during.text);
  await page.waitForFunction(()=>!document.querySelector('.loading-overlay.is-visible'),null,{timeout:4000});
  ok('cart: overlay hidden after store loads', true);
  ok('cart rendered (store name + item)', /Bong Restaurant/.test(await page.textContent('#store-name-tagline')) && /Rice Chop Syue/.test(await page.textContent('#cart-items')));
  await browser.close();
  console.log('\n--- cart loading overlay ---');
  let f=0; for(const [s,n,e] of results){if(s==='FAIL')f++; console.log(`${s}  ${n}${e?'  ['+e+']':''}`);}
  console.log(`\n${results.length-f}/${results.length} passed`);
  process.exit(f?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
