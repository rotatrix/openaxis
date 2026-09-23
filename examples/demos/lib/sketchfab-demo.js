import { SketchfabCamera, callApi } from './sketchfab-camera.js';
import { createSketchfabNavigation, cloneCamera, pivotScreen, measureTranslationScale, SKETCHFAB_NAVIGATION_TAGS } from './sketchfab-navigation.js';
import { OpenAxisClient, AsyncNavigationSession, NavigationDiagnostics, DIAGNOSTIC_COLORS, UNAVAILABLE } from '../../../ts/sdk/src/index.js';
import { PerspectiveCamera } from 'three';
import { NavigationDiagnosticOverlay } from './navigation-diagnostic-overlay.js';
import { manageFocus } from './focus-manager.js';
import { createStatusHUD } from './status-hud.js';

const $ = id => document.getElementById(id);
let api, camera, binding, initial, applied, generation = 0, controlEpoch = 0, active = false, documentId;
let cursor = null, authoritativePivot;
let navigationMode = 'orbit';
let travelMultiplier = 1;
function navigationTags() {
  return navigationMode === 'free_camera'
    ? [...SKETCHFAB_NAVIGATION_TAGS, 'navigation.hint.free_camera']
    : [...SKETCHFAB_NAVIGATION_TAGS];
}
function showNavigationMode() {
  $('navigation-mode').value = navigationMode;
  $('navigation-help').textContent = navigationMode === 'free_camera'
    ? 'Free camera: hold Win (Windows), Cmd (Mac), Super (Linux), or button 4 to walk. Add Shift / button 2 to look, Ctrl / button 1 for height, or Alt for continuous rate motion.'
    : 'Orbit: hold Win (Windows), Ctrl (Mac), or Super (Linux) to orbit; button 4 pans. Shift swaps orbit/pan. Button 1 snaps the view; button 2 locks turntable rotation.';
  $('lock-pivot').disabled = $('unlock-pivot').disabled = navigationMode === 'free_camera';
  $('travel-speed-control').hidden = navigationMode !== 'free_camera';
  if (binding) $('travel-scale').textContent = `1×: ${binding.translationScale.toPrecision(4)} model units per 90° at unit gain (${binding.translationScaleSource}).`;
}
let alive = true, diagnosticFrame;
const report = text => { $('status').textContent = text; };
const diagnostics = text => { $('diagnostics').textContent = text; };
function controlled(value) {
  active = value; document.body.classList.toggle('controlled', value);
  if (!value) cursor = null;
  $('controls').disabled = !value;
}
function showAuthoritativePivot() {
  const rect = $('stage').getBoundingClientRect();
  const screen = binding && authoritativePivot ? pivotScreen(binding.camera, binding.fov, rect.width / rect.height, authoritativePivot) : undefined;
  const marker = $('pivot-marker');
  marker.hidden = !screen || !active;
  if (screen) { marker.style.left = `${(screen.x+1)*50}%`; marker.style.top = `${(1-screen.y)*50}%`; }
}
const updateHUD = createStatusHUD({ pauseHint: false });
const navigationDiagnostics = new NavigationDiagnostics();
const diagnosticPanel = $('sdk-diagnostics-panel');
const diagnosticOverlay = new NavigationDiagnosticOverlay($('stage'), $('sdk-diagnostics'), DIAGNOSTIC_COLORS);
const diagnosticCamera = new PerspectiveCamera();
const toggleDiagnostics = () => { navigationDiagnostics.setEnabled(diagnosticPanel.open); diagnosticOverlay.clear(); };
diagnosticPanel.addEventListener('toggle', toggleDiagnostics);
toggleDiagnostics();
const client = new OpenAxisClient({ clientName: 'demo-sketchfab' }, {
  onError: (code, message) => report(`OpenAxis ${code}: ${message}`),
});
const host = createSketchfabNavigation({
  current: () => binding,
  available: () => active && fm.hasControlFocus(),
  aspect: () => { const rect = $('stage').getBoundingClientRect(); return rect.width / Math.max(rect.height, 1); },
  cursor: () => cursor ? { ...cursor } : null,
  translationScale: context => context.translationScale * travelMultiplier,
  unavailable: UNAVAILABLE,
  onApplied(context, command) {
    if (binding !== context) return;
    camera = context.camera;
    showAuthoritativePivot();
    applied = command;
    diagnostics(`setCameraLookAt + setCameraRoll acknowledged\nRoll: ${(command.roll*180/Math.PI).toFixed(2)}° (${command.roll.toFixed(5)} rad)\nEye: ${command.position.map(v=>v.toFixed(4))}\nTarget: ${command.target.map(v=>v.toFixed(4))}\nPivot: ${camera.pivot.toArray().map(v=>v.toFixed(4))}`);
  },
  onError: error => report(error.message),
  onPivot: point => {
    authoritativePivot = point;
    $('device-pivot').textContent = point ? `Device pivot: ${point.map(v=>v.toFixed(3)).join(', ')}` : 'Device pivot: idle';
    showAuthoritativePivot();
  },
  onPick: ({ name, point }) => {
    $('pick-status').textContent = `${name}: ${point ? `surface hit (${point.map(v=>v.toFixed(3)).join(', ')})` : 'no surface hit'}`;
  },
});
const session = new AsyncNavigationSession(client, host.adapter, {
  diagnostics: navigationDiagnostics,
});
const fm = manageFocus(client, {
  metadata: () => ({ tags: active ? navigationTags() : [], capabilities: active ? ['navigation'] : [] }),
  onState: state => {
    updateHUD(state); $('device-status').textContent = `OpenAxis: ${state}`;
    if (state !== 'ready') { navigationDiagnostics.clear(); diagnosticOverlay.clear(); }
  },
  onPauseChange: paused => { updateHUD.setPaused(paused); $('pause').textContent = paused ? 'Resume device' : 'Pause device'; },
});
fm.pause();
function invalidate() { binding = undefined; authoritativePivot = undefined; $('device-pivot').textContent = 'Device pivot: idle'; showAuthoritativePivot(); session.contextChanged(); }
async function manual(change) {
  if (!active || !binding) return;
  const previous = binding, epoch = controlEpoch;
  invalidate();
  await host.idle();
  if (!active || previous.api !== api || epoch !== controlEpoch) return;
  binding = { ...previous, camera: previous.camera };
  const next = cloneCamera(previous.camera); change(next);
  // Validate before writing (notably at look-at poles).
  next.command();
  await host.write(binding, next);
}
async function initializeCamera() {
  if (!alive) return;
  const version = generation, current = api, epoch = ++controlEpoch;
  await callApi(current, 'setEnableCameraConstraints', false);
  const pose = await callApi(current, 'getCameraLookAt');
  const fov = await callApi(current, 'getFov') * Math.PI / 180;
  if (!(fov > 0 && fov < Math.PI)) throw Error('Viewer returned an invalid field of view.');
  if (version !== generation || epoch !== controlEpoch) return;
  camera = new SketchfabCamera(pose.position, pose.target);
  initial = { ...pose, fov };
  // No getCameraRoll exists: deliberately establish a known zero-roll baseline.
  await callApi(current, 'setCameraRoll', 0);
  if (version !== generation || epoch !== controlEpoch) return;
  await callApi(current, 'setUserInteraction', false);
  if (version !== generation || epoch !== controlEpoch) return;
  const rect = $('stage').getBoundingClientRect();
  const measured = await measureTranslationScale(current, camera, fov, rect.width / Math.max(rect.height, 1));
  if (version !== generation || epoch !== controlEpoch) return;
  binding = { api: current, camera, fov, documentId, translationScale: measured.scale, translationScaleSource: measured.source };
  controlled(true);
  await host.write(binding, camera);
  if (version !== generation || epoch !== controlEpoch || !active || binding?.api !== current) return;
  fm.resume();
  showNavigationMode();
  report(`Ready. ${navigationMode === 'free_camera' ? 'Free camera' : 'Orbit'} navigation active.`);
}
function toggleDevice() {
  if (!active) return;
  session.contextChanged();
  if (fm.isPaused()) { fm.resume(); report('Device navigation resumed.'); }
  else { fm.pause(); report('Device navigation paused.'); }
}
function load() {
  const match = $('model').value.trim().match(/(?:^|[-/])([a-f0-9]{32})(?:[/?#].*)?$/i);
  if (!match) throw Error('Enter a 32-character Sketchfab UID or model URL.');
  const uid = match[1].toLowerCase();
  $('model-select').value = Array.from($('model-select').options).some(option => option.value === uid) ? uid : 'custom';
  $('model-source').href = 'https://sketchfab.com/models/' + uid;
  const version = ++generation;
  controlEpoch++;
  invalidate(); fm.pause(); api = null; camera = null; applied = null; controlled(false);
  documentId = `sketchfab:${match[1]}:${version}`;
  report('Loading Sketchfab…'); diagnostics('Waiting for viewerready.');
  if (!window.Sketchfab) throw Error('Sketchfab Viewer API script could not load. Check network access and reload.');
  // A fresh frame isolates old callbacks/messages when switching models.
  const old = $('viewer'), frame = version === 1 ? old : old.cloneNode(false);
  if (frame !== old) old.replaceWith(frame);
  // Keep the iframe visible while loading: hidden embeds can defer readiness.
  frame.style.visibility = 'visible';
  const timeout = setTimeout(() => { if (version === generation && !api) report('Viewer is taking longer than expected. Check the embedded viewer or retry Load model.'); }, 45000);
  new window.Sketchfab('1.12.1', frame).init(match[1], {
    // OpenAxis owns orbit/pivot integration. Use the native FPS renderer because
    // the native orbit renderer's roll axis changes when its target translates.
    navigation: 'fps', camera: 0, autostart: 1, preload: 1, ui_stop: 0,
    success(candidate) {
      if (version !== generation) return;
      candidate.addEventListener('viewerready', () => {
        if (version !== generation) return;
        clearTimeout(timeout);
        const methods = ['getCameraLookAt','setCameraLookAt','setCameraRoll','setEnableCameraConstraints','getFov','setFov','setUserInteraction','pickFromScene'];
        diagnostics(methods.map(name => `${name}: ${typeof candidate[name] === 'function' ? 'available' : 'MISSING'}`).join('\n'));
        if (methods.some(name => typeof candidate[name] !== 'function')) { report('This viewer lacks a required camera method.'); return; }
        api = candidate; controlled(false); report('Initializing camera navigation…');
        void initializeCamera().catch(error => {
          if (version === generation) { invalidate(); controlled(false); fm.pause(); report(`Camera initialization failed: ${error.message}. Use Load model to retry.`); }
        });
      });
      candidate.start();
    },
    error() { clearTimeout(timeout); if (version === generation) report('Sketchfab failed to initialize this model. Check the URL and model visibility.'); },
  });
}
function safe(fn) { return async event => { event?.preventDefault(); try { await fn(event); } catch(error) { report(error.message); } }; }
$('model-form').addEventListener('submit', safe(load));
$('model-select').addEventListener('change', safe(() => {
  const selected = $('model-select').value;
  $('custom-model').open = selected === 'custom';
  if (selected === 'custom') { $('model').focus(); return; }
  $('model').value = selected;
  load();
}));
$('pause').onclick = toggleDevice;
$('travel-speed').addEventListener('change', safe(() => {
  const value = Number($('travel-speed').value);
  if (![.25, 1, 4, 16].includes(value)) return;
  travelMultiplier = value;
  session.contextChanged();
  report(`Free-camera translation speed: ${value}×. Start a new gesture.`);
}));
$('navigation-mode').addEventListener('change', safe(async () => {
  const mode = $('navigation-mode').value;
  if (!active || !binding || !['orbit', 'free_camera'].includes(mode) || mode === navigationMode) return;
  const previous = binding, epoch = ++controlEpoch;
  // Cancel queued SDK output, but let an issued viewer write commit its pose
  // before replacing the context. Otherwise the new mode could jump backward.
  session.contextChanged();
  await host.idle();
  if (!active || previous.api !== api || epoch !== controlEpoch) return;
  invalidate();
  navigationMode = mode;
  binding = { ...previous };
  navigationDiagnostics.clear(); diagnosticOverlay.clear();
  showNavigationMode();
  await fm.lifecycle.refreshMetadata();
  report(`${mode === 'free_camera' ? 'Free camera' : 'Orbit'} navigation active. Start a new gesture.`);
}));
$('lock-pivot').onclick = safe(async () => {
  await client.executeCommand('navigation.pivot.lock');
  session.contextChanged(); report('Last server-selected pivot locked.');
});
$('unlock-pivot').onclick = safe(async () => {
  await client.executeCommand('navigation.pivot.clear');
  session.contextChanged(); report('Pivot unlocked. The next gesture will pick under the cursor, then at the center.');
});
$('reset').onclick = safe(() => manual(next => {
  const reset = new SketchfabCamera(initial.position, initial.target);
  next.eye.copy(reset.eye); next.orientation.copy(reset.orientation); next.pivot.copy(reset.pivot); next.distance = reset.distance;
}));
$('readback').onclick = safe(async () => {
  if (!api || !binding) return;
  await host.idle();
  const version = generation, expected = applied;
  const pose = await callApi(api, 'getCameraLookAt');
  if (version !== generation || !expected) return;
  const error = (a,b) => Math.hypot(...a.map((v,i)=>v-b[i]));
  diagnostics(`${$('diagnostics').textContent}\nReadback eye error: ${error(pose.position,expected.position).toExponential(3)}\nReadback target error: ${error(pose.target,expected.target).toExponential(3)}\nRoll has no API getter; verify it visually.`);
});
function preventNavigationAltMenu(event) {
  // Alt changes the host binding; its browser menu action must not steal focus
  // on release. Do not cancel/rebase the SDK gesture for this mode transition.
  if (event.key === 'Alt' && active && navigationMode === 'free_camera' && !fm.isPaused()) event.preventDefault();
}
addEventListener('keydown', event => {
  preventNavigationAltMenu(event);
  if (event.key === 'Escape' && active) toggleDevice();
});
addEventListener('keyup', preventNavigationAltMenu);
$('shield').addEventListener('pointermove', event => {
  const rect = $('stage').getBoundingClientRect();
  const x = (event.clientX-rect.left)/rect.width, y = (event.clientY-rect.top)/rect.height;
  cursor = x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x: x*2-1, y: 1-y*2 } : null;
});
$('shield').addEventListener('pointerleave', () => { cursor = null; });
addEventListener('blur', () => { cursor = null; session.checkContext(); });
document.addEventListener('visibilitychange', () => session.checkContext());
addEventListener('resize', () => { cursor = null; showAuthoritativePivot(); session.contextChanged(); });
addEventListener('pagehide', event => {
  cursor = null; session.contextChanged();
  if (event.persisted) return; // FocusManager suspends/reconnects without resetting pose or roll.
  alive = false; controlEpoch++;
  invalidate(); controlled(false);
  cancelAnimationFrame(diagnosticFrame);
  diagnosticPanel.removeEventListener('toggle', toggleDiagnostics);
  diagnosticOverlay.dispose();
  void (async () => {
    await session.close(); await host.idle();
    if (api) await callApi(api, 'setUserInteraction', true).catch(() => {});
    await fm.destroy();
  })();
});
function renderDiagnostics() {
  if (!alive) return;
  if (binding && navigationDiagnostics.enabled) {
    const rect = $('stage').getBoundingClientRect();
    diagnosticCamera.position.copy(binding.camera.eye); diagnosticCamera.quaternion.copy(binding.camera.orientation);
    diagnosticCamera.fov = binding.fov * 180 / Math.PI; diagnosticCamera.aspect = rect.width / Math.max(rect.height,1);
    diagnosticCamera.near = Math.max(binding.camera.distance * .0001, .000001);
    diagnosticCamera.far = Math.max(binding.camera.distance * 1000, 1);
    diagnosticCamera.updateProjectionMatrix(); diagnosticCamera.updateMatrixWorld(true);
    diagnosticOverlay.draw(navigationDiagnostics, diagnosticCamera, context => context === binding);
  }
  diagnosticFrame = requestAnimationFrame(renderDiagnostics);
}
renderDiagnostics();
void safe(load)();
