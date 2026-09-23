import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AsyncNavigationSession, NavigationQuery, UNAVAILABLE } from '../../ts/sdk/dist/index.js';
import { createSketchfabNavigation, cameraPose, cloneCamera, SKETCHFAB_NAVIGATION_TAGS } from './lib/sketchfab-navigation.js';
import { SketchfabCamera } from './lib/sketchfab-camera.js';
import { cameraRay, pickScene, pivotScreen, cameraTranslationScale, framedModelRadius, measureTranslationScale } from './lib/sketchfab-navigation.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('Sketchfab metadata describes a camera-only navigation client', () => {
  assert.ok(!SKETCHFAB_NAVIGATION_TAGS.some(tag => tag.startsWith('interaction.object')));
  assert.ok(SKETCHFAB_NAVIGATION_TAGS.includes('viewspace.3d'));
  assert.ok(SKETCHFAB_NAVIGATION_TAGS.includes('workspace.modeling'));
});
function fixture(cursor = () => null) {
  const calls = []; let fov = 45;
  const api = {
    setCameraLookAt(p,t,d,cb) { calls.push(['look',p,t,d]); cb(null); },
    setCameraRoll(r,cb) { calls.push(['roll',r]); cb(null); },
    setFov(value,cb) { fov=value; calls.push(['fov',value]); cb(null); },
    getFov(cb) { cb(null,fov); },
  };
  let context = { api, camera: new SketchfabCamera([0,-5,2],[0,0,0]), fov: Math.PI/4, documentId: 'model:1' };
  let available = true;
  const host = createSketchfabNavigation({current:()=>context,available:()=>available,aspect:()=>2,cursor,unavailable:UNAVAILABLE});
  return { host, calls, api, get context(){return context;}, retire(){context=undefined;}, blur(){available=false;} };
}
test('adapter reports Z-up perspective and chosen pivot without inventing picks', async () => {
  const f=fixture(), capture=await f.host.adapter.beginQuery(f.context);
  assert.deepEqual(await capture.resolve('camera.view_target'),[0,0,0]);
  assert.equal(await capture.resolve('viewport.aspect'),2);
  assert.equal(await capture.resolve('pick.cursor'),UNAVAILABLE);
  assert.equal((await capture.resolve('camera.pose')).fov,Math.PI/4);
  assert.deepEqual((await capture.resolve('world.orientation')).up,[0,0,1]);
});

test('free-camera scale follows authored view size and remains a query snapshot', async () => {
  const small=new SketchfabCamera([0,-5,2],[0,0,0]);
  const large=new SketchfabCamera([0,-5000,2000],[0,0,0]);
  const fov=Math.PI/3;
  assert.ok(Math.abs(cameraTranslationScale(large,fov)/cameraTranslationScale(small,fov)-1000)<1e-9);
  assert.ok(cameraTranslationScale(small,8*Math.PI/180)<cameraTranslationScale(small,fov));
  const f=fixture();
  f.context.translationScale=cameraTranslationScale(large,fov);
  const captured=await f.host.adapter.beginQuery(f.context), scale=f.context.translationScale;
  f.context.camera.move('back',10000);
  assert.equal(await captured.resolve('navigation.translation_scale'),scale);
  f.context.translationScale=scale*4;
  assert.equal(await captured.resolve('navigation.translation_scale'),scale);
  const next=await f.host.adapter.beginQuery(f.context);
  assert.equal(await next.resolve('navigation.translation_scale'),scale*4);
  f.context.translationScale=NaN;
  assert.equal(await (await f.host.adapter.beginQuery(f.context)).resolve('navigation.translation_scale'),UNAVAILABLE);
});

