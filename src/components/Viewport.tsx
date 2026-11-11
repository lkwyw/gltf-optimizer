import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { UploadCloud } from 'lucide-react';

const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const KTX2_TRANSCODER_PATH = 'https://unpkg.com/three@0.169.0/examples/jsm/libs/basis/';

interface ViewportProps {
  modelBuffer: ArrayBuffer | null;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export function Viewport({ modelBuffer, onLog }: ViewportProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const currentModelRef = useRef<THREE.Group | null>(null);
  const loaderRef = useRef<GLTFLoader | null>(null);
  const frameIdRef = useRef<number>(0);
  const lastBufferRef = useRef<ArrayBuffer | null>(null);

  // One-time scene init
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0f1117');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );
    camera.position.set(4, 3, 6);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controlsRef.current = controls;

    // Lighting
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x161a23, 1.0);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(5, 8, 6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.6);
    fill.position.set(-6, 2, -4);
    scene.add(fill);

    // Subtle grid
    const grid = new THREE.GridHelper(20, 40, 0x22d3ee, 0x1d2230);
    (grid.material as THREE.Material).opacity = 0.25;
    (grid.material as THREE.Material).transparent = true;
    grid.position.y = -0.001;
    scene.add(grid);

    // Loader config
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_DECODER_PATH);
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath(KTX2_TRANSCODER_PATH);
    ktx2.detectSupport(renderer);
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.setKTX2Loader(ktx2);
    loader.setMeshoptDecoder(MeshoptDecoder);
    loaderRef.current = loader;

    const animate = (): void => {
      frameIdRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      rendererRef.current.setSize(w, h);
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(frameIdRef.current);
      resizeObserver.disconnect();
      disposeCurrentModel();
      controls.dispose();
      ktx2.dispose();
      draco.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function disposeCurrentModel(): void {
    const model = currentModelRef.current;
    if (!model) return;
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) {
        material.forEach((m) => disposeMaterial(m));
      } else if (material) {
        disposeMaterial(material);
      }
    });
    sceneRef.current?.remove(model);
    currentModelRef.current = null;
  }

  function disposeMaterial(mat: THREE.Material): void {
    const anyMat = mat as THREE.MeshStandardMaterial;
    const texs = [
      anyMat.map,
      (anyMat as THREE.MeshStandardMaterial).normalMap,
      (anyMat as THREE.MeshStandardMaterial).roughnessMap,
      (anyMat as THREE.MeshStandardMaterial).metalnessMap,
      (anyMat as THREE.MeshStandardMaterial).emissiveMap,
      (anyMat as THREE.MeshStandardMaterial).aoMap,
    ];
    for (const t of texs) {
      if (t) t.dispose();
    }
    mat.dispose();
  }

  function frameObject(object: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = cameraRef.current!.fov * (Math.PI / 180);
    const distance = (maxDim / 2 / Math.tan(fov / 2)) * 1.6;
    const dir = new THREE.Vector3(1, 0.7, 1).normalize();
    cameraRef.current!.position.copy(center.clone().add(dir.multiplyScalar(distance)));
    controlsRef.current!.target.copy(center);
    controlsRef.current!.update();
  }

  // Load model whenever buffer changes
  useEffect(() => {
    if (!modelBuffer || !loaderRef.current || !sceneRef.current) return;
    if (lastBufferRef.current === modelBuffer) return;
    lastBufferRef.current = modelBuffer;

    onLog('info', 'Loading model into viewport...');
    disposeCurrentModel();

    const arrayBuffer = modelBuffer.slice(0);
    loaderRef.current!.parse(
      arrayBuffer,
      '',
      (gltf) => {
        const model = gltf.scene;
        sceneRef.current!.add(model);
        currentModelRef.current = model;
        frameObject(model);
        onLog('info', 'Model loaded into viewport.');
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        onLog('error', `Viewport load failed: ${message}`);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelBuffer]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {!modelBuffer && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-graphite-400">
          <UploadCloud className="h-12 w-12 text-accent-400/60" strokeWidth={1.5} />
          <p className="font-mono text-sm tracking-wide text-graphite-400">
            Перетащите .glb сюда
          </p>
        </div>
      )}
    </div>
  );
}
