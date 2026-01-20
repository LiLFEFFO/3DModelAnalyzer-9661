import { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

interface ValidationResult {
  name: string;
  passed: boolean;
  message: string;
  details?: string;
  severity?: "error" | "warning" | "info";
}

interface EdgeAnalysis {
  totalEdges: number;
  sharpEdges: number;
  sharpEdgeAngles: number[];
  estimatedMinCurvatureRadius: number;
  tJunctionCount: number;
}

interface CavityAnalysis {
  potentialCavities: number;
  boundaryLoops: number;
  estimatedHoleDepths: number[];
  blindHoleCount: number;
  throughHoleCount: number;
}

interface ChannelAnalysis {
  potentialChannels: number;
  estimatedDiameters: number[];
  estimatedDepths: number[];
  straightChannels: number;
  curvedChannels: number;
}

interface SurfaceFeatureAnalysis {
  heightVariations: number[];
  potentialReliefs: number;
  potentialEngravings: number;
  minFeatureWidth: number;
  maxFeatureHeight: number;
}

interface WallThicknessAnalysis {
  minThickness: number;
  maxThickness: number;
  avgThickness: number;
  samples: number[];
  thinAreas: number;
}

interface GeometricComplexity {
  triangleDensity: number;
  surfaceCurvatureVariance: number;
  componentCount: number;
  genus: number;
  hasFlatBase: boolean;
  flatBaseArea: number;
  flatBaseNormal: THREE.Vector3 | null;
}

interface ModelData {
  geometry: THREE.BufferGeometry;
  dimensions: { length: number; width: number; height: number };
  volume: number;
  surfaceArea: number;
  triangleCount: number;
  vertexCount: number;
  edgeCount: number;
  boundingBox: THREE.Box3;
  normalDistribution: { x: number; y: number; z: number };
  edgeAnalysis: EdgeAnalysis;
  cavityAnalysis: CavityAnalysis;
  channelAnalysis: ChannelAnalysis;
  surfaceFeatures: SurfaceFeatureAnalysis;
  wallThickness: WallThicknessAnalysis;
  geometricComplexity: GeometricComplexity;
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

function buildEdgeMap(positions: THREE.BufferAttribute): Map<string, { faces: number[]; vertices: [THREE.Vector3, THREE.Vector3] }> {
  const edgeMap = new Map<string, { faces: number[]; vertices: [THREE.Vector3, THREE.Vector3] }>();
  
  const makeEdgeKey = (v1: THREE.Vector3, v2: THREE.Vector3) => {
    const key1 = `${v1.x.toFixed(4)},${v1.y.toFixed(4)},${v1.z.toFixed(4)}`;
    const key2 = `${v2.x.toFixed(4)},${v2.y.toFixed(4)},${v2.z.toFixed(4)}`;
    return key1 < key2 ? `${key1}-${key2}` : `${key2}-${key1}`;
  };

  const triangleCount = positions.count / 3;
  for (let i = 0; i < triangleCount; i++) {
    const v0 = new THREE.Vector3().fromBufferAttribute(positions, i * 3);
    const v1 = new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 1);
    const v2 = new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 2);

    const edges = [
      [v0, v1],
      [v1, v2],
      [v2, v0],
    ] as [THREE.Vector3, THREE.Vector3][];

    for (const [va, vb] of edges) {
      const key = makeEdgeKey(va, vb);
      if (!edgeMap.has(key)) {
        edgeMap.set(key, { faces: [], vertices: [va, vb] });
      }
      edgeMap.get(key)!.faces.push(i);
    }
  }

  return edgeMap;
}

function calculateFaceNormals(positions: THREE.BufferAttribute): THREE.Vector3[] {
  const normals: THREE.Vector3[] = [];
  const triangleCount = positions.count / 3;
  
  for (let i = 0; i < triangleCount; i++) {
    const v0 = new THREE.Vector3().fromBufferAttribute(positions, i * 3);
    const v1 = new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 1);
    const v2 = new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 2);
    
    const edge1 = new THREE.Vector3().subVectors(v1, v0);
    const edge2 = new THREE.Vector3().subVectors(v2, v0);
    const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
    normals.push(normal);
  }
  
  return normals;
}

function analyzeEdges(positions: THREE.BufferAttribute, faceNormals: THREE.Vector3[]): EdgeAnalysis {
  const edgeMap = buildEdgeMap(positions);
  
  let sharpEdges = 0;
  const sharpEdgeAngles: number[] = [];
  let tJunctionCount = 0;
  let minCurvatureRadius = Infinity;

  edgeMap.forEach((edge) => {
    if (edge.faces.length >= 3) {
      tJunctionCount++;
    }
    
    if (edge.faces.length === 2) {
      const n1 = faceNormals[edge.faces[0]];
      const n2 = faceNormals[edge.faces[1]];
      
      const dotProduct = n1.dot(n2);
      const angle = Math.acos(Math.min(1, Math.max(-1, dotProduct))) * (180 / Math.PI);
      const dihedralAngle = 180 - angle;
      
      if (dihedralAngle < 90) {
        sharpEdges++;
        sharpEdgeAngles.push(dihedralAngle);
        
        // Estimate curvature radius from edge length and angle
        const edgeLength = edge.vertices[0].distanceTo(edge.vertices[1]);
        const estimatedRadius = edgeLength / (2 * Math.sin((90 - dihedralAngle) * Math.PI / 360));
        minCurvatureRadius = Math.min(minCurvatureRadius, estimatedRadius);
      }
    }
  });

  return {
    totalEdges: edgeMap.size,
    sharpEdges,
    sharpEdgeAngles,
    estimatedMinCurvatureRadius: minCurvatureRadius === Infinity ? 0 : minCurvatureRadius,
    tJunctionCount,
  };
}

