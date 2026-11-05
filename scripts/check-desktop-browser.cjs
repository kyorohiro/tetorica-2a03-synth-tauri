// Exercise the packaged frontend and actual WASM/AudioWorklets with a mocked
// desktop IPC host. Speakers stay muted; this does not test a CPAL device.
const {chromium, webkit} = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {gzipSync} = require('node:zlib');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const options = {out:path.join(root,'docs/desktop_browser_20261105.json'), screenshots:null};
for(let index=2;index<process.argv.length;index++) {
  const name=process.argv[index].replace(/^--/,'');
  assert(Object.hasOwn(options,name),`Unknown option: ${name}`);
  assert(process.argv[index+1],`Missing value: ${name}`);
  options[name]=path.resolve(process.argv[++index]);
}
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm',
  '.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'};
function vgm() {
  const w=(register,value)=>[0xb4,register,value], commands=[...w(0x15,1),
    ...w(0,0x79),...w(1,8),...w(2,0x40),...w(3,0x89),0x61,0xe8,0x03,0x66];
  const data=Buffer.alloc(256+commands.length);data.write('Vgm ');data.writeUInt32LE(data.length-4,4);
  data.writeUInt32LE(0x171,8);data.writeUInt32LE(0xcc,0x34);data.writeUInt32LE(1789773,0x84);data.set(commands,256);
  return data;
}

