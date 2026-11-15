const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../desktop/desktop-interface.js'), 'utf8');
function boot(url, subframe = false, fail = false, confirmed = false, saveResult = '/tmp/2a03-voice.json') {
  const calls = [], status = {textContent: ''}, listeners = {}, button = {disabled: false, addEventListener: (type, fn) => {listeners[type] = fn;}};
  let receiveExport;
  const exportCall = new Promise(resolve => {receiveExport = resolve;});
  class Anchor {click() {calls.push('browser-click');}}
  let serial = 0;
  const URLMock = {createObjectURL: () => `blob:${++serial}`, revokeObjectURL() {}};
  const window = {addEventListener() {}, __TAURI_INTERNALS__: {invoke: async (command, args) => {
    const call = {command, args}; calls.push(call);
    if (command === 'save_export_binary') receiveExport(call);
    if (fail) throw new Error('write failed');
    return command === 'save_export_binary' ? saveResult : false;
  }}};
  window.top = subframe ? {} : window;
  vm.runInNewContext(source, {window, location: new URL(url), URL: URLMock, HTMLAnchorElement: Anchor, Map, Uint8Array, Array, DataView, TextEncoder,
    document: {readyState: 'complete', getElementById: id => id === 'audioStatus' ? status : null,
      querySelector: selector => selector === '[data-reset-offline-cache]' ? button : null,
      createElement: () => ({style: {}, children: [], listeners: {},
        addEventListener(type, fn) {this.listeners[type] = fn;}, append(...items) {this.children.push(...items);},
        close(value) {this.returnValue = value; this.listeners.close();}, remove() {}, showModal() {}, focus() {}}),
      body: {append(dialog) {setImmediate(() => dialog.children[confirmed ? 2 : 1].listeners.click());}}}});
  return {calls, status, listeners, button, Anchor, URL: URLMock, exportCall};
}
test('local Synth exports original bytes even after immediate URL revocation', async () => {
  for (const url of ['tauri://localhost/index.html', 'http://tauri.localhost/index.html', 'https://tauri.localhost/index.html']) {
    const ui = boot(url), link = new ui.Anchor();
    link.href = ui.URL.createObjectURL(new Blob([new Uint8Array([1, 2, 255])])); link.download = '2a03-voice.json';
    link.click(); ui.URL.revokeObjectURL(link.href);
    await new Promise(resolve => setImmediate(resolve));
    const packet = exportPacket(ui.calls[0]);
    assert.deepEqual(Array.from(packet.bytes), [1, 2, 255]);
    assert.equal(packet.header.filename, '2a03-voice.json'); assert.match(ui.status.textContent, /Saved/);
  }
});
function exportPacket(call) {
  assert.equal(call.command, 'save_export_binary');
  assert.ok(call.args instanceof ArrayBuffer, 'Native IPC receives raw bytes, never a numeric JSON array');
  const headerLength = new DataView(call.args).getUint32(0, true);
  assert.ok(headerLength > 0 && headerLength <= 4096);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(call.args, 4, headerLength)));
  return {header, headerLength, bytes:new Uint8Array(call.args, 4 + headerLength)};
}
test('16 MiB generic export uses one binary packet with only a small JSON header', {timeout:2000}, async () => {
  const original = new Uint8Array(16 * 1024 * 1024);
  for (let i = 0; i < original.length; i++) original[i] = i & 0xff;
  const ui = boot('tauri://localhost/'), link = new ui.Anchor();
  link.href = ui.URL.createObjectURL(new Blob([original])); link.download = '音色🎵.cassette.zip';
  link.click(); ui.URL.revokeObjectURL(link.href);
  const call = await ui.exportCall;
  const packet = exportPacket(call);
  assert.deepEqual(packet.header, {filename:link.download});
  assert.equal(call.args.byteLength, original.byteLength + packet.headerLength + 4);
  assert.ok(packet.headerLength > JSON.stringify(packet.header).length, 'Header length counts UTF-8 bytes');
  assert.equal(Buffer.compare(Buffer.from(packet.bytes), Buffer.from(original)), 0);
  assert.equal(ui.calls.length, 1);
});
test('oversized export rejects before reading the Blob or invoking native code', async () => {
  const ui = boot('tauri://localhost/'), link = new ui.Anchor();
  let reads = 0;
  link.href = ui.URL.createObjectURL({size:128 * 1024 * 1024 + 1, arrayBuffer() {reads++; throw Error('Must not read');}});
  link.download = 'huge.cassette.zip'; link.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0); assert.deepEqual(ui.calls, []);
  assert.match(ui.status.textContent, /Could not save.*Export exceeds 128 MiB/);
});
test('oversized UTF-8 filename header rejects before reading the Blob', async () => {
  const ui = boot('tauri://localhost/'), link = new ui.Anchor();
  let reads = 0;
  link.href = ui.URL.createObjectURL({size:1, arrayBuffer() {reads++; throw Error('Must not read');}});
  link.download = '界'.repeat(1500); link.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0); assert.deepEqual(ui.calls, []);
  assert.match(ui.status.textContent, /Could not save.*header exceeds 4096 bytes/);
});
test('cancelled native binary save reports cancellation without browser navigation', async () => {
  const ui = boot('tauri://localhost/', false, false, false, null), link = new ui.Anchor();
  link.href = ui.URL.createObjectURL(new Blob([])); link.download = 'empty.bin'; link.click();
  await ui.exportCall;
  await new Promise(resolve => setImmediate(resolve));
  const packet = exportPacket(ui.calls[0]);
  assert.equal(packet.bytes.byteLength, 0);
  assert.equal(ui.status.textContent, 'Save cancelled.');
  assert.equal(ui.calls.includes('browser-click'), false);
});
test('remote pages and subframes retain browser behavior without native hooks', () => {
  for (const [url, frame] of [['https://example.com/', false], ['http://localhost:8890/', false], ['tauri://other/', false], ['tauri://localhost/', true]]) {
    const ui = boot(url, frame); const link = new ui.Anchor(); link.href = ui.URL.createObjectURL(new Blob(['x'])); link.download = 'x'; link.click();
    assert.deepEqual(ui.calls, ['browser-click']); assert.equal(ui.listeners.click, undefined);
  }
});
test('ordinary links use normal browser navigation and save errors are visible', async () => {
  const ui = boot('tauri://localhost/', false, true), link = new ui.Anchor(); link.href = 'https://example.com'; link.click();
  assert.equal(ui.calls[0], 'browser-click');
  link.href = ui.URL.createObjectURL(new Blob(['x'])); link.download = 'voice.vgi'; link.click();
  await new Promise(resolve => setImmediate(resolve)); assert.match(ui.status.textContent, /Could not save.*write failed/);
});
test('cache button confirms before native reload and cancellation re-enables it', async () => {
  for (const confirmed of [false, true]) {
    const ui = boot('tauri://localhost/', false, false, confirmed);
    await ui.listeners.click({preventDefault() {}, stopImmediatePropagation() {}});
    assert.equal(ui.calls.length, confirmed ? 1 : 0);
    if (confirmed) assert.equal(ui.calls[0].command, 'reload_window');
    assert.equal(ui.button.disabled, false);
  }
});