test('framing recovers half model diameter independent of FOV, aspect and authored view', async () => {
  for (const aspect of [.5, 1, 2]) for (const degrees of [8, 45, 90]) {
    const radius=500, fov=degrees*Math.PI/180;
    const distance=radius/Math.sin(Math.atan(Math.tan(fov/2)*Math.min(aspect,1)));
    const framed={position:[20,-distance,30],target:[20,0,30]};
    assert.ok(Math.abs(framedModelRadius(framed,fov,aspect)-radius)<1e-9);
    const camera=new SketchfabCamera([1,-2,3],[0,0,0]), calls=[];
    const api={recenterCamera(cb){calls.push('frame');cb(null);},
      getCameraLookAt(cb){cb(null,framed);},
      setCameraLookAt(p,t,d,cb){calls.push([p,t,d]);cb(null);}};
    const measured=await measureTranslationScale(api,camera,fov,aspect);
    assert.ok(Math.abs(measured.scale-radius)<1e-9);
    assert.equal(measured.source,'model framing radius');
    assert.deepEqual(calls.at(-1),[camera.command().position,camera.command().target,0]);
  }
});

test('failed framing restores the view and labels its fallback; failed restoration rejects', async () => {
  const camera=new SketchfabCamera([0,-5,2],[0,0,0]);let restored=false;
  const api={recenterCamera(cb){cb('not available');},setCameraLookAt(p,t,d,cb){restored=true;cb(null);}};
  const result=await measureTranslationScale(api,camera,Math.PI/3,2);
  assert.equal(restored,true);
  assert.equal(result.scale,cameraTranslationScale(camera,Math.PI/3));
  assert.equal(result.source,'initial view estimate');
  api.setCameraLookAt=(p,t,d,cb)=>cb('restore failed');
  await assert.rejects(measureTranslationScale(api,camera,Math.PI/3,2),/restore failed/);
});
test('real async SDK session applies absolute camera poses and rejects stale output', async t => {
  const f=fixture(), sent=[];
  const client={state:'connected', attachNavigation(){return ()=>{};}, captureNavigationSender(){return message=>sent.push(message);} };
  const session=new AsyncNavigationSession(client,f.host.adapter);
  t.after(()=>session.close());
  session.onMotionStart(1);
  let result;
  session.onNavigationQuery(new NavigationQuery({type:'request',id:1,method:'navigation.query',params:{gesture_id:1,values:['camera.pose','camera.view_target']}},r=>{result=r;},()=>assert.fail()));
  await tick();
  assert.ok(result.values['camera.pose']);
  const pose={...cameraPose(f.context),type:'camera_pose',gesture_id:1,seq:1,t:[2,-5,2]};
  session.onCameraPose(pose); await tick(); await f.host.idle();
  assert.deepEqual(f.context.camera.eye.toArray(),[2,-5,2]);
  const count=f.calls.length;
  session.onCameraPose({...pose,t:[9,9,9]}); await tick();
  assert.equal(f.calls.length,count);
  f.retire();session.contextChanged();
  session.onCameraPose({...pose,seq:2});await tick();
  assert.equal(f.calls.length,count);
});
test('slow viewer callbacks coalesce SDK poses without replaying intermediate positions', async t => {
  const f=fixture(), writes=[];
  f.context.fov=8*Math.PI/180;
  f.api.setCameraLookAt=(p,target,d,cb)=>writes.push({kind:'look',p,cb});
  f.api.setCameraRoll=(r,cb)=>writes.push({kind:'roll',cb});
  const client={state:'connected',attachNavigation(){return ()=>{};},captureNavigationSender(){return ()=>{};}};
  const session=new AsyncNavigationSession(client,f.host.adapter);
  t.after(()=>session.close());
  session.onMotionStart(1);
  session.onNavigationQuery(new NavigationQuery({type:'request',id:1,method:'navigation.query',params:{gesture_id:1,values:['camera.pose']}},()=>{},()=>assert.fail()));
  await tick();
  const pose={...cameraPose(f.context),type:'camera_pose',gesture_id:1};
  session.onCameraPose({...pose,seq:1,t:[1,-5,2]});await tick();
  assert.deepEqual(writes.map(w=>w.kind),['look','roll']);
  for(let seq=2;seq<=20;seq++) session.onCameraPose({...pose,seq,t:[seq,-5,2]});
  writes[1].cb(null);await tick();
  assert.equal(writes.length,2);
  writes[0].cb(null);await tick();
  assert.equal(writes.length,4);
  assert.deepEqual(writes[2].p,[20,-5,2]);
  writes.slice(2).forEach(w=>w.cb(null));await tick();
  assert.deepEqual(f.context.camera.eye.toArray(),[20,-5,2]);
  assert.equal(writes.length,4);
});

