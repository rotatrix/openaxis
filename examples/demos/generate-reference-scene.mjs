// Reproduce the original 3D Services scene exactly. Run from this package with Node.
import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
let seed = 123;
const rng = () => { seed = seed * 16807 % 2147483647; return (seed - 1) / 2147483646; };
const colors = [0xcc5544, 0x44aa66, 0x4466cc, 0xccaa33, 0xcc44aa, 0x44aacc, 0x8866cc, 0xcc8844];
const constructors = [
  () => new THREE.BoxGeometry(.8+rng()*.8, .8+rng()*1.2, .8+rng()*.8),
  () => new THREE.ConeGeometry(.3+rng()*.4, .8+rng(), 8),
  () => new THREE.CylinderGeometry(.3+rng()*.3, .3+rng()*.3, .8+rng(), 12),
  () => new THREE.SphereGeometry(.4+rng()*.4, 16, 12),
  () => new THREE.TorusGeometry(.3+rng()*.3, .1+rng()*.1, 12, 24),
];
const objects = Array.from({length: 30}, (_, index) => {
  const kind = Math.floor(rng()*5), geometry = constructors[kind]();
  const color = colors[Math.floor(rng()*colors.length)];
  geometry.computeBoundingBox();
  const halfHeight = (geometry.boundingBox.max.y-geometry.boundingBox.min.y)/2;
  const distance = 3+rng()*27, angle = rng()*Math.PI*2;
  const position = [Math.cos(angle)*distance, halfHeight, Math.sin(angle)*distance];
  const rotation = [0, rng()*Math.PI*2, 0];
  return {name: `${['Box','Cone','Cylinder','Sphere','Torus'][kind]} ${index+1}`, color,
    position, rotation, min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray(),
    vertices: Array.from(geometry.attributes.position.array), normals: Array.from(geometry.attributes.normal.array),
    indices: Array.from(geometry.index.array)};
});
const scene = {seed:123, camera:{t:[0,5,15], r:[-Math.atan2(5,15),0,0], fov:50*Math.PI/180},
  orthoExtent:30*Math.tan(25*Math.PI/180), ground:{size:80,step:2,y:0}, objects};
const directory = new URL('../demo_3d_scene/', import.meta.url);
mkdirSync(directory, {recursive:true});
writeFileSync(new URL('scene.json',directory), JSON.stringify(scene)+'\n');
// Shared geometry probes exercise actual triangles (including torus holes), not
// bounding-box stand-ins. Each camera faces one object's local XY plane.
const probes=objects.map((item,index)=>{
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(item.vertices,3));geometry.setIndex(item.indices);
  const mesh=new THREE.Mesh(geometry);mesh.position.fromArray(item.position);mesh.rotation.y=item.rotation[1];mesh.updateMatrixWorld(true);
  const camera=new THREE.PerspectiveCamera(50,1.5,.01,10000);
  camera.quaternion.copy(mesh.quaternion);camera.position.set(0,0,5).applyQuaternion(camera.quaternion).add(mesh.position);camera.updateMatrixWorld(true);
  const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(),camera);
  const hit=ray.intersectObject(mesh)[0];
  return {index,camera:{t:camera.position.toArray(),r:item.rotation,fov:50*Math.PI/180},hit:hit?.point.toArray()??null};
});
writeFileSync(new URL('probes.json',directory),JSON.stringify(probes)+'\n');
