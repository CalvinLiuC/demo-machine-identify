import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { matrix, worldMatrices } from "./model.ts";
import type { Project } from "./types.ts";
export class Viewer {
  host: HTMLElement;
  scene: T.Scene;
  renderer: T.WebGLRenderer;
  camera: T.PerspectiveCamera;
  controls: OrbitControls;
  grid: T.GridHelper;
  group: T.Group<T.Object3DEventMap>;
  axes: T.Group;
  ray: T.Raycaster;
  pointer: T.Vector2;
  resize: ResizeObserver;
  wireframe = false;
  tick?: () => void;
  constructor(
    host: HTMLElement,
    onSelect: (id: string, multi: boolean) => void,
  ) {
    this.host = host;
    this.scene = new T.Scene();
    this.scene.background = new T.Color("#101923");
    this.renderer = new T.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    host.append(this.renderer.domElement);
    this.camera = new T.PerspectiveCamera(42, 1, 0.005, 10000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(4, -5, 3.5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0.8);
    this.controls.enableDamping = true;
    this.scene.add(new T.HemisphereLight("#e5f4ff", "#3e4854", 2));
    const light = new T.DirectionalLight("#ffffff", 3);
    light.position.set(3, -5, 8);
    this.scene.add(light);
    this.grid = new T.GridHelper(12, 48, "#42596b", "#253441");
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);
    this.scene.add(new T.AxesHelper(0.6));
    this.group = new T.Group();
    this.scene.add(this.group);
    this.axes = new T.Group();
    this.scene.add(this.axes);
    this.ray = new T.Raycaster();
    this.pointer = new T.Vector2();
    let down: [number, number] | undefined;
    this.renderer.domElement.addEventListener(
      "pointerdown",
      (e) => (down = [e.clientX, e.clientY]),
    );
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5)
        return;
      const r = host.getBoundingClientRect();
      this.pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      this.ray.setFromCamera(this.pointer, this.camera);
      const hit = this.ray.intersectObjects(this.group.children)[0];
      if (hit)
        onSelect(hit.object.userData.id, e.ctrlKey || e.metaKey || e.shiftKey);
    });
    this.resize = new ResizeObserver(() => {
      const w = host.clientWidth,
        h = host.clientHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    });
    this.resize.observe(host);
    this.renderer.setAnimationLoop(() => {
      this.tick?.();
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }
  load(p: Project) {
    this.group.children.forEach(
      (m: T.Mesh<T.BufferGeometry, T.MeshStandardMaterial>) =>
        m.material.dispose(),
    );
    this.group.clear();
    for (const m of p.meshes) {
      const material = new T.MeshStandardMaterial({
        color: m.color || "#a5b6c5",
        metalness: 0.3,
        roughness: 0.4,
        side: T.DoubleSide,
      });
      const mesh = new T.Mesh(m.geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.userData = { id: m.id, link: m.link };
      this.group.add(mesh);
    }
    this.update(p);
    this.fit();
  }
  update(
    p: Project,
    selected = new Set<string>(),
    colorMode = "device",
    showAxes = true,
  ) {
    const worlds = worldMatrices(p);
    const palette = [
      "#efaa43",
      "#53bbc4",
      "#859ae7",
      "#e189a8",
      "#85bf88",
      "#bea1d8",
    ];
    this.group.children.forEach(
      (mesh: T.Mesh<T.BufferGeometry, T.MeshStandardMaterial>) => {
        const m = p.meshes.find((m) => m.id === mesh.userData.id),
          l = p.links.find((l) => l.id === m?.link);
        if (!l) return;
        mesh.matrix.copy(worlds.get(l.id)).multiply(matrix(l.bind).invert());
        mesh.matrixWorldNeedsUpdate = true;
        const i =
          colorMode === "link"
            ? p.links.indexOf(l)
            : p.devices.findIndex((d) => d.id === l.device);
        mesh.material.color.set(
          colorMode === "original"
            ? m.color
            : palette[(i + palette.length) % palette.length],
        );
        mesh.material.emissive.set(selected.has(m.id) ? "#553a0a" : "#000000");
        mesh.material.emissiveIntensity = 0.7;
        mesh.material.wireframe = this.wireframe || false;
      },
    );
    for (const child of this.axes.children) {
      child.traverse((o: T.Mesh) => {
        o.geometry?.dispose();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose();
      });
    }
    this.axes.clear();
    if (showAxes)
      for (const l of p.links) {
        if (l.joint?.type === "fixed") continue;
        const w = worlds.get(l.id),
          center = new T.Vector3().setFromMatrixPosition(w),
          axis = new T.Vector3(...l.joint.axis).transformDirection(w);
        const arrow = new T.ArrowHelper(
          axis,
          center,
          0.27,
          l.joint.type === "prismatic" ? 0x59d5df : 0xffd37a,
          0.065,
          0.035,
        );
        this.axes.add(arrow);
      }
    this.group.updateMatrixWorld(true);
  }
  fit() {
    const box = new T.Box3().setFromObject(this.group);
    if (box.isEmpty()) return;
    const center = box.getCenter(new T.Vector3()),
      size = box.getSize(new T.Vector3()).length();
    this.controls.target.copy(center);
    this.camera.position
      .copy(center)
      .add(
        new T.Vector3(1, -1.5, 1)
          .normalize()
          .multiplyScalar(Math.max(size * 1.5, 0.2)),
      );
    this.camera.near = Math.max(size / 10000, 0.0001);
    this.camera.far = Math.max(size * 100, 100);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}
