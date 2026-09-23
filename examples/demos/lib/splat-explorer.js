import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { zipSync } from 'fflate';
import { OpenAxisClient, NavigationSession, UNAVAILABLE } from '../../../ts/sdk/src/index.js';
import { manageFocus } from './focus-manager.js';
import { createStatusHUD } from './status-hud.js';
import { createSplatAdapter, moveCamera } from './splat-navigation.js';

const $ = id => document.getElementById(id);
const message = text => { $('message').textContent = text; };
const scene = new THREE.Scene();
scene.background = new THREE.Color('#111a20');
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.03, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('aria-label', 'Gaussian splat world');
document.body.prepend(renderer.domElement);
const spark = new SparkRenderer({ renderer });
scene.add(spark);
let alive = true, stopping, dragPoint;
const downloads = new AbortController();
let mesh;
let loading = false;
let isLudlow = true;
const credit = $('credit').innerHTML;
const homePosition = new THREE.Vector3(13.391, 0.050236, 0.975535);
const homeTarget = new THREE.Vector3(4.38689, 0.776641, 1.63677);
const preferences = () => ({ speed: Number($('speed').value), horizon: true });
const schemeTags = () => [`demo-splats-${$('scheme').value}`];
function showControls() {
  $('controls-help').textContent = $('scheme').value === 'left'
    ? 'Precision travel: roll forward/back or sideways, twist to turn left/right. Hold btn4 for rate travel; release to stop. Mouse looks; wheel sets speed. Esc pauses.'
    : 'Rotatrix looks: pitch/yaw, twist ignored. WASD moves, Q/E changes height, Shift boosts speed. Hold btn4 to roll along the ground and twist to turn; release to stop. Btn1 gives precision. Esc pauses.';
}
showControls();
const keys = new Set();
const updateHUD = createStatusHUD();
const client = new OpenAxisClient({ clientName: 'demo-splats' });
const adapter = createSplatAdapter(camera, UNAVAILABLE, preferences,
  () => alive && !loading && !!mesh && !fm.isPaused());
const session = new NavigationSession(client, adapter, { observation: adapter.observation });
const cancelNavigation = () => { keys.clear(); dragPoint = undefined; session.contextChanged(); };
const fm = manageFocus(client, {
  metadata: () => ({ tags: schemeTags(), capabilities: ['navigation'] }),
  onState: updateHUD,
  onPauseChange(paused) { updateHUD.setPaused(paused); if (paused) cancelNavigation(); },
});
$('scheme').onchange = () => {
  keys.clear();
  cancelNavigation();
  fm.disconnectNow();
  document.exitPointerLock?.();
  showControls();
  fm.scheduleConnect();
};
function resetView() {
  cancelNavigation();
  // Disconnect before changing the camera to invalidate any in-flight snapshot.
  fm.disconnectNow();
  camera.position.copy(homePosition);
  camera.lookAt(homeTarget);
  if (mesh && !loading) message(`${isLudlow ? 'Ludlow' : 'Scan'} ready · ${mesh.numSplats.toLocaleString()} splats`);
  fm.scheduleConnect();
}
resetView();

// SuperSplat hosts this CC BY scan as an unbundled SOG v2 manifest. Package
// its existing compressed textures in memory for Spark's SOG ZIP decoder.
// No scan data is uploaded or checked into the repository.
async function ludlowBytes() {
  const base = 'https://d28zzqy0iyovbz.cloudfront.net/ca36efcc/v1/';
  const response = await fetch(`${base}meta.json`, { signal: downloads.signal });
  if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
  const manifest = await response.json();
  const files = [...new Set(Object.values(manifest).flatMap(value => value?.files ?? []))];
  const archive = { 'meta.json': new TextEncoder().encode(JSON.stringify(manifest)) };
  let completed = 0;
  await Promise.all(files.map(async name => {
    const response = await fetch(new URL(name, base), { signal: downloads.signal });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    archive[name] = new Uint8Array(await response.arrayBuffer());
    message(`Downloading Ludlow… ${++completed}/${files.length} parts`);
  }));
  message('Decoding 4.6 million splats…');
  return zipSync(archive, { level: 0 });
}

