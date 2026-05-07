import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Trophy, Play, RotateCcw, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Users, Volume2, VolumeX, Twitter, Facebook, Share2 } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import { 
  collection, 
  query, 
  orderBy, 
  limit, 
  onSnapshot, 
  setDoc, 
  doc, 
  getDoc,
  serverTimestamp,
  getDocs
} from 'firebase/firestore';
import { db, auth, googleProvider } from '../lib/firebase';
import { signInWithPopup, onAuthStateChanged, User } from 'firebase/auth';

interface Point {
  x: number;
  y: number;
  type?: 'normal' | 'super' | 'shield' | 'multiplier' | 'slowMo' | 'ghost';
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}

interface NpcSnake {
  id: string;
  snakeBody: Point[];
  score: number;
  direction: number;
  hue: number;
  targetPoint: Point | null;
  speedMult: number;
  wanderingPhase?: number;
  targetMood?: 'scavenge' | 'hunt' | 'patrol' | 'curious';
  moodTimer?: number;
  patrolPoint?: Point;
}

interface OtherPlayer {
  id: string;
  snakeBody: Point[];
  score: number;
  direction: number;
}

interface LeaderboardEntry {
  playerName: string;
  score: number;
  userId: string;
  timestamp: any;
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
}

interface Theme {
  name: string;
  bg: string;
  head: string;
  body: string;
  food: string;
  accent: string;
}

const THEMES: Record<string, Theme> = {
  classic: {
    name: "Classic",
    bg: "#15803d", 
    head: "#3B82F6",
    body: "#60A5FA",
    food: "#EF4444",
    accent: "#3B82F6"
  },
  cyberpunk: {
    name: "Cyberpunk",
    bg: "#0f172a",
    head: "#f0abfc",
    body: "#c026d3",
    food: "#facc15",
    accent: "#d946ef"
  },
  matrix: {
    name: "Matrix",
    bg: "#000000",
    head: "#22c55e",
    body: "#166534",
    food: "#86efac",
    accent: "#4ade80"
  },
  vaporwave: {
    name: "Vaporwave",
    bg: "#2e1065",
    head: "#22d3ee",
    body: "#0891b2",
    food: "#f472b6",
    accent: "#ec4899"
  },
  inferno: {
    name: "Inferno",
    bg: "#1c1917",
    head: "#fb923c",
    body: "#ea580c",
    food: "#fcd34d",
    accent: "#f97316"
  }
};

const GRID_SIZE = 14;
const INITIAL_SPEED = 800; 
const WORLD_WIDTH = 2400;
const WORLD_HEIGHT = 2400;

interface BossProjectile {
  x: number;
  y: number;
  dx: number;
  dy: number;
  id: number;
  life: number;
}

export type DifficultyLevel = 'easy' | 'medium' | 'hard';

export const DIFFICULTY_CONFIG = {
  easy: {
    initialSpeed: 950,
    npcCount: 135,
    npcAggression: 0.45,
    bossHealthMult: 0.7,
    pointsMult: 1.0,
    name: "Easy",
    desc: "Relaxed pace, but more competitors"
  },
  medium: {
    initialSpeed: 800,
    npcCount: 225,
    npcAggression: 0.75,
    bossHealthMult: 1.1,
    pointsMult: 1.5,
    name: "Medium",
    desc: "High density chaos"
  },
  hard: {
    initialSpeed: 650,
    npcCount: 360,
    npcAggression: 1.25,
    bossHealthMult: 2.0,
    pointsMult: 2.5,
    name: "Extreme",
    desc: "Total GRID WARFARE"
  }
};