function bootPin({url = 'tauri://localhost/index.html', subframe = false, loading = false, available = true, initial = false, invoke} = {}) {
  const calls = [], events = {}, domEvents = {}, status = {textContent: ''};
  const button = {
    hidden: true, disabled: false, attributes: {}, listeners: {}, selected: false,
    setAttribute(name, value) {this.attributes[name] = value;},
    addEventListener(type, listener) {(this.listeners[type] ||= []).push(listener);},
    classList: {toggle(name, value) {if (name === 'is-selected') button.selected = value;}},
  };
  class Anchor {click() {}}
  const window = {
    addEventListener(type, listener) {events[type] = listener;},
    __TAURI_INTERNALS__: {invoke: async (command, args) => {
      calls.push({command, args});
      return invoke ? invoke(command, args) : command === 'window_pin_state' ? initial : args.pinned;
    }},
  };
  window.top = subframe ? {} : window;
  let mounted = available;
  vm.runInNewContext(source, {
    window, location: new URL(url), URL: {createObjectURL() {}, revokeObjectURL() {}},
    HTMLAnchorElement: Anchor, Map, Uint8Array, Array,
    document: {
      readyState: loading ? 'loading' : 'complete',
      getElementById: id => id === 'audioStatus' ? status : id === 'synthPinButton' && mounted ? button : null,
      querySelector() {return null;},
      addEventListener(type, listener) {domEvents[type] = listener;},
    },
  });
  return {calls, events, domEvents, status, button, mount() {mounted = true; events['tetorica-synth-ready']?.();}};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('native pin reads actual state and toggles without taking keyboard focus', async () => {
  for (const url of ['tauri://localhost/index.html', 'http://tauri.localhost/index.html', 'https://tauri.localhost/index.html']) {
    const ui = bootPin({url, initial: true});
    assert.equal(ui.button.disabled, true); assert.equal(ui.button.hidden, true);
    await settle();
    assert.equal(ui.button.hidden, false); assert.equal(ui.button.disabled, false);
    assert.equal(ui.button.attributes['aria-pressed'], 'true'); assert.equal(ui.button.selected, true);
    assert.equal(ui.button.title, 'Unpin window');
    let prevented = false;
    ui.button.listeners.pointerdown[0]({preventDefault() {prevented = true;}});
    assert.equal(prevented, true);
    await ui.button.listeners.click[0]();
    assert.equal(ui.calls[1].command, 'set_window_pin'); assert.equal(ui.calls[1].args.pinned, false);
    assert.equal(ui.button.attributes['aria-pressed'], 'false'); assert.equal(ui.button.selected, false);
    assert.equal(ui.button.title, 'Pin window on top');
  }
});

test('pin command errors retain the last confirmed state and allow retry', async () => {
  const ui = bootPin({initial: true, invoke: async command => {
    if (command === 'window_pin_state') return true;
    throw new Error('not supported');
  }});
  await settle();
  await ui.button.listeners.click[0]();
  assert.equal(ui.button.attributes['aria-pressed'], 'true'); assert.equal(ui.button.selected, true);
  assert.equal(ui.button.disabled, false); assert.match(ui.status.textContent, /Could not pin window.*not supported/);
  await ui.button.listeners.click[0]();
  assert.equal(ui.calls.filter(call => call.command === 'set_window_pin').length, 2);
});

test('pin uses the native returned state and rejects duplicate in-flight toggles', async () => {
  let complete;
  const ui = bootPin({invoke: (command) => command === 'window_pin_state' ? false : new Promise(resolve => {complete = resolve;})});
  await settle();
  const toggle = ui.button.listeners.click[0]();
  assert.equal(ui.button.disabled, true); assert.equal(ui.button.attributes['aria-pressed'], 'false');
  await ui.button.listeners.click[0]();
  assert.equal(ui.calls.length, 2);
  complete(false); // The actual native state can differ from the requested target.
  await toggle;
  assert.equal(ui.button.disabled, false); assert.equal(ui.button.attributes['aria-pressed'], 'false');
});

test('pin mounts once when DOM is ready or when Synth supplies the controls later', async () => {
  const pending = bootPin({loading: true});
  assert.equal(pending.calls.length, 0);
  pending.domEvents.DOMContentLoaded(); pending.events['tetorica-synth-ready']();
  await settle();
  assert.equal(pending.calls.length, 1); assert.equal(pending.button.listeners.click.length, 1);
  const dynamic = bootPin({available: false});
  assert.equal(dynamic.calls.length, 0);
  dynamic.mount(); dynamic.mount();
  await settle();
  assert.equal(dynamic.calls.length, 1); assert.equal(dynamic.button.listeners.click.length, 1);
});

test('remote pages and subframes cannot mount or call native pin controls', async () => {
  for (const [url, subframe] of [['https://example.com/', false], ['http://localhost:8890/', false], ['tauri://other/', false], ['tauri://localhost/', true]]) {
    const ui = bootPin({url, subframe});
    ui.mount(); await settle();
    assert.equal(ui.button.hidden, true); assert.equal(ui.button.listeners.click, undefined); assert.equal(ui.calls.length, 0);
  }
});

test('failed or malformed initial native pin state leaves the control hidden', async () => {
  for (const invoke of [() => {throw new Error('unavailable');}, () => 'false']) {
    const ui = bootPin({invoke}); await settle();
    assert.equal(ui.button.hidden, true); assert.match(ui.status.textContent, /Could not read window pin state/);
    assert.equal(ui.button.attributes['aria-pressed'], 'false');
  }
});

function bootToolbar(webMenu) {
  const nodes = new Map(), events = {};
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {};
      this.className = ''; this.style = {};
      this.classList = {add: (...names) => {this.className += ' ' + names.join(' ');}, toggle() {}};
    }
    set id(value) {this._id = value; nodes.set(value, this);} get id() {return this._id;}
    append(...elements) {
      for (const element of elements) {
        if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
        element.parent = this; this.children.push(element);
      }
    }
    before(element) {
      element.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this), 0, element);
    }
    replaceChildren(...elements) {
      for (const child of this.children) child.parent = null;
      this.children = []; this.append(...elements);
    }
    setAttribute(name, value) {this.attributes[name] = value;}
    addEventListener(type, listener) {(this.listeners[type] ||= []).push(listener);}
    querySelector(selector) {
      const matches = element => selector === '[data-reset-offline-cache]' ? 'resetOfflineCache' in element.dataset :
        selector === '.synth-menu-panel' && element.className.split(' ').includes('synth-menu-panel');
      for (const child of this.children) {
        if (matches(child)) return child;
        const nested = child.querySelector(selector); if (nested) return nested;
      }
      return null;
    }
    set innerHTML(value) {
      this.markup = value;
      if (this.id === 'synthMenu') {
        const button = make('summary', 'synthMenuButton'), panel = make('div', 'synthMenuPanel');
        panel.className = 'synth-menu-panel'; this.append(button, panel);
      }
    }
  }
  const make = (tag, id) => {const element = new Element(tag); if (id) element.id = id; return element;};
  const body = make('body'), head = make('head'), title = make('div'), identity = make('div');
  title.append(identity); body.append(title);
  for (const id of ['loadPreset', 'savePreset', 'presetFileInput', 'loadVgm', 'vgmPanel', 'audioStatus']) body.append(make('div', id));
  let host, menu, panel, hint;
  const originalAction = () => {};
  if (webMenu) {
    host = make('div', 'synthDesktopTools'); host.dataset.webMenu = 'true';
    menu = make('details', 'synthMenu'); panel = make('div', 'synthMenuPanel');
    panel.className = 'synth-menu-panel';
    const button = make('summary', 'synthMenuButton'), audio = make('section', 'synthMenuAudio');
    hint = make('p'); audio.append(hint);
    for (const id of ['synthMenuVgm', 'nesMenuProjectImport', 'nesMenuFilesImport', 'nesMenuProjectExport', 'nesMenuFileExport']) {
      const action = make('button', id); action.addEventListener('click', originalAction); panel.append(action);
    }
    panel.append(audio); menu.append(button, panel); host.append(menu, make('button', 'synthPinButton')); title.append(host);
  }
  class Anchor {click() {}}
  const window = {addEventListener(type, listener) {events[type] = listener;}, __TAURI_INTERNALS__: {invoke: async () => false}};
  window.top = window;
  const document = {readyState: 'complete', body, head, createElement: tag => make(tag), getElementById: id => nodes.get(id),
    addEventListener() {}, querySelector(selector) {
      if (selector === '.title-row') return title;
      if (selector === '.product-identity') return identity;
      if (selector === '#synthMenuAudio > p') return hint;
      return body.querySelector(selector);
    }};
  vm.runInNewContext(source, {window, document, location: new URL('tauri://localhost/index.html'),
    URL: {createObjectURL() {}, revokeObjectURL() {}}, HTMLAnchorElement: Anchor, Map, Uint8Array, Array, DataView, TextEncoder});
  return {nodes, events, menu, panel, hint, host: nodes.get('synthDesktopTools'), originalAction, body};
}

