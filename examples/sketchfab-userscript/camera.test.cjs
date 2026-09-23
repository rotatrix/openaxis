const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const script = readFileSync(`${__dirname}/openaxis-sketchfab.user.js`, 'utf8');
const context = { module: { exports: {} } };
runInNewContext(script, context);
const { Camera, installHook, findEngineModule } = context.module.exports;
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function close(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((v,i) => assert.ok(Math.abs(v-expected[i]) < 1e-8, `${v} != ${expected[i]}`));
}
test('arbitrary rigid camera poses round-trip through a view matrix', () => {
  const c = new Camera(identity, [1,2,3]);
  c.move('right', 3); c.move('up', -2); c.move('back', 7);
  c.turn('up', 0.73, false); c.turn('right', -1.12, false); c.turn('back', 1.3, false);
  close(new Camera(c.matrix(), c.pivot).matrix(), c.matrix());
  close(c.eye, [3,-2,7]);
});
test('roll rotates up and right without moving the eye', () => {
  const c = new Camera(identity, [0,0,-4]);
  c.turn('back', Math.PI/2, false);
  close(c.right, [0,1,0]); close(c.up, [-1,0,0]); close(c.eye, [0,0,0]);
});
test('an off-center pivot changes the orbit while remaining fixed', () => {
  const c = new Camera(identity, [2,0,0]);
  c.turn('up', Math.PI/2, true);
  close(c.eye, [2,0,2]); close(c.pivot, [2,0,0]);
  c.move('up', 3); close(c.eye, [2,3,2]); close(c.pivot, [2,3,0]);
});
test('renderer sees independent camera after native updates; release and teardown restore behavior', () => {
  let active = new Camera(identity, [0,0,-1]), observed, captures = 0;
  active.move('right', 5);
  class Viewer {
    view = [...identity];
    getCamera() { return { getViewMatrix: () => this.view }; }
    frame() { this.view[12] = -9; return this.renderingTraversal(); }
    renderingTraversal() { observed = [...this.view]; return 42; }
  }
  const originalFrame = Viewer.prototype.frame;
  const unhook = installHook(Viewer, () => captures++, () => active);
  const v = new Viewer();
  assert.equal(v.frame(), 42); assert.equal(captures, 1);
  assert.equal(observed[12], -5); assert.equal(v.view[12], -9);
  active = undefined; v.frame(); assert.equal(observed[12], -9);
  unhook(); unhook(); assert.equal(Viewer.prototype.frame, originalFrame);
});
test('native view restored even if drawing throws', () => {
  class Viewer {
    view = [...identity]; frame() {}
    getCamera() { return { getViewMatrix: () => this.view }; }
    renderingTraversal() { throw Error('context lost'); }
  }
  const c = new Camera(identity); c.move('up', 5);
  const unhook = installHook(Viewer, () => {}, () => c), v = new Viewer();
  assert.throws(() => v.renderingTraversal(), /context lost/);
  close(v.view, identity); unhook();
});
test('module discovery rejects unrelated and ambiguous modules', () => {
  function engine() { /* renderingTraversal getInverseMatrix osgViewer */ }
  assert.equal(findEngineModule({a: () => {}, b: engine}).join(','), 'b');
  assert.equal(findEngineModule({a: engine, b: engine}).length, 2);
});
test('invalid matrices fail instead of producing a corrupt camera', () => {
  assert.throws(() => new Camera([1]), /Invalid/);
  const bad = [...identity]; bad[0] = 2;
  assert.throws(() => new Camera(bad), /rigid/);
});
