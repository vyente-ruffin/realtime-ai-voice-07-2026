// Offline browser regression: Stop must await the provider's close acknowledgment.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url);
const html = readFileSync(new URL('talk.html', root), 'utf8').replace('__VOICE_AUTH__', 'offline-test').replace(/<script>[\s\S]*?<\/script>/, '<script type="module" src="/web/live.js"></script>');
const code = readFileSync(new URL('web/live.js', root), 'utf8');
const browser = await chromium.launch({channel:'chrome',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const report = {mode:'offline browser; no Azure, Hermes or Hindsight calls'};
try {
 const context = await browser.newContext();
 await context.grantPermissions(['microphone'], {origin:'http://127.0.0.1:8789'});
 await context.addInitScript(() => {
  window.__closeTest = {peers:[], messages:[], microphones:[]};
  const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {const s=await get(...args);window.__closeTest.microphones.push(s);return s;};
  window.EventSource = class {close(){}};
  window.RTCPeerConnection = class {
   constructor(){this.connectionState='connected';this.iceGatheringState='complete';window.__closeTest.peers.push(this);}
   addTrack(){}
   createDataChannel(){return this.channel={readyState:'open',send:data=>window.__closeTest.messages.push(JSON.parse(data)),close(){this.readyState='closed';}};}
   async createOffer(){return {type:'offer',sdp:'v=0\n'};}
   async setLocalDescription(offer){this.localDescription=offer;}
   async setRemoteDescription(){setTimeout(()=>this.channel.onmessage?.({data:JSON.stringify({type:'session.started',session:{id:'offline-session'}})}),0);}
   close(){this.connectionState='closed';}
  };
 });
 const page = await context.newPage();
 await page.route('**/*', route => {
  const path = new URL(route.request().url()).pathname;
  if(path==='/') return route.fulfill({contentType:'text/html',body:html});
  if(path==='/web/live.js') return route.fulfill({contentType:'application/javascript',body:code});
  if(path==='/api/conversations') return route.fulfill({json:{id:'offline-conversation',jobs:[],history:[]}});
  if(path==='/api/live') return route.fulfill({json:{session:{id:'offline-session'},transport:{sdp:'v=0\n'},memoryReady:true}});
  return route.fulfill({json:{ok:true}});
 });
 await page.goto('http://127.0.0.1:8789/?synthetic=1');
 await page.click('#startBtn');
 await page.waitForFunction(()=>window.__voiceLabEvents.some(e=>e.type==='session.started'));
 await page.click('#stopBtn');
 const pending=await page.evaluate(()=>({state:window.__closeTest.peers.at(-1).connectionState,closeRequests:window.__closeTest.messages.filter(e=>e.type==='session.close').length,microphoneStopped:window.__closeTest.microphones.every(s=>s.getTracks().every(t=>t.readyState==='ended'))}));
 report.beforeAcknowledgment=pending;
 assert.equal(pending.closeRequests,1);
 assert.equal(pending.state,'connected','Transport closed before the provider acknowledged the end of the session');
 assert.equal(pending.microphoneStopped,true,'Stop must release the microphone immediately');
 assert.equal(await page.locator('#startBtn').isDisabled(),true);
 await page.evaluate(()=>window.__closeTest.peers.at(-1).channel.onmessage({data:JSON.stringify({type:'session.closed',reason:'close_requested'})}));
 await page.waitForFunction(()=>!document.getElementById('startBtn').disabled);
 assert.equal(await page.evaluate(()=>window.__closeTest.peers.at(-1).connectionState),'closed');
 report.acknowledgedClose=true;
 await page.click('#startBtn');
 await page.waitForFunction(()=>window.__voiceLabEvents.filter(e=>e.type==='session.started').length===2);
 await page.click('#stopBtn');
 await page.waitForFunction(()=>!document.getElementById('startBtn').disabled,null,{timeout:16500});
 assert.equal(await page.evaluate(()=>window.__closeTest.peers.at(-1).connectionState),'closed');
 assert.equal(await page.evaluate(()=>window.__voiceLabEvents.some(e=>e.type==='connection.close.timeout')),true);
 report.timeoutFallback=true;report.passed=true;
} catch(error) {report.passed=false;report.failure=error.message;process.exitCode=1;}
finally {await browser.close();if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2),{mode:0o600});process.stdout.write(JSON.stringify(report)+'\n');}