test('desktop extends the web menu while preserving project actions and existing handlers', async () => {
  const ui = bootToolbar(true); await settle();
  assert.equal(ui.host.children[0], ui.menu);
  assert.equal(ui.nodes.get('synthMenuPanel'), ui.panel);
  for (const id of ['nesMenuProjectImport', 'nesMenuFilesImport', 'nesMenuProjectExport', 'nesMenuFileExport']) {
    assert.equal(ui.nodes.get(id).parent, ui.panel);
    assert.deepEqual(ui.nodes.get(id).listeners.click, [ui.originalAction]);
  }
  assert.equal(ui.nodes.get('loadPreset').parent, ui.body);
  assert.equal(ui.nodes.get('savePreset').parent, ui.body);
  assert.equal(ui.hint.id, 'synthBrowserAudioHint');
  const reload = ui.host.querySelector('[data-reset-offline-cache]');
  assert.equal(reload.textContent, 'Reload');
  assert.equal(reload.dataset.closeSynthMenu, '');
  assert.equal(reload.listeners.click.length, 1);
  for (const listener of ui.nodes.get('synthMenuVgm').listeners.click) listener();
  assert.equal(ui.nodes.get('vgmPanel').open, true);
  ui.events['tetorica-synth-ready'](); ui.events['tetorica-synth-ready']();
  assert.equal(ui.panel.children.filter(section => section.children.includes(reload)).length, 1);
  assert.equal(reload.listeners.click.length, 1);
  assert.equal(ui.nodes.get('synthMenuVgm').listeners.click.length, 2);
});

test('releases without a web menu retain the desktop toolbar and preset actions', async () => {
  const ui = bootToolbar(false); await settle();
  const menu = ui.nodes.get('synthMenu'), panel = ui.nodes.get('synthMenuPanel');
  assert.equal(ui.host.children[0], menu);
  assert.equal(ui.host.children[1], ui.nodes.get('synthPinButton'));
  assert.equal(ui.nodes.get('loadPreset').textContent, 'Instrument · 2A03 preset…');
  assert.equal(ui.nodes.get('savePreset').textContent, 'Instrument · 2A03 preset…');
  assert.equal(ui.nodes.get('loadPreset').parent.parent, panel);
  assert.equal(ui.nodes.get('savePreset').parent.parent, panel);
  const reload = ui.host.querySelector('[data-reset-offline-cache]');
  assert.equal(reload.listeners.click.length, 1);
  ui.events['tetorica-synth-ready']();
  assert.equal(ui.nodes.get('synthMenu'), menu);
  assert.equal(reload.listeners.click.length, 1);
});