async function run(name, engine, backend) {
  const browser=await engine.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:1000},acceptDownloads:true});
  page.setDefaultTimeout(15000);
  const errors=[], missing=[], consoleErrors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  const desktop=await fs.readFile(path.join(root,'desktop/desktop-interface.js'),'utf8');
  const audio=await fs.readFile(path.join(root,'desktop/audio-interface.js'),'utf8');
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(['blob:','data:'].includes(url.protocol)) return route.continue();
    if(url.hostname!=='tauri.localhost') {missing.push(url.href);return route.abort();}
    try {
      const file=url.pathname==='/desktop-audio-worklet.js' ? path.join(root,'desktop/audio-worklet.js')
        :path.resolve(root,'dist','.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      assert(file.startsWith(path.join(root,'dist')+path.sep)||file===path.join(root,'desktop/audio-worklet.js'));
      let body=await fs.readFile(file);
      if(url.pathname==='/synth-2a03/synth.js') body=Buffer.concat([body,Buffer.from('\n;\n'+audio)]);
      return route.fulfill({status:200,body,contentType:mime[path.extname(file)]||'application/octet-stream',
        headers:{'access-control-allow-origin':'*'}});
    } catch(error) {missing.push(`${url.pathname}: ${error.message}`);return route.fulfill({status:404,body:'Missing asset'});}
  });
  await page.addInitScript(({backend})=>{
    const audit=window.desktopAudit={calls:[],saves:[],contexts:[],worklets:[],speakerEdges:new Map(),
      pinned:false,nextRead:0,packets:0,returned:0,nativePeak:0,nativeFinite:true,nativeSession:0,failWrites:false,holdStart:false,cancelSave:false};
    const Context=window.AudioContext??window.webkitAudioContext, Node=window.AudioWorkletNode;
    const connect=AudioNode.prototype.connect,disconnect=AudioNode.prototype.disconnect;
    window.AudioContext=class extends Context {constructor(...args){
      super(...args);audit.contexts.push(this);
      // Playwright page routes do not see AudioWorklet module fetches. Serve
      // those exact bytes through a real CORS-enabled loopback test server.
      const add=this.audioWorklet.addModule.bind(this.audioWorklet);
      this.audioWorklet.addModule=(url,...options)=>{
        const value=new URL(url,location.href);
        return add(value.hostname==='tauri.localhost'?new URL(value.pathname+value.search,backend).href:url,...options);
      };
    }};
    if(window.webkitAudioContext) window.webkitAudioContext=window.AudioContext;
    window.AudioWorkletNode=class extends Node {constructor(...args){super(...args);audit.worklets.push({node:this,name:args[1]});}};
    AudioNode.prototype.connect=function(destination,...args){
      if(destination!==this.context.destination) return connect.call(this,destination,...args);
      const analyser=this.context.createAnalyser();analyser.fftSize=4096;
      const mute=this.context.createGain();mute.gain.value=0;
      connect.call(this,analyser);connect.call(analyser,mute);connect.call(mute,destination);
      audit.speakerEdges.set(this,{analyser,mute});return destination;
    };
    AudioNode.prototype.disconnect=function(destination,...args){
      const edge=audit.speakerEdges.get(this);
      if(edge&&(arguments.length===0||destination===this.context.destination)) {
        disconnect.call(this,edge.analyser);disconnect.call(edge.analyser);disconnect.call(edge.mute);audit.speakerEdges.delete(this);
        if(arguments.length) return;
      }
      return arguments.length?disconnect.call(this,destination,...args):disconnect.call(this);
    };
    audit.read=()=>new Promise((resolve,reject)=>{
      const node=audit.worklets.find(entry=>entry.name==='tetorica-nes-fds-synth')?.node;
      if(!node) return reject(Error('No synth worklet'));
      const id=--audit.nextRead,timer=setTimeout(()=>{node.port.removeEventListener('message',receive);reject(Error('Read timed out'));},5000);
      function receive({data}) {if(data.id!==id)return;clearTimeout(timer);node.port.removeEventListener('message',receive);data.error?reject(Error(data.error)):resolve(data.value);}
      node.port.addEventListener('message',receive);node.port.start();node.port.postMessage({id,method:'read',args:[]});
    });
    audit.webPeak=async()=>{
      const {output}=await window.tetoricaSynthAudio.ensureReady(),edge=audit.speakerEdges.get(output);
      if(!edge)return 0;const samples=new Float32Array(edge.analyser.fftSize);edge.analyser.getFloatTimeDomainData(samples);
      return samples.reduce((peak,value)=>Math.max(peak,Math.abs(value)),0);
    };
    window.__TAURI_INTERNALS__={invoke:async(command,args={},options)=>{
      audit.calls.push({command,session:args?.session,bytes:args instanceof ArrayBuffer?args.byteLength:null});
      if(command==='window_pin_state')return audit.pinned;
      if(command==='set_window_pin')return audit.pinned=args.pinned;
      if(command==='save_export_binary') {
        const length=new DataView(args).getUint32(0,true),header=JSON.parse(new TextDecoder().decode(new Uint8Array(args,4,length)));
        const bytes=new Uint8Array(args,4+length),text=new TextDecoder().decode(bytes);
        audit.saves.push({header,text,bytes:[...bytes]});return audit.cancelSave?null:'/tmp/'+header.filename;
      }
      if(command==='audio_devices')return [{id:'offline-test',name:'Offline test device',isDefault:true}];
      if(command==='audio_start') {
        if(audit.holdStart)await new Promise(resolve=>{audit.releaseStart=()=>{audit.holdStart=false;resolve();};});
        return {session:`offline-${++audit.nativeSession}`,frames:512,credits:8,sampleRate:args.sampleRate};
      }
      if(command==='audio_stop')return null;
      if(command==='audio_write') {
        if(audit.failWrites)throw Error('Injected offline device failure');
        const samples=new Float32Array(args);audit.packets+=args.byteLength/(512*8);
        for(const value of samples){audit.nativeFinite&&=Number.isFinite(value);audit.nativePeak=Math.max(audit.nativePeak,Math.abs(value));}
        return {rustMicros:100,serviceMicros:200};
      }
      if(command==='audio_poll') {
        await new Promise(resolve=>setTimeout(resolve,20));const credits=Math.min(8,audit.packets-audit.returned);audit.returned+=credits;
        return {credits,queuedFrames:1024,underruns:0};
      }
      if(command==='reload_window')return null;
      throw Error(`Unexpected native command: ${command}`);
    }};
  },{backend});
  await page.addInitScript({content:desktop});
  const state=()=>page.evaluate(()=>window.desktopAudit.read());
  const wait=async predicate=>{
    let value;for(let index=0;index<100;index++){value=await state();if(predicate(value))return value;await page.waitForTimeout(25);}
    throw Error('State did not settle: '+JSON.stringify(value));
  };
  const menu=async()=>{if(!await page.locator('#synthMenu').evaluate(node=>node.open))await page.click('#synthMenuButton');};
  const panel=async(id,open=true)=>{
    const node=page.locator(`#${id}`);
    if(await node.evaluate(node=>node.open)!==open)await page.locator(`#${id} > summary`).click();
    await page.waitForFunction(({id,open})=>document.getElementById(id).open===open,{id,open});
  };
  const source=async value=>{
    await panel('sourcePanel');await page.click(`[data-choice-for="source"][data-choice-value="${value}"]`);
    await wait(state=>state.preset.source===value);
    assert.equal(await page.evaluate(()=>Boolean(document.activeElement?.matches('input,select,textarea'))),false,'source choices leave performance keys available');
  };
  const audition=async()=>{
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);
    await page.waitForFunction(async()=>await window.desktopAudit.webPeak()>.0001);
    await page.keyboard.up('a');await wait(value=>value.voices.length===0);
  };
  try {
    console.log(`CHECK ${name}: desktop toolbar / pin / lazy native output controls`);
    await page.goto(backend+'/index.html');
    await page.waitForFunction(()=>window.tetoricaSynthAudio&&document.querySelector('#synthPinButton')?.hidden===false&&document.querySelector('#desktop-audio-native'));
    assert.equal(await page.locator('#synthPinButton').getAttribute('aria-pressed'),'false');
    assert.equal(await page.title(),'Tetorica 2A03 Synth');
    assert.match(await page.locator('#synthTitle').textContent(),/Tetorica\s+2A03 Synth/);
    assert.equal(await page.locator('#sourcePanel').evaluate(node=>node.open),true);
    for(const id of ['vgmPanel','filesPanel'])assert.equal(await page.locator(`#${id}`).evaluate(node=>node.open),false,'optional panels initially stay compact');
    assert.equal(await page.locator('#loadPreset').textContent(),'Instrument · 2A03 preset…');
    assert.equal(await page.evaluate(()=>window.desktopAudit.contexts.length),0);
    await page.uncheck('#keepMonitorVisible');
    await page.click('#synthPinButton');await page.waitForFunction(()=>document.querySelector('#synthPinButton').getAttribute('aria-pressed')==='true');
    await page.click('#synthPinButton');await page.waitForFunction(()=>document.querySelector('#synthPinButton').getAttribute('aria-pressed')==='false');
    await page.click('#startAudio');await page.waitForFunction(()=>document.querySelector('#audioStatus').textContent.startsWith('Audio ready'));
    await audition();

    console.log(`CHECK ${name}: held Pulse and Pitch reset / performance blocked during output switch`);
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);
    await page.locator('#pitchBend').evaluate(node=>{node.value='1';node.dispatchEvent(new Event('input',{bubbles:true}));});
    await wait(value=>value.pitch===1);
    await menu();await page.locator('#desktop-audio-output > summary').click();
    await page.evaluate(()=>{window.desktopAudit.holdStart=true;});await page.click('#desktop-audio-native');
    await page.waitForFunction(()=>typeof window.desktopAudit.releaseStart==='function');
    const switchedPulse=await wait(value=>value.voices.length===0&&value.pitch===0);
    assert.equal(switchedPulse.preset.source,'pulse');
    await page.keyboard.down('s');assert.equal((await state()).voices.length,0);await page.keyboard.up('s');
    await page.evaluate(()=>window.desktopAudit.releaseStart());
    await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    await page.keyboard.up('a');await page.click('#desktop-audio-web');
    await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent==='Web Audio output');await audition();

    console.log(`CHECK ${name}: native binary preset save / native save cancellation / reload cancellation`);
    await menu();await page.click('#savePreset');
    await page.waitForFunction(()=>window.desktopAudit.saves.length===1);
    const saved=await page.evaluate(()=>window.desktopAudit.saves[0]);
    assert.equal(saved.header.filename,'2a03-voice.json');const preset=JSON.parse(saved.text);
    assert.equal(preset.format,'tetorica-nes-fds-voice');assert.equal(preset.version,7);assert.equal(preset.source,'pulse');
    await page.evaluate(()=>{window.desktopAudit.cancelSave=true;});await menu();await page.click('#savePreset');
    await page.waitForFunction(()=>document.querySelector('#audioStatus').textContent==='Save cancelled.');
    assert.equal(await page.evaluate(()=>window.desktopAudit.saves.length),2);
    await page.evaluate(()=>{window.desktopAudit.cancelSave=false;});
    await menu();await page.click('[data-reset-offline-cache]');await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.desktopAudit.calls.filter(call=>call.command==='reload_window').length),0);

    console.log(`CHECK ${name}: menu NES VGM chooser reveals the library / actual FDS preset / keyboard focus`);
    await menu();const chooser=page.waitForEvent('filechooser');await page.click('#synthMenuVgm');
    await(await chooser).setFiles({name:'self-authored.vgz',mimeType:'application/gzip',buffer:gzipSync(vgm())});
    await page.waitForFunction(()=>document.querySelectorAll('[data-vgm-voice]').length===1&&document.querySelector('#vgmLibrary').dataset.loading==='false');
    assert.equal(await page.locator('#vgmPanel').evaluate(node=>node.open),true,'menu import reveals the initially folded VGM panel');
    await page.click('[data-vgm-voice]');let current=await wait(value=>value.preset.pulse.volume===9&&value.preset.pulse.duty===.25);
    assert.equal(current.preset.source,'pulse');assert.match(await page.locator('[data-vgm-voice]').textContent(),/Pulse/);
    await audition();
    const beforeLoadCancel=structuredClone((await state()).preset);
    await menu();const cancelledChooser=page.waitForEvent('filechooser');await page.click('#loadPreset');
    await(await cancelledChooser).setFiles([]);assert.deepEqual((await state()).preset,beforeLoadCancel,'cancelled instrument selection keeps the current sound');await audition();
    const imported=structuredClone(preset);imported.name='Desktop FDS test';imported.source='fds';
    imported.fds.wave=Array.from({length:64},(_,index)=>index<32?63:0);imported.fds.volume=24;
    await menu();const waveChooser=page.waitForEvent('filechooser');await page.click('#loadPreset');
    await(await waveChooser).setFiles({name:'desktop-fds.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});
    current=await wait(value=>value.preset.name===imported.name&&value.preset.source==='fds');assert.deepEqual(current.preset,imported);await audition();

    console.log(`CHECK ${name}: DMC demo / real bit edit / native binary DPCM export and cancellation`);
    await source('dmc');await page.click('#demoDpcm');
    current=await wait(value=>value.preset.dmc.data.length===257);await audition();
    let savesBefore=await page.evaluate(()=>window.desktopAudit.saves.length);
    const demoData=[...current.preset.dmc.data];await page.click('#saveDpcm');
    await page.waitForFunction(count=>window.desktopAudit.saves.length===count+1,savesBefore);
    let dmcSaved=await page.evaluate(()=>window.desktopAudit.saves.at(-1));
    assert.equal(dmcSaved.header.filename,'2a03-sample.dmc');assert.deepEqual(dmcSaved.bytes,demoData,'native DPCM save preserves the original demo bytes');
    await page.setInputFiles('#dpcmFileInput',{name:'self-authored-two.dmc',mimeType:'application/octet-stream',buffer:Buffer.from([0xa5,0x5a])});
    await wait(value=>value.preset.dmc.data.length===2&&value.preset.dmc.data[0]===0xa5);
    await page.check('#dmcLoop');await wait(value=>value.preset.dmc.loop);
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);
    await page.locator('[data-dmc-byte="0"][data-dmc-bit="0"]').click();
    current=await wait(value=>value.voices.length===0&&value.preset.dmc.data[0]===0xa4);await page.keyboard.up('a');
    assert.match(await page.locator('#dmcBitReadout').textContent(),/64\s*→\s*62/,'the actual DMC editor previews its edited first DAC step');
    const dmcPreset=structuredClone(current.preset);savesBefore=await page.evaluate(()=>window.desktopAudit.saves.length);
    await page.click('#saveDpcm');await page.waitForFunction(count=>window.desktopAudit.saves.length===count+1,savesBefore);
    dmcSaved=await page.evaluate(()=>window.desktopAudit.saves.at(-1));
    assert.equal(dmcSaved.header.filename,'2a03-sample.dmc');assert.deepEqual(dmcSaved.bytes,dmcPreset.dmc.data);
    assert.equal(dmcSaved.bytes.length,2,'raw DPCM export excludes the generated 15 padding bytes');
    await page.keyboard.down('a');const heldDmc=await wait(value=>value.voices.length===1);
    await page.evaluate(()=>{window.desktopAudit.cancelSave=true;});await page.click('#saveDpcm');
    await page.waitForFunction(()=>document.querySelector('#audioStatus').textContent==='Save cancelled.');
    current=await state();assert.deepEqual(current.preset,dmcPreset);assert.deepEqual(current.voices,heldDmc.voices,'cancelling native DPCM save keeps the playing sample');
    await page.evaluate(()=>{window.desktopAudit.cancelSave=false;});await page.keyboard.up('a');await wait(value=>value.voices.length===0);

    console.log(`CHECK ${name}: public desktop bridge quiesces both Pulse voices, Triangle, Noise, DMC and FDS`);
    for(const kind of ['pulse','triangle','noise','dmc','fds']) {
      await source(kind);
      const pressed=kind==='pulse'?['a','s']:['a'];
      for(const key of pressed)await page.keyboard.down(key);
      const playing=await wait(value=>value.voices.length===pressed.length);
      await page.waitForFunction(async()=>await window.desktopAudit.webPeak()>.0001);
      if(!await page.isDisabled('#pitchBend')) {
        await page.locator('#pitchBend').evaluate(node=>{node.value='.5';node.dispatchEvent(new Event('input',{bubbles:true}));});await wait(value=>value.pitch===.5);
      }
      await page.evaluate(async()=>{window.tetoricaSynthAudio.setSwitching(true);await window.tetoricaSynthAudio.stopPlayback();});
      current=await wait(value=>value.voices.length===0&&value.pitch===0);
      assert.deepEqual(current.preset,playing.preset,`${kind}: stopping the public bridge retains the full instrument`);
      for(const id of ['pitchBend','keyboardPitchBend'])assert.equal(await page.locator('#'+id).inputValue(),'0',`${kind}: both Pitch wheels reset`);
      if(kind==='dmc')assert.equal(current.coreState.dmcOutput,0,'explicit desktop stop clears the DMC DAC');
      await page.waitForFunction(async()=>await window.desktopAudit.webPeak()<.00001);
      await page.keyboard.down('d');assert.equal((await state()).voices.length,0,`${kind}: switching blocks new computer-key notes`);await page.keyboard.up('d');
      await page.evaluate(()=>window.tetoricaSynthAudio.setSwitching(false));
      for(const key of pressed)await page.keyboard.up(key);
      await audition();
    }

    console.log(`CHECK ${name}: FDS mouse edit stays a draft until release and the edited waveform plays`);
    const fdsCanvas=page.locator('#fdsCanvas');await fdsCanvas.scrollIntoViewIfNeeded();
    const fdsRect=await fdsCanvas.boundingBox();assert(fdsRect);
    await page.keyboard.down('a');const beforeFdsEdit=await wait(value=>value.voices.length===1);
    await page.mouse.move(fdsRect.x+fdsRect.width*.2,fdsRect.y+fdsRect.height*.35);await page.mouse.down();
    await page.mouse.move(fdsRect.x+fdsRect.width*.75,fdsRect.y+fdsRect.height*.65,{steps:6});
    current=await state();assert.deepEqual(current.preset,beforeFdsEdit.preset);assert.deepEqual(current.voices,beforeFdsEdit.voices);
    await page.mouse.up();current=await wait(value=>value.voices.length===0&&JSON.stringify(value.preset.fds.wave)!==JSON.stringify(beforeFdsEdit.preset.fds.wave));
    assert.equal(current.preset.fds.wave.length,64);assert(current.preset.fds.wave.every(value=>Number.isInteger(value)&&value>=0&&value<=63));
    await page.keyboard.up('a');await audition();
    await menu();const restoreChooser=page.waitForEvent('filechooser');await page.click('#loadPreset');
    await(await restoreChooser).setFiles({name:'desktop-fds-restored.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});
    await wait(value=>JSON.stringify(value.preset)===JSON.stringify(imported));

    console.log(`CHECK ${name}: actual native-capture Worklet PCM / route switch / device failure fallback`);
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);await menu();
    if(!await page.locator('#desktop-audio-output').evaluate(node=>node.open))await page.locator('#desktop-audio-output > summary').click();
    await page.click('#desktop-audio-native');
    await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    current=await wait(value=>value.voices.length===0);assert.deepEqual(current.preset,imported);await page.keyboard.up('a');
    assert.equal(await page.evaluate(async()=>window.desktopAudit.speakerEdges.has((await window.tetoricaSynthAudio.ensureReady()).output)),false);
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);
    await page.waitForFunction(()=>window.desktopAudit.nativePeak>.001&&window.desktopAudit.packets>0);
    assert.equal(await page.evaluate(()=>window.desktopAudit.nativeFinite),true);
    await page.click('#desktop-audio-web');await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent==='Web Audio output');
    current=await wait(value=>value.voices.length===0);assert.deepEqual(current.preset,imported);await page.keyboard.up('a');
    assert.equal(await page.evaluate(async()=>window.desktopAudit.speakerEdges.has((await window.tetoricaSynthAudio.ensureReady()).output)),true);await audition();
    await page.click('#desktop-audio-native');await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    await page.evaluate(()=>{window.desktopAudit.failWrites=true;});await page.keyboard.down('a');
    await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.includes('Injected offline device failure'));
    current=await wait(value=>value.voices.length===0);assert.deepEqual(current.preset,imported);await page.keyboard.up('a');
    await audition();
    assert.equal(await page.evaluate(()=>window.desktopAudit.contexts.length),1);
    if(options.screenshots)await page.screenshot({path:path.join(options.screenshots,`desktop-${name}.png`),fullPage:true});
    await page.setViewportSize({width:540,height:900});await page.waitForTimeout(100);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(overflow<=1,`Narrow desktop overflow: ${overflow}`);
    if(options.screenshots)await page.screenshot({path:path.join(options.screenshots,`desktop-${name}-narrow.png`),fullPage:true});
    assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);
    const measurements=await page.evaluate(()=>({nativePackets:window.desktopAudit.packets,nativePeak:window.desktopAudit.nativePeak,nativeFinite:window.desktopAudit.nativeFinite}));
    console.log(`PASS ${name}: mocked desktop host with actual WASM and capture Worklet`);
    return {engine:name,desktopToolbar:true,pin:true,nativePresetBinarySave:true,reloadCancel:true,vgzMenuChooser:true,
      presetFileImport:true,keyboardAfterMenus:true,nativeCapturePcm:true,switchPreservesPreset:true,nativeFailureFallback:true,
      switchStopsPulseAndPitch:true,switchBlocksPerformance:true,nativeSaveCancel:true,presetLoadCancel:true,
      presetV7:true,nesVgmImport:true,vgmPanelMenuReveal:true,allSourcesQuiesce:true,bothPulseVoicesQuiesce:true,allSourcesPitchReset:true,
      dmcDemoAudition:true,dmcBitEditor:true,dmcNativeBinaryExport:true,dmcExportWithoutPadding:true,dmcSaveCancelKeepsNotes:true,fdsDrawing:true,fdsEditedAudition:true,
      oneAudioContext:true,mobileOverflow:overflow,...measurements,pageErrors:errors,missingAssets:missing,
      nativeHost:'mocked Tauri IPC; no CPAL device',physicalOutput:'muted'};
  } catch(error) {
    console.error(JSON.stringify({engine:name,audioStatus:await page.locator('#audioStatus').textContent().catch(()=>null),errors,missing,consoleErrors}));
    if(options.screenshots)await page.screenshot({path:path.join(options.screenshots,`desktop-${name}-failure.png`),fullPage:true}).catch(()=>{});
    throw error;
  } finally {await browser.close();}
}
(async()=>{
  if(options.screenshots)await fs.mkdir(options.screenshots,{recursive:true});
  const server=http.createServer(async(request,response)=>{
    try {
      const name=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
      const file=name==='/desktop-audio-worklet.js'?path.join(root,'desktop/audio-worklet.js'):path.resolve(root,'dist','.'+name);
      assert(file.startsWith(path.join(root,'dist')+path.sep)||file===path.join(root,'desktop/audio-worklet.js'));
      const bytes=await fs.readFile(file);response.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','access-control-allow-origin':'*'});response.end(bytes);
    } catch(error){response.writeHead(404,{'access-control-allow-origin':'*'});response.end('Missing test asset');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const backend=`http://tauri.localhost:${server.address().port}`;
    const rows=[];for(const [name,engine] of [['chromium',chromium],['webkit',webkit]])rows.push(await run(name,engine,backend));
    await fs.mkdir(path.dirname(options.out),{recursive:true});await fs.writeFile(options.out,JSON.stringify({passed:true,rows},null,2)+'\n');
    console.log(`Desktop browser check passed: ${options.out}`);
  } finally {await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