export default function SnakeGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  
  const [score, setScore] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [finalSnakeBody, setFinalSnakeBody] = useState<Point[]>([]);
  
  // Statistics Tracking
  const [gameStartTime, setGameStartTime] = useState<number | null>(null);
  const [gameStats, setGameStats] = useState({
    timeSurvived: 0,
    maxLength: 0,
    foodEaten: 0
  });

  const [direction, setDirection] = useState(0); 
  const [isBoosting, setIsBoosting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isSoundEnabled, setIsSoundEnabled] = useState(true);
  const [bossSnake, setBossSnake] = useState<{ 
    x: number, 
    y: number, 
    active: boolean, 
    direction: 'LTR' | 'RTL' | 'UTD' | 'DTU',
    phase: number,
    speedMult: number,
    baseY: number,
    health: number,
    maxHealth: number,
    mode: 'patrol' | 'hunt' | 'trap' | 'charge' | 'stunned',
    lastAttack: number,
    chargeLevel: number,
    warning: boolean,
    stunTimer: number,
    stunProgress: number
  }>({ 
    x: -GRID_SIZE * 20, 
    y: WORLD_HEIGHT / 2, 
    active: false, 
    direction: 'LTR',
    phase: 0,
    speedMult: 1.2,
    baseY: WORLD_HEIGHT / 2,
    health: 100,
    maxHealth: 100,
    mode: 'patrol',
    lastAttack: 0,
    chargeLevel: 0,
    warning: false,
    stunTimer: 0,
    stunProgress: 0
  });

  const [bossProjectiles, setBossProjectiles] = useState<BossProjectile[]>([]);
  
  const [activePowerUps, setActivePowerUps] = useState<{
    shield: number; // timestamp until active
    multiplier: number;
    slowMo: number;
    ghost: number;
  }>({ shield: 0, multiplier: 0, slowMo: 0, ghost: 0 });

  const [playerColors, setPlayerColors] = useState<{ head: string; body: string }>(() => {
    const saved = localStorage.getItem('snakePlayerColors');
    return saved ? JSON.parse(saved) : { head: '#00ccff', body: '#0066aa' };
  });

  const [snakeBody, setSnakeBody] = useState<Point[]>([{ x: 200, y: 200 }]);
  const [otherPlayers, setOtherPlayers] = useState<Map<string, OtherPlayer>>(new Map());
  const [particles, setParticles] = useState<Particle[]>([]);
  const [trail, setTrail] = useState<{ x: number, y: number, life: number }[]>([]);
  const [npcSnakes, setNpcSnakes] = useState<NpcSnake[]>([]);
  const [foodList, setFoodList] = useState<Point[]>([]);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [bossExitTime, setBossExitTime] = useState<number | null>(null);
  const [roomId] = useState("global-room"); 
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('snakePlayerName') || "");
  const [user, setUser] = useState<User | null>(null);
  const [currentTheme, setCurrentTheme] = useState<string>(() => localStorage.getItem('snakeTheme') || 'classic');
  const [isShaking, setIsShaking] = useState(false);
  const [hasSavedGame, setHasSavedGame] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showCopied, setShowCopied] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [targetZoom, setTargetZoom] = useState(1);
  const [controlType, setControlType] = useState<'keypad' | 'touch'>(() => (localStorage.getItem('snakeControlType') as 'keypad' | 'touch') || 'keypad');
  const [touches, setTouches] = useState<TouchList | null>(null);
  const [difficulty, setDifficulty] = useState<DifficultyLevel>(() => (localStorage.getItem('snakeDifficulty') as DifficultyLevel) || 'medium');
  const [touchSensitivity, setTouchSensitivity] = useState(() => Number(localStorage.getItem('snakeTouchSensitivity')) || 50);
  const [touchMode, setTouchMode] = useState<'tap' | 'swipe'>(() => (localStorage.getItem('snakeTouchMode') as 'tap' | 'swipe') || 'tap');
  const [lastTaps, setLastTaps] = useState<{ x: number, y: number, id: number, time: number }[]>([]);
  const [touchStart, setTouchStart] = useState<{ x: number, y: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Persistence Effects
  useEffect(() => { localStorage.setItem('snakeTheme', currentTheme); }, [currentTheme]);
  useEffect(() => { localStorage.setItem('snakeControlType', controlType); }, [controlType]);
  useEffect(() => { localStorage.setItem('snakeDifficulty', difficulty); }, [difficulty]);
  useEffect(() => { localStorage.setItem('snakeTouchSensitivity', touchSensitivity.toString()); }, [touchSensitivity]);
  useEffect(() => { localStorage.setItem('snakeTouchMode', touchMode); }, [touchMode]);
  useEffect(() => { localStorage.setItem('snakePlayerColors', JSON.stringify(playerColors)); }, [playerColors]);
  useEffect(() => { localStorage.setItem('snakePlayerName', playerName); }, [playerName]);

  const COLOR_PRESETS = [
    { name: "Neon Blue", head: "#00ccff", body: "#0066aa" },
    { name: "Cyber Pink", head: "#ff00ff", body: "#aa00aa" },
    { name: "Matrix Green", head: "#00ffcc", body: "#00aa66" },
    { name: "Sunset Gold", head: "#ffcc00", body: "#aa6600" },
    { name: "Lava Red", head: "#ff3333", body: "#aa1111" },
    { name: "Mono Steel", head: "#ffffff", body: "#444444" }
  ];

  const COLORS = THEMES[currentTheme] || THEMES.classic;

  const triggerShake = useCallback(() => {
    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 200);
  }, []);

  // Touch Controls Implementation
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isPlaying || controlType !== 'touch') return;

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = container.getBoundingClientRect();
      
      // Add visual tap indicator
      const newTap = {
        x: touch.clientX,
        y: touch.clientY,
        id: Date.now() + Math.random(),
        time: Date.now()
      };
      setLastTaps(prev => [...prev, newTap].slice(-5));
      setTimeout(() => {
        setLastTaps(prev => prev.filter(t => t.id !== newTap.id));
      }, 600);

      if (touchMode === 'swipe') {
        setTouchStart({ x: touch.clientX, y: touch.clientY });
      } else {
        // Quadrant Tap Logic
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = touch.clientX - centerX;
        const dy = touch.clientY - centerY;

        // Dividing into quadrants: 
        // dx > 0 && Math.abs(dx) > Math.abs(dy) -> Right
        // dy > 0 && Math.abs(dy) > Math.abs(dx) -> Down
        // ... and so on
        if (Math.abs(dx) > Math.abs(dy)) {
          if (dx > 20 && direction !== 2) setDirection(0);
          else if (dx < -20 && direction !== 0) setDirection(2);
        } else {
          if (dy > 20 && direction !== 3) setDirection(1);
          else if (dy < -20 && direction !== 1) setDirection(3);
        }
      }

      setIsBoosting(e.touches.length >= 2);
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (touchMode === 'swipe' && touchStart) {
        const touch = e.touches[0];
        const dx = touch.clientX - touchStart.x;
        const dy = touch.clientY - touchStart.y;
        
        // Threshold adjusted by sensitivity (0-100 where 100 is most sensitive, so smaller threshold)
        const threshold = Math.max(10, 100 - touchSensitivity);

        if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) {
          if (Math.abs(dx) > Math.abs(dy)) {
            if (dx > threshold && direction !== 2) {
              setDirection(0);
              setTouchStart({ x: touch.clientX, y: touch.clientY });
            } else if (dx < -threshold && direction !== 0) {
              setDirection(2);
              setTouchStart({ x: touch.clientX, y: touch.clientY });
            }
          } else {
            if (dy > threshold && direction !== 3) {
              setDirection(1);
              setTouchStart({ x: touch.clientX, y: touch.clientY });
            } else if (dy < -threshold && direction !== 1) {
              setDirection(3);
              setTouchStart({ x: touch.clientX, y: touch.clientY });
            }
          }
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      setIsBoosting(e.touches.length >= 2);
      if (touchMode === 'swipe') setTouchStart(null);
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd);

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isPlaying, controlType, direction, touchMode, touchSensitivity, touchStart]);

  const gameLoopRef = useRef<number>(0);
  const lastUpdateRef = useRef<number>(0);

  // Firestore: Fetch Leaderboard
  useEffect(() => {
    const q = query(collection(db, "leaderboard"), orderBy("score", "desc"), limit(10));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const entries: LeaderboardEntry[] = [];
      snapshot.forEach((doc) => {
        entries.push(doc.data() as LeaderboardEntry);
      });
      setLeaderboard(entries);
      
      // Update global high score if top entry is higher
      if (entries.length > 0) {
        setHighScore(entries[0].score);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "leaderboard");
    });

    return () => unsubscribe();
  }, []);

  const submitScore = useCallback(async (finalScore: number) => {
    if (!auth.currentUser || finalScore <= 0) return;

    const userId = auth.currentUser.uid;
    const entryId = userId; // One entry per user to keep it simple/clean
    const path = `leaderboard/${entryId}`;

    try {
      // Check if user has a higher score already
      const docRef = doc(db, "leaderboard", entryId);
      const docSnap = await getDocs(query(collection(db, "leaderboard"), limit(1))); // Simplified
      // Actually, we can just use setDoc with a condition in rules (which we did),
      // but client-side optimization helps.
      
      await setDoc(docRef, {
        playerName,
        score: Math.max(finalScore, leaderboard.find(e => e.userId === userId)?.score || 0),
        userId,
        timestamp: serverTimestamp()
      }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }, [playerName, leaderboard]);

  const playSound = useCallback((type: 'eat' | 'gameOver' | 'boost' | 'boss') => {
    if (!isSoundEnabled) return;
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === 'eat') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.1);
      } else if (type === 'gameOver') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(110, audioCtx.currentTime + 0.5);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.5);
      } else if (type === 'boost') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(150, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.02, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.05);
      } else if (type === 'boss') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(100, audioCtx.currentTime);
        osc.frequency.linearRampToValueAtTime(300, audioCtx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
      }
    } catch (e) {
      console.error("Audio failed", e);
    }
  }, [isSoundEnabled]);

  const createExplosion = useCallback((x: number, y: number, color: string) => {
    const newParticles: Particle[] = [];
    for (let i = 0; i < 15; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 5 + 2;
      newParticles.push({
        x: x + GRID_SIZE / 2,
        y: y + GRID_SIZE / 2,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.0,
        color,
        size: Math.random() * 3 + 1
      });
    }
    setParticles(prev => [...prev, ...newParticles]);
  }, []);

  // Handle Socket Connection
  useEffect(() => {
    socketRef.current = io({
      transports: ['websocket'],
      autoConnect: true
    });

    socketRef.current.on('connect', () => {
      console.log('Connected to server');
      socketRef.current?.emit('join-room', {
        roomId,
        player: { snakeBody, score, direction }
      });
    });

    socketRef.current.on('room-update', ({ players, foodList: remoteFood, bossSnake: remoteBoss, globalHighScore: remoteHighScore }) => {
      const others = new Map();
      players.forEach((p: any) => {
        if (p.id !== socketRef.current?.id) {
          others.set(p.id, p);
        }
      });
      setOtherPlayers(others);
      if (remoteFood.length > 0) setFoodList(remoteFood);
      if (remoteBoss.active) setBossSnake(remoteBoss);
      if (typeof remoteHighScore === 'number') setHighScore(remoteHighScore);
    });

    socketRef.current.on('high-score-updated', (newHighScore: number) => {
      setHighScore(newHighScore);
    });

    socketRef.current.on('player-updated', (player: any) => {
      if (player.id !== socketRef.current?.id) {
        setOtherPlayers(prev => {
          const next = new Map(prev);
          next.set(player.id, player);
          return next;
        });
      }
    });

    socketRef.current.on('player-left', (id: string) => {
      setOtherPlayers(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    });

    socketRef.current.on('food-updated', (remoteFood: Point[]) => {
      setFoodList(remoteFood);
    });

    socketRef.current.on('boss-updated', (remoteBoss: any) => {
      setBossSnake(remoteBoss);
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, [roomId]);

  const baseSpeed = Math.max(120, DIFFICULTY_CONFIG[difficulty].initialSpeed / (1 + score * 0.02));
  const [currentSpeed, setCurrentSpeed] = useState(INITIAL_SPEED);

  // Smooth Speed Transition
  useEffect(() => {
    const isSlowMo = activePowerUps.slowMo > Date.now();
    const slowMoFactor = isSlowMo ? 1.8 : 1.0;
    const target = isBoosting ? (baseSpeed / 2) * slowMoFactor : baseSpeed * slowMoFactor;
    if (Math.abs(currentSpeed - target) > 1) {
      const timer = setInterval(() => {
        setCurrentSpeed(prev => prev + (target - prev) * 0.15);
      }, 16);
      return () => clearInterval(timer);
    }
  }, [baseSpeed, isBoosting, currentSpeed, activePowerUps.slowMo]);

  const spawnFood = useCallback((currentWidth: number, currentHeight: number, count = 1) => {
    // food should spawn in world coordinates
    const cols = Math.floor(WORLD_WIDTH / GRID_SIZE) - 1;
    const rows = Math.floor(WORLD_HEIGHT / GRID_SIZE) - 1;
    
    const newFoods: Point[] = [];
    for (let i = 0; i < count; i++) {
        const rand = Math.random();
        let type: Point['type'] = 'normal';
        if (rand > 0.99) type = 'ghost';
        else if (rand > 0.98) type = 'shield';
        else if (rand > 0.96) type = 'multiplier';
        else if (rand > 0.94) type = 'slowMo';
        else if (rand > 0.9) type = 'super';

        newFoods.push({
          x: Math.max(0, Math.floor(Math.random() * cols)) * GRID_SIZE,
          y: Math.max(0, Math.floor(Math.random() * rows)) * GRID_SIZE,
          type
        });
    }

    const newList = [...foodList, ...newFoods];
    setFoodList(newList);
    socketRef.current?.emit('sync-food', { roomId, foodList: newList });
  }, [foodList, roomId]);

  // Maintain 600 foods (3x increase)
  useEffect(() => {
    if (isPlaying && foodList.length < 500) {
      spawnFood(WORLD_WIDTH, WORLD_HEIGHT, 600 - foodList.length);
    }
  }, [foodList.length, isPlaying, spawnFood]);

  // Smooth Zoom Animation
  useEffect(() => {
    if (Math.abs(zoomLevel - targetZoom) > 0.001) {
      const interval = setInterval(() => {
        setZoomLevel(prev => {
          const next = prev + (targetZoom - prev) * 0.1;
          if (Math.abs(next - targetZoom) < 0.001) {
            clearInterval(interval);
            return targetZoom;
          }
          return next;
        });
      }, 16);
      return () => clearInterval(interval);
    }
  }, [targetZoom]);

  const [highScore, setHighScore] = useState(0);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u?.displayName) {
        setPlayerName(u.displayName.split(' ')[0]);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleGoogleLogin = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      if (result.user) {
        setUser(result.user);
        if (result.user.displayName) {
          const name = result.user.displayName.split(' ')[0];
          setPlayerName(name);
          localStorage.setItem('snakePlayerName', name);
        }
      }
    } catch (error) {
      console.error("Login failed:", error);
      // Fallback for environment issues or blocked popups
      if (error instanceof Error && error.message.includes('popup')) {
        alert("Please allow popups for Google Sign-in to work.");
      }
    }
  };

  const handleShareScore = () => {
    const gameUrl = window.location.href;
    const message = `🐍 I just scored ${score} in Snake 2026! (High Score: ${highScore})\n\nCan you beat me in this neon grid? ⚡️\n\nPlay here: ${gameUrl}`;
    
    if (navigator.share) {
      navigator.share({
        title: 'Snake 2026',
        text: message,
        url: gameUrl
      }).catch(err => {
        console.error("Share failed", err);
      });
    } else {
      navigator.clipboard.writeText(message).then(() => {
        setShowCopied(true);
        setTimeout(() => setShowCopied(false), 2000);
      });
    }
  };

  // Check for saved game
  useEffect(() => {
    const checkSave = async () => {
      if (user) {
        try {
          const docRef = doc(db, `users/${user.uid}/saves/current`);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            setHasSavedGame(true);
          } else {
            setHasSavedGame(false);
          }
        } catch (err) {
          console.error("Error checking save:", err);
        }
      } else {
        const localSave = localStorage.getItem('snakeSavedGame');
        setHasSavedGame(!!localSave);
      }
    };
    checkSave();
  }, [user]);

  const saveGame = async () => {
    if (isGameOver) return;
    setIsSaving(true);
    const gameState = {
      snakeBody,
      score,
      foodList,
      direction,
      currentTheme,
      timestamp: user ? serverTimestamp() : new Date().toISOString()
    };

    if (user) {
      try {
        await setDoc(doc(db, `users/${user.uid}/saves/current`), gameState);
        setHasSavedGame(true);
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/saves/current`);
      }
    } else {
      localStorage.setItem('snakeSavedGame', JSON.stringify(gameState));
      setHasSavedGame(true);
    }
    setIsSaving(false);
    setIsPlaying(false);
  };

  const resumeGame = async () => {
    let savedData: any = null;
    if (user) {
      try {
        const docRef = doc(db, `users/${user.uid}/saves/current`);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          savedData = docSnap.data();
        }
      } catch (err) {
        console.error("Error loading save:", err);
      }
    } else {
      const local = localStorage.getItem('snakeSavedGame');
      if (local) savedData = JSON.parse(local);
    }

    if (savedData) {
      setSnakeBody(savedData.snakeBody);
      setScore(savedData.score);
      setFoodList(savedData.foodList);
      setDirection(savedData.direction);
      setCurrentTheme(savedData.currentTheme);
      setIsPlaying(true);
      setIsGameOver(false);
      setHasSavedGame(false);
      
      // Cleanup save after loading
      if (user) {
        try {
          // Optional: delete or keep it. Let's keep it but mark as loaded? 
          // For simplicity, we just leave it or overwrite on next save.
        } catch (e) {}
      } else {
        localStorage.removeItem('snakeSavedGame');
      }
    }
  };

  const resetGame = useCallback(() => {
    const startX = Math.floor(WORLD_WIDTH / 2 / GRID_SIZE) * GRID_SIZE;
    const startY = Math.floor(WORLD_HEIGHT / 2 / GRID_SIZE) * GRID_SIZE;
    
    setSnakeBody([{ x: startX, y: startY }]);
    setBossSnake({ 
      active: false, 
      direction: Math.random() > 0.5 ? 'LTR' : 'RTL', 
      x: Math.random() > 0.5 ? -100 : WORLD_WIDTH + 100, 
      y: Math.random() * WORLD_HEIGHT, 
      baseY: Math.random() * WORLD_HEIGHT,
      phase: 0, 
      speedMult: 1.2,
      health: 0,
      maxHealth: 0
    });
    setBossExitTime(null);
    setScore(0);
    setGameStats({
      timeSurvived: 0,
      maxLength: 1,
      foodEaten: 0
    });
    setZoomLevel(1);
    setTargetZoom(1);
    setGameStartTime(Date.now());
    setDirection(0);
    setIsGameOver(false);
    setFoodList([]);
    setNpcSnakes([]); 
    spawnFood(WORLD_WIDTH, WORLD_HEIGHT, 100); // Doubled from 50
  }, [spawnFood]);

  const spawnNpcs = useCallback(() => {
    const newNpcs: NpcSnake[] = [];
    const count = DIFFICULTY_CONFIG[difficulty].npcCount;
    for (let i = 0; i < count; i++) {
      const x = Math.floor(Math.random() * (WORLD_WIDTH / GRID_SIZE)) * GRID_SIZE;
      const y = Math.floor(Math.random() * (WORLD_HEIGHT / GRID_SIZE)) * GRID_SIZE;
      newNpcs.push({
        id: `npc-${Math.random().toString(36).substr(2, 9)}`,
        snakeBody: [{ x, y }, { x: x - GRID_SIZE, y }, { x: x - GRID_SIZE * 2, y }],
        score: Math.floor(Math.random() * 5),
        direction: Math.floor(Math.random() * 4),
        hue: Math.random() * 360,
        targetPoint: null,
        speedMult: 0.8 + Math.random() * 0.4,
        targetMood: 'scavenge',
        moodTimer: Math.random() * 100,
        wanderingPhase: Math.random() * Math.PI * 2
      });
    }
    setNpcSnakes(newNpcs);
  }, []);

  useEffect(() => {
    if (isPlaying && npcSnakes.length === 0) {
      spawnNpcs();
    }
  }, [isPlaying, npcSnakes.length, spawnNpcs]);

  // Handle Container Resize
  useEffect(() => {
    if (!containerRef.current) return;
    
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height });
        // Initial food spawn if needed
        if (foodList.length === 0) {
           spawnFood(width, height, 1);
        }
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [foodList.length, spawnFood]);

  // Controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
        if (isPlaying && !isGameOver) {
          setIsPaused(prev => !prev);
          return;
        }
      }

      if (isPaused) return;
      if (!isPlaying) return;
      
      switch (e.key) {
        case 'ArrowRight':
        case 'd':
          if (direction !== 2) setDirection(0);
          break;
        case 'ArrowDown':
        case 's':
          if (direction !== 3) setDirection(1);
          break;
        case 'ArrowLeft':
        case 'a':
          if (direction !== 0) setDirection(2);
          break;
        case 'ArrowUp':
        case 'w':
          if (direction !== 1) setDirection(3);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, direction]);

  const endGame = useCallback(() => {
    if (isGameOver) return;
    const isShielded = activePowerUps.shield > Date.now();
    const isGhost = activePowerUps.ghost > Date.now();
    if (isShielded || isGhost) {
      playSound('eat');
      triggerShake();
      return;
    }
    setIsGameOver(true);
    setFinalSnakeBody([...snakeBody]);
    setIsPlaying(false);
    playSound('gameOver');
    triggerShake();
    submitScore(score);
    
    // Finalize stats
    if (gameStartTime) {
      const duration = Math.floor((Date.now() - gameStartTime) / 1000);
      setGameStats(prev => ({ ...prev, timeSurvived: duration }));
    }
  }, [isGameOver, playSound, triggerShake, submitScore, score, gameStartTime]);

  const update = useCallback(() => {
    setSnakeBody(prevBody => {
      const head = prevBody[0];
      const newHead = { ...head };

      if (direction === 0) newHead.x += GRID_SIZE;
      else if (direction === 1) newHead.y += GRID_SIZE;
      else if (direction === 2) newHead.x -= GRID_SIZE;
      else if (direction === 3) newHead.y -= GRID_SIZE;

      // Wall Collision
      if (newHead.x < 0 || newHead.x >= WORLD_WIDTH || newHead.y < 0 || newHead.y >= WORLD_HEIGHT) {
        const isGhost = activePowerUps.ghost > Date.now();
        if (!isGhost) {
          const bodyFoods = prevBody.map(s => ({ x: s.x, y: s.y, type: 'normal' as const }));
          setFoodList(f => [...f, ...bodyFoods]);
          triggerShake(); // Added shake on wall hit
          endGame();
          return prevBody;
        } else {
           // Wrap around or just stay at edge? Wrap around is cooler for Ghost.
           if (newHead.x < 0) newHead.x = WORLD_WIDTH - GRID_SIZE;
           else if (newHead.x >= WORLD_WIDTH) newHead.x = 0;
           if (newHead.y < 0) newHead.y = WORLD_HEIGHT - GRID_SIZE;
           else if (newHead.y >= WORLD_HEIGHT) newHead.y = 0;
        }
      }

      // Self Collision
      const isGhost = activePowerUps.ghost > Date.now();
      if (!isGhost && prevBody.some(s => s.x === newHead.x && s.y === newHead.y)) {
        const bodyFoods = prevBody.map(s => ({ x: s.x, y: s.y, type: 'normal' as const }));
        setFoodList(f => [...f, ...bodyFoods]);
        endGame();
        return prevBody;
      }

      // Other Players & NPCs Collision
      let collidedWithOther = false;
      
      // Check other players
      otherPlayers.forEach(player => {
        player.snakeBody.forEach(seg => {
          if (Math.abs(newHead.x - seg.x) < GRID_SIZE && Math.abs(newHead.y - seg.y) < GRID_SIZE) {
            collidedWithOther = true;
            triggerShake();
          }
        });
      });

      // Check NPCs
      npcSnakes.forEach(npc => {
        npc.snakeBody.forEach(seg => {
          if (Math.abs(newHead.x - seg.x) < GRID_SIZE * 0.9 && Math.abs(newHead.y - seg.y) < GRID_SIZE * 0.9) {
            collidedWithOther = true;
            triggerShake();
          }
        });
      });

      if (!isGhost && collidedWithOther) {
        const bodyFoods = prevBody.map(s => ({ x: s.x, y: s.y, type: 'normal' as const }));
        setFoodList(f => [...f, ...bodyFoods]);
        triggerShake(); // Added shake on player collision
        endGame();
        return prevBody;
      }

      const newBody = [newHead, ...prevBody];
      
      // Update Max Length Stat
      setGameStats(prev => ({
        ...prev,
        maxLength: Math.max(prev.maxLength, newBody.length)
      }));

      // Food Check
      const foodIndex = foodList.findIndex(f => Math.abs(newHead.x - f.x) < GRID_SIZE && Math.abs(newHead.y - f.y) < GRID_SIZE);
      
      if (foodIndex !== -1) {
        const eatenFood = foodList[foodIndex];
        const isMultiplier = activePowerUps.multiplier > Date.now();
        const config = DIFFICULTY_CONFIG[difficulty];
        const basePoints = eatenFood.type === 'super' ? 5 : 1;
        const multiplier = (isMultiplier ? 3 : 1) * config.pointsMult;
        const nextScore = score + Math.floor(basePoints * multiplier);
        setScore(nextScore);
        
        // Update Food Eaten Stat
        setGameStats(prev => ({
          ...prev,
          foodEaten: prev.foodEaten + 1
        }));

        if (eatenFood.type === 'super') {
          setTargetZoom(1.5);
          setTimeout(() => setTargetZoom(1), 4000);
          if (bossSnake.active) {
            setBossSnake(prev => ({ ...prev, stunProgress: (prev.stunProgress || 0) + 15 }));
          }
        } else if (eatenFood.type === 'shield') {
          setActivePowerUps(prev => ({ ...prev, shield: Date.now() + 10000 }));
        } else if (eatenFood.type === 'multiplier') {
          setActivePowerUps(prev => ({ ...prev, multiplier: Date.now() + 15000 }));
        } else if (eatenFood.type === 'slowMo') {
          setActivePowerUps(prev => ({ ...prev, slowMo: Date.now() + 8000 }));
        } else if (eatenFood.type === 'ghost') {
          setActivePowerUps(prev => ({ ...prev, ghost: Date.now() + 10000 }));
        }

        playSound('eat');
        createExplosion(eatenFood.x, eatenFood.y, eatenFood.type === 'super' ? '#3B82F6' : COLORS.food);
        triggerShake();
        
        // Remove eaten food
        const nextFoodList = foodList.filter((_, i) => i !== foodIndex);
        setFoodList(nextFoodList);
        socketRef.current?.emit('sync-food', { roomId, foodList: nextFoodList });
        
        // Check for Big Snake Boss trigger (EVERY 10 FOODS)
        if (nextScore > 0 && nextScore % 10 === 0) {
          const ltr = (nextScore / 10) % 2 !== 0;
          const spawnY = Math.floor(Math.random() * (WORLD_HEIGHT / GRID_SIZE)) * GRID_SIZE;
          const nextBoss = {
            active: true,
            direction: ltr ? 'LTR' : 'RTL' as const,
            x: ltr ? -GRID_SIZE * 20 : WORLD_WIDTH + GRID_SIZE * 5,
            y: spawnY,
            baseY: spawnY,
            phase: 0,
            speedMult: 1,
            health: 150 + nextScore,
            maxHealth: 150 + nextScore
          };
          setBossSnake(nextBoss);
          socketRef.current?.emit('sync-boss', { roomId, bossSnake: nextBoss });
          playSound('boss');
          
          // Spawn extra foods for total 3
          spawnFood(WORLD_WIDTH, WORLD_HEIGHT, 2);
          setBossExitTime(null);
        }
      } else {
        const removedTail = newBody.pop();
        if (removedTail) {
          setTrail(prev => [{ ...removedTail, life: 1.0 }, ...prev].slice(0, 20));
        }
      }

      // Sync state to server
      socketRef.current?.emit('update-state', {
        roomId,
        player: { snakeBody: newBody, score, direction }
      });

      return newBody;
    });

    // --- NPC AI UPDATE ---
    if (npcSnakes.length > 0) {
      setNpcSnakes(prevNpcs => {
        const deadNpcIndices: number[] = [];
        const nextNpcs = prevNpcs.map((npc, idx) => {
          let { direction: npcDir, targetPoint, snakeBody: npcBody, speedMult, wanderingPhase = 0, targetMood = 'scavenge', moodTimer = 0, patrolPoint } = npc;
          const head = npcBody[0];

          // 1. Contextual Intelligence & Mood Management
          const playerHead = snakeBody[0];
          const config = DIFFICULTY_CONFIG[difficulty];
          const otherPlayersList = Array.from(otherPlayers.values());
          
          if (moodTimer > 0) moodTimer--;
          else {
             // Dynamic Mood Selection
             const rand = Math.random();
             if (rand < 0.05) { targetMood = 'patrol'; patrolPoint = { x: Math.random() * WORLD_WIDTH, y: Math.random() * WORLD_HEIGHT }; }
             else if (rand < 0.1) { targetMood = 'curious'; targetPoint = { x: Math.random() * WORLD_WIDTH, y: Math.random() * WORLD_HEIGHT }; }
             else if (rand < 0.8) { targetMood = 'hunt'; } // Primary mode is hunting
             else { targetMood = 'scavenge'; }
             moodTimer = 50 + Math.random() * 100; // Faster mood shifts
          }

          // NPCs have dynamic aggression based on distance and mood
          const baseAggressionRange = 1500 + config.npcAggression * 1500; // Increased range
          
          // 1.1 Find the best target among all entities (Players or NPCs)
          let bestTarget = { pos: playerHead, dist: Math.sqrt(Math.pow(head.x - playerHead.x, 2) + Math.pow(head.y - playerHead.y, 2)), dir: direction, type: 'player' };
          
          prevNpcs.forEach((other, oIdx) => {
            if (oIdx === idx) return;
            const d = Math.sqrt(Math.pow(head.x - other.snakeBody[0].x, 2) + Math.pow(head.y - other.snakeBody[0].y, 2));
            // NPCs are highly aggressive toward other NPCs too
            const weight = 1.0; // Equal priority for now to maximize chaos
            if (d * weight < bestTarget.dist) {
              bestTarget = { pos: other.snakeBody[0], dist: d, dir: other.direction, type: 'npc' };
            }
          });

          otherPlayersList.forEach((other: any) => {
             const op = other as OtherPlayer;
             const d = Math.sqrt(Math.pow(head.x - op.snakeBody[0].x, 2) + Math.pow(head.y - op.snakeBody[0].y, 2));
             if (d < bestTarget.dist) {
               bestTarget = { pos: op.snakeBody[0], dist: d, dir: op.direction, type: 'other-player' };
             }
          });

          const isAggressive = bestTarget.dist < baseAggressionRange || targetMood === 'hunt';
          const currentSpeed = isAggressive ? (speedMult || 1.0) * (1.1 + config.npcAggression * 0.4) : (speedMult || 1.0);

          // AI Reaction Logic: Update target more intelligently
          const shouldUpdateTarget = !targetPoint || 
                                   (Math.abs(head.x - targetPoint.x) < GRID_SIZE * 3 && Math.abs(head.y - targetPoint.y) < GRID_SIZE * 3) || 
                                   (isAggressive && Math.random() > 0.6) || 
                                   Math.random() > 0.95;

          if (shouldUpdateTarget) {
            if (targetMood === 'patrol' && patrolPoint) {
               // Circle around patrol point
               wanderingPhase += 0.5;
               targetPoint = {
                 x: patrolPoint.x + Math.cos(wanderingPhase) * 600,
                 y: patrolPoint.y + Math.sin(wanderingPhase) * 600
               };
            } else if (isAggressive && (bestTarget.dist < 600 || foodList.length === 0)) {
               // HUNT / INTERCEPT
               const predictFactor = 15 + config.npcAggression * 20;
               const predictDist = GRID_SIZE * predictFactor;
               let px = bestTarget.pos.x;
               let py = bestTarget.pos.y;
               
               if (bestTarget.dir === 0) px += predictDist;
               else if (bestTarget.dir === 1) py += predictDist;
               else if (bestTarget.dir === 2) px -= predictDist;
               else if (bestTarget.dir === 3) py -= predictDist;

               targetPoint = { 
                 x: px + (Math.random() - 0.5) * GRID_SIZE * 2, 
                 y: py + (Math.random() - 0.5) * GRID_SIZE * 2 
               };
            } else if (targetMood === 'curious' || foodList.length === 0) {
               // EXPLORATION
               wanderingPhase += (Math.random() * 0.4 + 0.1);
               const wanderRad = 1000 + Math.sin(wanderingPhase * 0.1) * 500;
               targetPoint = {
                 x: head.x + Math.cos(wanderingPhase) * wanderRad,
                 y: head.y + Math.sin(wanderingPhase) * wanderRad
               };
            } else {
              // SCAVENGE / Resource Priority
              const searchRange = 1500;
              const nearbyFood = foodList.filter(f => Math.abs(f.x - head.x) < searchRange && Math.abs(f.y - head.y) < searchRange);
              
              if (nearbyFood.length > 0) {
                // Swarm detection: if food is clustered, NPCs are more likely to target the cluster
                let nearest = nearbyFood[0];
                let minDist = 1000000;
                nearbyFood.forEach(f => {
                  const d = Math.sqrt(Math.pow(f.x - head.x, 2) + Math.pow(f.y - head.y, 2));
                  const weight = (f.type && f.type !== 'normal') ? 0.05 : 1.0; 
                  const weightedDist = d * weight;
                  if (weightedDist < minDist) { minDist = weightedDist; nearest = f; }
                });
                targetPoint = nearest;
              } else {
                targetMood = 'curious';
              }
            }
          }

          // 2. Multi-Directional Planning with Smart Avoidance
          const getPos = (d: number) => {
            const p = { ...head };
            if (d === 0) p.x += GRID_SIZE;
            else if (d === 1) p.y += GRID_SIZE;
            else if (d === 2) p.x -= GRID_SIZE;
            else if (d === 3) p.y -= GRID_SIZE;
            return p;
          };

          const isColliding = (pos: Point) => {
            if (pos.x < 0 || pos.x >= WORLD_WIDTH || pos.y < 0 || pos.y >= WORLD_HEIGHT) return true;
            
            // AGGRESSIVE AVOIDANCE ZONE
            const hitBuffer = GRID_SIZE * 1.8; 
            
            // Proactive avoidance of player path
            const playerPredictDist = GRID_SIZE * 4;
            let ppx = playerHead.x;
            let ppy = playerHead.y;
            if (direction === 0) ppx += playerPredictDist;
            else if (direction === 1) ppy += playerPredictDist;
            else if (direction === 2) ppx -= playerPredictDist;
            else if (direction === 3) ppy -= playerPredictDist;

            if (Math.abs(pos.x - ppx) < hitBuffer && Math.abs(pos.y - ppy) < hitBuffer) return true;

            // Avoid player body
            for (const s of snakeBody) {
                if (Math.abs(s.x - pos.x) < hitBuffer && Math.abs(s.y - pos.y) < hitBuffer) return true;
            }
            
            // Avoid other NPCs body
            for (let i = 0; i < prevNpcs.length; i++) {
              const other = prevNpcs[i];
              const segmentsToIgnore = (i === idx) ? 1 : 0;
              for (let j = segmentsToIgnore; j < other.snakeBody.length; j++) {
                const s = other.snakeBody[j];
                if (Math.abs(s.x - pos.x) < hitBuffer && Math.abs(s.y - pos.y) < hitBuffer) return true;
              }
            }

            // Boss Avoidance
            if (bossSnake.active) {
                const bossDist = Math.sqrt(Math.pow(pos.x - bossSnake.x, 2) + Math.pow(pos.y - bossSnake.y, 2));
                if (bossDist < GRID_SIZE * 10) return true;
            }

            return false;
          };

          const dx = targetPoint.x - head.x;
          const dy = targetPoint.y - head.y;
          
          let preferredDirs = [
            { dir: 0, score: dx > 0 ? Math.abs(dx) : -1 }, // Right
            { dir: 1, score: dy > 0 ? Math.abs(dy) : -1 }, // Down
            { dir: 2, score: dx < 0 ? Math.abs(dx) : -1 }, // Left
            { dir: 3, score: dy < 0 ? Math.abs(dy) : -1 }  // Up
          ].sort((a, b) => b.score - a.score);

          let finalDir = npcDir;
          let minRisk = 1000;
          let bestDir = npcDir;

          for (const choice of preferredDirs) {
            if ((choice.dir + 2) % 4 === npcDir) continue;
            
            const nextP = getPos(choice.dir);
            if (!isColliding(nextP)) {
               // Look ahead even deeper for risk assessment
               let risk = 0;
               const nextNextDirs = [0, 1, 2, 3].filter(d => (d + 2) % 4 !== choice.dir);
               let escapePaths = 0;
               for (const nd of nextNextDirs) {
                 if (!isColliding(getPos(nd))) escapePaths++;
               }
               
               if (escapePaths > 0) {
                 bestDir = choice.dir;
                 minRisk = escapePaths;
                 break; 
               }
            }
          }

          const nextHead = getPos(bestDir);
          const newNpcsBody = [nextHead, ...npcBody];
          
          const fIdx = foodList.findIndex(f => Math.abs(nextHead.x - f.x) < GRID_SIZE && Math.abs(nextHead.y - f.y) < GRID_SIZE);
          if (fIdx !== -1) {
            if (newNpcsBody.length > 50) newNpcsBody.pop(); 
          } else {
            newNpcsBody.pop();
          }
          
          return { ...npc, snakeBody: newNpcsBody, direction: bestDir, targetPoint, speedMult: currentSpeed, wanderingPhase, targetMood, moodTimer, patrolPoint };
        });

        // POST MOVE RESOLUTION
        nextNpcs.forEach((npc, i) => {
          if (deadNpcIndices.includes(i)) return;
          const headPos = npc.snakeBody[0];
          const collisionDist = GRID_SIZE * 0.8;

          if (headPos.x < 0 || headPos.x >= WORLD_WIDTH || headPos.y < 0 || headPos.y >= WORLD_HEIGHT) {
            deadNpcIndices.push(i);
            return;
          }

          if (snakeBody.some(s => Math.abs(s.x - headPos.x) < collisionDist && Math.abs(s.y - headPos.y) < collisionDist)) {
            deadNpcIndices.push(i);
            return;
          }

          // Self collision (newly enforcing)
          if (npc.snakeBody.slice(1).some(s => Math.abs(s.x - headPos.x) < collisionDist && Math.abs(s.y - headPos.y) < collisionDist)) {
            deadNpcIndices.push(i);
            return;
          }

          for (let j = 0; j < nextNpcs.length; j++) {
            if (i === j) continue;
            const overlap = nextNpcs[j].snakeBody.some((s) => {
              return Math.abs(s.x - headPos.x) < collisionDist && Math.abs(s.y - headPos.y) < collisionDist;
            });
            if (overlap) {
              deadNpcIndices.push(i);
              return;
            }
          }
        });

        if (deadNpcIndices.length > 0) {
          const newFoods: Point[] = [];
          deadNpcIndices.forEach(i => {
            const deadNpc = prevNpcs[i];
            deadNpc.snakeBody.forEach(s => {
              if (Math.random() > 0.4) newFoods.push({ x: s.x, y: s.y, type: 'normal' });
            });
            createExplosion(deadNpc.snakeBody[0].x, deadNpc.snakeBody[0].y, `hsl(${deadNpc.hue}, 80%, 60%)`);
          });
          if (newFoods.length > 0) setFoodList(f => [...f, ...newFoods]);
          
          const survivors = nextNpcs.filter((_, i) => !deadNpcIndices.includes(i));
          
          // Rapid Respawn with variation
          for (let i = 0; i < deadNpcIndices.length; i++) {
            const x = Math.floor(Math.random() * (WORLD_WIDTH / GRID_SIZE)) * GRID_SIZE;
            const y = Math.floor(Math.random() * (WORLD_HEIGHT / GRID_SIZE)) * GRID_SIZE;
            survivors.push({
              id: `npc-${Math.random().toString(36).substr(2, 9)}`,
              snakeBody: [{ x, y }, { x: x - GRID_SIZE, y }, { x: x - GRID_SIZE * 2, y }],
              score: 0, 
              direction: Math.floor(Math.random() * 4), 
              hue: Math.random() * 360, 
              targetPoint: null, 
              speedMult: 0.9 + Math.random() * 0.5,
              targetMood: 'scavenge',
              moodTimer: 100,
              wanderingPhase: Math.random() * Math.PI * 2
            });
          }
          return survivors;
        }
        return nextNpcs;
      });
    }

    npcSnakes.forEach(npc => {
        const h = snakeBody[0];
        const isGhost = activePowerUps.ghost > Date.now();
        if (!isGhost && npc.snakeBody.slice(1).some(s => Math.abs(s.x - h.x) < GRID_SIZE && Math.abs(s.y - h.y) < GRID_SIZE)) {
            setFoodList(f => [...f, ...snakeBody.map(s => ({ x: s.x, y: s.y, type: 'normal' as const }))]);
            triggerShake();
            endGame();
        }
    });
  }, [direction, dimensions, foodList, score, bossSnake, snakeBody, npcSnakes, otherPlayers, endGame, playSound, createExplosion, triggerShake, submitScore, roomId, spawnFood, COLORS.food]);

  const updateContinuous = useCallback(() => {
    // Boosting Effects
    if (isBoosting) {
      const h = snakeBody[0];
      const newP = [];
      for (let i = 0; i < 2; i++) {
        newP.push({
          x: h.x + GRID_SIZE / 2 + (Math.random() - 0.5) * GRID_SIZE,
          y: h.y + GRID_SIZE / 2 + (Math.random() - 0.5) * GRID_SIZE,
          vx: (Math.random() - 0.5) * 1,
          vy: (Math.random() - 0.5) * 1,
          size: Math.random() * 4 + 2,
          life: 1.0,
          color: COLORS.head
        });
      }
      setParticles(prev => [...prev, ...newP].slice(-100));
      
      // Speed trail segments
      if (Math.random() > 0.5) {
        setTrail(prev => [{ x: h.x, y: h.y, life: 0.8, type: 'boost' }, ...prev].slice(0, 30));
      }
    }

    // Update Particles
    setParticles(prev => 
      prev
        .map(p => ({ ...p, x: p.x + p.vx, y: p.y + p.vy, life: p.life - 0.02 }))
        .filter(p => p.life > 0)
    );

    // Update Trail
    setTrail(prev => 
      prev
        .map(t => ({ ...t, life: t.life - 0.15 }))
        .filter(t => t.life > 0)
    );

    // Boss Independent Logic
    if (bossSnake.active) {
      setBossSnake(prev => {
        const h = snakeBody[0];
        const distToPlayer = Math.sqrt(Math.pow(prev.x - h.x, 2) + Math.pow(prev.y - h.y, 2));
        
        let mode = prev.mode || 'patrol';
        let stunTimer = prev.stunTimer || 0;
        let stunProgress = prev.stunProgress || 0;
        let speed = 0.5 + (prev.speedMult || 0.5) * 0.5;
        let chargeLevel = prev.chargeLevel || 0;
        let warning = prev.warning || false;

        // Handle Stun State
        if (stunTimer > 0) {
          stunTimer--;
          if (stunTimer === 0) {
            mode = 'hunt';
            stunProgress = 0;
          } else {
            mode = 'stunned';
            warning = false;
            return { ...prev, mode, stunTimer, stunProgress, warning };
          }
        }
        
        // Transition logic & Attack Patterns
        if (mode !== 'charge' && mode !== 'stunned') {
          if (distToPlayer < 350) mode = 'trap';
          else if (distToPlayer < 700) mode = 'hunt';
          else mode = 'patrol';

          // Randomly initiate charge attack
          if (Date.now() - (prev.lastAttack || 0) > 6000 && Math.random() > 0.98) {
             mode = 'charge';
             chargeLevel = 0;
          }
        }

        if (mode === 'hunt') speed *= 1.6;
        if (mode === 'trap') speed *= 0.7;
        if (mode === 'charge') {
          speed = 0.2; // Slow down while charging
          chargeLevel += 0.02;
          if (chargeLevel > 0.7) warning = true; // Telegraphing last 30% of charge
          
          if (chargeLevel >= 1) {
            // FIRE VOLLEY
            const bulletCount = 8;
            const newProjectiles: BossProjectile[] = [];
            for (let i = 0; i < bulletCount; i++) {
              const angle = (i * Math.PI * 2) / bulletCount;
              newProjectiles.push({
                x: prev.x,
                y: prev.y,
                dx: Math.cos(angle) * 12,
                dy: Math.sin(angle) * 12,
                id: Date.now() + i,
                life: 1.2
              });
            }
            setBossProjectiles(bp => [...bp, ...newProjectiles]);
            createExplosion(prev.x, prev.y, '#F87171');
            triggerShake();
            mode = 'hunt';
            chargeLevel = 0;
            warning = false;
            prev.lastAttack = Date.now();
          }
        }

        const frameDist = (GRID_SIZE / 12) * speed;
        
        let nextX = prev.x;
        let nextY = prev.y;
        let currentDir = prev.direction as any;

        // Regular Projectile (Single shot)
        if (prev.active && mode !== 'charge' && mode !== 'stunned' && Date.now() - (prev.lastAttack || 0) > 3000) {
           const angle = Math.atan2(h.y - prev.y, h.x - prev.x);
           const bullet = {
             x: prev.x,
             y: prev.y,
             dx: Math.cos(angle) * 14,
             dy: Math.sin(angle) * 14,
             id: Date.now(),
             life: 1.0
           };
           setBossProjectiles(bp => [...bp, bullet]);
           prev.lastAttack = Date.now();
        }

        if (mode === 'trap') {
          const currentAngle = Math.atan2(prev.y - h.y, prev.x - h.x);
          const nextAngle = currentAngle + 0.08;
          const targetRadius = 240 + Math.sin(Date.now() / 600) * 40;
          const targetX = h.x + Math.cos(nextAngle) * targetRadius;
          const targetY = h.y + Math.sin(nextAngle) * targetRadius;
          nextX = prev.x + (targetX - prev.x) * 0.1;
          nextY = prev.y + (targetY - prev.y) * 0.1;
        } else if (mode === 'charge') {
          nextX += (h.x - prev.x) * 0.01;
          nextY += (h.y - prev.y) * 0.01;
        } else {
          if (currentDir === 'LTR') nextX += frameDist;
          else if (currentDir === 'RTL') nextX -= frameDist;
          else if (currentDir === 'UTD') nextY += frameDist;
          else if (currentDir === 'DTU') nextY -= frameDist;

          const buffer = 100;
          let newDir = currentDir;
          if (nextX > WORLD_WIDTH - buffer) newDir = 'RTL';
          else if (nextX < buffer) newDir = 'LTR';
          else if (nextY > WORLD_HEIGHT - buffer) newDir = 'DTU';
          else if (nextY < buffer) newDir = 'UTD';
          currentDir = newDir;
        }

        const nextPhase = prev.phase + 0.05;
        const driftY = (currentDir === 'LTR' || currentDir === 'RTL' && mode !== 'trap') ? Math.sin(nextPhase) * 2 : 0;
        const driftX = (currentDir === 'UTD' || currentDir === 'DTU' && mode !== 'trap') ? Math.sin(nextPhase) * 2 : 0;

        // Damage calculation
        let damageTaken = 0;
        const isMultiplier = activePowerUps.multiplier > Date.now();
        const boostBonus = isBoosting ? 0.9 : 0.04;
        const multiplierBonus = isMultiplier ? 2.5 : 1.0;
        
        for (let i = 0; i < 20; i++) {
          const sx = currentDir === 'LTR' || currentDir === 'RTL' 
            ? (currentDir === 'LTR' ? prev.x - i * GRID_SIZE : prev.x + i * GRID_SIZE)
            : prev.x;
          const sy = currentDir === 'UTD' || currentDir === 'DTU'
            ? (currentDir === 'UTD' ? prev.y - i * GRID_SIZE : prev.y + i * GRID_SIZE)
            : prev.y;
          
          const d = Math.sqrt(Math.pow(h.x - sx, 2) + Math.pow(h.y - sy, 2));
          if (d < GRID_SIZE * 3.5) {
            damageTaken += boostBonus * multiplierBonus;
            stunProgress += (boostBonus * multiplierBonus * 0.4);
            if ((isBoosting || isMultiplier) && Math.random() > 0.8) {
              createExplosion(h.x, h.y, isMultiplier ? '#60A5FA' : '#EF4444');
            }
          }
        }

        if (stunProgress >= 40 && mode !== 'stunned') {
           mode = 'stunned';
           stunTimer = 180;
           stunProgress = 0;
           createExplosion(prev.x, prev.y, '#60A5FA');
           playSound('boss');
        }

        if (damageTaken > 0) {
          const newHealth = prev.health - damageTaken;
          if (newHealth <= 0) {
            createExplosion(prev.x, prev.y, '#FACC15');
            playSound('eat');
            triggerShake();
            setScore(s => s + 750);
            return { ...prev, active: false, health: 0 };
          }
          return { ...prev, health: newHealth, x: nextX + driftX, y: nextY + driftY, phase: nextPhase, direction: currentDir, mode, chargeLevel, warning, stunTimer, stunProgress };
        }

        return { ...prev, x: nextX + driftX, y: nextY + driftY, phase: nextPhase, direction: currentDir, mode, chargeLevel, warning, stunTimer, stunProgress };
      });

      // Update Projectiles
      setBossProjectiles(prev => {
        const next = prev.map(p => ({
           ...p,
           x: p.x + p.dx,
           y: p.y + p.dy,
           life: p.life - 0.015
        })).filter(p => p.life > 0);

        const h = snakeBody[0];
        const isGhost = activePowerUps.ghost > Date.now();
        if (!isGhost) {
           next.forEach(p => {
              if (Math.abs(h.x - p.x) < GRID_SIZE * 1.5 && Math.abs(h.y - p.y) < GRID_SIZE * 1.5) {
                triggerShake();
                endGame();
              }
           });
        }
        return next;
      });

      const h = snakeBody[0];
      const isGhost = activePowerUps.ghost > Date.now();

      for (let i = 0; i < 25; i++) {
        const sx = bossSnake.direction === 'LTR' || bossSnake.direction === 'RTL' 
          ? (bossSnake.direction === 'LTR' ? bossSnake.x - i * GRID_SIZE : bossSnake.x + i * GRID_SIZE)
          : bossSnake.x;
        const sy = bossSnake.direction === 'UTD' || bossSnake.direction === 'DTU'
          ? (bossSnake.direction === 'UTD' ? bossSnake.y - i * GRID_SIZE : bossSnake.y + i * GRID_SIZE)
          : bossSnake.y;
        
        if (!isGhost && Math.sqrt(Math.pow(h.x - sx, 2) + Math.pow(h.y - sy, 2)) < GRID_SIZE * 2.5) {
          triggerShake();
          endGame(); break;
        }
      }
    }
  }, [bossSnake, snakeBody, npcSnakes, COLORS, foodList, roomId, playSound, triggerShake, createExplosion, isBoosting]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const time = Date.now();
    const pulse = (Math.sin(time / 150) + 1) / 2;

    // Calculate Camera Position
    const head = snakeBody[0];
    const viewW = dimensions.width / zoomLevel;
    const viewH = dimensions.height / zoomLevel;
    
    const targetCamX = head.x - viewW / 2;
    const targetCamY = head.y - viewH / 2;
    
    // Clamp camera to world bounds
    const camX = Math.max(0, Math.min(targetCamX, WORLD_WIDTH - viewW));
    const camY = Math.max(0, Math.min(targetCamY, WORLD_HEIGHT - viewH));

    // Clear and draw background (viewport relative)
    ctx.fillStyle = bossSnake.active ? '#064e3b' : COLORS.bg; // Darker green for boss fight
    ctx.fillRect(0, 0, dimensions.width, dimensions.height);

    // Enter World Coordinates
    ctx.save();
    ctx.scale(zoomLevel, zoomLevel);
    ctx.translate(-camX, -camY);

    // Telegraphing: Boss Warning visuals
    if (bossSnake.active && bossSnake.warning) {
      // Circle on Boss
      ctx.beginPath();
      ctx.arc(bossSnake.x, bossSnake.y, GRID_SIZE * 15, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.4 + Math.sin(time / 100) * 0.3})`;
      ctx.lineWidth = 4;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(bossSnake.x, bossSnake.y, GRID_SIZE * 12, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(239, 68, 68, ${0.3 + Math.sin(time / 100) * 0.2})`;
      ctx.lineWidth = 3;
      ctx.setLineDash([15, 10]);
      ctx.lineDashOffset = -time / 25;
      ctx.stroke();
      
      const head = snakeBody[0];
      // Target Line
      ctx.beginPath();
      ctx.moveTo(bossSnake.x, bossSnake.y);
      ctx.lineTo(head.x, head.y);
      ctx.strokeStyle = `rgba(239, 68, 68, ${0.5 + Math.sin(time / 50) * 0.3})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([8, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Lock-on indicator on Player
      ctx.save();
      ctx.translate(head.x + GRID_SIZE/2, head.y + GRID_SIZE/2);
      ctx.rotate(time / 500);
      ctx.strokeStyle = '#EF4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for(let i=0; i<4; i++) {
        ctx.moveTo(GRID_SIZE * 2, 0);
        ctx.lineTo(GRID_SIZE * 3, 0);
        ctx.rotate(Math.PI / 2);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Draw Particles
    particles.forEach(p => {
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;

    // Draw Trail
    trail.forEach(t => {
      ctx.globalAlpha = t.life * 0.4;
      ctx.fillStyle = COLORS.body;
      ctx.shadowBlur = 10 * t.life;
      ctx.shadowColor = COLORS.body;
      ctx.beginPath();
      ctx.arc(t.x + GRID_SIZE / 2, t.y + GRID_SIZE / 2, (GRID_SIZE / 2 - 1) * t.life, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;

    // Draw Foods with Sophisticated Designs
    foodList.forEach((food, idx) => {
      const isSuper = food.type === 'super';
      const isShield = food.type === 'shield';
      const isMultiplier = food.type === 'multiplier';
      const isSlowMo = food.type === 'slowMo';
      const isGhost = food.type === 'ghost';
      
      let color = COLORS.food;
      if (isSuper) color = '#3B82F6';
      else if (isShield) color = '#60A5FA';
      else if (isMultiplier) color = '#F59E0B';
      else if (isSlowMo) color = '#A855F7';
      else if (isGhost) color = '#00F5FF';

      const sizeMult = (isSuper || isShield || isMultiplier || isSlowMo || isGhost) ? 1.6 : 1;
      const size = GRID_SIZE * sizeMult;
      const centerX = food.x + GRID_SIZE / 2;
      const centerY = food.y + GRID_SIZE / 2;

      ctx.shadowBlur = (isSuper || isShield || isMultiplier || isSlowMo || isGhost) ? 30 : 15;
      ctx.shadowColor = color;
      ctx.fillStyle = color;
      
      const designSeed = (idx % 8);

      if (isSuper || isShield || isMultiplier || isSlowMo || isGhost) {
          // Power-up background glow
          ctx.beginPath();
          ctx.arc(centerX, centerY, (size / 2.2) + (pulse * 3 * sizeMult), 0, Math.PI * 2);
          ctx.fill();
          
          // Inner icon / detail
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'white';
          ctx.font = `900 ${Math.floor(size * 0.5)}px Inter`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          if (isShield) {
              // Shield Icon (Cross-like shield)
              const w = size * 0.18;
              const h = size * 0.3;
              ctx.beginPath();
              ctx.moveTo(centerX, centerY - h);
              ctx.lineTo(centerX + w, centerY - h*0.5);
              ctx.lineTo(centerX + w, centerY + h*0.4);
              ctx.lineTo(centerX, centerY + h*0.8);
              ctx.lineTo(centerX - w, centerY + h*0.4);
              ctx.lineTo(centerX - w, centerY - h*0.5);
              ctx.closePath();
              ctx.fill();
          } else if (isMultiplier) {
              // Multiplier "x2"
              ctx.fillText('2x', centerX, centerY);
          } else if (isSlowMo) {
              // SlowMo (Clock-like)
              ctx.beginPath();
              ctx.arc(centerX, centerY, size * 0.22, 0, Math.PI * 2);
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = 'white';
              ctx.stroke();
              ctx.beginPath();
              ctx.moveTo(centerX, centerY);
              ctx.lineTo(centerX, centerY - size * 0.15);
              ctx.moveTo(centerX, centerY);
              ctx.lineTo(centerX + size * 0.1, centerY);
              ctx.stroke();
          } else if (isGhost) {
              // Ghost Icon (Smoother shape)
              const r = size * 0.18;
              ctx.beginPath();
              ctx.arc(centerX, centerY - r/2, r, Math.PI, 0);
              ctx.lineTo(centerX + r, centerY + r);
              ctx.lineTo(centerX + r/2, centerY + r/2);
              ctx.lineTo(centerX, centerY + r);
              ctx.lineTo(centerX - r/2, centerY + r/2);
              ctx.lineTo(centerX - r, centerY + r);
              ctx.closePath();
              ctx.fill();
          } else if (isSuper) {
              // Super (Improved Star)
              ctx.beginPath();
              for (let i = 0; i < 10; i++) {
                const angle = (i * Math.PI) / 5 - Math.PI / 2;
                const dist = i % 2 === 0 ? size * 0.35 : size * 0.15;
                ctx.lineTo(centerX + Math.cos(angle) * dist, centerY + Math.sin(angle) * dist);
              }
              ctx.closePath();
              ctx.fill();
          }
      } else {
          // Extended Regular food designs
          const rad = (size / 2.5) + (pulse * 1);
          if (designSeed === 0) { // Diamond
              ctx.beginPath();
              ctx.moveTo(centerX, centerY - rad);
              ctx.lineTo(centerX + rad, centerY);
              ctx.lineTo(centerX, centerY + rad);
              ctx.lineTo(centerX - rad, centerY);
              ctx.closePath();
              ctx.fill();
          } else if (designSeed === 1) { // 5-Point Star
              ctx.beginPath();
              for(let i=0; i<10; i++) {
                  const angle = (i * Math.PI) / 5 - Math.PI/2;
                  const r = i % 2 === 0 ? rad : rad * 0.5;
                  ctx.lineTo(centerX + Math.cos(angle) * r, centerY + Math.sin(angle) * r);
              }
              ctx.closePath();
              ctx.fill();
          } else if (designSeed === 2) { // Hexagon
              ctx.beginPath();
              for(let i=0; i<6; i++) {
                const angle = (i * Math.PI) / 3;
                ctx.lineTo(centerX + Math.cos(angle) * rad, centerY + Math.sin(angle) * rad);
              }
              ctx.closePath();
              ctx.fill();
          } else if (designSeed === 3) { // Square
              ctx.fillRect(centerX - rad*0.8, centerY - rad*0.8, rad*1.6, rad*1.6);
          } else if (designSeed === 4) { // Pulse Ring
              ctx.beginPath();
              ctx.arc(centerX, centerY, rad, 0, Math.PI * 2);
              ctx.stroke();
              ctx.fill();
          } else if (designSeed === 5) { // Cross
              const w = rad * 0.4;
              ctx.fillRect(centerX - w, centerY - rad, w*2, rad*2);
              ctx.fillRect(centerX - rad, centerY - w, rad*2, w*2);
          } else if (designSeed === 6) { // Triangle
              ctx.beginPath();
              ctx.moveTo(centerX, centerY - rad);
              ctx.lineTo(centerX + rad, centerY + rad);
              ctx.lineTo(centerX - rad, centerY + rad);
              ctx.closePath();
              ctx.fill();
          } else { // Classic Circle
              ctx.beginPath();
              ctx.arc(centerX, centerY, rad, 0, Math.PI * 2);
              ctx.fill();
          }
      }
      ctx.shadowBlur = 0; 
    });

    // Draw Boss Snake
    if (bossSnake.active) {
      const bossLen = 18;
      const time = Date.now();
      
      for (let i = 0; i < bossLen; i++) {
        // Individual segment movement for "slither" effect
        const segX = bossSnake.direction === 'LTR' ? 
          bossSnake.x - (i * GRID_SIZE * 1.8) : 
          bossSnake.x + (i * GRID_SIZE * 1.8);
        
        // Match the update phase logic for wavy drawing
        const segY = bossSnake.y - Math.sin(bossSnake.phase - i * 0.4) * (GRID_SIZE * 4);
        
        const sizeMult = i === 0 ? 4.5 : 3.5 - (i * 0.05); // Tapered body
        const pulseGlow = (Math.sin(time / 150 - i * 0.5) + 1) / 2;
        
        // Base Color using Theme Accent but shifting slightly
        if (bossSnake.mode === 'stunned') {
          ctx.fillStyle = i === 0 ? '#BFDBFE' : '#60A5FA';
          ctx.shadowColor = '#60A5FA';
        } else {
          ctx.fillStyle = i === 0 ? COLORS.accent : `${COLORS.accent}dd`;
          ctx.shadowColor = COLORS.accent;
        }
        
        ctx.shadowBlur = (i === 0 ? 40 : 20) * pulseGlow;
        
        ctx.beginPath();
        ctx.arc(segX, segY, (GRID_SIZE * sizeMult) / 2, 0, Math.PI * 2);
        ctx.fill();

        if (bossSnake.mode === 'stunned') {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(segX, segY, ((GRID_SIZE * sizeMult) / 2) + Math.sin(time/200 + i) * 5, 0, Math.PI * 2);
          ctx.stroke();

          if (i === 0) {
            ctx.fillStyle = 'white';
            ctx.font = 'bold 20px Inter';
            ctx.textAlign = 'center';
            ctx.fillText('STUNNED', segX, segY - GRID_SIZE * 8);
          }
        }

        if (bossSnake.warning && bossSnake.mode !== 'stunned') {
          ctx.fillStyle = `rgba(255, 255, 255, ${0.2 + Math.sin(time / 100 + i * 0.3) * 0.1})`;
          ctx.beginPath();
          ctx.arc(segX, segY, ((GRID_SIZE * sizeMult) / 2) * 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
        
        // Detail / Shine
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.beginPath();
        ctx.arc(segX - (GRID_SIZE * sizeMult) * 0.2, segY - (GRID_SIZE * sizeMult) * 0.2, (GRID_SIZE * sizeMult) / 6, 0, Math.PI * 2);
        ctx.fill();
        
        // Intimidating Head Details
        if (i === 0) {
          // Glowing Eyes
          const eyeOffset = (GRID_SIZE * sizeMult) * 0.25;
          ctx.shadowBlur = 15;
          ctx.shadowColor = '#FACC15';
          ctx.fillStyle = '#FACC15';
          
          ctx.beginPath();
          ctx.arc(bossSnake.direction === 'LTR' ? segX + eyeOffset : segX - eyeOffset, segY - eyeOffset, GRID_SIZE * 0.8, 0, Math.PI * 2);
          ctx.arc(bossSnake.direction === 'LTR' ? segX + eyeOffset : segX - eyeOffset, segY + eyeOffset, GRID_SIZE * 0.8, 0, Math.PI * 2);
          ctx.fill();
          
          // Slit pupils
          ctx.fillStyle = 'black';
          ctx.fillRect(bossSnake.direction === 'LTR' ? segX + eyeOffset - 1 : segX - eyeOffset - 1, segY - eyeOffset - GRID_SIZE*0.4, 2, GRID_SIZE*0.8);
          ctx.fillRect(bossSnake.direction === 'LTR' ? segX + eyeOffset - 1 : segX - eyeOffset - 1, segY + eyeOffset - GRID_SIZE*0.4, 2, GRID_SIZE*0.8);
        }
      }
      ctx.shadowBlur = 0;
    }

    // Draw Boss Projectiles
    bossProjectiles.forEach(p => {
       ctx.shadowBlur = 15;
       ctx.shadowColor = '#fb923c';
       ctx.fillStyle = '#fb923c';
       ctx.beginPath();
       ctx.arc(p.x, p.y, GRID_SIZE * 0.8, 0, Math.PI * 2);
       ctx.fill();
       
       // Core glow
       ctx.fillStyle = 'white';
       ctx.beginPath();
       ctx.arc(p.x, p.y, GRID_SIZE * 0.4, 0, Math.PI * 2);
       ctx.fill();
    });
    ctx.shadowBlur = 0;

    // Draw Snake
    snakeBody.forEach((segment, i) => {
      const isGhost = activePowerUps.ghost > Date.now();
      const alpha = isGhost ? 0.4 + Math.sin(time / 100) * 0.2 : 1.0;
      ctx.globalAlpha = alpha;

      if (i === 0) {
        ctx.fillStyle = playerColors.head;
      } else {
        const opacity = Math.max(0.3, 1 - (i / (snakeBody.length + 5)));
        ctx.fillStyle = playerColors.body;
        ctx.globalAlpha = alpha * opacity;
      }
      
      if (i === 0) {
        ctx.shadowBlur = isBoosting ? 40 : 20;
        ctx.shadowColor = playerColors.head;
        if (isBoosting) {
          ctx.strokeStyle = playerColors.head;
          ctx.lineWidth = 2;
          ctx.strokeRect(segment.x - 2, segment.y - 2, GRID_SIZE + 4, GRID_SIZE + 4);
        }
      } else {
        ctx.shadowBlur = 5;
        ctx.shadowColor = playerColors.body;
      }
      
      const pulseMult = 1 + (Math.sin(time / 400 - i * 0.3) * 0.08);
      const radius = (GRID_SIZE / 2 - 1) * pulseMult;
      const centerX = segment.x + GRID_SIZE / 2;
      const centerY = segment.y + GRID_SIZE / 2;
      
      ctx.beginPath();
      if (i === 0) {
        const padding = 1 - (pulseMult - 1) * 2;
        const size = GRID_SIZE - padding * 2;
        // Use regular rect for compatibility
        ctx.rect(segment.x + padding, segment.y + padding, size, size);
      } else {
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1.0;

      if (i > 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath();
        ctx.arc(centerX - radius * 0.3, centerY - radius * 0.3, radius / 3, 0, Math.PI * 2);
        ctx.fill();
      }

      if (i === 0) {
        ctx.fillStyle = 'white';
        const eyeSize = 1.5;
        ctx.beginPath();
        ctx.arc(segment.x + GRID_SIZE * 0.35, segment.y + GRID_SIZE * 0.4, eyeSize, 0, Math.PI * 2);
        ctx.arc(segment.x + GRID_SIZE * 0.65, segment.y + GRID_SIZE * 0.4, eyeSize, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Draw Other Players
    otherPlayers.forEach((player, id) => {
      // Use socket ID or some seed for stable unique hue
      const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const playerHue = hash % 360;
      
      player.snakeBody.forEach((segment, i) => {
        ctx.fillStyle = i === 0 ? `hsl(${playerHue}, 80%, 60%)` : `hsl(${playerHue}, 40%, 40%)`;
        
        const radius = (GRID_SIZE / 2 - 1);
        const centerX = segment.x + GRID_SIZE / 2;
        const centerY = segment.y + GRID_SIZE / 2;
        
        ctx.beginPath();
        if (i === 0) {
          const padding = 1;
          const size = GRID_SIZE - padding * 2;
          ctx.rect(segment.x + padding, segment.y + padding, size, size);
        } else {
          ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        }
        ctx.fill();

        if (i === 0) {
          ctx.fillStyle = 'white';
          const eyeSize = 1.2;
          ctx.beginPath();
          ctx.arc(segment.x + GRID_SIZE * 0.35, segment.y + GRID_SIZE * 0.4, eyeSize, 0, Math.PI * 2);
          ctx.arc(segment.x + GRID_SIZE * 0.65, segment.y + GRID_SIZE * 0.4, eyeSize, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    });

    // Draw NPC Snakes
    npcSnakes.forEach((npc) => {
      npc.snakeBody.forEach((segment, i) => {
        ctx.fillStyle = i === 0 ? `hsl(${npc.hue}, 80%, 60%)` : `hsl(${npc.hue}, 40%, 40%)`;
        
        const radius = (GRID_SIZE / 2 - 1);
        const centerX = segment.x + GRID_SIZE / 2;
        const centerY = segment.y + GRID_SIZE / 2;
        
        ctx.beginPath();
        if (i === 0) {
          const padding = 1;
          const size = GRID_SIZE - padding * 2;
          ctx.rect(segment.x + padding, segment.y + padding, size, size);
        } else {
          ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        }
        ctx.fill();

        if (i === 0) {
          ctx.fillStyle = 'white';
          const eyeSize = 1.2;
          ctx.beginPath();
          ctx.arc(segment.x + GRID_SIZE * 0.35, segment.y + GRID_SIZE * 0.4, eyeSize, 0, Math.PI * 2);
          ctx.arc(segment.x + GRID_SIZE * 0.65, segment.y + GRID_SIZE * 0.4, eyeSize, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    });

    ctx.restore();

    // --- MINI-MAP ---
    const mapSize = 60;
    const mapPadding = 15;
    const mapScale = mapSize / WORLD_WIDTH;
    const mapX = dimensions.width - mapSize - mapPadding;
    const mapY = dimensions.height - mapSize - mapPadding;

    // Map Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(mapX, mapY, mapSize, mapSize);
    ctx.fill();
    ctx.stroke();

    // Viewport bounding box on map
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.strokeRect(
      mapX + camX * mapScale, 
      mapY + camY * mapScale, 
      viewW * mapScale, 
      viewH * mapScale
    );

    // Food on map
    ctx.fillStyle = COLORS.food;
    foodList.forEach(f => {
      ctx.fillRect(mapX + f.x * mapScale, mapY + f.y * mapScale, 2, 2);
    });

    // Other Players on map
    ctx.fillStyle = '#10B981';
    otherPlayers.forEach(p => {
      if (p.snakeBody.length > 0) {
        ctx.fillRect(mapX + p.snakeBody[0].x * mapScale, mapY + p.snakeBody[0].y * mapScale, 3, 3);
      }
    });

    // NPC Snakes on map
    npcSnakes.forEach(npc => {
      ctx.fillStyle = `hsl(${npc.hue}, 80%, 60%)`;
      ctx.fillRect(mapX + npc.snakeBody[0].x * mapScale, mapY + npc.snakeBody[0].y * mapScale, 2, 2);
    });

    // Boss on map
    if (bossSnake.active) {
      ctx.fillStyle = '#EF4444';
      ctx.fillRect(mapX + bossSnake.x * mapScale, mapY + bossSnake.y * mapScale, 5, 5);
    }

    // Player on map
    ctx.fillStyle = COLORS.head;
    ctx.shadowBlur = 5;
    ctx.shadowColor = COLORS.head;
    ctx.fillRect(mapX + head.x * mapScale, mapY + head.y * mapScale, 4, 4);
    ctx.shadowBlur = 0;

  }, [dimensions, snakeBody, otherPlayers, foodList, particles, trail, COLORS, score, bossSnake, isBoosting, zoomLevel]);

  useEffect(() => {
    const loop = (timestamp: number) => {
      if (isPlaying && !isPaused) {
        updateContinuous();
        if (timestamp - lastUpdateRef.current > currentSpeed) {
          update();
          lastUpdateRef.current = timestamp;
        }
      }
      draw();
      gameLoopRef.current = requestAnimationFrame(loop);
    };

    gameLoopRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(gameLoopRef.current);
  }, [isPlaying, update, updateContinuous, draw, currentSpeed]);

  const handleCanvasClick = () => {
    if (!isPlaying && !isGameOver) {
      setIsPlaying(true);
    } else if (isPlaying) {
      setDirection(prev => (prev + 1) % 4);
    }
  };

  return (
    <div 
      className="w-full h-screen font-sans overflow-hidden flex flex-col tracking-tight transition-colors duration-500"
      style={{ backgroundColor: COLORS.bg, color: COLORS.bg === "#F1F5F9" ? '#0f172a' : '#f8fafc' }}
    >
      <AnimatePresence>
        {isPaused && (
          <motion.div 
            key="pause-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[80] flex items-center justify-center"
          >
             <motion.div 
               initial={{ scale: 0.9, opacity: 0 }}
               animate={{ scale: 1, opacity: 1 }}
               className="bg-white p-8 rounded-[40px] shadow-2xl max-w-xs w-full text-center space-y-6"
             >
                <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mx-auto ring-8 ring-slate-50">
                  <Play className="w-10 h-10 text-slate-800 rotate-90" />
                </div>
                <div>
                   <h2 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">Neural Link Paused</h2>
                   <p className="text-xs text-slate-400 font-bold uppercase tracking-widest mt-1">Synchronization Pending</p>
                </div>
                <button 
                  onClick={() => setIsPaused(false)}
                  className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black uppercase text-xs tracking-[0.2em] shadow-xl shadow-slate-900/20 hover:scale-[1.02] active:scale-95 transition-all"
                >
                  Resume Logic
                </button>
             </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Boss Health Bar */}
      <AnimatePresence>
        {isPlaying && bossSnake.active && bossSnake.maxHealth > 0 && (
          <motion.div 
            key="boss-health-bar"
            initial={{ y: -100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -100, opacity: 0 }}
            className="fixed top-20 left-1/2 -translate-x-1/2 w-[90%] max-w-2xl z-30"
          >
            <div className="bg-black/60 backdrop-blur-md rounded-2xl p-4 border border-red-500/30 shadow-[0_0_30px_rgba(239,68,68,0.2)]">
              <div className="flex justify-between items-end mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-red-500 font-black tracking-[0.2em] text-[10px] uppercase">
                    {bossSnake.warning && <span className="animate-pulse text-white bg-red-600 px-1 rounded">ATTACK IMMINENT</span>}
                  </span>
                </div>
                <span className="text-red-400 font-mono text-sm font-bold">{Math.ceil(bossSnake.health)} / {bossSnake.maxHealth}</span>
              </div>
              <div className="h-4 bg-slate-800/50 rounded-full overflow-hidden border border-white/5 relative">
                <motion.div 
                  initial={{ width: '100%' }}
                  animate={{ width: `${(bossSnake.health / bossSnake.maxHealth) * 100}%` }}
                  className="h-full bg-gradient-to-r from-red-600 via-orange-500 to-red-600 relative z-10"
                />
                <div className="absolute inset-0 bg-red-500/10 animate-pulse" />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Power-up Indicators */}
      <div className="fixed bottom-24 left-6 flex flex-col gap-3 z-30 pointer-events-none">
        <AnimatePresence>
          {activePowerUps.shield > Date.now() && (
            <motion.div 
              key="shield-indicator"
              initial={{ x: -50, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              className="flex items-center gap-3 bg-blue-500/20 backdrop-blur-md border border-blue-400/30 py-2 px-4 rounded-xl shadow-lg"
            >
              <div className="w-6 h-6 rounded-lg bg-blue-500 flex items-center justify-center">
                <Share2 className="w-4 h-4 text-white rotate-45" />
              </div>
              <div>
                <p className="text-[8px] uppercase font-bold text-blue-300 tracking-widest">Shield Active</p>
                <div className="h-1 bg-blue-900/50 rounded-full overflow-hidden w-24">
                  <motion.div 
                    animate={{ width: '0%' }}
                    transition={{ duration: (activePowerUps.shield - Date.now()) / 1000, ease: 'linear' }}
                    className="h-full bg-blue-400"
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </motion.div>
          )}

          {activePowerUps.multiplier > Date.now() && (
            <motion.div 
              key="multiplier-indicator"
              initial={{ x: -50, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              className="flex items-center gap-3 bg-amber-500/20 backdrop-blur-md border border-amber-400/30 py-2 px-4 rounded-xl shadow-lg"
            >
              <div className="w-6 h-6 rounded-lg bg-amber-500 flex items-center justify-center">
                <span className="text-white font-bold text-xs">3x</span>
              </div>
              <div>
                <p className="text-[8px] uppercase font-bold text-amber-300 tracking-widest">Multiplier</p>
                <div className="h-1 bg-amber-900/50 rounded-full overflow-hidden w-24">
                  <motion.div 
                    animate={{ width: '0%' }}
                    transition={{ duration: (activePowerUps.multiplier - Date.now()) / 1000, ease: 'linear' }}
                    className="h-full bg-amber-400"
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </motion.div>
          )}

          {activePowerUps.slowMo > Date.now() && (
            <motion.div 
              key="slowmo-indicator"
              initial={{ x: -50, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              className="flex items-center gap-3 bg-purple-500/20 backdrop-blur-md border border-purple-400/30 py-2 px-4 rounded-xl shadow-lg"
            >
              <div className="w-6 h-6 rounded-lg bg-purple-500 flex items-center justify-center">
                <Play className="w-4 h-4 text-white rotate-180" />
              </div>
              <div>
                <p className="text-[8px] uppercase font-bold text-purple-300 tracking-widest">Slow Motion</p>
                <div className="h-1 bg-purple-900/50 rounded-full overflow-hidden w-24">
                  <motion.div 
                    animate={{ width: '0%' }}
                    transition={{ duration: (activePowerUps.slowMo - Date.now()) / 1000, ease: 'linear' }}
                    className="h-full bg-purple-400"
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </motion.div>
          )}

          {activePowerUps.ghost > Date.now() && (
            <motion.div 
              key="ghost-indicator"
              initial={{ x: -50, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              className="flex items-center gap-3 bg-cyan-500/20 backdrop-blur-md border border-cyan-400/30 py-2 px-4 rounded-xl shadow-lg"
            >
              <div className="w-6 h-6 rounded-lg bg-cyan-500 flex items-center justify-center">
                <Users className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-[8px] uppercase font-bold text-cyan-300 tracking-widest">Ghost Mode</p>
                <div className="h-1 bg-cyan-900/50 rounded-full overflow-hidden w-24">
                  <motion.div 
                    animate={{ width: '0%' }}
                    transition={{ duration: (activePowerUps.ghost - Date.now()) / 1000, ease: 'linear' }}
                    className="h-full bg-cyan-400"
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Top Header / Stats Bar */}
      {!(isPlaying && controlType === 'touch') && (
        <header 
          className="h-16 md:h-20 border-b flex items-center justify-between px-6 md:px-12 z-20 shadow-sm transition-colors duration-500"
          style={{ 
            backgroundColor: COLORS.bg === "#F1F5F9" ? 'white' : 'rgba(0,0,0,0.2)',
            borderColor: 'rgba(0,0,0,0.05)',
            backdropFilter: COLORS.bg === "#F1F5F9" ? 'none' : 'blur(10px)'
          }}
        >
        <div className="flex items-center space-x-4">
          <motion.div 
            animate={{ scale: [1, 1.2, 1] }} 
            transition={{ duration: 2, repeat: Infinity }}
            className="w-3 h-3 rounded-full shadow-[0_0_10px_rgba(59,130,246,0.5)]" 
            style={{ backgroundColor: COLORS.accent }}
          />
          <span className="text-[10px] tracking-[0.3em] uppercase font-bold opacity-50">Snake 2026</span>
          
          {/* Multiplayer Status */}
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full border" style={{ backgroundColor: 'rgba(0,0,0,0.05)', borderColor: 'rgba(0,0,0,0.05)' }}>
            <Users className="w-3 h-3" style={{ color: COLORS.accent }} />
            <span className="text-[10px] font-bold opacity-60">{otherPlayers.size + 1} ONLINE</span>
          </div>

          {/* Sound Toggle */}
          <button 
            onClick={() => setIsSoundEnabled(!isSoundEnabled)}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors opacity-40 hover:opacity-100"
          >
            {isSoundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
        </div>
        
        <div className="flex space-x-6 md:space-x-12">
          <div className="flex flex-col items-center">
            <span className="text-[10px] uppercase tracking-widest opacity-40 mb-1 font-bold">Score</span>
            <span className="text-2xl md:text-3xl font-mono font-bold leading-none">{score.toLocaleString()}</span>
          </div>
          <div className="flex flex-col items-center border-l pl-6 md:pl-12" style={{ borderColor: 'rgba(0,0,0,0.1)' }}>
            <span className="text-[10px] uppercase tracking-widest opacity-40 mb-1 font-bold">Hi-Score</span>
            <span className="text-2xl md:text-3xl font-mono font-bold leading-none" style={{ color: COLORS.accent }}>{highScore.toLocaleString()}</span>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <button 
            onClick={() => isGameOver ? resetGame() : (isPlaying ? setIsPaused(!isPaused) : setIsPlaying(true))}
            className="w-10 h-10 rounded-xl bg-game-accent flex items-center justify-center hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-blue-500/20"
          >
            {isPlaying && !isPaused ? (
              <div className="flex gap-1">
                <div className="w-1.5 h-4 bg-white rounded-full"></div>
                <div className="w-1.5 h-4 bg-white rounded-full"></div>
              </div>
            ) : (
              <div className="w-0 h-0 border-t-[6px] border-t-transparent border-l-[10px] border-l-white border-b-[6px] border-b-transparent ml-1"></div>
            )}
          </button>
        </div>
      </header>
      )}

      {/* Main Game Layout */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden italic:not">
        {/* Central Game Board Container */}
        <motion.section 
          className="flex-1 bg-game-board relative overflow-hidden group shadow-inner transition-all duration-200" 
          ref={containerRef}
          animate={isShaking ? {
            x: [0, -3, 3, -2, 2, 0],
            y: [0, 2, -2, 3, -3, 0],
            boxShadow: [
              `inset 0 0 0px ${COLORS.accent}`,
              `inset 0 0 30px ${COLORS.accent}`,
              `inset 0 0 0px ${COLORS.accent}`
            ],
            transition: { duration: 0.2 }
          } : {
            boxShadow: `inset 0 0 0px ${COLORS.accent}`
          }}
        >
          {/* Subtle Dynamic Fog / Noise Background */}
          <div 
            className="absolute inset-0 opacity-[0.05] pointer-events-none" 
            style={{ 
              backgroundImage: 'radial-gradient(circle at 100% 100%, #3B82F6, transparent 50%), radial-gradient(circle at 0% 0%, #EF4444, transparent 50%)',
            }}
          />
          
          <canvas
            ref={canvasRef}
            width={dimensions.width}
            height={dimensions.height}
            className="absolute inset-0 cursor-crosshair z-10"
            onClick={handleCanvasClick}
          />

          {/* Touch Visual Indicators */}
          <AnimatePresence>
            {lastTaps.map(tap => (
              <motion.div
                key={tap.id}
                initial={{ scale: 0, opacity: 0.8 }}
                animate={{ scale: 2.5, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                className="fixed w-12 h-12 rounded-full border-2 z-20 pointer-events-none shadow-[0_0_15px_rgba(59,130,246,0.3)]"
                style={{ 
                  left: tap.x - 24, 
                  top: tap.y - 24, 
                  borderColor: COLORS.accent,
                }}
              />
            ))}
          </AnimatePresence>

          <AnimatePresence>
            {!isPlaying && (
              <motion.div
                key="main-menu-overlay"
                initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
                animate={{ opacity: 1, backdropFilter: 'blur(12px)' }}
                exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
                className="absolute inset-0 z-20 flex items-center justify-center bg-white/30"
              >
                <motion.div
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="bg-white border border-black/5 p-8 rounded-[2.5rem] shadow-[0_20px_50px_rgba(0,0,0,0.1)] flex flex-col items-center gap-6 max-w-sm w-full"
                >
                  <Trophy className={`w-12 h-12 ${isGameOver ? 'text-game-accent' : 'text-slate-200'}`} />
                  <div className="text-center w-full relative">
                    {isGameOver && (
                      <div className="absolute -top-16 left-1/2 -translate-x-1/2 w-48 h-12 bg-red-600 flex items-center justify-center transform -rotate-2 border-b-4 border-red-800 shadow-xl overflow-hidden z-20">
                        <motion.div 
                          animate={{ x: [-200, 200] }}
                          transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
                          className="absolute inset-0 bg-white/10 skew-x-12"
                        />
                        <span className="text-white font-black italic text-sm tracking-widest uppercase">Data Purged: {score}</span>
                      </div>
                    )}
                    <h2 className="text-2xl font-extrabold tracking-tighter mb-1 text-slate-900">
                      {isGameOver ? 'MISSION TERMINATED' : 'SNAKE 2026'}
                    </h2>
                    {isGameOver ? (
                      <div className="flex flex-col gap-4 mt-6 w-full animate-in fade-in zoom-in duration-500">
                        {/* Retro Glitch Header */}
                        <div className="relative py-4 overflow-hidden bg-black rounded-2xl border-4 border-slate-800 shadow-[0_0_20px_rgba(0,0,0,0.5)]">
                          <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] pointer-events-none" />
                          <h2 className="text-4xl font-black text-center text-red-500 tracking-tighter italic scale-y-125 uppercase drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]">
                            GAME OVER
                          </h2>
                          <div className="flex justify-center items-center gap-2 mt-1">
                            <span className="h-1 w-8 bg-red-500/30 rounded-full" />
                            <span className="text-[10px] font-bold text-red-400/80 uppercase tracking-[0.5em]">System Failure</span>
                            <span className="h-1 w-8 bg-red-500/30 rounded-full" />
                          </div>
                        </div>

                        {/* Neural Echo / Final Snake Replay Rendering */}
                        <div className="relative w-full h-32 bg-slate-900 rounded-3xl overflow-hidden border-2 border-slate-800 flex items-center justify-center shadow-2xl group">
                          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.1)_0%,transparent_70%)]" />
                          <svg viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`} className="w-full h-full opacity-60 scale-125 blur-[1px] group-hover:blur-0 transition-all duration-700">
                            {/* Static Background Grid */}
                            <pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse">
                                <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1"/>
                            </pattern>
                            <rect width="100%" height="100%" fill="url(#grid)" />
                            
                            <motion.path
                              d={`M ${finalSnakeBody.map(p => `${p.x} ${p.y}`).join(' L ')}`}
                              fill="none"
                              stroke={playerColors.head}
                              strokeWidth={GRID_SIZE * 4}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              initial={{ pathLength: 0, opacity: 0 }}
                              animate={{ pathLength: 1, opacity: 1 }}
                              transition={{ duration: 2, ease: "easeInOut" }}
                            />
                            {finalSnakeBody.length > 0 && (
                                <motion.circle 
                                    cx={finalSnakeBody[0].x} 
                                    cy={finalSnakeBody[0].y} 
                                    r={GRID_SIZE * 5}
                                    fill={playerColors.head}
                                    initial={{ scale: 0 }}
                                    animate={{ scale: [1, 1.2, 1] }}
                                    transition={{ duration: 2, repeat: Infinity }}
                                    className="opacity-20"
                                />
                            )}
                          </svg>
                          <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-transparent to-transparent pointer-events-none" />
                          <div className="absolute top-2 right-4 flex items-center gap-1">
                             <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                             <span className="text-[8px] font-bold text-red-500 uppercase tracking-widest">Replay Source: Grid_Memory_Alpha</span>
                          </div>
                          <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[9px] font-black text-blue-400/60 uppercase tracking-[0.4em] drop-shadow-[0_0_5px_rgba(59,130,246,0.3)]">NEURAL ECHO SYNCHRONIZED</span>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-3">
                          <motion.div 
                            initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ delay: 0.2 }}
                            className="bg-slate-900/50 p-3 rounded-2xl border border-white/5 flex flex-col items-center justify-center backdrop-blur-md"
                          >
                            <p className="text-[8px] uppercase tracking-[0.3em] text-slate-500 font-bold mb-1">Runtime</p>
                            <p className="text-xl font-mono font-black text-slate-200">{gameStats.timeSurvived}<span className="text-[10px] ml-1 text-slate-500">s</span></p>
                          </motion.div>
                          <motion.div 
                            initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ delay: 0.3 }}
                            className="bg-slate-900/50 p-3 rounded-2xl border border-white/5 flex flex-col items-center justify-center backdrop-blur-md"
                          >
                            <p className="text-[8px] uppercase tracking-[0.3em] text-slate-500 font-bold mb-1">Harvested</p>
                            <p className="text-xl font-mono font-black text-slate-200">{gameStats.foodEaten}</p>
                          </motion.div>
                          <motion.div 
                            initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ delay: 0.4 }}
                            className="bg-slate-900/50 p-3 rounded-2xl border border-white/5 flex flex-col items-center justify-center backdrop-blur-md"
                          >
                            <p className="text-[8px] uppercase tracking-[0.3em] text-slate-500 font-bold mb-1">Max Signal</p>
                            <p className="text-xl font-mono font-black text-slate-200">{gameStats.maxLength}</p>
                          </motion.div>
                          <motion.div 
                            initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ delay: 0.5 }}
                            className="bg-red-500/10 p-3 rounded-2xl border border-red-500/20 flex flex-col items-center justify-center shadow-[0_0_20px_rgba(239,68,68,0.1)] group"
                          >
                            <p className="text-[8px] uppercase tracking-[0.3em] text-red-500 font-bold mb-1">Fatal Score</p>
                            <p className="text-2xl font-mono font-black text-red-500 group-hover:scale-110 transition-transform">{score}</p>
                          </motion.div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-slate-400 text-[10px] uppercase tracking-widest font-mono font-bold">
                        Initialize Neural Link
                      </p>
                    )}
                  </div>

                  <div className="w-full space-y-4">
                    {showSettings ? (
                      <div className="space-y-6">
                        <div className="flex items-center justify-between border-b pb-2">
                          <button 
                            onClick={() => setShowSettings(false)}
                            className="flex items-center gap-1 text-[10px] font-bold text-slate-400 uppercase tracking-widest hover:text-slate-800 transition-colors"
                          >
                            <ChevronLeft className="w-4 h-4" />
                            Back
                          </button>
                          <span className="text-[10px] font-bold text-slate-800 uppercase tracking-widest">Protocol Configuration</span>
                        </div>

                        {/* Control Settings */}
                        <div className="space-y-2">
                          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block text-center">Controls</label>
                          <div className="bg-slate-100 p-1 rounded-2xl flex">
                            <button 
                              onClick={() => {
                                setControlType('keypad');
                                localStorage.setItem('snakeControlType', 'keypad');
                              }}
                              className={`flex-1 py-2 rounded-xl text-[10px] font-bold transition-all ${controlType === 'keypad' ? 'bg-white shadow-sm text-slate-900 scale-[1.02]' : 'text-slate-400 hover:text-slate-600'}`}
                            >
                              Keypad
                            </button>
                            <button 
                              onClick={() => {
                                setControlType('touch');
                                localStorage.setItem('snakeControlType', 'touch');
                                if (containerRef.current?.requestFullscreen) {
                                  containerRef.current.requestFullscreen().catch(() => {});
                                }
                              }}
                              className={`flex-1 py-2 rounded-xl text-[10px] font-bold transition-all ${controlType === 'touch' ? 'bg-white shadow-sm text-slate-900 scale-[1.02]' : 'text-slate-400 hover:text-slate-600'}`}
                            >
                              Touch Focus
                            </button>
                          </div>
                        </div>

                        {/* Theme Selector */}
                        <div className="space-y-2">
                          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block text-center">Visual Theme</label>
                          <div className="flex justify-center gap-2">
                            {Object.entries(THEMES).map(([id, theme]) => (
                              <button
                                key={id}
                                onClick={() => {
                                  setCurrentTheme(id);
                                  localStorage.setItem('snakeTheme', id);
                                }}
                                className={`w-7 h-7 rounded-full border-2 transition-all ${currentTheme === id ? 'border-game-accent scale-110 shadow-lg' : 'border-black/5 hover:scale-105'}`}
                                style={{ background: theme.head }}
                                title={theme.name}
                              />
                            ))}
                          </div>
                        </div>

                        {/* Touch Settings */}
                        {controlType === 'touch' && (
                          <div className="space-y-3 bg-slate-50 p-4 rounded-3xl border border-black/5">
                            <div className="space-y-2">
                              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block text-center">Touch Mode</label>
                              <div className="bg-slate-200/50 p-1 rounded-xl flex">
                                <button 
                                  onClick={() => {
                                    setTouchMode('tap');
                                    localStorage.setItem('snakeTouchMode', 'tap');
                                  }}
                                  className={`flex-1 py-1.5 rounded-lg text-[9px] font-bold transition-all ${touchMode === 'tap' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400'}`}
                                >
                                  Tap (Quadrants)
                                </button>
                                <button 
                                  onClick={() => {
                                    setTouchMode('swipe');
                                    localStorage.setItem('snakeTouchMode', 'swipe');
                                  }}
                                  className={`flex-1 py-1.5 rounded-lg text-[9px] font-bold transition-all ${touchMode === 'swipe' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400'}`}
                                >
                                  Swipe
                                </button>
                              </div>
                            </div>
                            
                            <div className="space-y-2">
                              <div className="flex justify-between items-center text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                                <span>Touch Sensitivity</span>
                                <span className="font-mono text-game-accent">{touchSensitivity}</span>
                              </div>
                              <input 
                                type="range"
                                min="10"
                                max="95"
                                value={touchSensitivity}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  setTouchSensitivity(val);
                                  localStorage.setItem('snakeTouchSensitivity', val.toString());
                                }}
                                className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-game-accent"
                              />
                              <p className="text-[7px] text-slate-400 font-medium text-center uppercase tracking-tighter">Adjusts required swipe distance</p>
                            </div>
                          </div>
                        )}

                        {/* Difficulty Selector */}
                        <div className="space-y-3">
                          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block text-center">Difficulty Protocol</label>
                          <div className="grid grid-cols-3 gap-2">
                            {(Object.keys(DIFFICULTY_CONFIG) as DifficultyLevel[]).map((level) => (
                              <button
                                key={level}
                                onClick={() => {
                                  setDifficulty(level);
                                  localStorage.setItem('snakeDifficulty', level);
                                }}
                                className={`py-2 px-1 rounded-xl border flex flex-col items-center transition-all ${
                                  difficulty === level 
                                    ? 'bg-game-accent/5 border-game-accent text-game-accent scale-[1.05]' 
                                    : 'bg-slate-50 border-black/5 text-slate-400 hover:border-slate-300'
                                }`}
                              >
                                <span className="text-[10px] font-black uppercase tracking-tighter">{DIFFICULTY_CONFIG[level].name}</span>
                                <span className="text-[8px] opacity-60 font-medium">x{DIFFICULTY_CONFIG[level].pointsMult.toFixed(1)}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Color Customization */}
                        <div className="space-y-4">
                          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block text-center">Neural Aesthetics</label>
                          
                          <div className="space-y-2">
                             <p className="text-[8px] font-bold text-slate-500 uppercase text-center">Presets</p>
                             <div className="flex flex-wrap justify-center gap-2">
                               {COLOR_PRESETS.map(preset => (
                                 <button
                                   key={preset.name}
                                   onClick={() => {
                                     setPlayerColors({ head: preset.head, body: preset.body });
                                     localStorage.setItem('snakePlayerColors', JSON.stringify({ head: preset.head, body: preset.body }));
                                    }}
                                   className={`group relative flex flex-col items-center gap-1 p-1 rounded-xl border-2 transition-all ${playerColors.head === preset.head && playerColors.body === preset.body ? 'border-game-accent bg-game-accent/5' : 'border-black/5 hover:border-slate-300'}`}
                                 >
                                    <div className="flex -space-x-1.5">
                                      <div className="w-4 h-4 rounded-full shadow-sm ring-1 ring-black/5" style={{ background: preset.head }} />
                                      <div className="w-4 h-4 rounded-full shadow-sm ring-1 ring-black/5" style={{ background: preset.body }} />
                                    </div>
                                    <span className="text-[7px] font-black uppercase opacity-60 group-hover:opacity-100">{preset.name}</span>
                                 </button>
                               ))}
                             </div>
                          </div>

                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <p className="text-[8px] font-bold text-slate-500 uppercase text-center">Head</p>
                              <div className="flex flex-wrap justify-center gap-1.5 px-2">
                                {['#00ccff', '#ff00ff', '#00ffcc', '#ffcc00', '#ff3333', '#ffffff'].map(c => (
                                  <button
                                    key={c}
                                    onClick={() => {
                                      const newColors = { ...playerColors, head: c };
                                      setPlayerColors(newColors);
                                      localStorage.setItem('snakePlayerColors', JSON.stringify(newColors));
                                    }}
                                    className={`w-6 h-6 rounded-lg border-2 transition-transform active:scale-90 ${playerColors.head === c ? 'border-indigo-500 scale-110' : 'border-transparent'}`}
                                    style={{ backgroundColor: c }}
                                  />
                                ))}
                              </div>
                            </div>
                            <div className="space-y-2">
                              <p className="text-[8px] font-bold text-slate-500 uppercase text-center">Body</p>
                              <div className="flex flex-wrap justify-center gap-1.5 px-2">
                                {['#0066aa', '#aa00aa', '#00aa66', '#aa6600', '#aa1111', '#444444'].map(c => (
                                  <button
                                    key={c}
                                    onClick={() => {
                                      const newColors = { ...playerColors, body: c };
                                      setPlayerColors(newColors);
                                      localStorage.setItem('snakePlayerColors', JSON.stringify(newColors));
                                    }}
                                    className={`w-6 h-6 rounded-lg border-2 transition-transform active:scale-90 ${playerColors.body === c ? 'border-indigo-500 scale-110' : 'border-transparent'}`}
                                    style={{ backgroundColor: c }}
                                  />
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {/* Name Input */}
                        <div className="space-y-2 w-full">
                          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block text-center">Your Callsign</label>
                          <div className="relative">
                            <input 
                              type="text" 
                              value={playerName}
                              onChange={(e) => {
                                const newName = e.target.value.slice(0, 12);
                                setPlayerName(newName);
                                localStorage.setItem('snakePlayerName', newName);
                              }}
                              className="w-full bg-slate-50 border border-black/10 rounded-2xl px-4 py-3 text-center text-sm font-bold text-slate-800 outline-none focus:ring-2 transition-all placeholder:text-slate-300"
                              style={{ boxShadow: `0 0 0 2px ${COLORS.accent}20` }}
                              placeholder="Type your name..."
                            />
                            {user && (
                              <div className="absolute top-1/2 -right-2 -translate-y-1/2 translate-x-full hidden md:block">
                                <img src={user.photoURL || ''} className="w-8 h-8 rounded-full border-2 border-white shadow-md" alt="Avatar" />
                              </div>
                            )}
                          </div>
                        </div>

                        {!user && (
                          <button
                            onClick={handleGoogleLogin}
                            className="w-full bg-white border border-black/10 hover:bg-slate-50 text-slate-600 py-3 rounded-2xl font-bold uppercase tracking-widest text-[10px] transition-all active:scale-95 flex items-center justify-center gap-2"
                          >
                            <svg className="w-4 h-4" viewBox="0 0 24 24">
                              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.29.81-.55z" />
                              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                            </svg>
                            Sign in for Leaderboard
                          </button>
                        )}

                        <div className="grid grid-cols-1 gap-3 pt-2">
                          {!isGameOver && isPlaying === false && score > 0 && (
                            <button
                              onClick={saveGame}
                              disabled={isSaving}
                              className="w-full bg-slate-900 border border-transparent hover:bg-slate-800 text-white py-3 rounded-2xl font-bold uppercase tracking-widest text-[10px] transition-all active:scale-95 flex items-center justify-center gap-2"
                            >
                              {isSaving ? 'Saving...' : 'Save & Exit'}
                            </button>
                          )}

                          {hasSavedGame && !isGameOver && score === 0 && (
                            <button
                              onClick={resumeGame}
                              className="w-full bg-green-500 hover:bg-green-600 text-white py-3 rounded-2xl font-bold uppercase tracking-widest text-[10px] transition-all active:scale-95 flex items-center justify-center gap-2 shadow-lg shadow-green-500/20"
                            >
                              Resume Session
                            </button>
                          )}

                          {!isGameOver && !isPlaying && (
                            <div className="space-y-3">
                              <button
                                onClick={() => setIsPlaying(true)}
                                className="w-full hover:brightness-110 text-white py-6 rounded-3xl font-black uppercase tracking-[0.25em] text-xl shadow-2xl shadow-blue-500/40 transition-all active:scale-95 flex flex-col items-center justify-center gap-2 group relative overflow-hidden"
                                style={{ 
                                  backgroundColor: COLORS.accent,
                                  borderBottom: `6px solid ${COLORS.accent}80`
                                }}
                              >
                                <motion.div 
                                  className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/20 to-white/0 -skew-x-12 translate-x-[-200%]"
                                  animate={{ translateX: ['100%', '-200%'] }}
                                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                                />
                                <div className="flex items-center gap-3 relative z-10">
                                  <Play className="w-8 h-8 fill-current group-hover:scale-110 transition-transform" />
                                  <span className="group-hover:tracking-[0.3em] transition-all">ENTER GRID</span>
                                </div>
                                <span className="text-[9px] opacity-70 tracking-[0.4em] font-black relative z-10 animate-pulse">ESTABLISHING NEURAL LINK</span>
                              </button>

                              <button
                                onClick={() => setShowSettings(true)}
                                className="w-full bg-slate-50 border border-black/5 hover:bg-slate-100 text-slate-500 py-3 rounded-2xl font-bold uppercase tracking-widest text-[10px] transition-all active:scale-95 flex items-center justify-center gap-2"
                              >
                                PROTOCOL SETTINGS
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
          </motion.section>

        {/* Global Controls Panel */}
        {controlType === 'keypad' && (
          <aside className="w-full md:w-48 border-t md:border-t-0 md:border-l border-black/5 flex flex-col p-4 md:p-6 bg-white/50 backdrop-blur-md transition-all duration-300">
            <div className="hidden lg:block mb-6">
              <h3 className="text-[10px] uppercase tracking-widest text-slate-400 mb-6 font-bold text-center">Diagnostics</h3>
              <div className="space-y-6">
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-slate-500">
                    <span className="text-[10px] uppercase tracking-widest font-bold">Process</span>
                    <span className="text-xs font-mono font-bold">{Math.round(currentSpeed)}ms</span>
                  </div>
                  <div className="w-full h-1 bg-slate-200 overflow-hidden rounded-full">
                    <motion.div 
                      style={{ width: isBoosting ? '100%' : '40%' }}
                      className="h-full bg-game-accent" 
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col items-center justify-end flex-1 pb-4">
              <div className="grid grid-cols-3 gap-2 w-fit">
                <button 
                  onPointerDown={(e) => { 
                    e.stopPropagation(); 
                    if (direction !== 1) setDirection(3); 
                    setIsBoosting(true); 
                    playSound('boost'); 
                  }}
                  onPointerUp={() => setIsBoosting(false)}
                  onPointerLeave={() => setIsBoosting(false)}
                  className={`col-start-2 w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer shadow-sm border ${direction === 3 ? 'text-white scale-105' : 'bg-white/10 border-white/5 text-slate-400 hover:bg-white/20'}`}
                  style={{ backgroundColor: direction === 3 ? COLORS.accent : undefined, borderColor: direction === 3 ? 'transparent' : undefined }}
                >
                  <ChevronUp className="w-5 h-5" />
                </button>
                <button 
                  onPointerDown={(e) => { 
                    e.stopPropagation(); 
                    if (direction !== 0) setDirection(2); 
                    setIsBoosting(true); 
                    playSound('boost'); 
                  }}
                  onPointerUp={() => setIsBoosting(false)}
                  onPointerLeave={() => setIsBoosting(false)}
                  className={`col-start-1 w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer shadow-sm border ${direction === 2 ? 'text-white scale-105' : 'bg-white/10 border-white/5 text-slate-400 hover:bg-white/20'}`}
                  style={{ backgroundColor: direction === 2 ? COLORS.accent : undefined, borderColor: direction === 2 ? 'transparent' : undefined }}
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button 
                  onPointerDown={(e) => { 
                    e.stopPropagation(); 
                    if (direction !== 3) setDirection(1); 
                    setIsBoosting(true); 
                    playSound('boost'); 
                  }}
                  onPointerUp={() => setIsBoosting(false)}
                  onPointerLeave={() => setIsBoosting(false)}
                  className={`col-start-2 w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer shadow-sm border ${direction === 1 ? 'text-white scale-105' : 'bg-white/10 border-white/5 text-slate-400 hover:bg-white/20'}`}
                  style={{ backgroundColor: direction === 1 ? COLORS.accent : undefined, borderColor: direction === 1 ? 'transparent' : undefined }}
                >
                  <ChevronDown className="w-5 h-5" />
                </button>
                <button 
                  onPointerDown={(e) => { 
                    e.stopPropagation(); 
                    if (direction !== 2) setDirection(0); 
                    setIsBoosting(true); 
                    playSound('boost'); 
                  }}
                  onPointerUp={() => setIsBoosting(false)}
                  onPointerLeave={() => setIsBoosting(false)}
                  className={`col-start-3 w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer shadow-sm border ${direction === 0 ? 'text-white scale-105' : 'bg-white/10 border-white/5 text-slate-400 hover:bg-white/20'}`}
                  style={{ backgroundColor: direction === 0 ? COLORS.accent : undefined, borderColor: direction === 0 ? 'transparent' : undefined }}
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* Footer / System Log */}
      {!(isPlaying && controlType === 'touch') && (
        <footer className="h-10 bg-white border-t border-black/5 flex items-center px-8 md:px-12 justify-between z-20 text-slate-400">
          <div className="flex items-center space-x-6">
            <span className="flex items-center gap-2 text-[9px] text-game-accent font-mono tracking-tighter">
              <span className="w-1.5 h-1.5 rounded-full bg-game-accent animate-pulse"></span>
              [ SYSTEM ACTIVE ]
            </span>
          </div>
          <div className="text-[9px] font-mono uppercase tracking-[0.2em] font-bold">
            COORD: X:{Math.round(snakeBody[0]?.x || 0)} Y:{Math.round(snakeBody[0]?.y || 0)}
          </div>
        </footer>
      )}
    </div>
  );
}