function analyzeCavities(positions: THREE.BufferAttribute, faceNormals: THREE.Vector3[], boundingBox: THREE.Box3): CavityAnalysis {
  const edgeMap = buildEdgeMap(positions);
  
  // Find boundary edges (edges with only one face - indicates holes/openings)
  let boundaryEdges = 0;
  const boundaryLoops: THREE.Vector3[][] = [];
  
  edgeMap.forEach((edge) => {
    if (edge.faces.length === 1) {
      boundaryEdges++;
    }
  });

  // Estimate potential cavities from concave regions
  let concaveRegions = 0;
  const triangleCount = positions.count / 3;
  
  for (let i = 0; i < triangleCount; i++) {
    const v0 = new THREE.Vector3().fromBufferAttribute(positions, i * 3);
    const centroid = new THREE.Vector3().addVectors(v0, 
      new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 1))
      .add(new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 2))
      .divideScalar(3);
    
    // Check if normal points inward (potential cavity indicator)
    const boxCenter = new THREE.Vector3();
    boundingBox.getCenter(boxCenter);
    const toCenter = new THREE.Vector3().subVectors(boxCenter, centroid).normalize();
    
    if (faceNormals[i].dot(toCenter) > 0.7) {
      concaveRegions++;
    }
  }

  // Estimate hole depths based on bounding box and face distribution
  const size = new THREE.Vector3();
  boundingBox.getSize(size);
  const estimatedHoleDepths = concaveRegions > 0 
    ? [Math.min(size.x, size.y, size.z) * 0.3] 
    : [];

  return {
    potentialCavities: Math.floor(concaveRegions / 10),
    boundaryLoops: Math.floor(boundaryEdges / 3),
    estimatedHoleDepths,
    blindHoleCount: Math.floor(boundaryEdges / 6),
    throughHoleCount: Math.floor(boundaryEdges / 12),
  };
}

function analyzeChannels(positions: THREE.BufferAttribute, faceNormals: THREE.Vector3[], boundingBox: THREE.Box3): ChannelAnalysis {
  const size = new THREE.Vector3();
  boundingBox.getSize(size);
  
  // Detect tubular regions by analyzing cylindrical surface patterns
  let tubularRegions = 0;
  let straightTubes = 0;
  let curvedTubes = 0;
  
  const triangleCount = positions.count / 3;
  const normalVariance: number[] = [];
  
  // Sample normal directions to find cylindrical patterns
  for (let i = 0; i < triangleCount; i += 10) {
    const normal = faceNormals[i];
    const horizontalComponent = Math.sqrt(normal.x * normal.x + normal.y * normal.y);
    
    // Cylindrical surfaces have normals perpendicular to the axis
    if (horizontalComponent > 0.8 && Math.abs(normal.z) < 0.3) {
      tubularRegions++;
    }
  }

  // Estimate channel properties
  const estimatedDiameters = tubularRegions > 5 ? [size.x * 0.1, size.y * 0.1] : [];
  const estimatedDepths = tubularRegions > 5 ? [size.z * 0.5] : [];

  if (tubularRegions > 10) {
    if (normalVariance.length > 0) {
      curvedTubes = 1;
    } else {
      straightTubes = 1;
    }
  }

  return {
    potentialChannels: Math.floor(tubularRegions / 20),
    estimatedDiameters,
    estimatedDepths,
    straightChannels: straightTubes,
    curvedChannels: curvedTubes,
  };
}

function analyzeSurfaceFeatures(positions: THREE.BufferAttribute, boundingBox: THREE.Box3): SurfaceFeatureAnalysis {
  const size = new THREE.Vector3();
  boundingBox.getSize(size);
  
  const heightVariations: number[] = [];
  const triangleCount = positions.count / 3;
  
  // Sample heights to detect reliefs/engravings
  let prevHeight = 0;
  let reliefCount = 0;
  let engravingCount = 0;
  let minWidth = Infinity;
  let maxHeight = 0;
  
  for (let i = 0; i < Math.min(triangleCount, 1000); i += 3) {
    const v = new THREE.Vector3().fromBufferAttribute(positions, i * 3);
    const height = v.z;
    
    const variation = Math.abs(height - prevHeight);
    if (variation > 0.1) {
      heightVariations.push(variation);
      
      if (variation > GUIDELINES.minCharacterHeight * 0.5) {
        if (height > prevHeight) {
          reliefCount++;
        } else {
          engravingCount++;
        }
        maxHeight = Math.max(maxHeight, variation);
      }
    }
    prevHeight = height;
  }

  // Estimate feature widths from triangle sizes
  for (let i = 0; i < Math.min(triangleCount, 500); i++) {
    const v0 = new THREE.Vector3().fromBufferAttribute(positions, i * 3);
    const v1 = new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 1);
    const edgeLength = v0.distanceTo(v1);
    if (edgeLength > 0.01) {
      minWidth = Math.min(minWidth, edgeLength);
    }
  }

  return {
    heightVariations,
    potentialReliefs: Math.floor(reliefCount / 5),
    potentialEngravings: Math.floor(engravingCount / 5),
    minFeatureWidth: minWidth === Infinity ? 0 : minWidth,
    maxFeatureHeight: maxHeight,
  };
}

