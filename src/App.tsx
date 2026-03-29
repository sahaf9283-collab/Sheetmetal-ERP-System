/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import Webcam from 'react-webcam';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Camera, 
  CameraOff,
  Trash2, 
  History, 
  ArrowRightLeft, 
  ArrowRight, 
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  AlertTriangle,
  CheckCircle2,
  Package,
  Factory,
  RefreshCcw,
  Loader2,
  ChevronRight,
  Info,
  Layers,
  Triangle,
  Square,
  Zap,
  Tag,
  Truck,
  Hash,
  Database,
  Power,
  Upload,
  ImageIcon,
  X,
  Box,
  LayoutGrid,
  Maximize,
  Cpu,
  Play,
  Scissors,
  Activity,
  Search
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, Float, PerspectiveCamera, Environment, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';
import { cn } from './lib/utils';

// --- Types ---

type MaterialType = 'Basic Steel' | 'Stainless Steel' | 'Zinc Steel' | 'Aluminum' | 'Finished Good' | 'Unknown';

interface BatchData {
  vendor: string;
  material: MaterialType;
  batchNumber: string;
  triangular: number;
  rectangular: number;
  scrap: number;
  size?: number; // in m2
  weight?: number; // in kg
}

interface InventoryItem extends BatchData {
  id: string;
  lastUpdated: Date;
}

interface InventoryLog extends BatchData {
  id: string;
  timestamp: Date;
  direction: 'inbound' | 'outbound';
  imageUrl?: string;
  type?: string;
  message?: string;
}

interface PendingTransaction {
  result: BatchData;
  direction: 'inbound' | 'outbound';
  targetBatchNumber: string;
  recommendedCubes: { id: string; type: string; material: string }[];
  imageSrc: string;
}

interface FinishedGood {
  id: string;
  itemName: string;
  material: MaterialType;
  weightPerItem: number; // grams
  quantity: number;
  batchNumber: string;
  timestamp: Date;
}

interface StorageCube {
  id: string;
  row: number;
  col: number;
  level: number;
  type: 'rectangular' | 'triangular' | 'scrap' | 'finished';
  material: MaterialType | 'Mixed';
  occupiedBy: {
    vendor: string;
    batchNumber: string;
    itemName?: string;
    quantity?: number;
    volume?: number;
  } | null;
  recommendationType: 'inbound' | 'outbound' | null;
}

// --- Constants ---

const MODEL_NAME = "gemini-3-flash-preview";

const MATERIAL_PROPS: Record<string, { price: number; density: number }> = {
  'Aluminum': { price: 4, density: 2.7 },
  'Stainless Steel': { price: 2.8, density: 8 },
  'Zinc Steel': { price: 1.1, density: 8 },
  'Basic Steel': { price: 0.95, density: 8 },
  'Triangular Steel': { price: 0.95, density: 4 },
  'Triangular Aluminum': { price: 0.95, density: 4 }
};

const INITIAL_STORAGE: StorageCube[] = (() => {
  const cubes: StorageCube[] = [];
  const materials: MaterialType[] = ['Basic Steel', 'Aluminum', 'Stainless Steel', 'Zinc Steel'];
  
  for (let l = 0; l < 3; l++) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let type: 'rectangular' | 'triangular' | 'scrap' | 'finished' = 'rectangular';
        const material = materials[c % materials.length];

        // Level 0: Rows 0, 1, 2 are Scrap (12 total). Row 3 is Rectangular (4 total).
        if (l === 0) {
          if (r < 3) {
            type = 'scrap';
          } else {
            type = 'rectangular';
          }
        } 
        // Level 1: All Rectangular (16 total).
        else if (l === 1) {
          type = 'rectangular';
        } 
        // Level 2: All Triangular (16 total).
        else if (l === 2) {
          type = 'triangular';
        }

        cubes.push({
          id: `RM-L${l}-R${r}-C${c}`,
          row: r,
          col: c,
          level: l,
          type,
          material,
          occupiedBy: null,
          recommendationType: null
        });
      }
    }
  }
  return cubes;
})();

const INITIAL_FG_STORAGE: StorageCube[] = (() => {
  const cubes: StorageCube[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      for (let l = 0; l < 3; l++) {
        cubes.push({
          id: `Can.R${r+1}.B${l+1}.C${c+1}`,
          row: r,
          col: c,
          level: l,
          type: 'finished',
          material: 'Mixed',
          occupiedBy: null,
          recommendationType: null
        });
      }
    }
  }
  return cubes;
})();

// --- 3D Components ---

function Cube({ data, onHover, isFG = false }: { data: StorageCube; onHover: (data: StorageCube | null) => void; isFG?: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const isOccupied = !!data.occupiedBy;
  const isFull = data.occupiedBy?.volume && data.occupiedBy.volume >= 0.7;
  
  let color = '#1e293b'; // Default: Empty (Dark Slate)
  let emissive = '#000000';
  let emissiveIntensity = 0;
  let opacity = 0.2;

  if (data.recommendationType === 'inbound') {
    color = '#10b981'; // STORE (IN) - Emerald
    emissive = '#34d399';
    emissiveIntensity = 3;
    opacity = 0.9;
  } else if (data.recommendationType === 'outbound') {
    color = '#f59e0b'; // PICK (OUT) - Amber
    emissive = '#fbbf24';
    emissiveIntensity = 3;
    opacity = 0.9;
  } else if (isOccupied) {
    color = '#ef4444'; // OCCUPIED - Red
    opacity = 0.8;
  } else {
    color = '#334155'; // EMPTY - Light Slate
    opacity = 0.15;
  }

  return (
    <mesh 
      ref={meshRef}
      position={[data.col * 1.2 - 1.8, data.level * 1.2, data.row * 1.2 - 1.8]}
      onPointerOver={() => onHover(data)}
      onPointerOut={() => onHover(null)}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial 
        color={color} 
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
        transparent 
        opacity={opacity} 
        metalness={0.8}
        roughness={0.2}
      />
      {isOccupied && (
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.8, 0.8, 0.8]} />
          <meshStandardMaterial color="#ffffff" opacity={0.1} transparent />
        </mesh>
      )}
    </mesh>
  );
}

function StorageMap({ storage, onHover, isFG = false }: { storage: StorageCube[]; onHover: (data: StorageCube | null) => void; isFG?: boolean }) {
  const groupRef = useRef<THREE.Group>(null);

  return (
    <group ref={groupRef}>
      {storage.map((cube) => (
        <Cube key={cube.id} data={cube} onHover={onHover} isFG={isFG} />
      ))}
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.6, 0]}>
        <planeGeometry args={[10, 10]} />
        <meshStandardMaterial color="#0f172a" transparent opacity={0.5} />
      </mesh>
    </group>
  );
}

