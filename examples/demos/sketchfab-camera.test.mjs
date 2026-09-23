import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Matrix4, Quaternion } from 'three';
import { SketchfabCamera } from './lib/sketchfab-camera.js';
const near = (a,b) => { assert.equal(a.length,b.length); a.forEach((x,i)=>assert.ok(Math.abs(x-b[i])<1e-8, `${x} != ${b[i]}`)); };
test('look-at and roll reconstruct independent orientation away from poles', () => {
  const c = new SketchfabCamera([3,-7,4], [1,2,0]);
  for (let i=0;i<40;i++) {
    c.turn('right', .07, false); c.turn('up', .11, false); c.turn('back', .19, false);
    const command = c.command();
    const eye = new Vector3(...command.position), target = new Vector3(...command.target);
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye,target,new Vector3(0,0,1)));
    // The shipped FPS update rolls its up vector around the FORWARD direction.
    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0,0,-1),command.roll));
    assert.ok(1-Math.abs(q.dot(c.orientation)) < 1e-8);
  }
});
test('FPS rendered orientation stays fixed through depth translation away from the origin', () => {
  const c = new SketchfabCamera([13,-27,14], [11,2,5]);
  c.turn('back',1.2,false); c.turn('right',0.4,false);
  const desired=c.orientation.clone();
  for(let step=0;step<100;step++) {
    c.move('back',0.7);
    const command=c.command();
    const eye=new Vector3(...command.position), target=new Vector3(...command.target);
    const forward=target.clone().sub(eye).normalize();
    const base=new Matrix4().lookAt(eye,target,new Vector3(0,0,1));
    const baseUp=new Vector3().setFromMatrixColumn(base,1);
    const renderedUp=baseUp.applyAxisAngle(forward,command.roll);
    const rendered=new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye,target,renderedUp));
    assert.ok(1-Math.abs(rendered.dot(desired)) < 1e-10, 'depth travel must not change the rotation frame');
  }
});
test('editing the pivot does not move the eye or change the API look-at', () => {
  const c = new SketchfabCamera([0,-5,2],[0,0,0]), before = c.command();
  c.pivot.set(2,1,3);
  assert.deepEqual(c.command(),before);
  const distance=c.eye.distanceTo(c.pivot);
  c.turn('up',Math.PI/3,true);
  assert.ok(Math.abs(c.eye.distanceTo(c.pivot)-distance)<1e-8);
  near(c.pivot.toArray(),[2,1,3]);
});
test('translation moves eye and pivot by equal world displacement', () => {
  const c = new SketchfabCamera([0,-5,2],[0,0,0]);
  const offset=c.eye.clone().sub(c.pivot);
  c.turn('back',Math.PI/2,false); c.move('right',3);
  near(c.eye.clone().sub(c.pivot).toArray(),offset.toArray());
});