test('retiring a model during the pose pair prevents FOV writes and local commits', async () => {
  const f=fixture(), context=f.context;let finish;
  f.api.setCameraLookAt=(...args)=>{finish=args.at(-1);};
  const next=cloneCamera(context.camera);next.move('right',2);
  const write=f.host.write(context,next,Math.PI/3);await tick();
  f.retire();finish(null);
  assert.equal((await write).success,false);
  assert.deepEqual(f.calls.map(c=>c[0]),['roll']);
  assert.deepEqual(context.camera.eye.toArray(),[0,-5,2]);
});
test('FOV writes use degrees; unsupported projection and inactive focus fail closed', async () => {
  const f=fixture(),pose={...cameraPose(f.context),fov:Math.PI/3};
  const result=await f.host.adapter.applyPose(f.context,pose,undefined,[1,2,3]);
  assert.equal(result.success,true);
  assert.ok(Math.abs(f.calls.find(c=>c[0]==='fov')[1]-60)<1e-8);
  assert.deepEqual(f.context.camera.pivot.toArray(),[1,2,3]);
  await assert.rejects(f.host.adapter.applyPose(f.context,{...pose,fov:undefined,ortho_extent:2}),/perspective/);
  f.blur();assert.equal(f.host.adapter.captureContext(),undefined);
  assert.equal((await f.host.adapter.applyPose(f.context,pose)).success,false);
});
test('focus lost during the pose pair prevents subsequent FOV writes and commits', async () => {
  const f=fixture();let finish;
  f.api.setCameraLookAt=(...args)=>{finish=args.at(-1);};
  const pending=f.host.adapter.applyPose(f.context,{...cameraPose(f.context),t:[4,-5,2],fov:Math.PI/3});
  await tick();f.blur();finish(null);
  assert.equal((await pending).success,false);
  assert.deepEqual(f.calls.map(c=>c[0]),['roll']);
  assert.deepEqual(f.context.camera.eye.toArray(),[0,-5,2]);
});

for (const first of ['look','roll']) test(`pose pair dispatches together and drains both callbacks when ${first} finishes first`, async () => {
  const f=fixture(), pending=[];
  f.api.setCameraLookAt=(p,t,d,cb)=>pending.push({kind:'look',cb,p});
  f.api.setCameraRoll=(r,cb)=>pending.push({kind:'roll',cb,r});
  const next=cloneCamera(f.context.camera);next.turn('back',.4,false);
  const a=f.host.write(f.context,next);
  const b=f.host.write(f.context,cloneCamera(next));
  await tick();
  assert.deepEqual(pending.map(p=>p.kind),['look','roll'],'roll does not wait for look-at acknowledgment');
  pending.find(p=>p.kind===first).cb(null);await tick();
  assert.equal(pending.length,2,'next pose cannot overtake the unfinished component');
  pending.find(p=>p.kind!==first).cb(null);
  assert.equal((await a).success,true);await tick();
  assert.equal(pending.length,4);
  pending.slice(2).forEach(p=>p.cb(null));
  assert.equal((await b).success,true);
});