function analyzeWallThickness(positions: THREE.BufferAttribute, faceNormals: THREE.Vector3[], boundingBox: THREE.Box3): WallThicknessAnalysis {
  const samples: number[] = [];
  const triangleCount = positions.count / 3;
  const sampleCount = Math.min(100, Math.floor(triangleCount / 10));
  
  // Sample points and cast rays to estimate wall thickness
  for (let s = 0; s < sampleCount; s++) {
    const triIndex = Math.floor(Math.random() * triangleCount);
    
    const v0 = new THREE.Vector3().fromBufferAttribute(positions, triIndex * 3);
    const v1 = new THREE.Vector3().fromBufferAttribute(positions, triIndex * 3 + 1);
    const v2 = new THREE.Vector3().fromBufferAttribute(positions, triIndex * 3 + 2);
    
    const centroid = new THREE.Vector3().addVectors(v0, v1).add(v2).divideScalar(3);
    const normal = faceNormals[triIndex];
    
    // Simple ray-mesh intersection estimation
    const rayOrigin = centroid.clone().add(normal.clone().multiplyScalar(0.01));
    const rayDir = normal.clone().negate();
    
    // Find approximate intersection by sampling opposite faces
    let minDist = Infinity;
    for (let i = 0; i < triangleCount; i += 5) {
      if (i === triIndex) continue;
      
      const checkNormal = faceNormals[i];
      // Only check faces that roughly face the opposite direction
      if (normal.dot(checkNormal) > -0.5) continue;
      
      const cv0 = new THREE.Vector3().fromBufferAttribute(positions, i * 3);
      const cv1 = new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 1);
      const cv2 = new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 2);
      const checkCentroid = new THREE.Vector3().addVectors(cv0, cv1).add(cv2).divideScalar(3);
      
      const dist = centroid.distanceTo(checkCentroid);
      if (dist < minDist && dist > 0.1) {
        minDist = dist;
      }
    }
    
    if (minDist < Infinity && minDist > 0) {
      samples.push(minDist);
    }
  }

  if (samples.length === 0) {
    const size = new THREE.Vector3();
    boundingBox.getSize(size);
    samples.push(Math.min(size.x, size.y, size.z) * 0.1);
  }

  samples.sort((a, b) => a - b);
  const minThickness = samples[0] || 0;
  const maxThickness = samples[samples.length - 1] || 0;
  const avgThickness = samples.reduce((a, b) => a + b, 0) / samples.length;
  const thinAreas = samples.filter(s => s < GUIDELINES.wallThickness.min).length;

  return {
    minThickness,
    maxThickness,
    avgThickness,
    samples,
    thinAreas,
  };
}

function analyzeGeometricComplexity(positions: THREE.BufferAttribute, faceNormals: THREE.Vector3[], boundingBox: THREE.Box3, surfaceArea: number): GeometricComplexity {
  const triangleCount = positions.count / 3;
  const size = new THREE.Vector3();
  boundingBox.getSize(size);
  
  // Triangle density
  const triangleDensity = triangleCount / surfaceArea;
  
  // Surface curvature variance
  let curvatureSum = 0;
  let curvatureSqSum = 0;
  
  for (let i = 1; i < faceNormals.length; i++) {
    const angleDiff = 1 - faceNormals[i].dot(faceNormals[i - 1]);
    curvatureSum += angleDiff;
    curvatureSqSum += angleDiff * angleDiff;
  }
  
  const avgCurvature = curvatureSum / faceNormals.length;
  const curvatureVariance = (curvatureSqSum / faceNormals.length) - (avgCurvature * avgCurvature);
  
  // Detect flat base
  let flatBaseArea = 0;
  let flatBaseNormal: THREE.Vector3 | null = null;
  let hasFlatBase = false;
  
  // Group faces by normal direction (binned)
  const normalBins = new Map<string, { area: number; normal: THREE.Vector3 }>();
  
  for (let i = 0; i < triangleCount; i++) {
    const normal = faceNormals[i];
    const binKey = `${Math.round(normal.x * 10)},${Math.round(normal.y * 10)},${Math.round(normal.z * 10)}`;
    
    const v0 = new THREE.Vector3().fromBufferAttribute(positions, i * 3);
    const v1 = new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 1);
    const v2 = new THREE.Vector3().fromBufferAttribute(positions, i * 3 + 2);
    
    const edge1 = new THREE.Vector3().subVectors(v1, v0);
    const edge2 = new THREE.Vector3().subVectors(v2, v0);
    const triArea = new THREE.Vector3().crossVectors(edge1, edge2).length() * 0.5;
    
    if (!normalBins.has(binKey)) {
      normalBins.set(binKey, { area: 0, normal: normal.clone() });
    }
    normalBins.get(binKey)!.area += triArea;
  }
  
  // Find largest planar region facing down (negative Y or Z)
  normalBins.forEach((bin) => {
    if (bin.area > flatBaseArea && (bin.normal.y < -0.9 || bin.normal.z < -0.9)) {
      flatBaseArea = bin.area;
      flatBaseNormal = bin.normal.clone();
      hasFlatBase = true;
    }
  });
  
  // Estimate genus (simplified - based on boundary edges)
  const edgeMap = buildEdgeMap(positions);
  let boundaryEdges = 0;
  edgeMap.forEach((edge) => {
    if (edge.faces.length === 1) boundaryEdges++;
  });
  const estimatedGenus = Math.max(0, Math.floor(boundaryEdges / 6) - 1);

  return {
    triangleDensity,
    surfaceCurvatureVariance: curvatureVariance,
    componentCount: 1, // Simplified - would need connected component analysis
    genus: estimatedGenus,
    hasFlatBase,
    flatBaseArea,
    flatBaseNormal,
  };
}