export default function App() {
  // --- State ---
  const [activeTab, setActiveTab] = useState<'inventory' | 'production' | 'finished'>('inventory');
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([]);
  const [logs, setLogs] = useState<InventoryLog[]>([]);
  const [storage, setStorage] = useState<StorageCube[]>(INITIAL_STORAGE);
  const [fgStorage, setFgStorage] = useState<StorageCube[]>(INITIAL_FG_STORAGE);
  const [hoveredCube, setHoveredCube] = useState<StorageCube | null>(null);
  const [showStorageMap, setShowStorageMap] = useState(false);
  const [showFGMap, setShowFGMap] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingTransaction, setPendingTransaction] = useState<PendingTransaction | null>(null);
  const [pendingProduction, setPendingProduction] = useState<{
    itemName: string;
    material: MaterialType;
    weightPerItem: number;
    quantity: number;
    totalWeightNeededKg: number;
    assignedCubes: string[];
    updatedInventory: InventoryItem[];
    storageUpdates: { batchNumber: string, type: 'clear' | 'move_to_scrap', updatedItem?: any, scrapWeight?: number }[];
    tempFgStorage: StorageCube[];
    consumptionLogs: InventoryLog[];
    newBatchNumber: string;
  } | null>(null);
  
  // Production State
  const [prodItemName, setProdItemName] = useState('');
  const [prodMaterial, setProdMaterial] = useState<MaterialType>('Basic Steel');
  const [prodWeightGrams, setProdWeightGrams] = useState(0);
  const [prodQuantity, setProdQuantity] = useState(1);
  const [prodMachine, setProdMachine] = useState<'Milling' | 'Bending'>('Milling');
  const [productionError, setProductionError] = useState<string | null>(null);
  const [productionSuccess, setProductionSuccess] = useState<string | null>(null);
  
  // Finished Goods Manual Management State
  const [fgManualItemName, setFgManualItemName] = useState('');
  const [fgManualQuantity, setFgManualQuantity] = useState(1);
  const [fgManualDirection, setFgManualDirection] = useState<'inbound' | 'outbound'>('inbound');
  const [fgError, setFgError] = useState<string | null>(null);
  const [fgSuccess, setFgSuccess] = useState<string | null>(null);

  const [pendingFGOutbound, setPendingFGOutbound] = useState<{
    itemName: string;
    quantity: number;
    storageUpdates: { cubeId: string, quantityTaken: number, remainingQuantity: number, batchNumber: string }[];
    updatedFG: FinishedGood[];
  } | null>(null);

  const [direction, setDirection] = useState<'inbound' | 'outbound'>('inbound');
  const [inventoryType, setInventoryType] = useState<'raw' | 'finished'>('raw');
  const [isScanning, setIsScanning] = useState(false);
  const [lastScan, setLastScan] = useState<BatchData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showInventoryList, setShowInventoryList] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  const webcamRef = useRef<Webcam>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cameraReady, setCameraReady] = useState(false);

  useEffect(() => {
    if (!cameraEnabled) {
      setCameraReady(false);
    }
  }, [cameraEnabled]);

  // --- AI Logic ---

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setUploadedImage(reader.result as string);
        setCameraEnabled(false);
      };
      reader.readAsDataURL(file);
    }
  };

  const scanSheetsWithToken = async () => {
    let imageSrc: string | null = null;

    if (uploadedImage) {
      imageSrc = uploadedImage;
    } else {
      if (!cameraEnabled) {
        setError("Camera is disabled. Please turn it on or upload an image to scan.");
        return;
      }
      if (!webcamRef.current || !cameraReady) {
        setError("Camera is not ready yet.");
        return;
      }
      imageSrc = webcamRef.current.getScreenshot();
    }

    if (!imageSrc) {
      setError("Could not capture or find image for analysis.");
      return;
    }

    setIsScanning(true);
    setError(null);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      setError("Gemini API Key is missing. Please check your environment variables.");
      setIsScanning(false);
      return;
    }

    const ai = new GoogleGenAI({ apiKey });
    const base64Data = imageSrc.split(',')[1];

    if (inventoryType === 'raw') {
      console.log("Starting metal sheet + token scan with model:", MODEL_NAME);

      try {
        console.log("Sending request to Gemini API...");
        const response = await ai.models.generateContent({
          model: MODEL_NAME,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Data,
                },
              },
              {
                text: `Analyze this image of industrial metal sheets and a paper identification token. 
                
                TASK 1: TOKEN RECOGNITION
                - Find the paper label/token in the image.
                - Extract the 'Vendor Name'.
                - Extract the 'Material Type' (Basic Steel, Stainless Steel, Zinc Steel, or Aluminum).
                - Extract the 'Batch Number'.
                - Extract 'Size per piece' (in m2) and 'Weight per piece' (in kg) from the token.
                
                TASK 2: SHAPE COUNTING
                - Count distinct 'Triangular' metal sheets.
                - Count distinct 'Rectangular' metal sheets.
                - Count 'Scrap' pieces.
                
                Return ONLY a JSON object:
                { 
                  "vendor": "string", 
                  "material": "string", 
                  "batchNumber": "string", 
                  "triangular": number, 
                  "rectangular": number, 
                  "scrap": number,
                  "size": number | null,
                  "weight": number | null
                }
                
                NOTE: The 'size' and 'weight' fields in the JSON should be the values PER PIECE as read from the token.
                
                If any token field is absolutely unreadable, use "Unknown" or null for numbers.`,
              },
            ],
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                vendor: { type: Type.STRING },
                material: { type: Type.STRING },
                batchNumber: { type: Type.STRING },
                triangular: { type: Type.NUMBER },
                rectangular: { type: Type.NUMBER },
                scrap: { type: Type.NUMBER },
                size: { type: Type.NUMBER, nullable: true },
                weight: { type: Type.NUMBER, nullable: true }
              },
              required: ["vendor", "material", "batchNumber", "triangular", "rectangular", "scrap"],
            },
          },
        });

        console.log("Received response from Gemini API:", response.text);
        let result = JSON.parse(response.text || "{}") as BatchData;

        // Normalize Material Type to match INITIAL_STORAGE exactly
        const rawMaterial = (result.material || "Unknown").trim().toLowerCase();
        if (rawMaterial.includes('stainless')) {
          result.material = 'Stainless Steel';
        } else if (rawMaterial.includes('zinc')) {
          result.material = 'Zinc Steel';
        } else if (rawMaterial.includes('aluminum') || rawMaterial.includes('aluminium')) {
          result.material = 'Aluminum';
        } else if (rawMaterial.includes('steel')) {
          result.material = 'Basic Steel';
        } else {
          result.material = 'Unknown';
        }

        // Normalize Batch Number (remove leading #)
        result.batchNumber = result.batchNumber?.toString().replace(/^#/, '') || "Unknown";

        const totalSheets = (result.triangular || 0) + (result.rectangular || 0) + (result.scrap || 0);

        // Convert per-piece values to batch totals if they were extracted
        if (result.size) result.size = result.size * totalSheets;
        if (result.weight) result.weight = result.weight * totalSheets;

        // Apply ideal values if missing
        if (!result.weight || !result.size) {
          if (totalSheets > 0) {
            const isTri = result.triangular > 0;
            let propsKey = result.material as string;
            if (isTri) {
              propsKey = result.material.includes('Aluminum') ? 'Triangular Aluminum' : 'Triangular Steel';
            }
            const props = MATERIAL_PROPS[propsKey] || MATERIAL_PROPS[result.material] || MATERIAL_PROPS['Basic Steel'];
            
            if (!result.size) result.size = totalSheets * 1.0; // Assume 1m2 per sheet as ideal
            if (!result.weight) result.weight = result.size * props.density;
          }
        }
        
        setLastScan(result);
        
        // --- Inventory Validation ---
        const targetBatchNumber = (selectedBatchId 
          ? inventory.find(i => i.id === selectedBatchId)?.batchNumber 
          : result.batchNumber)?.toString().replace(/^#/, '');

        const existingBatch = inventory.find(item => 
          (selectedBatchId && item.id === selectedBatchId) ||
          (targetBatchNumber !== "Unknown" && item.batchNumber?.toString().replace(/^#/, '').trim().toLowerCase() === targetBatchNumber?.trim().toLowerCase())
        );

        if (direction === 'outbound') {
          if (!existingBatch) {
            setError(`Insufficient Resource: Batch "${targetBatchNumber || 'Unknown'}" not found in inventory.`);
            setIsScanning(false);
            return;
          }

          const missingItems = [];
          if (existingBatch.triangular < result.triangular) missingItems.push(`${result.triangular - existingBatch.triangular} more Triangular`);
          if (existingBatch.rectangular < result.rectangular) missingItems.push(`${result.rectangular - existingBatch.rectangular} more Rectangular`);
          if (existingBatch.scrap < result.scrap) missingItems.push(`${result.scrap - existingBatch.scrap} more Scrap`);

          if (missingItems.length > 0) {
            setError(`Insufficient Resource: Batch "${existingBatch.batchNumber}" is missing ${missingItems.join(', ')}.`);
            setIsScanning(false);
            return;
          }
        }

        if (direction === 'inbound' && !existingBatch && result.batchNumber === "Unknown") {
          setError("Inbound Failed: Could not identify batch number from token. Please ensure the token is clear.");
          setIsScanning(false);
          return;
        }

        // --- Calculate Recommended Cubes for Confirmation ---
        const recommendedCubes: { id: string; type: string; material: string }[] = [];
        
        if (direction === 'inbound') {
          const itemsToStore = [
            { type: 'rectangular', count: result.rectangular },
            { type: 'triangular', count: result.triangular },
            { type: 'scrap', count: result.scrap }
          ];

          // Create a temporary copy to simulate placement
          const tempStorage = storage.map(c => ({ ...c }));
          
          itemsToStore.forEach(item => {
            let placed = 0;
            for (let i = 0; i < tempStorage.length && placed < item.count; i++) {
              const cube = tempStorage[i];
              if (!cube.occupiedBy && cube.type === item.type && cube.material.trim().toLowerCase() === result.material.trim().toLowerCase()) {
                cube.occupiedBy = { vendor: result.vendor, batchNumber: result.batchNumber };
                recommendedCubes.push({ id: cube.id, type: cube.type, material: cube.material });
                placed++;
              }
            }
          });
        } else {
          // Outbound: Find cubes occupied by this batch and type
          const itemsToRemove = [
            { type: 'rectangular', count: result.rectangular },
            { type: 'triangular', count: result.triangular },
            { type: 'scrap', count: result.scrap }
          ];

          itemsToRemove.forEach(item => {
            let recommended = 0;
            for (let i = 0; i < storage.length && recommended < item.count; i++) {
              const cube = storage[i];
              const matchesBatch = cube.occupiedBy?.batchNumber?.toString().replace(/^#/, '').trim().toLowerCase() === targetBatchNumber?.trim().toLowerCase();
              if (matchesBatch && cube.type === item.type) {
                recommendedCubes.push({ id: cube.id, type: cube.type, material: cube.material });
                recommended++;
              }
            }
          });
        }

        // Update storage to show recommendations
        setStorage(prev => prev.map(cube => {
          const isRecommended = recommendedCubes.some(rc => rc.id === cube.id);
          if (isRecommended) {
            return { ...cube, recommendationType: direction };
          }
          return cube;
        }));

        setPendingTransaction({
          result,
          direction,
          targetBatchNumber: targetBatchNumber || "Unknown",
          recommendedCubes,
          imageSrc
        });
        setShowStorageMap(true);
        setShowFGMap(false);
        setShowConfirmDialog(true);
      } catch (err) {
        console.error("Scanning error:", err);
        setError(`Scanning failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      } finally {
        setIsScanning(false);
      }
    } else {
      // Finished Goods Scanning
      console.log("Starting Finished Goods scan with model:", MODEL_NAME);

      try {
        const response = await ai.models.generateContent({
          model: MODEL_NAME,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Data,
                },
              },
              {
                text: `Analyze this image of a finished good product label or token.
                
                Extract:
                - 'itemName': The name of the product.
                - 'quantity': The number of units.
                
                Return ONLY a JSON object:
                { 
                  "itemName": "string", 
                  "quantity": number
                }`,
              },
            ],
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                itemName: { type: Type.STRING },
                quantity: { type: Type.NUMBER }
              },
              required: ["itemName", "quantity"],
            },
          },
        });

        const result = JSON.parse(response.text || "{}");
        if (result.itemName && result.quantity) {
          setFgManualItemName(result.itemName);
          setFgManualQuantity(result.quantity);
          setFgManualDirection(direction);
          
          handleFGManualTransaction(result.itemName, result.quantity, direction);
        } else {
          setError("Could not extract product information from the image.");
        }
      } catch (err) {
        console.error("FG Scanning error:", err);
        setError(`Scanning failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      } finally {
        setIsScanning(false);
      }
    }
  };

  const handleConfirmTransaction = () => {
    if (!pendingTransaction) return;

    const { result, direction, targetBatchNumber, recommendedCubes, imageSrc } = pendingTransaction;

    if (direction === 'inbound') {
      // Update Inventory
      const existingBatchIndex = inventory.findIndex(item => 
        item.batchNumber.trim().toLowerCase() === result.batchNumber.trim().toLowerCase()
      );

      if (existingBatchIndex >= 0) {
        const updatedInventory = [...inventory];
        updatedInventory[existingBatchIndex] = {
          ...updatedInventory[existingBatchIndex],
          triangular: updatedInventory[existingBatchIndex].triangular + result.triangular,
          rectangular: updatedInventory[existingBatchIndex].rectangular + result.rectangular,
          scrap: updatedInventory[existingBatchIndex].scrap + result.scrap,
          weight: (updatedInventory[existingBatchIndex].weight || 0) + (result.weight || 0),
          size: (updatedInventory[existingBatchIndex].size || 0) + (result.size || 0),
          lastUpdated: new Date()
        };
        setInventory(updatedInventory);
      } else {
        setInventory(prev => [...prev, {
          ...result,
          id: Math.random().toString(36).substr(2, 9),
          lastUpdated: new Date()
        }]);
      }

      // Update Storage
      setStorage(prev => prev.map(cube => {
        const recommended = recommendedCubes.find(rc => rc.id === cube.id);
        if (recommended) {
          return {
            ...cube,
            occupiedBy: { vendor: result.vendor, batchNumber: result.batchNumber },
            recommendationType: null
          };
        }
        return cube;
      }));

      // Auto-switch to 3D view to show the update
      setShowStorageMap(true);
      setShowFGMap(false);
      setActiveTab('inventory');
    } else {
      // Outbound
      const existingBatchIndex = inventory.findIndex(item => 
        item.batchNumber.trim().toLowerCase() === targetBatchNumber.trim().toLowerCase()
      );

      if (existingBatchIndex >= 0) {
        const updatedInventory = [...inventory];
        const item = updatedInventory[existingBatchIndex];
        
        item.triangular -= result.triangular;
        item.rectangular -= result.rectangular;
        item.scrap -= result.scrap;
        
        if (result.weight) item.weight = Math.max(0, (item.weight || 0) - result.weight);
        if (result.size) item.size = Math.max(0, (item.size || 0) - result.size);

        if (item.triangular <= 0 && item.rectangular <= 0 && item.scrap <= 0) {
          updatedInventory.splice(existingBatchIndex, 1);
        } else {
          item.lastUpdated = new Date();
        }
        setInventory(updatedInventory);
      }

      // Update Storage
      setStorage(prev => prev.map(cube => {
        const recommended = recommendedCubes.find(rc => rc.id === cube.id);
        if (recommended) {
          return {
            ...cube,
            occupiedBy: null,
            recommendationType: null
          };
        }
        return cube;
      }));

      // Auto-switch to 3D view to show the update
      setShowStorageMap(true);
      setShowFGMap(false);
      setActiveTab('inventory');
    }

    // Add to logs
    setLogs(prev => [{
      ...result,
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date(),
      direction,
      imageUrl: imageSrc
    }, ...prev]);

    setPendingTransaction(null);
    setShowConfirmDialog(false);
    setUploadedImage(null);
    setLastScan(null);
  };

  const handleStartProduction = () => {
    setProductionError(null);
    setProductionSuccess(null);

    if (!prodItemName || prodWeightGrams <= 0 || prodQuantity <= 0) {
      setProductionError("Please fill in all production details.");
      return;
    }

    const totalWeightNeededKg = (prodWeightGrams * prodQuantity) / 1000;
    
    // Find suitable raw materials
    const suitableMaterials = inventory.filter(item => item.material === prodMaterial);
    
    // Sort to prioritize batches that have scrap pieces first, then by weight
    const sortedMaterials = [...suitableMaterials].sort((a, b) => {
      // Prioritize batches with scrap
      if (a.scrap > 0 && b.scrap === 0) return -1;
      if (a.scrap === 0 && b.scrap > 0) return 1;
      // If both have scrap or both don't, sort by weight (smaller first to use up small pieces)
      return (a.weight || 0) - (b.weight || 0);
    });

    const totalAvailableWeight = sortedMaterials.reduce((sum, item) => sum + (item.weight || 0), 0);

    if (totalAvailableWeight < totalWeightNeededKg) {
      setProductionError(`Insufficient raw material. Need ${totalWeightNeededKg.toFixed(2)}kg of ${prodMaterial}, but only ${totalAvailableWeight.toFixed(2)}kg available across ${suitableMaterials.length} batches.`);
      return;
    }

    const newBatchNumber = `PROD-${Date.now()}`;

    // Check for space in FG storage
    const propsKey = prodMaterial;
    const itemVolume = totalWeightNeededKg / (MATERIAL_PROPS[propsKey]?.density || 8);
    const compartmentVolume = 1.0; // 1m3
    const maxVolumePerCompartment = compartmentVolume * 0.7;

    let remainingVolumeToStore = itemVolume;
    const assignedCubes: string[] = [];
    const tempFgStorage = [...fgStorage];

    for (let i = 0; i < tempFgStorage.length && remainingVolumeToStore > 0; i++) {
      const cube = tempFgStorage[i];
      const currentVolume = cube.occupiedBy?.volume || 0;
      const availableSpace = maxVolumePerCompartment - currentVolume;

      if (availableSpace > 0) {
        const volumeToPut = Math.min(availableSpace, remainingVolumeToStore);
        const quantityForThisCube = Math.round(prodQuantity * (volumeToPut / itemVolume));
        cube.occupiedBy = {
          vendor: "Internal Production",
          batchNumber: newBatchNumber,
          itemName: prodItemName,
          quantity: quantityForThisCube,
          volume: currentVolume + volumeToPut
        };
        assignedCubes.push(cube.id);
        remainingVolumeToStore -= volumeToPut;
      }
    }

    if (remainingVolumeToStore > 0) {
      setProductionError("Insufficient space in Finished Goods storage.");
      return;
    }

    // Deduct from inventory and handle scrap
    let weightDeducted = 0;
    const updatedInventory = [...inventory];
    const consumptionLogs: InventoryLog[] = [];
    const storageUpdates: { batchNumber: string, type: 'clear' | 'move_to_scrap', updatedItem?: any, scrapWeight?: number }[] = [];

    // Use sortedMaterials logic to deduct
    for (const mat of sortedMaterials) {
      if (weightDeducted >= totalWeightNeededKg) break;

      const invIndex = updatedInventory.findIndex(item => item.id === mat.id);
      if (invIndex === -1) continue;

      const item = updatedInventory[invIndex];
      const itemWeight = item.weight || 0;
      const weightToTake = Math.min(itemWeight, totalWeightNeededKg - weightDeducted);
      
      const totalSheets = (item.rectangular || 0) + (item.triangular || 0) + (item.scrap || 0);
      const weightPerSheet = totalSheets > 0 ? itemWeight / totalSheets : 0;

      if (Math.abs(weightToTake - itemWeight) < 0.001) {
        // Use entire item/batch - clear all its sectors
        updatedInventory.splice(invIndex, 1);
        weightDeducted += itemWeight;
        
        consumptionLogs.push({
          id: Math.random().toString(36).substr(2, 9),
          vendor: item.vendor,
          material: item.material,
          batchNumber: item.batchNumber,
          triangular: item.triangular,
          rectangular: item.rectangular,
          scrap: item.scrap,
          weight: itemWeight,
          timestamp: new Date(),
          direction: 'outbound',
          type: 'production',
          message: `Consumed for ${prodItemName}`
        });

        // Add a clear update for every sheet in this batch
        for (let i = 0; i < totalSheets; i++) {
          storageUpdates.push({ batchNumber: item.batchNumber, type: 'clear' });
        }
      } else {
        // Partial use - determine how many sheets are fully consumed and if one becomes scrap
        const fullSheetsConsumed = weightPerSheet > 0 ? Math.floor(weightToTake / weightPerSheet) : 0;
        const remainderWeightFromPartialSheet = weightToTake - (fullSheetsConsumed * weightPerSheet);
        
        const actualScrapWeight = remainderWeightFromPartialSheet > 0 ? weightPerSheet - remainderWeightFromPartialSheet : 0;
        const remainingFullSheetsWeight = itemWeight - weightToTake - actualScrapWeight;
        
        // Update original inventory item (only full sheets left)
        const updatedItem = {
          ...item,
          weight: remainingFullSheetsWeight,
          size: (item.size || 0) * (remainingFullSheetsWeight / itemWeight),
          rectangular: Math.max(0, item.rectangular - (item.rectangular > 0 ? fullSheetsConsumed + (remainderWeightFromPartialSheet > 0 ? 1 : 0) : 0)),
          triangular: Math.max(0, item.triangular - (item.triangular > 0 && item.rectangular === 0 ? fullSheetsConsumed + (remainderWeightFromPartialSheet > 0 ? 1 : 0) : 0)),
          lastUpdated: new Date()
        };
        
        if (updatedItem.weight <= 0.001) {
          updatedInventory.splice(invIndex, 1);
        } else {
          updatedInventory[invIndex] = updatedItem;
        }
        
        weightDeducted += weightToTake;

        consumptionLogs.push({
          id: Math.random().toString(36).substr(2, 9),
          vendor: item.vendor,
          material: item.material,
          batchNumber: item.batchNumber,
          triangular: 0,
          rectangular: 0,
          scrap: 0,
          weight: weightToTake,
          timestamp: new Date(),
          direction: 'outbound',
          type: 'production',
          message: `Consumed for ${prodItemName}`
        });

        // Clear the fully consumed sheets
        for (let i = 0; i < fullSheetsConsumed; i++) {
          storageUpdates.push({ batchNumber: item.batchNumber, type: 'clear' });
        }
        
        // If there's a partial sheet, move it to scrap
        if (remainderWeightFromPartialSheet > 0) {
          const newScrapItem: InventoryItem = {
            id: Math.random().toString(36).substr(2, 9),
            vendor: item.vendor,
            material: item.material,
            batchNumber: `${item.batchNumber}-SCRAP`,
            triangular: 0,
            rectangular: 0,
            scrap: 1,
            size: (item.size || 0) * (actualScrapWeight / itemWeight),
            weight: actualScrapWeight,
            lastUpdated: new Date()
          };
          updatedInventory.push(newScrapItem);
          storageUpdates.push({ batchNumber: item.batchNumber, type: 'move_to_scrap', updatedItem: newScrapItem, scrapWeight: actualScrapWeight });
        }
      }
    }
    
    // Set pending production instead of applying immediately
    setPendingProduction({
      itemName: prodItemName,
      material: prodMaterial,
      weightPerItem: prodWeightGrams,
      quantity: prodQuantity,
      totalWeightNeededKg,
      assignedCubes,
      updatedInventory,
      storageUpdates,
      tempFgStorage,
      consumptionLogs,
      newBatchNumber
    });
  };

  const handleConfirmProduction = () => {
    if (!pendingProduction) return;

    const { 
      itemName, 
      material, 
      weightPerItem, 
      quantity, 
      updatedInventory, 
      storageUpdates, 
      tempFgStorage, 
      consumptionLogs, 
      newBatchNumber 
    } = pendingProduction;

    // Apply storage updates
    setStorage(prev => {
      const nextStorage = [...prev];
      for (const update of storageUpdates) {
        // Find original location
        const originalCubeIndex = nextStorage.findIndex(c => c.occupiedBy?.batchNumber === update.batchNumber);
        if (originalCubeIndex !== -1) {
          nextStorage[originalCubeIndex] = { ...nextStorage[originalCubeIndex], occupiedBy: null };
        }

        if (update.type === 'move_to_scrap' && update.updatedItem) {
          // Find empty scrap section, prioritizing matching material type
          let scrapCubeIndex = nextStorage.findIndex(c => 
            c.type === 'scrap' && 
            c.occupiedBy === null && 
            c.material === update.updatedItem.material
          );
          
          // Fallback to any empty scrap section if no matching material section is free
          if (scrapCubeIndex === -1) {
            scrapCubeIndex = nextStorage.findIndex(c => c.type === 'scrap' && c.occupiedBy === null);
          }

          if (scrapCubeIndex !== -1) {
            nextStorage[scrapCubeIndex] = {
              ...nextStorage[scrapCubeIndex],
              occupiedBy: {
                vendor: update.updatedItem.vendor,
                batchNumber: update.updatedItem.batchNumber,
                itemName: update.updatedItem.material + " Scrap",
                quantity: update.scrapWeight || 0.1,
                volume: 0.1
              }
            };
          }
        }
      }
      return nextStorage;
    });

    setInventory(updatedInventory);
    setFgStorage(tempFgStorage);
    
    setFinishedGoods(prev => [...prev, {
      id: Math.random().toString(36).substr(2, 9),
      itemName,
      material,
      weightPerItem,
      quantity,
      batchNumber: newBatchNumber,
      timestamp: new Date()
    }]);

    // Add to logs
    setLogs(prev => [
      {
        id: Math.random().toString(36).substr(2, 9),
        vendor: "Internal Production",
        material,
        batchNumber: newBatchNumber,
        triangular: 0,
        rectangular: quantity,
        scrap: 0,
        weight: (weightPerItem * quantity) / 1000,
        timestamp: new Date(),
        direction: 'inbound',
        type: 'production',
        message: `Produced ${quantity}x ${itemName}`
      },
      ...consumptionLogs,
      ...prev
    ]);

    setProductionSuccess(`Successfully produced ${quantity}x ${itemName}.`);
    setPendingProduction(null);
    setProdItemName('');
    setProdWeightGrams(0);
    setProdQuantity(1);

    setTimeout(() => setProductionSuccess(""), 5000);
  };

  const handleOutboundFG = (fg: FinishedGood) => {
    // Confirmation dialog for FG outbound
    const cubes = fgStorage.filter(c => c.occupiedBy?.batchNumber === fg.batchNumber);
    
    const storageUpdates = cubes.map(c => ({
      cubeId: c.id,
      quantityTaken: c.occupiedBy?.quantity || 0,
      remainingQuantity: 0,
      batchNumber: fg.batchNumber
    }));

    setPendingFGOutbound({
      itemName: fg.itemName,
      quantity: fg.quantity,
      storageUpdates,
      updatedFG: finishedGoods.filter(f => f.batchNumber !== fg.batchNumber)
    });

    // Highlight the cubes in FG storage
    setFgStorage(prev => prev.map(c => 
      c.occupiedBy?.batchNumber === fg.batchNumber ? { ...c, recommendationType: 'outbound' } : c
    ));

    setShowStorageMap(true);
    setShowFGMap(true);
    setShowConfirmDialog(true);
  };

  const handleConfirmFGOutbound = () => {
    if (!pendingFGOutbound) return;
    const { itemName, quantity, storageUpdates, updatedFG } = pendingFGOutbound;

    setFgStorage(prev => prev.map(c => {
      const update = storageUpdates.find(u => u.cubeId === c.id);
      if (update) {
        if (update.remainingQuantity <= 0) {
          return { ...c, occupiedBy: null, recommendationType: null };
        } else {
          const originalQty = c.occupiedBy!.quantity;
          const originalVol = c.occupiedBy!.volume;
          const newVol = originalQty > 0 ? originalVol * (update.remainingQuantity / originalQty) : originalVol;
          return { 
            ...c, 
            occupiedBy: { ...c.occupiedBy!, quantity: update.remainingQuantity, volume: newVol },
            recommendationType: null 
          };
        }
      }
      return c;
    }));

    setFinishedGoods(updatedFG);
    setFgSuccess(`Successfully dispatched ${quantity}x ${itemName}.`);
    
    // Add to logs
    setLogs(prev => [
      {
        id: Math.random().toString(36).substr(2, 9),
        vendor: "Internal",
        material: "Finished Good",
        batchNumber: `OUT-${Date.now()}`,
        triangular: 0,
        rectangular: 0,
        scrap: 0,
        weight: 0,
        timestamp: new Date(),
        direction: 'outbound',
        type: 'production',
        message: `Manual dispatch: ${quantity}x ${itemName}`
      },
      ...prev
    ]);

    setFgManualItemName('');
    setFgManualQuantity(1);
    setPendingFGOutbound(null);
    setShowConfirmDialog(false);
    setShowStorageMap(true);
    setShowFGMap(true);
    setActiveTab('finished');
  };

  const handleFGManualTransaction = (overrideItemName?: string, overrideQuantity?: number, overrideDirection?: 'inbound' | 'outbound') => {
    const itemName = overrideItemName || fgManualItemName;
    const quantity = overrideQuantity || fgManualQuantity;
    const directionToUse = overrideDirection || fgManualDirection;

    setFgError(null);
    setFgSuccess(null);

    if (!itemName || quantity <= 0) {
      setFgError("Please enter item name and quantity.");
      return;
    }

    if (directionToUse === 'outbound') {
      const totalAvailable = finishedGoods
        .filter(fg => fg.itemName.toLowerCase() === itemName.toLowerCase())
        .reduce((sum, fg) => sum + fg.quantity, 0);

      if (totalAvailable < quantity) {
        setFgError(`Insufficient inventory. Only ${totalAvailable} units of "${itemName}" available.`);
        return;
      }

      // Deduct from finishedGoods
      let remainingToDeduct = quantity;
      const updatedFG = [...finishedGoods];
      const storageUpdates: { cubeId: string, quantityTaken: number, remainingQuantity: number, batchNumber: string }[] = [];
      
      // Sort by timestamp to outbound oldest first (FIFO)
      const matchingIndices = updatedFG
        .map((fg, idx) => ({ ...fg, idx }))
        .filter(fg => fg.itemName.toLowerCase() === itemName.toLowerCase())
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .map(fg => fg.idx);

      const maxVolumePerCompartment = 0.7; // 1m3 * 0.7

      for (const idx of matchingIndices) {
        if (remainingToDeduct <= 0) break;
        const fg = updatedFG[idx];
        const toTake = Math.min(fg.quantity, remainingToDeduct);
        
        // Find all storage cubes for this batch
        const cubes = fgStorage.filter(c => c.occupiedBy?.batchNumber === fg.batchNumber);
        const totalBatchQuantity = fg.quantity;
        const remainingBatchQuantity = totalBatchQuantity - toTake;
        
        // Calculate how many cubes the REMAINDER should occupy if consolidated
        // We need to know weightPerItem to calculate volume
        const weightPerItem = fg.weightPerItem || 100; // fallback
        const propsKey = fg.material;
        const totalRemainderVolume = (remainingBatchQuantity * weightPerItem / 1000) / (MATERIAL_PROPS[propsKey]?.density || 8);
        
        // Mark all current cubes for this batch as "taken from" or "cleared"
        // To implement "empty one section at a time", we'll clear cubes one by one
        let batchRemainingToDeductFromStorage = toTake;
        
        // Sort cubes by quantity (ascending) to empty smaller ones first, or just iterate
        for (const cube of cubes) {
          const cubeQty = cube.occupiedBy?.quantity || 0;
          if (cubeQty === 0) continue;
          
          const takeFromCube = Math.min(cubeQty, batchRemainingToDeductFromStorage);
          
          storageUpdates.push({
            cubeId: cube.id,
            quantityTaken: takeFromCube,
            remainingQuantity: cubeQty - takeFromCube,
            batchNumber: fg.batchNumber
          });
          
          batchRemainingToDeductFromStorage -= takeFromCube;
          if (batchRemainingToDeductFromStorage <= 0) break;
        }

        if (toTake === fg.quantity) {
          updatedFG[idx].quantity = 0; // Mark for removal
        } else {
          updatedFG[idx].quantity -= toTake;
        }
        remainingToDeduct -= toTake;
      }

      setPendingFGOutbound({
        itemName,
        quantity,
        storageUpdates,
        updatedFG: updatedFG.filter(fg => fg.quantity > 0)
      });

      // Highlight the cubes in FG storage
      setFgStorage(prev => prev.map(c => {
        const update = storageUpdates.find(u => u.cubeId === c.id);
        return update ? { ...c, recommendationType: 'outbound' } : c;
      }));

      setShowStorageMap(true);
      setShowFGMap(true);
      setShowConfirmDialog(true);
    } else {
      // Manual Inbound
      const newBatchNumber = `MANUAL-${Date.now()}`;
      const newFG: FinishedGood = {
        id: Math.random().toString(36).substr(2, 9),
        itemName,
        material: "Basic Steel",
        weightPerItem: 100, // Default weight for volume calculation
        quantity,
        batchNumber: newBatchNumber,
        timestamp: new Date()
      };
      
      // Calculate storage for manual inbound
      const propsKey = newFG.material;
      const itemVolume = (newFG.weightPerItem * newFG.quantity / 1000) / (MATERIAL_PROPS[propsKey]?.density || 8);
      const maxVolumePerCompartment = 0.7;
      let remainingVolumeToStore = itemVolume;
      const tempFgStorage = [...fgStorage];
      
      for (let i = 0; i < tempFgStorage.length && remainingVolumeToStore > 0; i++) {
        const cube = tempFgStorage[i];
        const currentVolume = cube.occupiedBy?.volume || 0;
        const availableSpace = maxVolumePerCompartment - currentVolume;

        if (availableSpace > 0) {
          const volumeToPut = Math.min(availableSpace, remainingVolumeToStore);
          const quantityForThisCube = Math.round(quantity * (volumeToPut / itemVolume));
          cube.occupiedBy = {
            vendor: "Internal Production",
            batchNumber: newBatchNumber,
            itemName: newFG.itemName,
            quantity: quantityForThisCube,
            volume: currentVolume + volumeToPut
          };
          remainingVolumeToStore -= volumeToPut;
        }
      }

      if (remainingVolumeToStore > 0) {
        setFgError("Insufficient space in Finished Goods storage for this inbound.");
        return;
      }

      setFgStorage(tempFgStorage);
      setFinishedGoods(prev => [...prev, newFG]);
      setFgSuccess(`Successfully added ${quantity}x ${itemName} to inventory.`);
      
      // Add to logs
      setLogs(prev => [
        {
          id: Math.random().toString(36).substr(2, 9),
          vendor: "Internal",
          material: "Finished Good",
          batchNumber: newFG.batchNumber,
          triangular: 0,
          rectangular: quantity,
          scrap: 0,
          weight: 0,
          timestamp: new Date(),
          direction: 'inbound',
          type: 'production',
          message: `Manual inbound: ${quantity}x ${itemName}`
        },
        ...prev
      ]);
      
      if (!overrideItemName) setFgManualItemName('');
      if (!overrideQuantity) setFgManualQuantity(1);
      setTimeout(() => {
        setFgError(null);
        setFgSuccess(null);
      }, 5000);
    }
  };

  const handleCancelTransaction = () => {
    // Clear recommendations from storage
    setStorage(prev => prev.map(c => ({ ...c, recommendationType: null })));
    setFgStorage(prev => prev.map(c => ({ ...c, recommendationType: null })));
    setPendingTransaction(null);
    setPendingProduction(null);
    setPendingFGOutbound(null);
    setShowConfirmDialog(false);
    setShowStorageMap(false);
  };

  const clearInventory = () => {
    if (window.confirm("Are you sure you want to clear the entire inventory?")) {
      setInventory([]);
      setLogs([]);
      setLastScan(null);
    }
  };

  // --- Derived Stats ---
  const totalRect = inventory.reduce((acc, curr) => acc + curr.rectangular, 0);
  const totalTri = inventory.reduce((acc, curr) => acc + curr.triangular, 0);
  const totalScrap = inventory.reduce((acc, curr) => acc + curr.scrap, 0);
  const totalUnits = totalRect + totalTri + totalScrap;

  return (
    <div className="min-h-screen bg-[#020408] text-slate-200 font-sans selection:bg-blue-500/30">
      
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#020408]/80 backdrop-blur-xl border-b border-white/5 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20">
              <Box className="text-white w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tighter text-white leading-none">STEEL<span className="text-blue-500">FLOW</span></h1>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em] mt-1">Inventory & Production OS</p>
            </div>
          </div>

          <nav className="hidden md:flex items-center bg-slate-900/50 border border-white/5 p-1 rounded-2xl">
            <button 
              onClick={() => setActiveTab('inventory')}
              className={cn(
                "px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all",
                activeTab === 'inventory' ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20" : "text-slate-500 hover:text-slate-300"
              )}
            >
              Inventory
            </button>
            <button 
              onClick={() => setActiveTab('production')}
              className={cn(
                "px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all",
                activeTab === 'production' ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20" : "text-slate-500 hover:text-slate-300"
              )}
            >
              Production
            </button>
            <button 
              onClick={() => setActiveTab('finished')}
              className={cn(
                "px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all",
                activeTab === 'finished' ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20" : "text-slate-500 hover:text-slate-300"
              )}
            >
              Finished Goods
            </button>
          </nav>

          <div className="flex items-center gap-3">
            <div className="flex flex-col items-end mr-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">System Status</span>
              <span className="text-[10px] font-bold text-green-500 uppercase tracking-widest flex items-center gap-1">
                <div className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />
                Operational
              </span>
            </div>
            <button 
              onClick={() => setShowHistory(!showHistory)}
              className="p-2.5 bg-slate-900 border border-white/5 rounded-xl hover:bg-slate-800 transition-all text-slate-400 hover:text-white"
            >
              <History className="w-5 h-5" />
            </button>
            <button 
              onClick={() => setCameraEnabled(!cameraEnabled)}
              className={cn(
                "p-2.5 border rounded-xl transition-all",
                cameraEnabled ? "bg-blue-600/10 border-blue-500/30 text-blue-400" : "bg-red-600/10 border-red-500/30 text-red-400"
              )}
            >
              {cameraEnabled ? <Camera className="w-5 h-5" /> : <CameraOff className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 lg:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Camera & Controls */}
        <div className="lg:col-span-8 space-y-6">
          
          {activeTab === 'inventory' ? (
            <>
              {/* Main Viewport Container */}
              <div className="relative aspect-video bg-[#050505] rounded-3xl overflow-hidden border border-slate-800 shadow-2xl group">
                <AnimatePresence mode="wait">
                  {showStorageMap ? (
                    <motion.div 
                      key="storage-map"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 1.05 }}
                      className="absolute inset-0 bg-[#0a0c10]"
                    >
                      <Canvas shadows dpr={[1, 2]}>
                        <PerspectiveCamera makeDefault position={[8, 8, 8]} fov={40} />
                        <OrbitControls 
                          enablePan={false} 
                          minDistance={5} 
                          maxDistance={15} 
                          maxPolarAngle={Math.PI / 2.1} 
                        />
                        <ambientLight intensity={0.5} />
                        <pointLight position={[10, 10, 10]} intensity={1} />
                        <spotLight position={[-10, 10, 10]} angle={0.15} penumbra={1} intensity={1} castShadow />
                        
                        <StorageMap storage={showFGMap ? fgStorage : storage} onHover={setHoveredCube} isFG={showFGMap} />
                        
                        <Environment preset="city" />
                        <ContactShadows position={[0, -0.6, 0]} opacity={0.4} scale={20} blur={2} far={4.5} />
                      </Canvas>

                      {/* 3D UI Overlays */}
                      <div className="absolute top-6 left-6 flex flex-col gap-2 pointer-events-none">
                        <div className="bg-black/60 backdrop-blur-md border border-white/10 p-1 rounded-xl pointer-events-auto">
                          <div className="flex gap-1">
                            <button 
                              onClick={() => setShowFGMap(false)}
                              className={cn(
                                "px-3 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-widest transition-all",
                                !showFGMap ? "bg-blue-600 text-white" : "text-slate-500 hover:text-slate-300"
                              )}
                            >
                              Raw Materials
                            </button>
                            <button 
                              onClick={() => setShowFGMap(true)}
                              className={cn(
                                "px-3 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-widest transition-all",
                                showFGMap ? "bg-blue-600 text-white" : "text-slate-500 hover:text-slate-300"
                              )}
                            >
                              Finished Goods
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="absolute top-6 right-6 flex flex-col items-end gap-2 pointer-events-none">
                        <div className="bg-black/60 backdrop-blur-md border border-white/10 p-3 rounded-xl">
                          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Storage Status</p>
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-4">
                              <div className="flex items-center gap-1.5">
                                <div className="w-2 h-2 rounded-full bg-[#10b981]" />
                                <span className="text-[10px] text-white uppercase font-bold">Store (In)</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <div className="w-2 h-2 rounded-full bg-[#f59e0b]" />
                                <span className="text-[10px] text-white uppercase font-bold">Pick (Out)</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-4">
                              <div className="flex items-center gap-1.5">
                                <div className="w-2 h-2 rounded-full bg-[#ef4444]" />
                                <span className="text-[10px] text-white uppercase font-bold">Occupied</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <div className="w-2 h-2 rounded-full bg-slate-700" />
                                <span className="text-[10px] text-white uppercase font-bold">Empty</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Hover Info Tooltip */}
                      <AnimatePresence>
                        {hoveredCube && (
                          <motion.div 
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 10 }}
                            className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-black/80 backdrop-blur-xl border border-blue-500/30 p-4 rounded-2xl min-w-[240px] shadow-2xl z-20"
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-blue-400 font-black text-sm tracking-tighter">{hoveredCube.id}</span>
                              <span className={cn(
                                "px-2 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider",
                                hoveredCube.occupiedBy ? "bg-red-500/20 text-red-400" : "bg-green-500/20 text-green-400"
                              )}>
                                {hoveredCube.occupiedBy ? "Occupied" : "Available"}
                              </span>
                            </div>
                            <div className="space-y-2">
                              <div className="flex justify-between text-[10px]">
                                <span className="text-slate-500 uppercase font-bold">Sector</span>
                                <span className="text-white font-bold uppercase">{hoveredCube.type} {hoveredCube.material}</span>
                              </div>
                              {hoveredCube.occupiedBy && (
                                <>
                                  <div className="h-px bg-white/10 my-2" />
                                  <div className="flex justify-between text-[10px]">
                                    <span className="text-slate-500 uppercase font-bold">Batch</span>
                                    <span className="text-blue-400 font-bold">#{hoveredCube.occupiedBy.batchNumber}</span>
                                  </div>
                                  {hoveredCube.occupiedBy.itemName && (
                                    <div className="flex justify-between text-[10px]">
                                      <span className="text-slate-500 uppercase font-bold">Item</span>
                                      <span className="text-white font-bold">{hoveredCube.occupiedBy.itemName}</span>
                                    </div>
                                  )}
                                  {hoveredCube.occupiedBy.volume !== undefined && (
                                    <div className="flex justify-between text-[10px]">
                                      <span className="text-slate-500 uppercase font-bold">Volume</span>
                                      <span className="text-white font-bold">{(hoveredCube.occupiedBy.volume * 100).toFixed(0)}%</span>
                                    </div>
                                  )}
                                  <div className="flex justify-between text-[10px]">
                                    <span className="text-slate-500 uppercase font-bold">Vendor</span>
                                    <span className="text-white font-bold">{hoveredCube.occupiedBy.vendor}</span>
                                  </div>
                                </>
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <div className="absolute bottom-6 right-6 flex gap-2">
                        <button 
                          onClick={() => setShowInventoryList(true)}
                          className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg shadow-blue-500/20"
                        >
                          <Database className="w-4 h-4" />
                          Inventory List
                        </button>
                        <button 
                          onClick={() => setShowStorageMap(false)}
                          className="bg-slate-800/80 hover:bg-slate-700 text-white px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all border border-slate-700"
                        >
                          <Camera className="w-4 h-4" />
                          Back to Scanner
                        </button>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div 
                      key="scanner-view"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="absolute inset-0"
                    >
                      {uploadedImage ? (
                        <div className="absolute inset-0 bg-slate-900 flex items-center justify-center p-4">
                          <img src={uploadedImage} alt="Uploaded" className="max-w-full max-h-full object-contain rounded-xl shadow-lg" />
                          <button 
                            onClick={() => setUploadedImage(null)}
                            className="absolute top-4 right-4 p-2 bg-red-500/80 hover:bg-red-500 text-white rounded-full transition-all"
                          >
                            <X className="w-5 h-5" />
                          </button>
                        </div>
                      ) : cameraEnabled ? (
                        <Webcam
                          audio={false}
                          ref={webcamRef}
                          screenshotFormat="image/jpeg"
                          className={cn(
                            "w-full h-full object-cover transition-opacity duration-700",
                            cameraReady ? "opacity-100" : "opacity-0"
                          )}
                          videoConstraints={{ 
                            width: 1280,
                            height: 720,
                            facingMode: { ideal: "environment" } 
                          }}
                          disablePictureInPicture={false}
                          forceScreenshotSourceSize={false}
                          imageSmoothing={true}
                          mirrored={false}
                          screenshotQuality={0.92}
                          onUserMedia={() => setCameraReady(true)}
                          onUserMediaError={(err) => {
                            console.error("Camera Error:", err);
                            setError("Camera access denied or not found. Please ensure permissions are granted.");
                          }}
                        />
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/80 backdrop-blur-sm">
                          <div className="w-20 h-20 bg-slate-800 rounded-3xl flex items-center justify-center mb-4">
                            <CameraOff className="w-10 h-10 text-slate-600" />
                          </div>
                          <p className="text-slate-400 font-black uppercase tracking-[0.2em] text-xs">Scanner Offline</p>
                          <p className="text-slate-600 text-[10px] mt-2">Enable camera or upload image to begin</p>
                          <div className="flex gap-3 mt-8">
                            <button 
                              onClick={() => setCameraEnabled(true)}
                              className="px-6 py-2.5 bg-blue-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20"
                            >
                              Enable Camera
                            </button>
                            <button 
                              onClick={() => fileInputRef.current?.click()}
                              className="px-6 py-2.5 bg-slate-800 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-slate-700 transition-all border border-slate-700"
                            >
                              Upload Image
                            </button>
                          </div>
                        </div>
                      )}
                      
                      {/* Loading Placeholder */}
                      {cameraEnabled && !cameraReady && !error && !uploadedImage && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/50 backdrop-blur-sm">
                          <Loader2 className="w-10 h-10 text-blue-500 animate-spin mb-4" />
                          <p className="text-slate-400 text-sm font-medium animate-pulse">Initializing Scanner...</p>
                        </div>
                      )}

                      {/* Overlay Grid */}
                      <div className="absolute inset-0 pointer-events-none">
                        <div className="absolute top-8 left-8 w-8 h-8 border-t-2 border-l-2 border-blue-500/50 rounded-tl-lg" />
                        <div className="absolute top-8 right-8 w-8 h-8 border-t-2 border-r-2 border-blue-500/50 rounded-tr-lg" />
                        <div className="absolute bottom-8 left-8 w-8 h-8 border-b-2 border-l-2 border-blue-500/50 rounded-bl-lg" />
                        <div className="absolute bottom-8 right-8 w-8 h-8 border-b-2 border-r-2 border-blue-500/50 rounded-br-lg" />
                      </div>

                      {/* Scanning Animation */}
                      <AnimatePresence>
                        {isScanning && (
                          <motion.div 
                            initial={{ top: 0 }}
                            animate={{ top: '100%' }}
                            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                            className="absolute left-0 right-0 h-1 bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.8)] z-10"
                          />
                        )}
                      </AnimatePresence>

                      {/* Status Badge */}
                      <div className="absolute top-6 left-6 flex items-center gap-2">
                        <div className={cn(
                          "w-2 h-2 rounded-full animate-pulse",
                          isScanning ? "bg-blue-500" : (cameraEnabled || uploadedImage) ? "bg-green-500" : "bg-red-500"
                        )} />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-white drop-shadow-md">
                          {isScanning ? "Analyzing Batch & Token..." : (cameraEnabled || uploadedImage) ? "Scanner Ready" : "Scanner Offline"}
                        </span>
                      </div>

                      {/* Direction Indicator Overlay */}
                      <div className="absolute inset-y-0 flex items-center justify-between px-8 pointer-events-none">
                        <motion.div 
                          animate={{ x: direction === 'inbound' ? 0 : -20, opacity: direction === 'inbound' ? 1 : 0.2 }}
                          className="bg-black/40 backdrop-blur-sm p-4 rounded-2xl border border-white/10"
                        >
                          <ArrowRight className="w-8 h-8 text-green-400" />
                        </motion.div>
                        <motion.div 
                          animate={{ x: direction === 'outbound' ? 0 : 20, opacity: direction === 'outbound' ? 1 : 0.2 }}
                          className="bg-black/40 backdrop-blur-sm p-4 rounded-2xl border border-white/10"
                        >
                          <ArrowLeft className="w-8 h-8 text-red-400" />
                        </motion.div>
                      </div>

                      <div className="absolute bottom-6 right-6 flex gap-2">
                        <button 
                          onClick={() => setShowInventoryList(true)}
                          className="bg-slate-800/80 hover:bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg border border-white/10"
                        >
                          <Database className="w-4 h-4 text-blue-400" />
                          Inventory List
                        </button>
                        <button 
                          onClick={() => setShowStorageMap(true)}
                          className="bg-blue-600/80 hover:bg-blue-600 text-white px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg"
                        >
                          <LayoutGrid className="w-4 h-4" />
                          View 3D Storage
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Inventory Dataset Summary (Always visible in Inventory tab) */}
              <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-4">
                    <h3 className="text-sm font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
                      <Database className="w-4 h-4 text-blue-500" />
                      {inventoryType === 'raw' ? 'Raw Material Inventory' : 'Finished Goods Inventory'}
                    </h3>
                    <div className="flex bg-slate-800 rounded-lg p-1">
                      <button 
                        onClick={() => setInventoryType('raw')}
                        className={cn(
                          "px-3 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest transition-all",
                          inventoryType === 'raw' ? "bg-blue-600 text-white" : "text-slate-500 hover:text-slate-300"
                        )}
                      >
                        Raw
                      </button>
                      <button 
                        onClick={() => setInventoryType('finished')}
                        className={cn(
                          "px-3 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest transition-all",
                          inventoryType === 'finished' ? "bg-blue-600 text-white" : "text-slate-500 hover:text-slate-300"
                        )}
                      >
                        FG
                      </button>
                    </div>
                  </div>
                  <button 
                    onClick={() => setShowInventoryList(true)}
                    className="text-[10px] font-bold text-blue-400 hover:text-blue-300 uppercase tracking-widest"
                  >
                    View Full Details
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-800">
                        <th className="pb-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                          {inventoryType === 'raw' ? 'Batch' : 'Item Name'}
                        </th>
                        <th className="pb-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Material</th>
                        {inventoryType === 'raw' ? (
                          <>
                            <th className="pb-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Rect</th>
                            <th className="pb-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Tri</th>
                            <th className="pb-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Scrap</th>
                          </>
                        ) : (
                          <th className="pb-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Quantity</th>
                        )}
                        <th className="pb-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                          {inventoryType === 'raw' ? 'Weight' : 'Batch'}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {inventoryType === 'raw' ? (
                        inventory.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-8 text-center text-slate-600 text-[10px] font-bold uppercase tracking-widest">
                              No raw material inventory data
                            </td>
                          </tr>
                        ) : (
                          inventory.slice(0, 5).map((item) => (
                            <tr key={item.id} className="hover:bg-white/5 transition-colors">
                              <td className="py-3 text-[10px] font-bold text-blue-400">#{item.batchNumber}</td>
                              <td className="py-3 text-[10px] font-bold text-white uppercase">{item.material}</td>
                              <td className="py-3 text-[10px] font-bold text-white">{item.rectangular}</td>
                              <td className="py-3 text-[10px] font-bold text-white">{item.triangular}</td>
                              <td className="py-3 text-[10px] font-bold text-white">{item.scrap}</td>
                              <td className="py-3 text-[10px] font-bold text-white">{item.weight?.toFixed(1)} kg</td>
                            </tr>
                          ))
                        )
                      ) : (
                        finishedGoods.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-8 text-center text-slate-600 text-[10px] font-bold uppercase tracking-widest">
                              No finished goods inventory data
                            </td>
                          </tr>
                        ) : (
                          finishedGoods.slice(0, 5).map((item) => (
                            <tr key={item.id} className="hover:bg-white/5 transition-colors">
                              <td className="py-3 text-[10px] font-bold text-white">{item.itemName}</td>
                              <td className="py-3 text-[10px] font-bold text-slate-400 uppercase">{item.material}</td>
                              <td className="py-3 text-[10px] font-bold text-white">{item.quantity} Units</td>
                              <td className="py-3 text-[10px] font-bold text-blue-400">#{item.batchNumber}</td>
                            </tr>
                          ))
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Controls */}
              <div className="flex flex-col space-y-4">
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleFileUpload} 
                  accept="image/*" 
                  className="hidden" 
                />
                
                {inventoryType === 'raw' ? (
                  <>
                    {direction === 'outbound' && inventory.length > 0 && (
                      <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-2xl flex flex-col sm:flex-row items-center gap-4">
                        <div className="flex items-center gap-2 text-slate-400 shrink-0">
                          <Database className="w-4 h-4" />
                          <span className="text-xs font-bold uppercase tracking-wider">Manual Batch Select (Optional)</span>
                        </div>
                        <select 
                          value={selectedBatchId || ""} 
                          onChange={(e) => setSelectedBatchId(e.target.value || null)}
                          className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white focus:ring-2 focus:ring-blue-500 outline-none"
                        >
                          <option value="">Auto-detect from token (Default)</option>
                          {inventory.map(item => (
                            <option key={item.id} value={item.id}>
                              {item.batchNumber} - {item.vendor} ({item.material})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div className="flex flex-col sm:flex-row gap-4">
                      <button
                        onClick={() => setDirection(d => d === 'inbound' ? 'outbound' : 'inbound')}
                        className={cn(
                          "flex-1 h-16 rounded-2xl border flex items-center justify-center gap-3 transition-all active:scale-95",
                          direction === 'inbound' 
                            ? "bg-green-500/10 border-green-500/30 text-green-400" 
                            : "bg-red-500/10 border-red-500/30 text-red-400"
                        )}
                      >
                        <ArrowRightLeft className="w-5 h-5" />
                        <div className="text-left">
                          <p className="text-[10px] uppercase font-bold tracking-wider opacity-60">Flow Direction</p>
                          <p className="font-bold">{direction === 'inbound' ? 'Inbound (L → R)' : 'Outbound (R → L)'}</p>
                        </div>
                      </button>

                      <div className="flex-[2] flex gap-2">
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="w-16 h-16 bg-slate-800 hover:bg-slate-700 text-white rounded-2xl flex items-center justify-center transition-all active:scale-95 border border-slate-700"
                          title="Upload Image"
                        >
                          <Upload className="w-6 h-6" />
                        </button>
                        
                        <button
                          onClick={scanSheetsWithToken}
                          disabled={isScanning || (!cameraEnabled && !uploadedImage)}
                          className="flex-1 h-16 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-2xl font-bold flex items-center justify-center gap-3 shadow-xl shadow-blue-600/20 transition-all active:scale-95"
                        >
                          {isScanning ? (
                            <Loader2 className="w-6 h-6 animate-spin" />
                          ) : (
                            <Zap className="w-6 h-6" />
                          )}
                          {isScanning ? "Analyzing..." : "Process Batch"}
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="bg-slate-800/50 border border-slate-700 p-6 rounded-3xl space-y-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-500/10 rounded-xl">
                          <Package className="w-5 h-5 text-blue-500" />
                        </div>
                        <h2 className="text-white font-black uppercase tracking-widest text-sm">FG {direction === 'inbound' ? 'Inbound' : 'Outbound'}</h2>
                      </div>
                      <button
                        onClick={() => setDirection(d => d === 'inbound' ? 'outbound' : 'inbound')}
                        className={cn(
                          "px-4 py-2 rounded-xl border text-[10px] font-bold uppercase tracking-widest transition-all",
                          direction === 'inbound' ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-red-500/10 border-red-500/30 text-red-400"
                        )}
                      >
                        Switch to {direction === 'inbound' ? 'Outbound' : 'Inbound'}
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Item Name</label>
                        <input 
                          type="text" 
                          value={fgManualItemName}
                          onChange={(e) => setFgManualItemName(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-all"
                          placeholder="e.g., Support Bracket A"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Quantity</label>
                        <input 
                          type="number" 
                          value={fgManualQuantity}
                          onChange={(e) => setFgManualQuantity(Number(e.target.value))}
                          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-all"
                        />
                      </div>
                    </div>
                    <button 
                      onClick={() => {
                        setFgManualDirection(direction);
                        handleFGManualTransaction();
                      }}
                      className={cn(
                        "w-full py-4 rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2",
                        direction === 'inbound' ? "bg-green-600 hover:bg-green-500 shadow-green-600/20" : "bg-red-600 hover:bg-red-500 shadow-red-600/20"
                      )}
                    >
                      {direction === 'inbound' ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                      Process FG {direction}
                    </button>
                  </div>
                )}
              </div>

              {fgError && (
                <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-2xl flex items-center gap-3 text-red-400">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <p className="text-sm font-medium">{fgError}</p>
                </div>
              )}

              {fgSuccess && (
                <div className="bg-green-500/10 border border-green-500/20 p-4 rounded-2xl flex items-center gap-3 text-green-400">
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                  <p className="text-sm font-medium">{fgSuccess}</p>
                </div>
              )}

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-2xl flex items-center gap-3 text-red-400">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <p className="text-sm font-medium">{error}</p>
                </div>
              )}
            </>
          ) : activeTab === 'production' ? (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="grid grid-cols-1 lg:grid-cols-3 gap-8"
            >
              {/* Production Controls */}
              <div className="lg:col-span-1 space-y-6">
                <div className="bg-[#0a0c10] border border-slate-800 rounded-3xl p-6 shadow-xl">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-2 bg-blue-500/10 rounded-xl">
                      <Cpu className="w-5 h-5 text-blue-500" />
                    </div>
                    <h2 className="text-white font-black uppercase tracking-widest text-sm">Initiate Production</h2>
                  </div>

                  {productionError && (
                    <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2 text-red-400 text-[10px] font-bold uppercase">
                      <AlertTriangle className="w-4 h-4" />
                      {productionError}
                    </div>
                  )}

                  {productionSuccess && (
                    <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center gap-2 text-green-400 text-[10px] font-bold uppercase">
                      <CheckCircle2 className="w-4 h-4" />
                      {productionSuccess}
                    </div>
                  )}

                  <div className="space-y-4">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Item Name</label>
                      <input 
                        type="text" 
                        value={prodItemName}
                        onChange={(e) => setProdItemName(e.target.value)}
                        className="w-full bg-slate-900/50 border border-slate-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-all"
                        placeholder="e.g., Support Bracket A"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Material Type</label>
                      <select 
                        value={prodMaterial}
                        onChange={(e) => setProdMaterial(e.target.value as MaterialType)}
                        className="w-full bg-slate-900/50 border border-slate-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-all"
                      >
                        <option value="Basic Steel">Basic Steel</option>
                        <option value="Aluminum">Aluminum</option>
                        <option value="Stainless Steel">Stainless Steel</option>
                        <option value="Zinc Steel">Zinc Steel</option>
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Weight (g)</label>
                        <input 
                          type="number" 
                          value={prodWeightGrams}
                          onChange={(e) => setProdWeightGrams(Number(e.target.value))}
                          className="w-full bg-slate-900/50 border border-slate-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Quantity</label>
                        <input 
                          type="number" 
                          value={prodQuantity}
                          onChange={(e) => setProdQuantity(Number(e.target.value))}
                          className="w-full bg-slate-900/50 border border-slate-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-all"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Select Machine</label>
                      <div className="grid grid-cols-2 gap-2">
                        {['Milling', 'Bending'].map(machine => (
                          <button
                            key={machine}
                            onClick={() => setProdMachine(machine as any)}
                            className={cn(
                              "py-3 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all border",
                              prodMachine === machine 
                                ? "bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-600/20" 
                                : "bg-slate-900/50 border-slate-800 text-slate-500 hover:text-slate-300"
                            )}
                          >
                            {machine}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="pt-4">
                      <div className="bg-slate-900/80 rounded-2xl p-4 border border-slate-800 mb-4">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Total Weight Required</span>
                          <span className="text-white font-bold">{((prodWeightGrams * prodQuantity) / 1000).toFixed(2)} kg</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Estimated Cost</span>
                          <span className="text-blue-400 font-bold">
                            €{(((prodWeightGrams * prodQuantity) / 1000) * (MATERIAL_PROPS[prodMaterial]?.price || 0)).toFixed(2)}
                          </span>
                        </div>
                      </div>

                      <button 
                        onClick={handleStartProduction}
                        disabled={!prodItemName || prodWeightGrams <= 0 || prodQuantity <= 0}
                        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-800 disabled:text-slate-600 text-white py-4 rounded-2xl font-black uppercase tracking-[0.2em] text-xs transition-all shadow-xl shadow-blue-600/20 flex items-center justify-center gap-2"
                      >
                        <Play className="w-4 h-4" />
                        Start Production Task
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Production Status & Scrap Info */}
              <div className="lg:col-span-2 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Scrap Availability */}
                  <div className="bg-[#0a0c10] border border-slate-800 rounded-3xl p-6 shadow-xl">
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-emerald-500/10 rounded-xl">
                          <Scissors className="w-5 h-5 text-emerald-500" />
                        </div>
                        <h2 className="text-white font-black uppercase tracking-widest text-sm">Scrap Inventory</h2>
                      </div>
                      <span className="text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded uppercase">Prioritized</span>
                    </div>
                    
                    <div className="space-y-3 max-h-[300px] overflow-y-auto custom-scrollbar pr-2">
                      {inventory.filter(b => b.scrap > 0 && b.material === prodMaterial).length > 0 ? (
                        inventory.filter(b => b.scrap > 0 && b.material === prodMaterial).map(batch => (
                          <div key={batch.batchNumber} className="bg-slate-900/50 border border-slate-800 p-3 rounded-xl flex items-center justify-between">
                            <div>
                              <p className="text-white font-bold text-xs">Batch #{batch.batchNumber}</p>
                              <p className="text-[10px] text-slate-500 uppercase font-bold">{batch.material}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-emerald-400 font-bold text-xs">{batch.scrap} Units</p>
                              <p className="text-[10px] text-slate-500 uppercase font-bold">{batch.weight.toFixed(2)} kg</p>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-8">
                          <p className="text-slate-600 text-[10px] font-bold uppercase tracking-widest">No usable scraps found</p>
                          <p className="text-slate-700 text-[8px] mt-1 uppercase">System will use full sheets</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Active Production */}
                  <div className="bg-[#0a0c10] border border-slate-800 rounded-3xl p-6 shadow-xl">
                    <div className="flex items-center gap-3 mb-6">
                      <div className="p-2 bg-amber-500/10 rounded-xl">
                        <Activity className="w-5 h-5 text-amber-500" />
                      </div>
                      <h2 className="text-white font-black uppercase tracking-widest text-sm">Production Queue</h2>
                    </div>
                    
                    <div className="flex flex-col items-center justify-center h-[200px] border-2 border-dashed border-slate-800 rounded-2xl">
                      <p className="text-slate-600 text-[10px] font-bold uppercase tracking-widest">No Active Tasks</p>
                    </div>
                  </div>
                </div>

                {/* Production History/Logs */}
                <div className="bg-[#0a0c10] border border-slate-800 rounded-3xl p-6 shadow-xl">
                  <h2 className="text-white font-black uppercase tracking-widest text-sm mb-6">Recent Activity</h2>
                  <div className="space-y-3">
                    {logs.filter(l => l.type === 'production').slice(0, 5).map(log => (
                      <div key={log.id} className="flex items-center gap-4 p-3 bg-slate-900/30 rounded-xl border border-slate-800/50">
                        <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                          <CheckCircle2 className="w-4 h-4 text-blue-500" />
                        </div>
                        <div className="flex-1">
                          <p className="text-white text-xs font-bold">{log.message}</p>
                          <p className="text-[10px] text-slate-500">{new Date(log.timestamp).toLocaleTimeString()}</p>
                        </div>
                      </div>
                    ))}
                    {logs.filter(l => l.type === 'production').length === 0 && (
                      <p className="text-center text-slate-600 text-[10px] font-bold uppercase py-4">No production history</p>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-8"
            >
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
                {/* Stats */}
                <div className="lg:col-span-1 space-y-6">
                  <div className="bg-[#0a0c10] border border-slate-800 rounded-3xl p-6 shadow-xl">
                    <h2 className="text-white font-black uppercase tracking-widest text-sm mb-6">FG Overview</h2>
                    <div className="space-y-4">
                      <div className="p-4 bg-slate-900/50 rounded-2xl border border-slate-800">
                        <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-1">Total Items</p>
                        <p className="text-3xl text-white font-black">{finishedGoods.reduce((acc, curr) => acc + curr.quantity, 0)}</p>
                      </div>
                      <div className="p-4 bg-slate-900/50 rounded-2xl border border-slate-800">
                        <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-1">Storage Utilization</p>
                        <p className="text-3xl text-blue-400 font-black">
                          {((fgStorage.filter(c => c.occupiedBy).length / fgStorage.length) * 100).toFixed(1)}%
                        </p>
                      </div>
                    </div>
                    <button 
                      onClick={() => { setActiveTab('inventory'); setShowStorageMap(true); setShowFGMap(true); }}
                      className="w-full mt-6 bg-slate-800 hover:bg-slate-700 text-white py-3 rounded-xl font-bold text-xs uppercase tracking-widest transition-all border border-slate-700 flex items-center justify-center gap-2"
                    >
                      <LayoutGrid className="w-4 h-4" />
                      View FG Storage
                    </button>
                  </div>

                  {/* Manual FG Transaction Form */}
                  <div className="bg-[#0a0c10] border border-slate-800 rounded-3xl p-6 shadow-xl">
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-purple-500/10 rounded-xl">
                          <Package className="w-5 h-5 text-purple-500" />
                        </div>
                        <h2 className="text-white font-black uppercase tracking-widest text-sm">Manual Transaction</h2>
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => { setInventoryType('finished'); scanSheetsWithToken(); }}
                          className="p-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 rounded-xl transition-all border border-blue-500/20 flex items-center gap-2 text-[10px] font-bold uppercase"
                          title="Scan FG Token"
                        >
                          <Camera className="w-4 h-4" />
                          Scan
                        </button>
                      </div>
                    </div>

                    {fgError && (
                      <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2 text-red-400 text-[10px] font-bold uppercase">
                        <AlertTriangle className="w-4 h-4" />
                        {fgError}
                      </div>
                    )}

                    {fgSuccess && (
                      <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center gap-2 text-green-400 text-[10px] font-bold uppercase">
                        <CheckCircle2 className="w-4 h-4" />
                        {fgSuccess}
                      </div>
                    )}

                    <div className="space-y-4">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Item Name</label>
                        <input 
                          type="text" 
                          value={fgManualItemName}
                          onChange={(e) => setFgManualItemName(e.target.value)}
                          className="w-full bg-slate-900/50 border border-slate-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-all"
                          placeholder="Search or enter item name"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Quantity</label>
                          <input 
                            type="number" 
                            value={fgManualQuantity}
                            onChange={(e) => setFgManualQuantity(Number(e.target.value))}
                            className="w-full bg-slate-900/50 border border-slate-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-all"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Direction</label>
                          <select 
                            value={fgManualDirection}
                            onChange={(e) => setFgManualDirection(e.target.value as 'inbound' | 'outbound')}
                            className="w-full bg-slate-900/50 border border-slate-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-all"
                          >
                            <option value="inbound">Inbound</option>
                            <option value="outbound">Outbound</option>
                          </select>
                        </div>
                      </div>

                      <button 
                        onClick={() => handleFGManualTransaction()}
                        className={cn(
                          "w-full py-4 rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2",
                          fgManualDirection === 'inbound' 
                            ? "bg-green-600 hover:bg-green-500 shadow-green-600/20" 
                            : "bg-red-600 hover:bg-red-500 shadow-red-600/20"
                        )}
                      >
                        {fgManualDirection === 'inbound' ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                        Confirm {fgManualDirection}
                      </button>
                    </div>
                  </div>
                </div>

                {/* FG List */}
                <div className="lg:col-span-3">
                  <div className="bg-[#0a0c10] border border-slate-800 rounded-3xl p-6 shadow-xl">
                    <div className="flex items-center justify-between mb-6">
                      <h2 className="text-white font-black uppercase tracking-widest text-sm">Manufactured Items</h2>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => { setInventoryType('finished'); scanSheetsWithToken(); }}
                          className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg shadow-blue-600/20"
                        >
                          <Camera className="w-3 h-3" />
                          Scan FG
                        </button>
                        <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 flex items-center gap-2">
                          <Search className="w-3 h-3 text-slate-500" />
                          <input type="text" placeholder="Search FG..." className="bg-transparent text-[10px] text-white focus:outline-none w-32" />
                        </div>
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="text-left border-b border-slate-800">
                            <th className="pb-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Item Name</th>
                            <th className="pb-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Material</th>
                            <th className="pb-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Batch</th>
                            <th className="pb-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Quantity</th>
                            <th className="pb-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                          {finishedGoods.map((item, idx) => (
                            <tr key={idx} className="group hover:bg-white/[0.02] transition-colors">
                              <td className="py-4">
                                <p className="text-white font-bold text-xs">{item.itemName}</p>
                              </td>
                              <td className="py-4">
                                <span className="text-[10px] text-slate-400 font-bold uppercase">{item.material}</span>
                              </td>
                              <td className="py-4">
                                <span className="text-blue-400 font-bold text-xs">#{item.batchNumber}</span>
                              </td>
                              <td className="py-4">
                                <span className="text-white font-bold text-xs">{item.quantity} Units</span>
                              </td>
                              <td className="py-4 text-right">
                                <button 
                                  onClick={() => handleOutboundFG(item)}
                                  className="bg-blue-600/10 hover:bg-blue-600 text-blue-500 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all"
                                >
                                  Dispatch
                                </button>
                              </td>
                            </tr>
                          ))}
                          {finishedGoods.length === 0 && (
                            <tr>
                              <td colSpan={5} className="py-12 text-center">
                                <Package className="w-12 h-12 text-slate-800 mx-auto mb-4" />
                                <p className="text-slate-600 text-[10px] font-bold uppercase tracking-widest">No finished goods in stock</p>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </div>

        {/* Right Column: Stats & Results */}
        <div className="lg:col-span-4 space-y-6">
          
          {/* Inventory Summary */}
          <div className="bg-[#0f1218] border border-slate-800 rounded-3xl p-6 shadow-xl">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500 mb-6 flex items-center gap-2">
              <Layers className="w-4 h-4" />
              Total Stock Inventory
            </h2>
            
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-800/30 p-4 rounded-2xl border border-slate-800">
                  <div className="flex items-center gap-2 text-blue-400 mb-2">
                    <Square className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">Rectangular</span>
                  </div>
                  <p className="text-3xl font-black text-white">{totalRect}</p>
                </div>
                <div className="bg-slate-800/30 p-4 rounded-2xl border border-slate-800">
                  <div className="flex items-center gap-2 text-purple-400 mb-2">
                    <Triangle className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">Triangular</span>
                  </div>
                  <p className="text-3xl font-black text-white">{totalTri}</p>
                </div>
              </div>

              <div className="bg-red-500/5 border border-red-500/10 p-4 rounded-2xl flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-red-500/20 rounded-xl flex items-center justify-center text-red-400">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Scrap / Deformed</p>
                    <p className="text-2xl font-black text-red-400">{totalScrap}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Scrap Rate</p>
                  <p className="text-lg font-bold text-white">
                    { totalUnits > 0 ? Math.round((totalScrap / totalUnits) * 100) : 0 }%
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Last Scan Result - Detailed with Token Info */}
          <AnimatePresence mode="wait">
            {lastScan && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-[#0f1218] border border-slate-800 rounded-3xl p-6 shadow-xl relative overflow-hidden"
              >
                <div className={cn(
                  "absolute top-0 right-0 w-24 h-24 -mr-8 -mt-8 rounded-full blur-3xl opacity-20",
                  direction === 'inbound' ? "bg-green-500" : "bg-red-500"
                )} />

                <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500 mb-6 flex items-center gap-2">
                  <Tag className="w-4 h-4 text-blue-500" />
                  Token Detected
                </h2>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-800/50 p-3 rounded-xl border border-slate-700/50">
                      <p className="text-[10px] font-bold uppercase text-slate-500 flex items-center gap-1 mb-1">
                        <Truck className="w-3 h-3" /> Vendor
                      </p>
                      <p className="text-xs font-bold text-white truncate">{lastScan.vendor}</p>
                    </div>
                    <div className="bg-slate-800/50 p-3 rounded-xl border border-slate-700/50">
                      <p className="text-[10px] font-bold uppercase text-slate-500 flex items-center gap-1 mb-1">
                        <Package className="w-3 h-3" /> Material
                      </p>
                      <p className="text-xs font-bold text-white truncate">{lastScan.material}</p>
                    </div>
                  </div>
                  
                  <div className="bg-slate-800/50 p-3 rounded-xl border border-slate-700/50">
                    <p className="text-[10px] font-bold uppercase text-slate-500 flex items-center gap-1 mb-1">
                      <Hash className="w-3 h-3" /> Batch Number
                    </p>
                    <p className="text-sm font-black text-blue-400 tracking-wider">{lastScan.batchNumber}</p>
                  </div>

                  <div className="pt-4 border-t border-slate-800 grid grid-cols-5 gap-2">
                    <div className="text-center">
                      <p className="text-[8px] font-bold text-slate-500 uppercase">Rect</p>
                      <p className="text-xs font-bold text-white">+{lastScan.rectangular}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[8px] font-bold text-slate-500 uppercase">Tri</p>
                      <p className="text-xs font-bold text-white">+{lastScan.triangular}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[8px] font-bold text-red-400 uppercase">Scrap</p>
                      <p className="text-xs font-bold text-red-400">+{lastScan.scrap}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[8px] font-bold text-blue-400 uppercase">Size</p>
                      <p className="text-xs font-bold text-blue-400">{lastScan.size?.toFixed(1)}m²</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[8px] font-bold text-amber-400 uppercase">Weight</p>
                      <p className="text-xs font-bold text-amber-400">{lastScan.weight?.toFixed(1)}kg</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Quick Info */}
          <div className="bg-blue-500/5 border border-blue-500/10 p-4 rounded-2xl">
            <div className="flex gap-3">
              <Info className="w-5 h-5 text-blue-500 shrink-0" />
              <div className="text-xs text-slate-400 leading-relaxed">
                <p className="font-bold text-slate-300 mb-1 uppercase tracking-wider">Token Guidance</p>
                <p>Place the paper token next to the metal sheets. The AI will extract Vendor, Material (Steel/Aluminum), and Batch Number to update specific stock records.</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Confirmation Dialog Overlay */}
      <AnimatePresence>
        {showConfirmDialog && pendingTransaction && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 z-[100] flex items-center justify-center p-4"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="fixed inset-0 z-[110] flex items-center justify-center p-4 pointer-events-none"
            >
              <div className="bg-[#0f1218] border border-slate-800 rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden pointer-events-auto">
                <div className={cn(
                  "p-6 flex items-center gap-4 border-b border-slate-800",
                  pendingTransaction.direction === 'inbound' ? "bg-green-500/10" : "bg-amber-500/10"
                )}>
                  <div className={cn(
                    "w-12 h-12 rounded-2xl flex items-center justify-center",
                    pendingTransaction.direction === 'inbound' ? "bg-green-500 text-white" : "bg-amber-500 text-white"
                  )}>
                    {pendingTransaction.direction === 'inbound' ? <ArrowRight className="w-6 h-6" /> : <ArrowLeft className="w-6 h-6" />}
                  </div>
                  <div>
                    <h2 className="font-bold text-xl text-white">Confirm {pendingTransaction.direction === 'inbound' ? 'Inbound' : 'Outbound'}</h2>
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-slate-500 uppercase tracking-widest font-bold">Batch #{pendingTransaction.targetBatchNumber}</p>
                      <span className="w-1 h-1 rounded-full bg-slate-700" />
                      <p className="text-xs text-blue-400 uppercase tracking-widest font-bold">{pendingTransaction.result.material}</p>
                    </div>
                  </div>
                </div>

                <div className="p-6 space-y-6">
                  <div className="grid grid-cols-5 gap-4">
                    <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 text-center">
                      <p className="text-[8px] text-slate-500 uppercase font-bold mb-1">Rect</p>
                      <p className="text-sm font-bold text-white">{pendingTransaction.result.rectangular}</p>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 text-center">
                      <p className="text-[8px] text-slate-500 uppercase font-bold mb-1">Tri</p>
                      <p className="text-sm font-bold text-white">{pendingTransaction.result.triangular}</p>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 text-center">
                      <p className="text-[8px] text-red-500 uppercase font-bold mb-1">Scrap</p>
                      <p className="text-sm font-bold text-red-400">{pendingTransaction.result.scrap}</p>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 text-center">
                      <p className="text-[8px] text-blue-400 uppercase font-bold mb-1">Size</p>
                      <p className="text-sm font-bold text-blue-400">{pendingTransaction.result.size?.toFixed(1)}m²</p>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 text-center">
                      <p className="text-[8px] text-amber-400 uppercase font-bold mb-1">Weight</p>
                      <p className="text-sm font-bold text-amber-400">{pendingTransaction.result.weight?.toFixed(1)}kg</p>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                      <LayoutGrid className="w-4 h-4" />
                      Suggested Grid Locations ({pendingTransaction.direction === 'inbound' ? 'To Store' : 'To Collect'})
                    </h3>
                    <div className="max-h-48 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                      {pendingTransaction.recommendedCubes.length === 0 ? (
                        <div className="bg-amber-500/10 border border-amber-500/20 p-4 rounded-xl">
                          <p className="text-sm text-amber-400 font-bold mb-1 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4" />
                            No specific locations found
                          </p>
                          <p className="text-[10px] text-slate-500 leading-relaxed uppercase font-bold">
                            {pendingTransaction.direction === 'inbound' 
                              ? `Could not find enough empty slots matching Material: "${pendingTransaction.result.material}" and Shape types.`
                              : `Could not find any items from Batch #${pendingTransaction.targetBatchNumber} in the storage grid.`}
                          </p>
                        </div>
                      ) : (
                        pendingTransaction.recommendedCubes.map(cube => (
                          <div key={cube.id} className="bg-slate-800/50 border border-slate-700 p-3 rounded-xl flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className={cn(
                                "w-2 h-2 rounded-full",
                                pendingTransaction.direction === 'inbound' ? "bg-green-500" : "bg-amber-500"
                              )} />
                              <span className="text-sm font-black text-blue-400 tracking-tighter">Grid ID: {cube.id}</span>
                            </div>
                            <span className="text-[10px] font-bold text-slate-400 uppercase">{cube.type} {cube.material}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="p-6 bg-slate-900/50 border-t border-slate-800 flex gap-4">
                  <button 
                    onClick={handleCancelTransaction}
                    className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-2xl font-bold transition-all border border-slate-700"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleConfirmTransaction}
                    className={cn(
                      "flex-[2] py-3 rounded-2xl font-bold text-white shadow-xl transition-all active:scale-95",
                      pendingTransaction.direction === 'inbound' ? "bg-green-600 hover:bg-green-700 shadow-green-600/20" : "bg-amber-600 hover:bg-amber-700 shadow-amber-600/20"
                    )}
                  >
                    {pendingTransaction.direction === 'inbound' ? 'Delivered' : 'Confirm'}
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
        {pendingFGOutbound && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 z-[100] flex items-center justify-center p-4"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="fixed inset-0 z-[110] flex items-center justify-center p-4 pointer-events-none"
            >
              <div className="bg-[#0f1218] border border-slate-800 rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden pointer-events-auto">
                <div className="p-6 flex items-center gap-4 border-b border-slate-800 bg-amber-500/10">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-amber-500 text-white">
                    <ArrowUpRight className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="font-bold text-xl text-white">Confirm FG Dispatch</h2>
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-slate-500 uppercase tracking-widest font-bold">Item: {pendingFGOutbound.itemName}</p>
                      <span className="w-1 h-1 rounded-full bg-slate-700" />
                      <p className="text-xs text-amber-400 uppercase tracking-widest font-bold">Manual Outbound</p>
                    </div>
                  </div>
                </div>

                <div className="p-6 space-y-6">
                  <div className="bg-slate-900/50 p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Quantity to Dispatch</p>
                      <p className="text-2xl font-black text-white">{pendingFGOutbound.quantity} Units</p>
                    </div>
                    <div className="w-12 h-12 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-500">
                      <Package className="w-6 h-6" />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                      <LayoutGrid className="w-4 h-4" />
                      Suggested Removal Sectors
                    </h3>
                    <div className="max-h-48 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                      {pendingFGOutbound.storageUpdates.map((update, idx) => (
                        <div key={idx} className="bg-slate-800/50 border border-slate-700 p-3 rounded-xl flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-amber-500" />
                            <div>
                              <span className="text-sm font-black text-amber-400 tracking-tighter">Sector: {update.cubeId}</span>
                              <p className="text-[10px] text-slate-500 font-bold uppercase">Batch: #{update.batchNumber}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="text-sm font-bold text-white">-{update.quantityTaken}</span>
                            <p className="text-[8px] text-slate-500 uppercase font-bold">Remaining: {update.remainingQuantity}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="p-6 bg-slate-900/50 border-t border-slate-800 flex gap-4">
                  <button 
                    onClick={() => handleCancelTransaction()}
                    className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-2xl font-bold transition-all border border-slate-700"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleConfirmFGOutbound}
                    className="flex-[2] py-3 bg-amber-600 hover:bg-amber-700 rounded-2xl font-bold text-white shadow-xl shadow-amber-600/20 transition-all active:scale-95"
                  >
                    Confirm Dispatch
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
        {pendingProduction && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 z-[100] flex items-center justify-center p-4"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="fixed inset-0 z-[110] flex items-center justify-center p-4 pointer-events-none"
            >
              <div className="bg-[#0f1218] border border-slate-800 rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden pointer-events-auto">
                <div className="p-6 flex items-center gap-4 border-b border-slate-800 bg-blue-500/10">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-blue-500 text-white">
                    <Factory className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="font-bold text-xl text-white">Confirm Production</h2>
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-slate-500 uppercase tracking-widest font-bold">Item: {pendingProduction.itemName}</p>
                      <span className="w-1 h-1 rounded-full bg-slate-700" />
                      <p className="text-xs text-blue-400 uppercase tracking-widest font-bold">{pendingProduction.material}</p>
                    </div>
                  </div>
                </div>

                <div className="p-6 space-y-6">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 text-center">
                      <p className="text-[8px] text-slate-500 uppercase font-bold mb-1">Quantity</p>
                      <p className="text-sm font-bold text-white">{pendingProduction.quantity}</p>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 text-center">
                      <p className="text-[8px] text-slate-500 uppercase font-bold mb-1">Unit Weight</p>
                      <p className="text-sm font-bold text-white">{pendingProduction.weightPerItem}g</p>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-2xl border border-slate-800 text-center">
                      <p className="text-[8px] text-amber-400 uppercase font-bold mb-1">Total Weight</p>
                      <p className="text-sm font-bold text-amber-400">{pendingProduction.totalWeightNeededKg.toFixed(1)}kg</p>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                      <LayoutGrid className="w-4 h-4" />
                      Suggested Finished Goods Locations
                    </h3>
                    <div className="max-h-48 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                      {pendingProduction.assignedCubes.map(cubeId => (
                        <div key={cubeId} className="bg-slate-800/50 border border-slate-700 p-3 rounded-xl flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-blue-500" />
                            <span className="text-sm font-black text-blue-400 tracking-tighter">Location ID: {cubeId}</span>
                          </div>
                          <span className="text-[10px] font-bold text-slate-400 uppercase">FG Storage</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="p-6 bg-slate-900/50 border-t border-slate-800 flex gap-4">
                  <button 
                    onClick={() => setPendingProduction(null)}
                    className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-2xl font-bold transition-all border border-slate-700"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleConfirmProduction}
                    className="flex-[2] py-3 bg-blue-600 hover:bg-blue-700 rounded-2xl font-bold text-white shadow-xl shadow-blue-600/20 transition-all active:scale-95"
                  >
                    Confirm Task
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showInventoryList && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowInventoryList(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60]"
            />
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-2xl bg-[#0f1218] border-l border-slate-800 z-[70] shadow-2xl flex flex-col"
            >
              <div className="p-6 border-b border-slate-800 flex items-center justify-between">
                <h2 className="font-bold text-lg flex items-center gap-2">
                  <Database className="w-5 h-5 text-blue-500" />
                  Active Batch Inventory
                </h2>
                <button 
                  onClick={() => setShowInventoryList(false)}
                  className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {inventory.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-4">
                    <Database className="w-12 h-12 opacity-20" />
                    <p className="text-sm font-medium">No active batches in inventory</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4">
                    {inventory.map((item) => (
                      <div key={item.id} className="bg-slate-800/30 border border-slate-800 rounded-2xl p-5 space-y-4">
                        <div className="flex justify-between items-start">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className={cn(
                                "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                                item.material.toLowerCase().includes('steel') ? "bg-slate-700 text-slate-300" : "bg-blue-900/40 text-blue-300"
                              )}>
                                {item.material}
                              </span>
                              <span className="text-xs font-black text-blue-400 tracking-wider">#{item.batchNumber}</span>
                            </div>
                            <p className="text-sm font-bold text-white">{item.vendor}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[10px] text-slate-500 font-bold uppercase">Last Updated</p>
                            <p className="text-[10px] text-slate-400">{item.lastUpdated.toLocaleString()}</p>
                          </div>
                        </div>

                        <div className="grid grid-cols-5 gap-2 pt-2">
                          <div className="bg-slate-900/50 p-2 rounded-xl text-center">
                            <p className="text-[8px] text-slate-500 uppercase font-bold">Rect</p>
                            <p className="text-sm font-bold text-white">{item.rectangular}</p>
                          </div>
                          <div className="bg-slate-900/50 p-2 rounded-xl text-center">
                            <p className="text-[8px] text-slate-500 uppercase font-bold">Tri</p>
                            <p className="text-sm font-bold text-white">{item.triangular}</p>
                          </div>
                          <div className="bg-slate-900/50 p-2 rounded-xl text-center">
                            <p className="text-[8px] text-red-400 uppercase font-bold">Scrap</p>
                            <p className="text-sm font-bold text-red-400">{item.scrap}</p>
                          </div>
                          <div className="bg-slate-900/50 p-2 rounded-xl text-center">
                            <p className="text-[8px] text-blue-400 uppercase font-bold">Size</p>
                            <p className="text-sm font-bold text-blue-400">{item.size?.toFixed(1)}m²</p>
                          </div>
                          <div className="bg-slate-900/50 p-2 rounded-xl text-center">
                            <p className="text-[8px] text-amber-400 uppercase font-bold">Weight</p>
                            <p className="text-sm font-bold text-amber-400">{item.weight?.toFixed(1)}kg</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* History Sidebar/Overlay */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60]"
            />
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-[#0f1218] border-l border-slate-800 z-[70] shadow-2xl flex flex-col"
            >
              <div className="p-6 border-b border-slate-800 flex items-center justify-between">
                <h2 className="font-bold text-lg flex items-center gap-2">
                  <History className="w-5 h-5 text-blue-500" />
                  Scan History
                </h2>
                <button 
                  onClick={() => setShowHistory(false)}
                  className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {logs.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-4">
                    <History className="w-12 h-12 opacity-20" />
                    <p className="text-sm font-medium">No scan history yet</p>
                  </div>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className="bg-slate-800/30 border border-slate-800 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className={cn(
                            "w-8 h-8 rounded-lg flex items-center justify-center",
                            log.direction === 'inbound' ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                          )}>
                            {log.direction === 'inbound' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
                          </div>
                          <div>
                            <p className="text-xs font-bold text-white uppercase tracking-wider">{log.direction}</p>
                            <p className="text-[10px] text-slate-500">{log.timestamp.toLocaleString()}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] font-bold text-blue-400 uppercase">Batch #{log.batchNumber}</p>
                          <p className="text-[10px] text-slate-500 font-bold uppercase">{log.material}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center bg-slate-900/30 p-2 rounded-xl">
                        <div>
                          <p className="text-[8px] text-slate-500 uppercase">Rect</p>
                          <p className="text-xs font-bold text-white">{log.rectangular}</p>
                        </div>
                        <div>
                          <p className="text-[8px] text-slate-500 uppercase">Tri</p>
                          <p className="text-xs font-bold text-white">{log.triangular}</p>
                        </div>
                        <div>
                          <p className="text-[8px] text-red-400 uppercase">Scrap</p>
                          <p className="text-xs font-bold text-red-400">{log.scrap}</p>
                        </div>
                      </div>
                      {log.imageUrl && (
                        <div className="aspect-video rounded-xl overflow-hidden border border-slate-700/50">
                          <img src={log.imageUrl} alt="Scan capture" className="w-full h-full object-cover" />
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              <div className="p-6 border-t border-slate-800 bg-slate-900/50">
                <button 
                  onClick={() => setLogs([])}
                  className="w-full py-3 text-slate-400 hover:text-red-400 text-xs font-bold uppercase tracking-widest transition-colors"
                >
                  Clear History Logs
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