test('failed look-at still drains outstanding roll before the next pose', async () => {
  const f=fixture(), pending=[];
  f.api.setCameraLookAt=(p,t,d,cb)=>pending.push(cb);
  f.api.setCameraRoll=(r,cb)=>pending.push(cb);
  const original=f.context.camera, next=cloneCamera(original);next.move('right',2);
  const a=f.host.write(f.context,next);
  const rejected=assert.rejects(a,/viewer busy/);
  const b=f.host.write(f.context,next);
  await tick();pending[0]('viewer busy');await tick();
  assert.equal(pending.length,2);
  assert.equal(f.context.camera,original);
  pending[1](null);await rejected;await tick();
  assert.equal(pending.length,4);
  pending.slice(2).forEach(cb=>cb(null));
  assert.equal((await b).success,true);
});
test('lazy surface queries use captured cursor, skip selection facts, and fall back to center', async () => {
  let cursor={x:.6,y:-.2};const f=fixture(()=>({...cursor}));const rays=[];
  f.api.pickFromScene=(a,b,cb)=>{rays.push([a,b]);cb(null,rays.length===1?undefined:{position3D:[1,2,3]});};
  const capture=await f.host.adapter.beginQuery(f.context);cursor={x:-1,y:1};
  assert.equal(rays.length,0,'no eager casting');
  const query=new NavigationQuery({type:'request',id:1,method:'navigation.query',params:{first:['pick.cursor.selection','pick.viewport_center.selection','pick.cursor','pick.viewport_center']}},()=>{},()=>{});
  const result=await query.evaluateAsync(capture.resolve);
  assert.deepEqual(result.first,{name:'pick.viewport_center',value:{point:[1,2,3]}});
  assert.equal(rays.length,2);
  assert.deepEqual(rays[0],cameraRay(f.context.camera,f.context.fov,2,{x:.6,y:-.2}));
  assert.deepEqual(rays[1],cameraRay(f.context.camera,f.context.fov,2,{x:0,y:0}));
});
test('cursor hit stops fallback and returns the actual world point', async () => {
  const f=fixture(()=>({x:.2,y:.3}));let calls=0;
  f.api.pickFromScene=(a,b,cb)=>{calls++;cb(null,{position3D:[10,-4,8]});};
  const capture=await f.host.adapter.beginQuery(f.context);
  const query=new NavigationQuery({type:'request',id:1,method:'navigation.query',params:{first:['pick.cursor','pick.viewport_center']}},()=>{},()=>{});
  const result=await query.evaluateAsync(capture.resolve);
  assert.deepEqual(result.first,{name:'pick.cursor',value:{point:[10,-4,8]}});assert.equal(calls,1);
});
test('late picks cannot escape a retired model; misses and malformed hits are unavailable', async () => {
  const f=fixture();let finish;
  f.api.pickFromScene=(a,b,cb)=>{finish=cb;};
  const capture=await f.host.adapter.beginQuery(f.context), pending=capture.resolve('pick.viewport_center');
  f.retire();finish(null,{position3D:[1,2,3]});assert.equal(await pending,UNAVAILABLE);
  for(const hit of [undefined,{position3D:[NaN,0,0]},{position3D:[1,2]}]) {
    assert.equal(await pickScene({pickFromScene(a,b,cb){cb(null,hit);}},[[0,0,0],[1,1,1]]),undefined);
  }
  assert.equal(await pickScene({pickFromScene(){}},[[0,0,0],[1,1,1]],5),undefined);
});
test('world rays and pivot overlay agree after camera roll and depth travel', () => {
  const c=new SketchfabCamera([15,-25,10],[2,1,0]);c.turn('back',1.1,false);c.move('back',5);
  const screen={x:.45,y:-.6}, ray=cameraRay(c,Math.PI/3,1.8,screen);
  const p=ray[0].map((v,i)=>v+(ray[1][i]-v)*.001);
  const projected=pivotScreen(c,Math.PI/3,1.8,p);
  assert.ok(Math.abs(projected.x-screen.x)<1e-10);assert.ok(Math.abs(projected.y-screen.y)<1e-10);
  assert.equal(pivotScreen(c,Math.PI/3,1.8,c.eye.toArray()),undefined);
});