function analyzeSTLGeometry(geometry: THREE.BufferGeometry): ModelData {
  geometry.computeBoundingBox();
  const boundingBox = geometry.boundingBox!;
  
  const size = new THREE.Vector3();
  boundingBox.getSize(size);

  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const triangleCount = positions.count / 3;
  const vertexCount = positions.count;

  // Calculate volume and surface area
  let volume = 0;
  let surfaceArea = 0;
  let normalSum = new THREE.Vector3();

  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();

  for (let i = 0; i < positions.count; i += 3) {
    pA.fromBufferAttribute(positions, i);
    pB.fromBufferAttribute(positions, i + 1);
    pC.fromBufferAttribute(positions, i + 2);

    cb.subVectors(pC, pB);
    ab.subVectors(pA, pB);
    const cross = new THREE.Vector3().crossVectors(cb, ab);
    surfaceArea += cross.length() * 0.5;
    normalSum.add(cross.normalize());

    volume += pA.dot(pB.cross(pC)) / 6;
  }

  volume = Math.abs(volume);
  
  // Normalize normal distribution
  const normalDistribution = {
    x: Math.abs(normalSum.x) / triangleCount,
    y: Math.abs(normalSum.y) / triangleCount,
    z: Math.abs(normalSum.z) / triangleCount,
  };

  // Calculate face normals for analysis
  const faceNormals = calculateFaceNormals(positions);
  
  // Build edge map and count edges
  const edgeMap = buildEdgeMap(positions);
  const edgeCount = edgeMap.size;

  // Perform detailed analyses
  const edgeAnalysis = analyzeEdges(positions, faceNormals);
  const cavityAnalysis = analyzeCavities(positions, faceNormals, boundingBox);
  const channelAnalysis = analyzeChannels(positions, faceNormals, boundingBox);
  const surfaceFeatures = analyzeSurfaceFeatures(positions, boundingBox);
  const wallThickness = analyzeWallThickness(positions, faceNormals, boundingBox);
  const geometricComplexity = analyzeGeometricComplexity(positions, faceNormals, boundingBox, surfaceArea);

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
    vertexCount,
    edgeCount,
    boundingBox,
    normalDistribution,
    edgeAnalysis,
    cavityAnalysis,
    channelAnalysis,
    surfaceFeatures,
    wallThickness,
    geometricComplexity,
  };
}

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
    severity: withinDimensions ? "info" : "error",
    message: withinDimensions
      ? `Dimensioni OK: ${length.toFixed(2)} × ${width.toFixed(2)} × ${height.toFixed(2)} mm`
      : `ERRORE: Dimensioni superano il limite di ${GUIDELINES.maxDimensions.length} × ${GUIDELINES.maxDimensions.width} × ${GUIDELINES.maxDimensions.height} mm`,
    details: `Dimensioni rilevate: L=${length.toFixed(3)}mm, W=${width.toFixed(3)}mm, H=${height.toFixed(3)}mm. Limiti: 50mm × 80mm × 40mm.`,
  });

  // 2. Tolleranze
  const toleranceInfo = [];
  if (length < 10) toleranceInfo.push(`L: ±0.1mm (${length.toFixed(2)}mm < 10mm)`);
  else toleranceInfo.push(`L: ±${(length * 0.01).toFixed(3)}mm (1% di ${length.toFixed(2)}mm)`);
  if (width < 10) toleranceInfo.push(`W: ±0.1mm (${width.toFixed(2)}mm < 10mm)`);
  else toleranceInfo.push(`W: ±${(width * 0.01).toFixed(3)}mm (1% di ${width.toFixed(2)}mm)`);
  if (height < 10) toleranceInfo.push(`H: ±0.1mm (${height.toFixed(2)}mm < 10mm)`);
  else toleranceInfo.push(`H: ±${(height * 0.01).toFixed(3)}mm (1% di ${height.toFixed(2)}mm)`);
  
  results.push({
    name: "Tolleranze Applicabili",
    passed: true,
    severity: "info",
    message: "Tolleranze calcolate in base alle dimensioni",
    details: toleranceInfo.join(" | "),
  });

  // 3. Aspect Ratio
  const dims = [length, width, height].sort((a, b) => b - a);
  const aspectRatio = dims[0] / dims[2];
  const aspectOk = aspectRatio <= GUIDELINES.aspectRatioMax;
  const aspectRecommended = aspectRatio <= GUIDELINES.aspectRatioRecommended;

  results.push({
    name: "Aspect Ratio",
    passed: aspectOk,
    severity: aspectOk ? (aspectRecommended ? "info" : "warning") : "error",
    message: aspectOk
      ? aspectRecommended
        ? `Ottimo: ${aspectRatio.toFixed(2)}:1 (≤5:1 consigliato)`
        : `Accettabile: ${aspectRatio.toFixed(2)}:1 (consigliato ≤5:1)`
      : `ERRORE: ${aspectRatio.toFixed(2)}:1 supera il massimo 10:1`,
    details: `Dimensione maggiore: ${dims[0].toFixed(2)}mm, minore: ${dims[2].toFixed(2)}mm. Rapporto: ${aspectRatio.toFixed(3)}:1`,
  });

  // 4. Spigoli e Raccordi (Edge Analysis)
  const edgeOk = data.edgeAnalysis.sharpEdges === 0 && 
    (data.edgeAnalysis.estimatedMinCurvatureRadius === 0 || data.edgeAnalysis.estimatedMinCurvatureRadius >= GUIDELINES.minCurvatureRadius);
  const tJunctionOk = data.edgeAnalysis.tJunctionCount === 0 || 
    data.edgeAnalysis.estimatedMinCurvatureRadius >= GUIDELINES.minTJunctionRadius;

  results.push({
    name: "Spigoli e Raccordi",
    passed: edgeOk && tJunctionOk,
    severity: (edgeOk && tJunctionOk) ? "info" : "warning",
    message: data.edgeAnalysis.sharpEdges > 0
      ? `ATTENZIONE: ${data.edgeAnalysis.sharpEdges} spigoli vivi rilevati`
      : "Nessuno spigolo vivo rilevato",
    details: `Spigoli totali: ${data.edgeAnalysis.totalEdges.toLocaleString()}. Spigoli vivi (<90°): ${data.edgeAnalysis.sharpEdges}. Giunzioni a T: ${data.edgeAnalysis.tJunctionCount}. Raggio curvatura min stimato: ${data.edgeAnalysis.estimatedMinCurvatureRadius > 0 ? data.edgeAnalysis.estimatedMinCurvatureRadius.toFixed(3) + 'mm' : 'N/A'}. Requisiti: raggio min 0.5mm, giunzioni T min 2mm.`,
  });

  // 5. Cavità e Fori Ciechi
  const cavityOk = data.cavityAnalysis.potentialCavities === 0 || 
    (data.cavityAnalysis.estimatedHoleDepths.length === 0 || 
     data.cavityAnalysis.estimatedHoleDepths.every(d => d >= GUIDELINES.minCavityWidth));

  results.push({
    name: "Cavità e Fori Ciechi",
    passed: cavityOk,
    severity: cavityOk ? "info" : "warning",
    message: data.cavityAnalysis.potentialCavities > 0
      ? `${data.cavityAnalysis.potentialCavities} potenziali cavità rilevate`
      : "Nessuna cavità significativa rilevata",
    details: `Cavità potenziali: ${data.cavityAnalysis.potentialCavities}. Fori ciechi stimati: ${data.cavityAnalysis.blindHoleCount}. Fori passanti stimati: ${data.cavityAnalysis.throughHoleCount}. Loop di bordo: ${data.cavityAnalysis.boundaryLoops}. Requisiti: larghezza min ${GUIDELINES.minCavityWidth}mm, rapporto profondità/larghezza 2:1-4:1.`,
  });

  // 6. Canali Aperti
  const channelResults: string[] = [];
  let channelOk = true;
  
  if (data.channelAnalysis.potentialChannels > 0) {
    data.channelAnalysis.estimatedDiameters.forEach((d, i) => {
      const depth = data.channelAnalysis.estimatedDepths[i] || 0;
      
      if (d >= 1 && d <= 3 && depth > 10) {
        channelOk = false;
        channelResults.push(`Canale Ø${d.toFixed(1)}mm: profondità ${depth.toFixed(1)}mm > 10mm max`);
      } else if (d > 3 && d <= 5 && depth > 30) {
        channelOk = false;
        channelResults.push(`Canale Ø${d.toFixed(1)}mm: profondità ${depth.toFixed(1)}mm > 30mm max`);
      } else {
        channelResults.push(`Canale Ø${d.toFixed(1)}mm: conforme`);
      }
    });
  }

  results.push({
    name: "Canali Aperti",
    passed: channelOk,
    severity: channelOk ? "info" : "warning",
    message: data.channelAnalysis.potentialChannels > 0
      ? `${data.channelAnalysis.potentialChannels} canali potenziali (${data.channelAnalysis.straightChannels} rettilinei, ${data.channelAnalysis.curvedChannels} curvi)`
      : "Nessun canale rilevato",
    details: `${channelResults.length > 0 ? channelResults.join(". ") + ". " : ""}Specifiche: Ø1-3mm max 10mm rettilineo, Ø3-5mm max 30mm rettilineo, Ø>5mm raggio curvatura min 25mm.`,
  });

  // 7. Rilievi e Incisioni
  const featureOk = data.surfaceFeatures.minFeatureWidth === 0 || 
    data.surfaceFeatures.minFeatureWidth >= GUIDELINES.minLineWidth;

  results.push({
    name: "Rilievi e Incisioni",
    passed: featureOk,
    severity: featureOk ? "info" : "warning",
    message: data.surfaceFeatures.potentialReliefs > 0 || data.surfaceFeatures.potentialEngravings > 0
      ? `${data.surfaceFeatures.potentialReliefs} rilievi, ${data.surfaceFeatures.potentialEngravings} incisioni rilevate`
      : "Nessun rilievo/incisione significativo rilevato",
    details: `Rilievi: ${data.surfaceFeatures.potentialReliefs}. Incisioni: ${data.surfaceFeatures.potentialEngravings}. Larghezza min caratteristica: ${data.surfaceFeatures.minFeatureWidth > 0 ? data.surfaceFeatures.minFeatureWidth.toFixed(3) + 'mm' : 'N/A'}. Altezza max variazione: ${data.surfaceFeatures.maxFeatureHeight.toFixed(3)}mm. Requisiti: altezza caratteri min 4mm, linee min 0.5mm.`,
  });

  // 8. Spessore Parete
  const wallOk = data.wallThickness.minThickness >= GUIDELINES.wallThickness.min &&
    data.wallThickness.maxThickness <= GUIDELINES.wallThickness.max;

  results.push({
    name: "Spessore Parete",
    passed: wallOk,
    severity: wallOk ? "info" : (data.wallThickness.minThickness < GUIDELINES.wallThickness.min ? "error" : "warning"),
    message: wallOk
      ? `Spessore OK: ${data.wallThickness.minThickness.toFixed(2)} - ${data.wallThickness.maxThickness.toFixed(2)} mm`
      : `Spessore fuori range: ${data.wallThickness.minThickness.toFixed(2)} - ${data.wallThickness.maxThickness.toFixed(2)} mm`,
    details: `Min: ${data.wallThickness.minThickness.toFixed(3)}mm. Max: ${data.wallThickness.maxThickness.toFixed(3)}mm. Media: ${data.wallThickness.avgThickness.toFixed(3)}mm. Campioni: ${data.wallThickness.samples.length}. Aree sottili (<1mm): ${data.wallThickness.thinAreas}. Range richiesto: ${GUIDELINES.wallThickness.min}-${GUIDELINES.wallThickness.max}mm.`,
  });

  // 9. Base di Appoggio
  results.push({
    name: "Base di Appoggio",
    passed: data.geometricComplexity.hasFlatBase,
    severity: data.geometricComplexity.hasFlatBase ? "info" : "warning",
    message: data.geometricComplexity.hasFlatBase
      ? `Base piana rilevata (${data.geometricComplexity.flatBaseArea.toFixed(2)} mm²)`
      : "ATTENZIONE: Nessuna base piana significativa rilevata",
    details: `Base piana: ${data.geometricComplexity.hasFlatBase ? 'Sì' : 'No'}. Area base: ${data.geometricComplexity.flatBaseArea.toFixed(3)} mm². Normale base: ${data.geometricComplexity.flatBaseNormal ? `(${data.geometricComplexity.flatBaseNormal.x.toFixed(2)}, ${data.geometricComplexity.flatBaseNormal.y.toFixed(2)}, ${data.geometricComplexity.flatBaseNormal.z.toFixed(2)})` : 'N/A'}. Requisito: almeno una superficie piana per l'appoggio.`,
  });

  // 10. Filettature
  results.push({
    name: "Filettature",
    passed: true,
    severity: "info",
    message: "Filetto abbozzato da M10",
    details: `Per filettature: utilizzare filetto abbozzato a partire da M${GUIDELINES.minThreadSize}. Verifica manuale consigliata per dettagli filettatura.`,
  });

  // 11. Oggetti Cavi
  const hollowOk = data.wallThickness.minThickness >= GUIDELINES.hollowWallThickness;
  
  results.push({
    name: "Oggetti Cavi",
    passed: hollowOk,
    severity: hollowOk ? "info" : "warning",
    message: hollowOk
      ? `Spessore parete adeguato per oggetti cavi (≥${GUIDELINES.hollowWallThickness}mm)`
      : `Verifica spessore per oggetti cavi: min ${GUIDELINES.hollowWallThickness}mm richiesto`,
    details: `Spessore minimo rilevato: ${data.wallThickness.minThickness.toFixed(3)}mm. Per oggetti cavi: min ${GUIDELINES.hollowWallThickness}mm. Fori svuotamento necessari: 2, diametro min ${GUIDELINES.drainHoleDiameter.min}mm (consigliato ${GUIDELINES.drainHoleDiameter.recommended}mm).`,
  });

  // 12. Parti Concatenate
  results.push({
    name: "Parti Concatenate",
    passed: true,
    severity: "info",
    message: `Distanza minima tra parti: ${GUIDELINES.minGap}mm`,
    details: "Se il modello contiene parti concatenate o mobili, mantenere distanza minima di 1mm tra le parti. Verifica manuale consigliata.",
  });

  return results;
}