async function loadScan(source, ludlow = false) {
  if (!alive || loading) return;
  loading = true;
  cancelNavigation();
  fm.pause();
  document.exitPointerLock?.();
  const controls = [$('ludlow'), $('file'), $('url-form').querySelector('button'), $('flip'), $('reset'), $('fly'), $('scheme')];
  controls.forEach(control => { control.disabled = true; });
  let candidate;
  message(ludlow ? 'Downloading Ludlow… ~50 MB' : 'Reading scan…');
  try {
    const options = ludlow
      ? { fileBytes: await ludlowBytes(), fileName: 'ludlow.sog' }
      : source instanceof File
        ? { fileBytes: await source.arrayBuffer(), fileName: source.name }
        : { url: source };
    if (!alive) return;
    candidate = new SplatMesh({ ...options, onProgress: event => {
      message(event.total ? `Loading… ${Math.round(event.loaded / event.total * 100)}%` : 'Decoding scan…');
    } });
    await candidate.initialized;
    if (!alive) { candidate.dispose(); return; }
    if (!candidate.numSplats) throw new Error('The file contains no Gaussian splats');
    candidate.rotation.x = (ludlow || $('flip').checked) ? Math.PI : 0;
    if (mesh) { scene.remove(mesh); mesh.dispose(); }
    mesh = candidate;
    scene.add(mesh);
    isLudlow = ludlow;
    $('flip').checked = mesh.rotation.x !== 0;
    if (ludlow) {
      homePosition.set(13.391, 0.050236, 0.975535);
      homeTarget.set(4.38689, 0.776641, 1.63677);
      $('credit').innerHTML = credit;
    } else {
      mesh.updateMatrixWorld(true);
      const box = mesh.getBoundingBox().applyMatrix4(mesh.matrixWorld);
      box.getCenter(homeTarget);
      const radius = box.getSize(new THREE.Vector3()).length() * 0.35;
      homePosition.copy(homeTarget).add(new THREE.Vector3(0, 0, Math.max(radius, 1)));
      $('credit').textContent = `${source instanceof File ? source.name : 'Custom scan'} · Rendered with Spark`;
    }
    resetView();
    message(`${ludlow ? 'Ludlow' : 'Scan'} ready · ${mesh.numSplats.toLocaleString()} splats`);
  } catch (error) {
    if (candidate && candidate !== mesh) candidate.dispose();
    if (!alive) return;
    console.error('Scan loading failed', error);
    message(`Could not load scan: ${error instanceof Error ? error.message : String(error)}. Retry, or choose a local splat file.`);
  } finally {
    loading = false;
    controls.forEach(control => { control.disabled = false; });
    if (alive) fm.resume();
  }
}
$('ludlow').onclick = () => loadScan(undefined, true);
$('file').onchange = () => { const file = $('file').files[0]; if (file) void loadScan(file); $('file').value = ''; };
$('url-form').onsubmit = event => { event.preventDefault(); void loadScan($('url').value.trim()); };
$('reset').onclick = resetView;
$('flip').onchange = () => {
  if (!mesh) return;
  cancelNavigation();
  mesh.rotation.x = $('flip').checked ? Math.PI : 0;
  if (isLudlow) resetView();
};
$('speed').oninput = () => { session.contextChanged(); $('speed-value').value = Number($('speed').value).toFixed(1); };
const clearKeys = () => keys.clear();
addEventListener('blur', cancelNavigation);
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelNavigation(); });
document.addEventListener('pointerlockchange', () => {
  clearKeys();
  $('fly').textContent = document.pointerLockElement ? 'Flying · Esc to release' : 'Start flying';
});
$('fly').onclick = async () => {
  fm.resume();
  try { if ($('scheme').value === 'left') await renderer.domElement.requestPointerLock(); }
  catch { message('Mouse capture unavailable. Drag on the scene to look; focus the scene to use its controls.'); }
  renderer.domElement.focus();
};
renderer.domElement.addEventListener('click', () => fm.resume());
addEventListener('keydown', event => {
  if (event.key === 'Escape') { clearKeys(); fm.pause(); cancelNavigation(); return; }
  if (loading || event.target !== renderer.domElement && document.pointerLockElement !== renderer.domElement) return;
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
    event.preventDefault(); keys.add(event.code);
  }
});
addEventListener('keyup', event => keys.delete(event.code));
renderer.domElement.addEventListener('pointerdown', event => {
  renderer.domElement.focus();
  dragPoint = [event.clientX, event.clientY];
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointerup', () => { dragPoint = undefined; });
renderer.domElement.addEventListener('pointercancel', () => { dragPoint = undefined; });
renderer.domElement.addEventListener('pointermove', event => {
  const captured = document.pointerLockElement === renderer.domElement;
  const dx = captured ? event.movementX : dragPoint ? event.clientX - dragPoint[0] : 0;
  const dy = captured ? event.movementY : dragPoint ? event.clientY - dragPoint[1] : 0;
  if (dragPoint) dragPoint = [event.clientX, event.clientY];
  if ($('scheme').value !== 'left' || loading || fm.isPaused() || (!event.buttons && document.pointerLockElement !== renderer.domElement)) return;
  if (!dx && !dy) return;
  const yaw = -dx * .002;
  const pitch = -dy * .002;
  if (preferences().horizon) {
    const angles = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    angles.y += yaw;
    angles.x = THREE.MathUtils.clamp(angles.x + pitch, -Math.PI / 2 + .01, Math.PI / 2 - .01);
    angles.z = 0;
    camera.quaternion.setFromEuler(angles);
  } else {
    camera.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'))).normalize();
  }
  session.nativeCameraChanged();
});
renderer.domElement.addEventListener('wheel', event => {
  event.preventDefault();
  $('speed').value = THREE.MathUtils.clamp(preferences().speed * Math.exp(-event.deltaY * .001), .1, 15);
  $('speed').oninput();
}, { passive: false });
let lastTime;
renderer.setAnimationLoop(time => {
  if (!alive) return;
  const dt = lastTime === undefined ? 0 : Math.min((time - lastTime) / 1000, .05);
  lastTime = time;
  if ($('scheme').value === 'right' && !loading && !fm.isPaused()) {
    const down = code => keys.has(code) ? 1 : 0;
    const direction = [down('KeyD') - down('KeyA'), down('KeyE') - down('KeyQ'), down('KeyS') - down('KeyW')];
    if (dt > 0 && direction.some(Boolean)) {
      moveCamera(camera, direction, preferences().speed * dt * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1));
      session.nativeCameraChanged();
    }
  }
  renderer.render(scene, camera);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.domElement.addEventListener('webglcontextlost', event => {
  event.preventDefault(); fm.pause(); message('Graphics context lost. Reload the page to restore the scene.');
});
function shutdown() {
  if (stopping) return stopping;
  alive = false; downloads.abort(); keys.clear();
  renderer.setAnimationLoop(null); document.exitPointerLock?.();
  stopping = (async () => {
    try { await fm.destroy(); }
    finally {
      session.close(); session.drain(); mesh?.dispose(); spark.dispose(); renderer.dispose();
    }
  })();
  return stopping;
}
addEventListener('pagehide', event => {
  if (event.persisted) { cancelNavigation(); lastTime = undefined; }
  else void shutdown().catch(error => console.error('Splat shutdown failed', error));
});
void loadScan(undefined, true);
