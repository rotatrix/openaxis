import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PerspectiveCamera } from 'three';
import { AsyncNavigationSession, NavigationDiagnostics, DIAGNOSTIC_COLORS, UNAVAILABLE } from '../../ts/sdk/dist/index.js';
import { SketchfabCamera, callApi } from './lib/sketchfab-camera.js';
import { createSketchfabNavigation, cloneCamera, pivotScreen, measureTranslationScale, SKETCHFAB_NAVIGATION_TAGS } from './lib/sketchfab-navigation.js';

test('viewer readiness auto-connects CAD metadata; pause and page-cache resume preserve camera', async () => {
  const html=readFileSync(new URL('./sketchfab.html',import.meta.url),'utf8');
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{
    style:{},hidden:false,disabled:false,open:false,value:'0',textContent:'',
    listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},removeEventListener(){},replaceChildren(){},focus(){},
    cloneNode(){return this;},replaceWith(){},
    getBoundingClientRect:()=>({left:330,top:0,width:900,height:600}),
  }]));
  const element=id=>{assert.ok(elements.has(id),`unknown UI element ${id}`);return elements.get(id);};
  element('model').value='faef9fe5ace445e7b2989d1c1ece361c';
  element('model-select').options=[...html.matchAll(/<option value="([^"]+)"/g)].map(([,value])=>({value}));
  element('sdk-diagnostics-panel').open=true;
  let ready, options, pause=true, starts=0, rollWrites=0, metadata, destroyed=false;
  const events=new Map();
  const api={addEventListener(name,fn){if(name==='viewerready')ready=fn;},start(){},
    setEnableCameraConstraints(v,cb){cb(null);},getCameraLookAt(cb){cb(null,{position:[0,-5,2],target:[0,0,0]});},
    getFov(cb){cb(null,45);},setFov(v,cb){cb(null);},setCameraRoll(v,cb){rollWrites++;cb(null);},
    setCameraLookAt(p,t,d,cb){cb(null);},setUserInteraction(v,cb){cb(null);},pickFromScene(a,b,cb){cb(null);}};
  class Client {state='disconnected';attachNavigation(){return ()=>{};}captureNavigationSender(){return ()=>{};} }
  const scope={SketchfabCamera,callApi,createSketchfabNavigation,cloneCamera,pivotScreen,measureTranslationScale,SKETCHFAB_NAVIGATION_TAGS,
    PerspectiveCamera,OpenAxisClient:Client,AsyncNavigationSession,NavigationDiagnostics,DIAGNOSTIC_COLORS,UNAVAILABLE,
    NavigationDiagnosticOverlay:class {clear(){}draw(){}dispose(){}},
    createStatusHUD:()=>Object.assign(()=>{},{setPaused(){}}),
    manageFocus(client,opts){metadata=opts.metadata;return {
      lifecycle:{async refreshMetadata(){}},
      hasControlFocus:()=>!pause,isPaused:()=>pause,
      pause(){pause=true;opts.onPauseChange(true);},resume(){pause=false;starts++;opts.onPauseChange(false);},
      async destroy(){destroyed=true;},
    };},
    document:{getElementById:element,querySelectorAll:()=>[],body:{classList:{toggle(){}}},addEventListener(){}},
    window:{Sketchfab:class {init(uid,opts){options=opts;opts.success(api);}}},
    addEventListener(name,fn){events.set(name,fn);},requestAnimationFrame:()=>1,cancelAnimationFrame(){},
    setTimeout:()=>1,clearTimeout(){},performance,console,
  };
  const source=readFileSync(new URL('./lib/sketchfab-demo.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
  runInNewContext(source+'\nglobalThis.inspect=()=>({active,binding,session,host});',scope);
  assert.equal(starts,0);assert.equal(elements.has('take'),false);
  assert.equal(options.navigation,'fps');
  assert.equal(element('viewer').style.visibility,'visible','viewer must render before it can signal readiness');
  ready();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(starts,1);assert.equal(scope.inspect().active,true);
  assert.deepEqual(Array.from(metadata().tags),SKETCHFAB_NAVIGATION_TAGS);
  const pose=scope.inspect().binding.camera, writes=rollWrites;
  element('pause').onclick();assert.equal(pause,true);
  element('pause').onclick();assert.equal(pause,false);
  assert.equal(scope.inspect().binding.camera,pose);assert.equal(rollWrites,writes);
  element('navigation-mode').value='free_camera';
  await element('navigation-mode').listeners.change();
  assert.deepEqual(Array.from(metadata().tags), [...SKETCHFAB_NAVIGATION_TAGS, 'navigation.hint.free_camera']);
  assert.deepEqual(Array.from(metadata().capabilities), ['navigation']);
  assert.equal(scope.inspect().binding.camera,pose);
  assert.equal(rollWrites,writes);
  assert.equal(element('lock-pivot').disabled,true);
  let prevented=0;
  const beforeAlt=scope.inspect().binding;
  for (const type of ['keydown','keyup']) events.get(type)({key:'Alt',preventDefault(){prevented++;}});
  assert.equal(prevented,2,'suppress both browser Alt menu events');
  assert.equal(scope.inspect().binding,beforeAlt,'Alt release preserves navigation context');
  assert.equal(pause,false);
  const {host,binding}=scope.inspect();
  const base=await (await host.adapter.beginQuery(binding)).resolve('navigation.translation_scale');
  assert.ok(base>0);
  element('travel-speed').value='4';
  await element('travel-speed').listeners.change();
  assert.equal(await (await host.adapter.beginQuery(binding)).resolve('navigation.translation_scale'),base*4);
  assert.equal(rollWrites,writes);
  element('navigation-mode').value='orbit';
  await element('navigation-mode').listeners.change();
  assert.deepEqual(Array.from(metadata().tags),SKETCHFAB_NAVIGATION_TAGS);
  assert.equal(element('lock-pivot').disabled,false);
  events.get('keyup')({key:'Alt',preventDefault(){prevented++;}});
  assert.equal(prevented,2,'ordinary Alt behavior remains available outside free camera');
  element('model-select').value='fb30feb22cf04b91be3be0872d10ba17';
  await element('model-select').listeners.change();
  assert.equal(element('model').value,'fb30feb22cf04b91be3be0872d10ba17');
  assert.equal(element('travel-speed').value,'4');
  assert.equal(element('model-source').href,'https://sketchfab.com/models/fb30feb22cf04b91be3be0872d10ba17');
  ready();await new Promise(resolve=>setImmediate(resolve));
  const switchedPose=scope.inspect().binding.camera;
  element('model-select').value='custom';
  await element('model-select').listeners.change();
  assert.equal(element('custom-model').open,true);
  assert.equal(scope.inspect().binding.camera,switchedPose);
  events.get('pagehide')({persisted:true});
  assert.equal(scope.inspect().binding.camera,switchedPose);assert.equal(destroyed,false);
  events.get('pagehide')({persisted:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(destroyed,true);assert.equal(scope.inspect().active,false);
});
