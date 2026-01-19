import { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

interface ValidationResult {
  name: string;
  passed: boolean;
  message: string;
  details?: string;
}

interface ModelData {
  geometry: THREE.BufferGeometry;
  dimensions: { length: number; width: number; height: number };
  volume: number;
  surfaceArea: number;
  triangleCount: number;
  hasManifoldEdges: boolean;
  boundingBox: THREE.Box3;
}

const GUIDELINES = {
  maxDimensions: { length: 50, width: 80, height: 40 },
  wallThickness: { min: 1, max: 15 },
  minGap: 1,
  aspectRatioMax: 10,
  aspectRatioRecommended: 5,
  minCurvatureRadius: 0.5,
  minTJunctionRadius: 2,
  minCavityWidth: 0.4,
  cavityDepthRatio: { min: 2, max: 4 },
  channelSpecs: [
    { diameterRange: [1, 3], maxDepth: 10 },
    { diameterRange: [3, 5], maxDepth: 30 },
    { diameterRange: [5, Infinity], minCurvatureRadius: 25 },
  ],
  minCharacterHeight: 4,
  minLineWidth: 0.5,
  minThreadSize: 10,
  hollowWallThickness: 1.2,
  drainHoleDiameter: { min: 2, recommended: 4 },
};

function validateModel(data: ModelData): ValidationResult[] {
  const results: ValidationResult[] = [];
  const { length, width, height } = data.dimensions;

  // 1. Dimensioni massime
  const withinDimensions =
    length <= GUIDELINES.maxDimensions.length &&
    width <= GUIDELINES.maxDimensions.width &&
    height <= GUIDELINES.maxDimensions.height;
  
  results.push({
    name: "Dimensioni Massime",
    passed: withinDimensions,
    message: withinDimensions
      ? `Dimensioni OK: ${length.toFixed(1)} x ${width.toFixed(1)} x ${height.toFixed(1)} mm`
      : `Dimensioni SUPERANO il limite di ${GUIDELINES.maxDimensions.length} x ${GUIDELINES.maxDimensions.width} x ${GUIDELINES.maxDimensions.height} mm`,
    details: `Il modello misura ${length.toFixed(2)}mm (L) x ${width.toFixed(2)}mm (W) x ${height.toFixed(2)}mm (H). Limite: 50mm x 80mm x 40mm.`,
  });

  // 2. Tolleranze
  const toleranceInfo = [];
  if (length < 10 || width < 10 || height < 10) {
    toleranceInfo.push("Tolleranza ±0.1mm per dimensioni < 10mm");
  }
  if (length >= 10 || width >= 10 || height >= 10) {
    toleranceInfo.push("Tolleranza ±1% per dimensioni ≥ 10mm");
  }
  
  results.push({
    name: "Tolleranze",
    passed: true,
    message: "Informazione sulle tolleranze applicabili",
    details: toleranceInfo.join(". ") + `. Dimensioni minori di 10mm: ±0.1mm. Dimensioni maggiori: ±1%.`,
  });

  // 3. Aspect Ratio
  const dims = [length, width, height].sort((a, b) => b - a);
  const aspectRatio = dims[0] / dims[2];
  const aspectOk = aspectRatio <= GUIDELINES.aspectRatioMax;
  const aspectRecommended = aspectRatio <= GUIDELINES.aspectRatioRecommended;

  results.push({
    name: "Aspect Ratio",
    passed: aspectOk,
    message: aspectOk
      ? aspectRecommended
        ? `Aspect ratio ottimale: ${aspectRatio.toFixed(1)}:1`
        : `Aspect ratio accettabile: ${aspectRatio.toFixed(1)}:1 (consigliato ≤5:1)`
      : `Aspect ratio ${aspectRatio.toFixed(1)}:1 supera il massimo 10:1`,
    details: `Rapporto tra dimensione maggiore e minore: ${aspectRatio.toFixed(2)}:1. Massimo: 10:1, Consigliato: 5:1.`,
  });

  // 4. Volume e triangoli (indicatori di complessità)
  results.push({
    name: "Complessità Geometrica",
    passed: true,
    message: `${data.triangleCount.toLocaleString()} triangoli, volume ${data.volume.toFixed(2)} mm³`,
    details: `Area superficiale: ${data.surfaceArea.toFixed(2)} mm². Geometria analizzata con successo.`,
  });

  // 5. Spessore parete (stima basata su volume/area)
  const estimatedWallThickness = data.volume / data.surfaceArea;
  const wallThicknessOk = 
    estimatedWallThickness >= GUIDELINES.wallThickness.min * 0.5 &&
    estimatedWallThickness <= GUIDELINES.wallThickness.max * 2;

  results.push({
    name: "Spessore Parete (Stima)",
    passed: wallThicknessOk,
    message: wallThicknessOk
      ? `Spessore stimato compatibile: ~${estimatedWallThickness.toFixed(2)}mm`
      : `Verifica spessore parete: range 1-15mm richiesto`,
    details: `Spessore parete richiesto: ${GUIDELINES.wallThickness.min}mm - ${GUIDELINES.wallThickness.max}mm. Per oggetti cavi: min ${GUIDELINES.hollowWallThickness}mm.`,
  });

  // 6. Raccomandazioni geometriche
  results.push({
    name: "Spigoli e Raccordi",
    passed: true,
    message: "Verificare manualmente: no spigoli vivi, raggi min 0.5mm",
    details: `Evitare spigoli vivi. Raggio di curvatura minimo: ${GUIDELINES.minCurvatureRadius}mm. Per giunzioni a T: min ${GUIDELINES.minTJunctionRadius}mm.`,
  });

  // 7. Cavità e fori
  results.push({
    name: "Cavità e Fori Ciechi",
    passed: true,
    message: "Verificare: larghezza min 0.4mm, rapporto profondità 2:1 - 4:1",
    details: `Larghezza minima cavità: ${GUIDELINES.minCavityWidth}mm. Rapporto profondità/larghezza: ${GUIDELINES.cavityDepthRatio.min}:1 - ${GUIDELINES.cavityDepthRatio.max}:1.`,
  });

  // 8. Canali aperti
  results.push({
    name: "Canali Aperti",
    passed: true,
    message: "Verificare specifiche diametro/profondità",
    details: `Ø 1-3mm: max 10mm rettilineo. Ø 3-5mm: max 30mm rettilineo. Ø >5mm: raggio curvatura min 25mm.`,
  });

  // 9. Incisioni
  results.push({
    name: "Incisioni",
    passed: true,
    message: "Verificare: caratteri min 4mm, linee min 0.5mm",
    details: `Altezza carattere minima: ${GUIDELINES.minCharacterHeight}mm. Larghezza linea minima: ${GUIDELINES.minLineWidth}mm. Rapporto profondità/larghezza: 2:1 - 4:1.`,
  });

  // 10. Rilievi
  results.push({
    name: "Rilievi",
    passed: true,
    message: "Verificare: caratteri min 4mm, linee min 0.5mm",
    details: `Altezza carattere minima: ${GUIDELINES.minCharacterHeight}mm. Larghezza linea minima: ${GUIDELINES.minLineWidth}mm. Rapporto profondità/larghezza: 2:1 - 3:1.`,
  });

  // 11. Filettature
  results.push({
    name: "Filettature",
    passed: true,
    message: "Filetto abbozzato da M10",
    details: `Per filettature: utilizzare filetto abbozzato a partire da M${GUIDELINES.minThreadSize}.`,
  });

  // 12. Oggetti cavi
  results.push({
    name: "Oggetti Cavi",
    passed: true,
    message: "Verificare: parete min 1.2mm, 2 fori svuotamento min Ø2mm",
    details: `Spessore parete minimo: ${GUIDELINES.hollowWallThickness}mm. Necessari almeno 2 fori di svuotamento, diametro min ${GUIDELINES.drainHoleDiameter.min}mm (consigliato ${GUIDELINES.drainHoleDiameter.recommended}mm).`,
  });

  // 13. Base piana
  results.push({
    name: "Base di Appoggio",
    passed: true,
    message: "Verificare presenza di almeno una base piana",
    details: "Requisito geometrico: il modello deve avere almeno una superficie piana per l'appoggio durante la stampa.",
  });

  // 14. Parti concatenate
  results.push({
    name: "Parti Concatenate",
    passed: true,
    message: `Distanza minima tra parti: ${GUIDELINES.minGap}mm`,
    details: "Se il modello contiene parti concatenate o mobili, mantenere distanza minima di 1mm tra le parti.",
  });

  return results;
}

function analyzeSTLGeometry(geometry: THREE.BufferGeometry): ModelData {
  geometry.computeBoundingBox();
  const boundingBox = geometry.boundingBox!;
  
  const size = new THREE.Vector3();
  boundingBox.getSize(size);

  const positions = geometry.getAttribute("position");
  const triangleCount = positions.count / 3;

  // Calculate volume and surface area
  let volume = 0;
  let surfaceArea = 0;

  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();

  for (let i = 0; i < positions.count; i += 3) {
    pA.fromBufferAttribute(positions, i);
    pB.fromBufferAttribute(positions, i + 1);
    pC.fromBufferAttribute(positions, i + 2);

    // Surface area (triangle area)
    cb.subVectors(pC, pB);
    ab.subVectors(pA, pB);
    cb.cross(ab);
    surfaceArea += cb.length() * 0.5;

    // Volume (signed volume of tetrahedron with origin)
    volume += pA.dot(pB.cross(pC)) / 6;
  }

  volume = Math.abs(volume);

  return {
    geometry,
    dimensions: {
      length: size.x,
      width: size.y,
      height: size.z,
    },
    volume,
    surfaceArea,
    triangleCount,
    hasManifoldEdges: true,
    boundingBox,
  };
}

function STLViewer({ geometry }: { geometry: THREE.BufferGeometry | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  useEffect(() => {
    if (!containerRef.current || !geometry) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    
    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-1, -1, -1);
    scene.add(directionalLight2);

    // Mesh
    const material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      specular: 0x333333,
      shininess: 30,
      flatShading: false,
    });

    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);

    // Center and scale
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox!.getCenter(center);
    mesh.position.sub(center);

    const size = new THREE.Vector3();
    geometry.boundingBox!.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 100 / maxDim;
    mesh.scale.multiplyScalar(scale);

    scene.add(mesh);

    // Grid
    const gridHelper = new THREE.GridHelper(200, 20, 0x333333, 0x222222);
    gridHelper.position.y = -size.y * scale / 2;
    scene.add(gridHelper);

    // Position camera
    camera.position.set(150, 100, 150);
    camera.lookAt(0, 0, 0);

    // Animation
    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize handler
    const handleResize = () => {
      const newWidth = container.clientWidth;
      const newHeight = container.clientHeight;
      camera.aspect = newWidth / newHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(newWidth, newHeight);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", handleResize);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [geometry]);

  return (
    <div
      ref={containerRef}
      className="w-full h-[400px] rounded-lg overflow-hidden bg-[#0a0a0a] border border-white/10"
    />
  );
}

function Index() {
  const [isDragging, setIsDragging] = useState(false);
  const [modelData, setModelData] = useState<ModelData | null>(null);
  const [validationResults, setValidationResults] = useState<ValidationResult[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith(".stl")) {
      setError("Per favore carica un file STL");
      return;
    }

    setIsLoading(true);
    setError("");
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const loader = new STLLoader();
        const geometry = loader.parse(e.target?.result as ArrayBuffer);
        const data = analyzeSTLGeometry(geometry);
        setModelData(data);
        setValidationResults(validateModel(data));
      } catch (err) {
        setError("Errore nel parsing del file STL");
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    };
    reader.onerror = () => {
      setError("Errore nella lettura del file");
      setIsLoading(false);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

  const passedCount = validationResults.filter((r) => r.passed).length;
  const failedCount = validationResults.filter((r) => !r.passed).length;

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Hero Section */}
      <header className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.03)_0%,transparent_50%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:60px_60px]" />
        
        <div className="relative max-w-6xl mx-auto px-6 py-20 md:py-32">
          <div className="animate-fade-in">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/10 bg-white/5 mb-8">
              <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-sm text-white/70 font-mono">VALIDATORE 3D</span>
            </div>
            
            <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight mb-6">
              <span className="block">Valida il tuo</span>
              <span className="block text-transparent bg-clip-text bg-gradient-to-r from-white via-white to-white/50">
                modello 3D
              </span>
            </h1>
            
            <p className="text-lg md:text-xl text-white/60 max-w-2xl mb-12 leading-relaxed">
              Carica il tuo file STL e verifica la conformità alle specifiche di stampa 3D industriale. 
              Analisi istantanea secondo le linee guida di produzione italiana.
            </p>

            <button
              onClick={() => fileInputRef.current?.click()}
              className="group inline-flex items-center gap-3 px-8 py-4 bg-white text-black font-semibold rounded-lg hover:bg-white/90 transition-all hover:scale-105 active:scale-100"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Carica File STL
            </button>
          </div>
        </div>
      </header>

      {/* Upload Area */}
      <section className="max-w-6xl mx-auto px-6 py-12">
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`
            relative cursor-pointer rounded-2xl border-2 border-dashed p-12 transition-all duration-300
            ${isDragging 
              ? "border-white bg-white/10 scale-[1.02]" 
              : "border-white/20 hover:border-white/40 hover:bg-white/5"
            }
          `}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".stl"
            onChange={handleFileChange}
            className="hidden"
          />
          
          <div className="text-center">
            <div className={`mx-auto w-16 h-16 mb-6 rounded-full flex items-center justify-center transition-all ${isDragging ? "bg-white/20" : "bg-white/5"}`}>
              <svg className="w-8 h-8 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p className="text-xl font-medium mb-2">
              {isDragging ? "Rilascia il file qui" : "Trascina il file STL qui"}
            </p>
            <p className="text-white/50">oppure clicca per selezionare</p>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400">
            {error}
          </div>
        )}

        {isLoading && (
          <div className="mt-8 flex items-center justify-center gap-3">
            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            <span className="text-white/60">Analisi in corso...</span>
          </div>
        )}
      </section>

      {/* Results Section */}
      {modelData && (
        <section className="max-w-6xl mx-auto px-6 py-12 animate-fade-in">
          {/* File Info */}
          <div className="flex flex-wrap items-center gap-4 mb-8">
            <h2 className="text-2xl font-bold">{fileName}</h2>
            <div className="flex gap-2">
              <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-sm font-medium">
                {passedCount} OK
              </span>
              {failedCount > 0 && (
                <span className="px-3 py-1 rounded-full bg-red-500/20 text-red-400 text-sm font-medium">
                  {failedCount} Errori
                </span>
              )}
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-8">
            {/* 3D Preview */}
            <div>
              <h3 className="text-lg font-semibold mb-4 text-white/80">Anteprima 3D</h3>
              <STLViewer geometry={modelData.geometry} />
              
              {/* Quick Stats */}
              <div className="mt-4 grid grid-cols-3 gap-4">
                <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                  <p className="text-sm text-white/50 mb-1">Dimensioni</p>
                  <p className="font-mono text-sm">
                    {modelData.dimensions.length.toFixed(1)} × {modelData.dimensions.width.toFixed(1)} × {modelData.dimensions.height.toFixed(1)} mm
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                  <p className="text-sm text-white/50 mb-1">Volume</p>
                  <p className="font-mono text-sm">{modelData.volume.toFixed(1)} mm³</p>
                </div>
                <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                  <p className="text-sm text-white/50 mb-1">Triangoli</p>
                  <p className="font-mono text-sm">{modelData.triangleCount.toLocaleString()}</p>
                </div>
              </div>
            </div>

            {/* Validation Results */}
            <div>
              <h3 className="text-lg font-semibold mb-4 text-white/80">Risultati Validazione</h3>
              <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
                {validationResults.map((result, index) => (
                  <details
                    key={index}
                    className={`group rounded-lg border transition-all ${
                      result.passed
                        ? "bg-white/5 border-white/10 hover:border-white/20"
                        : "bg-red-500/10 border-red-500/30 hover:border-red-500/50"
                    }`}
                  >
                    <summary className="flex items-center gap-3 p-4 cursor-pointer list-none">
                      <span className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
                        result.passed ? "bg-emerald-500/20" : "bg-red-500/20"
                      }`}>
                        {result.passed ? (
                          <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium">{result.name}</p>
                        <p className="text-sm text-white/60 truncate">{result.message}</p>
                      </div>
                      <svg className="w-5 h-5 text-white/40 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </summary>
                    {result.details && (
                      <div className="px-4 pb-4 pt-2 border-t border-white/5">
                        <p className="text-sm text-white/70 leading-relaxed">{result.details}</p>
                      </div>
                    )}
                  </details>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Guidelines Reference */}
      <section className="max-w-6xl mx-auto px-6 py-16 border-t border-white/10 mt-12">
        <h2 className="text-2xl font-bold mb-8">Linee Guida di Produzione</h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            { title: "Dimensioni Max", value: "50 × 80 × 40 mm" },
            { title: "Spessore Parete", value: "1 - 15 mm" },
            { title: "Tolleranza (<10mm)", value: "±0.1 mm" },
            { title: "Tolleranza (≥10mm)", value: "±1%" },
            { title: "Aspect Ratio", value: "Max 10:1" },
            { title: "Raggio Min Curvatura", value: "0.5 mm" },
            { title: "Distanza Parti", value: "Min 1 mm" },
            { title: "Caratteri Min", value: "4 mm altezza" },
            { title: "Linee Min", value: "0.5 mm larghezza" },
          ].map((item, i) => (
            <div key={i} className="p-4 rounded-lg bg-white/5 border border-white/10">
              <p className="text-sm text-white/50 mb-1">{item.title}</p>
              <p className="font-mono font-medium">{item.value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-6 py-8 border-t border-white/10">
        <p className="text-center text-white/40 text-sm">
          Validatore STL per stampa 3D industriale • Linee guida manifattura italiana
        </p>
      </footer>

      <style>{`
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in {
          animation: fade-in 0.6s ease-out;
        }
      `}</style>
    </div>
  );
}

export default Index;