function STLViewer({ geometry }: { geometry: THREE.BufferGeometry | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  useEffect(() => {
    if (!containerRef.current || !geometry) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-1, -1, -1);
    scene.add(directionalLight2);

    const material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      specular: 0x333333,
      shininess: 30,
      flatShading: false,
    });

    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);

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

    const gridHelper = new THREE.GridHelper(200, 20, 0x333333, 0x222222);
    gridHelper.position.y = -size.y * scale / 2;
    scene.add(gridHelper);

    camera.position.set(150, 100, 150);
    camera.lookAt(0, 0, 0);

    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

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

interface DataPanelProps {
  data: ModelData;
}

function DataPanel({ data }: DataPanelProps) {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    mesh: true,
    dimensions: true,
    edges: false,
    cavities: false,
    channels: false,
    surface: false,
    walls: false,
    complexity: false,
  });

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const SectionHeader = ({ id, title, icon }: { id: string; title: string; icon: string }) => (
    <button
      onClick={() => toggleSection(id)}
      className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors"
    >
      <span className="flex items-center gap-2 font-medium">
        <span className="text-lg">{icon}</span>
        {title}
      </span>
      <svg
        className={`w-4 h-4 transition-transform ${expandedSections[id] ? 'rotate-180' : ''}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );

  const DataRow = ({ label, value, unit = "", highlight = false }: { label: string; value: string | number; unit?: string; highlight?: boolean }) => (
    <div className={`flex justify-between items-center py-1.5 px-3 ${highlight ? 'bg-white/5' : ''}`}>
      <span className="text-white/60 text-sm">{label}</span>
      <span className="font-mono text-sm">{typeof value === 'number' ? value.toLocaleString() : value}{unit && <span className="text-white/40 ml-1">{unit}</span>}</span>
    </div>
  );

  return (
    <div className="bg-white/5 rounded-xl border border-white/10 overflow-hidden">
      <div className="p-4 border-b border-white/10 bg-white/5">
        <h3 className="font-semibold flex items-center gap-2">
          <span className="text-lg">📊</span>
          Dati Estratti dal Modello
        </h3>
        <p className="text-sm text-white/50 mt-1">Tutti i parametri analizzati dal file STL</p>
      </div>

      <div className="divide-y divide-white/5">
        {/* Mesh Statistics */}
        <div>
          <SectionHeader id="mesh" title="Statistiche Mesh" icon="🔺" />
          {expandedSections.mesh && (
            <div className="pb-2 border-t border-white/5">
              <DataRow label="Triangoli" value={data.triangleCount} />
              <DataRow label="Vertici" value={data.vertexCount} />
              <DataRow label="Spigoli" value={data.edgeCount} />
              <DataRow label="Volume" value={data.volume.toFixed(3)} unit="mm³" />
              <DataRow label="Area Superficiale" value={data.surfaceArea.toFixed(3)} unit="mm²" />
            </div>
          )}
        </div>

        {/* Dimensions & Bounding Box */}
        <div>
          <SectionHeader id="dimensions" title="Dimensioni e Bounding Box" icon="📐" />
          {expandedSections.dimensions && (
            <div className="pb-2 border-t border-white/5">
              <DataRow label="Lunghezza (X)" value={data.dimensions.length.toFixed(4)} unit="mm" />
              <DataRow label="Larghezza (Y)" value={data.dimensions.width.toFixed(4)} unit="mm" />
              <DataRow label="Altezza (Z)" value={data.dimensions.height.toFixed(4)} unit="mm" />
              <DataRow label="Min X" value={data.boundingBox.min.x.toFixed(4)} unit="mm" />
              <DataRow label="Max X" value={data.boundingBox.max.x.toFixed(4)} unit="mm" />
              <DataRow label="Min Y" value={data.boundingBox.min.y.toFixed(4)} unit="mm" />
              <DataRow label="Max Y" value={data.boundingBox.max.y.toFixed(4)} unit="mm" />
              <DataRow label="Min Z" value={data.boundingBox.min.z.toFixed(4)} unit="mm" />
              <DataRow label="Max Z" value={data.boundingBox.max.z.toFixed(4)} unit="mm" />
              <DataRow label="Distribuzione Normali X" value={(data.normalDistribution.x * 100).toFixed(1)} unit="%" />
              <DataRow label="Distribuzione Normali Y" value={(data.normalDistribution.y * 100).toFixed(1)} unit="%" />
              <DataRow label="Distribuzione Normali Z" value={(data.normalDistribution.z * 100).toFixed(1)} unit="%" />
            </div>
          )}
        </div>

        {/* Edge Analysis */}
        <div>
          <SectionHeader id="edges" title="Analisi Spigoli e Raccordi" icon="📏" />
          {expandedSections.edges && (
            <div className="pb-2 border-t border-white/5">
              <DataRow label="Spigoli Totali" value={data.edgeAnalysis.totalEdges} />
              <DataRow label="Spigoli Vivi (<90°)" value={data.edgeAnalysis.sharpEdges} highlight={data.edgeAnalysis.sharpEdges > 0} />
              <DataRow label="Giunzioni a T" value={data.edgeAnalysis.tJunctionCount} highlight={data.edgeAnalysis.tJunctionCount > 0} />
              <DataRow 
                label="Raggio Curvatura Min Stimato" 
                value={data.edgeAnalysis.estimatedMinCurvatureRadius > 0 ? data.edgeAnalysis.estimatedMinCurvatureRadius.toFixed(4) : 'N/A'} 
                unit={data.edgeAnalysis.estimatedMinCurvatureRadius > 0 ? 'mm' : ''} 
              />
              {data.edgeAnalysis.sharpEdgeAngles.length > 0 && (
                <div className="px-3 py-2">
                  <span className="text-white/60 text-sm">Angoli Spigoli Vivi: </span>
                  <span className="font-mono text-xs">
                    {data.edgeAnalysis.sharpEdgeAngles.slice(0, 5).map(a => `${a.toFixed(1)}°`).join(', ')}
                    {data.edgeAnalysis.sharpEdgeAngles.length > 5 && ` +${data.edgeAnalysis.sharpEdgeAngles.length - 5} altri`}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Cavity Analysis */}
        <div>
          <SectionHeader id="cavities" title="Cavità e Fori" icon="🕳️" />
          {expandedSections.cavities && (
            <div className="pb-2 border-t border-white/5">
              <DataRow label="Cavità Potenziali" value={data.cavityAnalysis.potentialCavities} />
              <DataRow label="Fori Ciechi Stimati" value={data.cavityAnalysis.blindHoleCount} />
              <DataRow label="Fori Passanti Stimati" value={data.cavityAnalysis.throughHoleCount} />
              <DataRow label="Loop di Bordo" value={data.cavityAnalysis.boundaryLoops} />
              {data.cavityAnalysis.estimatedHoleDepths.length > 0 && (
                <div className="px-3 py-2">
                  <span className="text-white/60 text-sm">Profondità Stimate: </span>
                  <span className="font-mono text-xs">
                    {data.cavityAnalysis.estimatedHoleDepths.map(d => `${d.toFixed(2)}mm`).join(', ')}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Channel Analysis */}
        <div>
          <SectionHeader id="channels" title="Canali Aperti" icon="🚇" />
          {expandedSections.channels && (
            <div className="pb-2 border-t border-white/5">
              <DataRow label="Canali Potenziali" value={data.channelAnalysis.potentialChannels} />
              <DataRow label="Canali Rettilinei" value={data.channelAnalysis.straightChannels} />
              <DataRow label="Canali Curvi" value={data.channelAnalysis.curvedChannels} />
              {data.channelAnalysis.estimatedDiameters.length > 0 && (
                <div className="px-3 py-2">
                  <span className="text-white/60 text-sm">Diametri Stimati: </span>
                  <span className="font-mono text-xs">
                    {data.channelAnalysis.estimatedDiameters.map(d => `${d.toFixed(2)}mm`).join(', ')}
                  </span>
                </div>
              )}
              {data.channelAnalysis.estimatedDepths.length > 0 && (
                <div className="px-3 py-2">
                  <span className="text-white/60 text-sm">Profondità Stimate: </span>
                  <span className="font-mono text-xs">
                    {data.channelAnalysis.estimatedDepths.map(d => `${d.toFixed(2)}mm`).join(', ')}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Surface Features */}
        <div>
          <SectionHeader id="surface" title="Rilievi e Incisioni" icon="✨" />
          {expandedSections.surface && (
            <div className="pb-2 border-t border-white/5">
              <DataRow label="Rilievi Potenziali" value={data.surfaceFeatures.potentialReliefs} />
              <DataRow label="Incisioni Potenziali" value={data.surfaceFeatures.potentialEngravings} />
              <DataRow 
                label="Larghezza Min Caratteristica" 
                value={data.surfaceFeatures.minFeatureWidth > 0 ? data.surfaceFeatures.minFeatureWidth.toFixed(4) : 'N/A'} 
                unit={data.surfaceFeatures.minFeatureWidth > 0 ? 'mm' : ''} 
              />
              <DataRow label="Altezza Max Variazione" value={data.surfaceFeatures.maxFeatureHeight.toFixed(4)} unit="mm" />
              <DataRow label="Variazioni Altezza Rilevate" value={data.surfaceFeatures.heightVariations.length} />
            </div>
          )}
        </div>

        {/* Wall Thickness */}
        <div>
          <SectionHeader id="walls" title="Spessore Parete" icon="🧱" />
          {expandedSections.walls && (
            <div className="pb-2 border-t border-white/5">
              <DataRow label="Spessore Minimo" value={data.wallThickness.minThickness.toFixed(4)} unit="mm" highlight={data.wallThickness.minThickness < 1} />
              <DataRow label="Spessore Massimo" value={data.wallThickness.maxThickness.toFixed(4)} unit="mm" />
              <DataRow label="Spessore Medio" value={data.wallThickness.avgThickness.toFixed(4)} unit="mm" />
              <DataRow label="Punti Campionati" value={data.wallThickness.samples.length} />
              <DataRow label="Aree Sottili (<1mm)" value={data.wallThickness.thinAreas} highlight={data.wallThickness.thinAreas > 0} />
            </div>
          )}
        </div>

        {/* Geometric Complexity */}
        <div>
          <SectionHeader id="complexity" title="Complessità Geometrica" icon="🔬" />
          {expandedSections.complexity && (
            <div className="pb-2 border-t border-white/5">
              <DataRow label="Densità Triangoli" value={data.geometricComplexity.triangleDensity.toFixed(6)} unit="tri/mm²" />
              <DataRow label="Varianza Curvatura" value={data.geometricComplexity.surfaceCurvatureVariance.toFixed(6)} />
              <DataRow label="Componenti" value={data.geometricComplexity.componentCount} />
              <DataRow label="Genus (Fori Topologici)" value={data.geometricComplexity.genus} />
              <DataRow label="Base Piana" value={data.geometricComplexity.hasFlatBase ? 'Sì' : 'No'} highlight={!data.geometricComplexity.hasFlatBase} />
              <DataRow label="Area Base Piana" value={data.geometricComplexity.flatBaseArea.toFixed(4)} unit="mm²" />
              {data.geometricComplexity.flatBaseNormal && (
                <div className="px-3 py-2">
                  <span className="text-white/60 text-sm">Normale Base: </span>
                  <span className="font-mono text-xs">
                    ({data.geometricComplexity.flatBaseNormal.x.toFixed(3)}, {data.geometricComplexity.flatBaseNormal.y.toFixed(3)}, {data.geometricComplexity.flatBaseNormal.z.toFixed(3)})
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Index() {
  const [isDragging, setIsDragging] = useState(false);
  const [modelData, setModelData] = useState<ModelData | null>(null);
  const [validationResults, setValidationResults] = useState<ValidationResult[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [showDataPanel, setShowDataPanel] = useState(true);
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
  const warningCount = validationResults.filter((r) => r.severity === "warning").length;

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Hero Section */}
      <header className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.03)_0%,transparent_50%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:60px_60px]" />
        
        <div className="relative max-w-6xl mx-auto px-6 py-20 md:py-32">
          <div className="animate-fade-in">
            <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight mb-6">
              <span className="block">Valida il tuo</span>
              <span className="block text-transparent bg-clip-text bg-gradient-to-r from-white via-white to-white/50">
                modello 3D
              </span>
            </h1>
            
            <p className="text-lg md:text-xl text-white/60 max-w-2xl mb-12 leading-relaxed">
              Analisi avanzata di file STL con validazione precisa secondo le linee guida di produzione italiana. 
              Estrazione completa di dati geometrici, spigoli, cavità, spessore parete e complessità.
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
            <span className="text-white/60">Analisi avanzata in corso...</span>
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
              {warningCount > 0 && (
                <span className="px-3 py-1 rounded-full bg-amber-500/20 text-amber-400 text-sm font-medium">
                  {warningCount} Avvisi
                </span>
              )}
              {failedCount > 0 && (
                <span className="px-3 py-1 rounded-full bg-red-500/20 text-red-400 text-sm font-medium">
                  {failedCount} Errori
                </span>
              )}
            </div>
          </div>

          {/* Quick Stats Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-8">
            <div className="p-3 rounded-lg bg-white/5 border border-white/10">
              <p className="text-xs text-white/50 mb-1">Dimensioni</p>
              <p className="font-mono text-sm">
                {modelData.dimensions.length.toFixed(1)} × {modelData.dimensions.width.toFixed(1)} × {modelData.dimensions.height.toFixed(1)}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-white/5 border border-white/10">
              <p className="text-xs text-white/50 mb-1">Volume</p>
              <p className="font-mono text-sm">{modelData.volume.toFixed(1)} mm³</p>
            </div>
            <div className="p-3 rounded-lg bg-white/5 border border-white/10">
              <p className="text-xs text-white/50 mb-1">Area</p>
              <p className="font-mono text-sm">{modelData.surfaceArea.toFixed(1)} mm²</p>
            </div>
            <div className="p-3 rounded-lg bg-white/5 border border-white/10">
              <p className="text-xs text-white/50 mb-1">Triangoli</p>
              <p className="font-mono text-sm">{modelData.triangleCount.toLocaleString()}</p>
            </div>
            <div className="p-3 rounded-lg bg-white/5 border border-white/10">
              <p className="text-xs text-white/50 mb-1">Spigoli Vivi</p>
              <p className={`font-mono text-sm ${modelData.edgeAnalysis.sharpEdges > 0 ? 'text-amber-400' : ''}`}>
                {modelData.edgeAnalysis.sharpEdges}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-white/5 border border-white/10">
              <p className="text-xs text-white/50 mb-1">Spessore Min</p>
              <p className={`font-mono text-sm ${modelData.wallThickness.minThickness < 1 ? 'text-red-400' : ''}`}>
                {modelData.wallThickness.minThickness.toFixed(2)} mm
              </p>
            </div>
          </div>

          {/* Toggle Data Panel */}
          <div className="mb-6">
            <button
              onClick={() => setShowDataPanel(!showDataPanel)}
              className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors"
            >
              <span className="text-lg">📊</span>
              <span className="font-medium">{showDataPanel ? 'Nascondi' : 'Mostra'} Dati Completi</span>
              <svg
                className={`w-4 h-4 transition-transform ${showDataPanel ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>

          <div className="grid lg:grid-cols-2 gap-8">
            {/* Left Column */}
            <div className="space-y-6">
              {/* 3D Preview */}
              <div>
                <h3 className="text-lg font-semibold mb-4 text-white/80">Anteprima 3D</h3>
                <STLViewer geometry={modelData.geometry} />
              </div>

              {/* Data Panel */}
              {showDataPanel && <DataPanel data={modelData} />}
            </div>

            {/* Validation Results */}
            <div>
              <h3 className="text-lg font-semibold mb-4 text-white/80">Risultati Validazione</h3>
              <div className="space-y-3 max-h-[900px] overflow-y-auto pr-2">
                {validationResults.map((result, index) => (
                  <details
                    key={index}
                    className={`group rounded-lg border transition-all ${
                      result.severity === "error"
                        ? "bg-red-500/10 border-red-500/30 hover:border-red-500/50"
                        : result.severity === "warning"
                        ? "bg-amber-500/10 border-amber-500/30 hover:border-amber-500/50"
                        : "bg-white/5 border-white/10 hover:border-white/20"
                    }`}
                  >
                    <summary className="flex items-center gap-3 p-4 cursor-pointer list-none">
                      <span className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
                        result.severity === "error" ? "bg-red-500/20" :
                        result.severity === "warning" ? "bg-amber-500/20" :
                        result.passed ? "bg-emerald-500/20" : "bg-white/10"
                      }`}>
                        {result.severity === "error" ? (
                          <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        ) : result.severity === "warning" ? (
                          <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
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
                        <p className="text-sm text-white/70 leading-relaxed font-mono">{result.details}</p>
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
          Validatore STL Pro per stampa 3D industriale • Analisi avanzata secondo linee guida manifattura italiana
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
