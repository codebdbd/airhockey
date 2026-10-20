import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play, Pause, RotateCcw, Trophy, Volume2, VolumeX, Zap, Crown,
  MousePointer2, Keyboard, Hand, Timer, Target, Flame, Trash2,
  ChevronRight, Shield, Swords, Gauge, Medal, X, Maximize2, Minimize2,
} from "lucide-react";

/* ============================================================
   NEON AIR HOCKEY — canvas engine + React shell
   Logical table: 420 x 720. First to 7 wins.
   ============================================================ */
const W = 420;
const H = 720;
const GOAL_W = 176;
const GOAL_X0 = (W - GOAL_W) / 2;
const GOAL_X1 = GOAL_X0 + GOAL_W;
const PUCK_R = 14;
const PAD_R = 30;
const WIN_SCORE = 7;
const MAX_PARTICLES = 340;

type Difficulty = "rookie" | "pro" | "legend";
type Screen = "menu" | "playing" | "paused" | "gameover";
type Scorer = "player" | "ai";

interface DiffCfg {
  label: string; aiSpeed: number; aiReaction: number; aiError: number;
  aiAggro: number; desc: string; color: string;
}
const DIFFS: Record<Difficulty, DiffCfg> = {
  rookie: { label: "НОВИЧОК", aiSpeed: 335, aiReaction: 190, aiError: 30, aiAggro: 0.32, desc: "Разминка. Изучай углы и траектории.", color: "#34d399" },
  pro:    { label: "ПРОФИ",   aiSpeed: 540, aiReaction: 105, aiError: 15, aiAggro: 0.62, desc: "Быстрая реакция и надежная защита.", color: "#22d3ee" },
  legend: { label: "ЛЕГЕНДА", aiSpeed: 760, aiReaction: 55,  aiError: 6,  aiAggro: 0.95, desc: "Читает любые удары. Удачи!", color: "#fb7185" },
};

interface ScoreEntry {
  id: string; date: string; player: number; ai: number;
  result: "ПОБЕДА" | "ПОРАЖЕНИЕ"; difficulty: string; duration: number;
}
const LS_KEY = "neon-air-hockey-scores-v1";

function loadScores(): ScoreEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, 24) : [];
  } catch { return []; }
}
function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/* ---------------- audio (synthesised, no assets) ---------------- */
function useAudio(mutedRef: React.RefObject<boolean>) {
  const ctxRef = useRef<AudioContext | null>(null);
  const ensure = useCallback(() => {
    if (!ctxRef.current) {
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctxRef.current = new AC();
      } catch { /* no audio */ }
    }
    if (ctxRef.current?.state === "suspended") void ctxRef.current.resume();
    return ctxRef.current;
  }, []);
  const tone = useCallback((freq: number, dur = 0.08, type: OscillatorType = "square", gain = 0.05, slideTo?: number, delay = 0) => {
    if (mutedRef.current) return;
    const ctx = ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }, [ensure, mutedRef]);
  return {
    unlock: ensure,
    hit: (sp: number) => tone(160 + Math.min(420, sp * 0.35), 0.06, "square", 0.045, 90),
    wall: () => tone(240, 0.035, "triangle", 0.025),
    count: (final: boolean) => tone(final ? 880 : 440, final ? 0.18 : 0.09, "square", 0.05),
    goalFor: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, "square", 0.055, undefined, i * 0.07)); },
    goalAgainst: () => { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.16, "sawtooth", 0.04, undefined, i * 0.07)); },
    win: () => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.22, "triangle", 0.06, undefined, i * 0.09)); },
    lose: () => { [330, 262, 208].forEach((f, i) => tone(f, 0.25, "triangle", 0.05, undefined, i * 0.12)); },
    click: () => tone(660, 0.05, "square", 0.03, 880),
  };
}

/* ---------------- mutable engine state ---------------- */
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; drag: number }
interface FloatText { x: number; y: number; life: number; max: number; text: string; color: string; size: number }
interface Body { x: number; y: number; vx: number; vy: number }

type EnginePhase = "menu" | "countdown" | "playing" | "goal" | "paused" | "over";
interface Engine {
  phase: EnginePhase;
  puck: Body & { trail: { x: number; y: number }[]; spin: number };
  player: Body & { tx: number; ty: number; squash: number; usingKeys: boolean };
  ai: Body & { tx: number; ty: number; squash: number; thinkAt: number; errX: number };
  scoreP: number; scoreA: number;
  time: number; lastWholeSec: number;
  countdown: number; lastCountInt: number; prevPhase: EnginePhase;
  goalTimer: number; goalScorer: Scorer | null; flash: number;
  shake: number; hitStop: number; serveDir: 1 | -1;
  particles: Particle[]; texts: FloatText[];
  saved: boolean; winner: Scorer | null; tGlobal: number;
}

function freshEngine(): Engine {
  return {
    phase: "menu",
    puck: { x: W / 2, y: H / 2, vx: 120, vy: 160, trail: [], spin: 0 },
    player: { x: W / 2, y: H - 120, vx: 0, vy: 0, tx: W / 2, ty: H - 120, squash: 0, usingKeys: false },
    ai: { x: W / 2, y: 120, vx: 0, vy: 0, tx: W / 2, ty: 120, squash: 0, thinkAt: 0, errX: 0 },
    scoreP: 0, scoreA: 0, time: 0, lastWholeSec: -1,
    countdown: 0, lastCountInt: 99, prevPhase: "playing", goalTimer: 0, goalScorer: null,
    flash: 0, shake: 0, hitStop: 0, serveDir: 1,
    particles: [], texts: [], saved: false, winner: null, tGlobal: 0,
  };
}

const CYAN = "#22d3ee";
const ROSE = "#fb7185";
const WHITE = "#f4f9ff";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engRef = useRef<Engine>(freshEngine());
  const keysRef = useRef<Set<string>>(new Set());
  const pointerRef = useRef<{ x: number; y: number; active: boolean; id: number | null }>({ x: W / 2, y: H - 120, active: false, id: null });
  const rafRef = useRef(0);
  const timerElRef = useRef<HTMLSpanElement>(null);
  const savedOnceRef = useRef(false);

  const [screen, setScreen] = useState<Screen>("menu");
  const screenRef = useRef<Screen>("menu");
  const [difficulty, setDifficulty] = useState<Difficulty>("pro");
  const diffRef = useRef<Difficulty>("pro");
  const [scoreP, setScoreP] = useState(0);
  const [scoreA, setScoreA] = useState(0);
  const [countdownVal, setCountdownVal] = useState<number | null>(null);
  const [goalBanner, setGoalBanner] = useState<{ scorer: Scorer; id: number } | null>(null);
  const [winner, setWinner] = useState<Scorer | null>(null);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [scores, setScores] = useState<ScoreEntry[]>(loadScores);
  const [showScoresMobile, setShowScoresMobile] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = useCallback(() => {
    try {
      if (!document.fullscreenElement) {
        void document.documentElement.requestFullscreen();
      } else {
        void document.exitFullscreen();
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const audio = useAudio(mutedRef);
  const setScreenBoth = useCallback((s: Screen) => { screenRef.current = s; setScreen(s); }, []);

  /* ================= ENGINE HELPERS ================= */
  const burst = useCallback((x: number, y: number, color: string, n: number, speed: number, size = 3.4) => {
    const e = engRef.current;
    for (let i = 0; i < n; i++) {
      if (e.particles.length >= MAX_PARTICLES) e.particles.shift();
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.25 + Math.random() * 0.95);
      e.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0, max: 0.45 + Math.random() * 0.55,
        size: size * (0.5 + Math.random()), color, drag: 2.6,
      });
    }
  }, []);
  const ringBurst = useCallback((x: number, y: number, color: string, n = 26) => {
    const e = engRef.current;
    for (let i = 0; i < n; i++) {
      if (e.particles.length >= MAX_PARTICLES) e.particles.shift();
      const a = (i / n) * Math.PI * 2;
      const sp = 260 + Math.random() * 160;
      e.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 0.6 + Math.random() * 0.3, size: 3, color, drag: 3.2 });
    }
  }, []);

  const serve = useCallback((dir: 1 | -1, slow = false) => {
    const e = engRef.current;
    // dir: 1 = puck placed on AI half drifting down, -1 = on player half drifting up
    if (slow) {
      e.puck.x = W / 2; e.puck.y = H / 2;
      e.puck.vx = (Math.random() > 0.5 ? 1 : -1) * 70;
      e.puck.vy = dir * 190;
    } else {
      e.puck.x = W / 2 + (Math.random() * 60 - 30);
      e.puck.y = dir === 1 ? H * 0.3 : H * 0.7;
      e.puck.vx = (Math.random() * 120 - 60);
      e.puck.vy = dir * 210;
    }
    e.puck.trail = [];
  }, []);

  const startMatch = useCallback((diff?: Difficulty) => {
    const d = diff ?? diffRef.current;
    diffRef.current = d; setDifficulty(d);
    const e = engRef.current;
    e.scoreP = 0; e.scoreA = 0; e.time = 0; e.lastWholeSec = -1;
    e.particles = []; e.texts = []; e.saved = false; e.winner = null;
    e.player.x = W / 2; e.player.y = H - 120; e.player.tx = W / 2; e.player.ty = H - 120;
    e.player.vx = 0; e.player.vy = 0;
    e.ai.x = W / 2; e.ai.y = 120; e.ai.tx = W / 2; e.ai.ty = 120; e.ai.vx = 0; e.ai.vy = 0;
    e.phase = "countdown"; e.countdown = 3.0; e.lastCountInt = 99;
    if (timerElRef.current) timerElRef.current.textContent = "0:00";
    e.serveDir = Math.random() > 0.5 ? 1 : -1;
    serve(e.serveDir, true);
    e.puck.vx = 0; e.puck.vy = 0; // hold during countdown
    savedOnceRef.current = false;
    setScoreP(0); setScoreA(0); setWinner(null); setGoalBanner(null);
    setCountdownVal(3);
    setScreenBoth("playing");
    audio.unlock();
  }, [serve, setScreenBoth, audio]);

  const finishMatch = useCallback((w: Scorer) => {
    const e = engRef.current;
    e.phase = "over"; e.winner = w;
    setWinner(w);
    setScreenBoth("gameover");
    if (w === "player") audio.win(); else audio.lose();
    if (!savedOnceRef.current) {
      savedOnceRef.current = true;
      const entry: ScoreEntry = {
        id: `${Date.now()}`,
        date: new Date().toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }) + " " +
          new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
        player: e.scoreP, ai: e.scoreA,
        result: w === "player" ? "ПОБЕДА" : "ПОРАЖЕНИЕ",
        difficulty: DIFFS[diffRef.current].label,
        duration: Math.floor(e.time),
      };
      setScores(prev => {
        const next = [entry, ...prev].slice(0, 24);
        try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
        return next;
      });
    }
  }, [audio, setScreenBoth]);

  const onGoal = useCallback((scorer: Scorer) => {
    const e = engRef.current;
    if (scorer === "player") e.scoreP += 1; else e.scoreA += 1;
    setScoreP(e.scoreP); setScoreA(e.scoreA);
    e.phase = "goal"; e.goalTimer = 1.45; e.goalScorer = scorer;
    e.flash = 1; e.shake = Math.min(22, e.shake + 16);
    const gx = Math.max(GOAL_X0 + 10, Math.min(GOAL_X1 - 10, e.puck.x));
    const gy = scorer === "player" ? 8 : H - 8;
    const col = scorer === "player" ? CYAN : ROSE;
    burst(gx, gy, col, 46, 460, 4);
    burst(gx, gy, WHITE, 18, 320, 2.6);
    ringBurst(gx, gy, col, 30);
    e.texts.push({ x: W / 2, y: scorer === "player" ? H * 0.34 : H * 0.62, life: 0, max: 1.3, text: scorer === "player" ? "ГОЛ!" : "ПРОПУЩЕН", color: col, size: scorer === "player" ? 44 : 30 });
    if (scorer === "player") audio.goalFor(); else audio.goalAgainst();
    setGoalBanner({ scorer, id: Date.now() });
    // puck to scorer conceded side for next serve
    e.serveDir = scorer === "player" ? 1 : -1;
  }, [audio, burst, ringBurst]);

  const togglePause = useCallback(() => {
    const e = engRef.current;
    if (e.phase === "playing" || e.phase === "countdown" || e.phase === "goal") {
      e.prevPhase = e.phase; e.phase = "paused"; e.shake = 0; setScreenBoth("paused"); audio.click();
    } else if (e.phase === "paused") {
      e.phase = e.prevPhase; setScreenBoth("playing"); audio.click();
    }
  }, [audio, setScreenBoth]);

  const resume = useCallback(() => {
    const e = engRef.current;
    if (e.phase === "paused") { e.phase = e.prevPhase; setScreenBoth("playing"); audio.click(); }
  }, [audio, setScreenBoth]);

  /* ================= UPDATE ================= */
  const update = useCallback((rawDt: number) => {
    const e = engRef.current;
    const cfg = DIFFS[diffRef.current];
    let dt = Math.min(rawDt, 1 / 30);
    e.tGlobal += dt;
    if (e.hitStop > 0) { e.hitStop -= rawDt; dt *= 0.12; }
    const P = e.player, A = e.ai, K = e.puck;

    /* ---- player control ---- */
    const keys = keysRef.current;
    const kx = (keys.has("arrowright") || keys.has("d") || keys.has("в") ? 1 : 0) - (keys.has("arrowleft") || keys.has("a") || keys.has("ф") ? 1 : 0);
    const ky = (keys.has("arrowdown") || keys.has("s") || keys.has("ы") ? 1 : 0) - (keys.has("arrowup") || keys.has("w") || keys.has("ц") ? 1 : 0);
    const prevPx = P.x, prevPy = P.y;
    if (kx !== 0 || ky !== 0) {
      P.usingKeys = true;
      const sp = 640;
      const inv = 1 / Math.max(1, Math.hypot(kx, ky));
      P.x += kx * inv * sp * dt; P.y += ky * inv * sp * dt;
      P.tx = P.x; P.ty = P.y; pointerRef.current.x = P.x; pointerRef.current.y = P.y;
    } else if (pointerRef.current.active || !P.usingKeys) {
      const tx = pointerRef.current.x, ty = pointerRef.current.y;
      const dx = tx - P.x, dy = ty - P.y;
      const dist = Math.hypot(dx, dy);
      const maxStep = 2600 * dt;
      if (dist > 0.01) {
        const step = Math.min(dist, maxStep);
        // critically-damped feel: snap fast but keep measurable velocity
        const blend = Math.min(1, dt * 38);
        P.x += dx * Math.max(blend, step / Math.max(dist, 0.001) * 0.999);
        P.y += dy * Math.max(blend, step / Math.max(dist, 0.001) * 0.999);
        if (dist > 90) { P.x = prevPx + (dx / dist) * maxStep; P.y = prevPy + (dy / dist) * maxStep; }
      }
      P.tx = tx; P.ty = ty;
    }
    P.x = Math.max(PAD_R + 5, Math.min(W - PAD_R - 5, P.x));
    P.y = Math.max(H / 2 + PAD_R * 0.55, Math.min(H - PAD_R - 6, P.y));
    P.vx = dt > 0 ? (P.x - prevPx) / dt : 0;
    P.vy = dt > 0 ? (P.y - prevPy) / dt : 0;
    P.squash = Math.max(0, P.squash - dt * 6);

    /* ---- AI ---- */
    const prevAx = A.x, prevAy = A.y;
    if (e.phase !== "menu") {
      if (e.tGlobal >= A.thinkAt) {
        A.thinkAt = e.tGlobal + cfg.aiReaction / 1000;
        const puckThreat = K.y < H * 0.62 || K.vy < -40;
        if (puckThreat && e.phase !== "countdown") {
          // choose target goal corner (bottom) — opposite side to stretch player
          const cornerX = K.x < W / 2 ? GOAL_X1 - 24 : GOAL_X0 + 24;
          const dxg = cornerX - K.x, dyg = H - K.y;
          const gl = Math.hypot(dxg, dyg) || 1;
          // stand behind puck relative to target corner so contact drives it goalward
          let desX = K.x - (dxg / gl) * (PAD_R + PUCK_R - 2);
          let desY = K.y - (dyg / gl) * (PAD_R + PUCK_R - 2);
          // if puck moving fast toward AI, intercept its line instead of chasing tail
          if (K.vy < -260) {
            const tHit = Math.max(0, (K.y - 130) / Math.max(60, -K.vy));
            let px = K.x + K.vx * tHit;
            // reflect x in table
            const span = W - PUCK_R * 2;
            px = ((px - PUCK_R) % (span * 2) + span * 2) % (span * 2);
            if (px > span) px = span * 2 - px;
            desX = px + PUCK_R;
            desY = 128;
          }
          if (Math.random() < 0.28) A.errX = (Math.random() * 2 - 1) * cfg.aiError;
          A.tx = desX + A.errX * 0.6;
          A.ty = desY;
          // aggression: don't park on midline, respect own half
          A.ty = Math.max(PAD_R + 6, Math.min(H / 2 - PAD_R * 0.4, A.ty));
        } else {
          A.tx = W / 2 + Math.sin(e.tGlobal * 0.9) * 42;
          A.ty = 108;
        }
      }
      const adx = A.tx - A.x, ady = A.ty - A.y;
      const ad = Math.hypot(adx, ady);
      const aMax = cfg.aiSpeed * (e.phase === "countdown" ? 0.4 : 1);
      if (ad > 1) {
        const step = Math.min(ad, aMax * dt);
        A.x += (adx / ad) * step; A.y += (ady / ad) * step;
      }
    } else {
      // menu idle: gentle demo tracking
      A.tx = W / 2 + Math.sin(e.tGlobal * 0.6) * 90; A.ty = 120;
      A.x += (A.tx - A.x) * Math.min(1, dt * 2.2);
      A.y += (A.ty - A.y) * Math.min(1, dt * 2.2);
      P.x += ((W / 2 + Math.sin(e.tGlobal * 0.6 + Math.PI) * 90) - P.x) * Math.min(1, dt * 2.2);
      P.y += ((H - 120) - P.y) * Math.min(1, dt * 2.2);
    }
    A.x = Math.max(PAD_R + 5, Math.min(W - PAD_R - 5, A.x));
    A.y = Math.max(PAD_R + 6, Math.min(H / 2 - PAD_R * 0.55, A.y));
    A.vx = dt > 0 ? (A.x - prevAx) / dt : 0;
    A.vy = dt > 0 ? (A.y - prevAy) / dt : 0;
    A.squash = Math.max(0, A.squash - dt * 6);

    /* ---- phases ---- */
    if (e.phase === "countdown") {
      e.countdown -= rawDt;
      const ci = Math.ceil(e.countdown);
      if (ci !== e.lastCountInt && ci > 0) { e.lastCountInt = ci; setCountdownVal(ci); audio.count(false); }
      if (e.countdown <= 0) {
        e.phase = "playing"; setCountdownVal(null);
        audio.count(true);
        serve(e.serveDir, true);
        e.texts.push({ x: W / 2, y: H / 2 - 60, life: 0, max: 0.7, text: "ВПЕРЁД!", color: WHITE, size: 40 });
      }
      return;
    }
    if (e.phase === "goal") {
      e.goalTimer -= rawDt;
      // puck drifts out, particles continue below
      K.x += K.vx * dt; K.y += K.vy * dt; K.vx *= 0.94; K.vy *= 0.94;
      if (e.goalTimer <= 0) {
        setGoalBanner(null);
        if (e.scoreP >= WIN_SCORE) finishMatch("player");
        else if (e.scoreA >= WIN_SCORE) finishMatch("ai");
        else { e.phase = "playing"; serve(e.serveDir, false); }
      }
    }
    if (e.phase === "playing") e.time += dt;

    /* ---- puck physics ---- */
    if (e.phase === "playing" || e.phase === "menu") {
      K.x += K.vx * dt; K.y += K.vy * dt;
      // air-hockey glide: very low friction
      const fr = e.phase === "menu" ? 0.12 : 0.06;
      K.vx -= K.vx * fr * dt; K.vy -= K.vy * fr * dt;
      // keep menu puck lively
      if (e.phase === "menu") {
        const sp = Math.hypot(K.vx, K.vy);
        if (sp < 190) { const s = 190 / Math.max(40, sp); K.vx *= s; K.vy *= s; }
        if (sp > 260) { const s = 260 / sp; K.vx *= s; K.vy *= s; }
      }
      const maxSp = 1350;
      const spd = Math.hypot(K.vx, K.vy);
      if (spd > maxSp) { K.vx = (K.vx / spd) * maxSp; K.vy = (K.vy / spd) * maxSp; }

      // side walls
      if (K.x < PUCK_R + 4) {
        K.x = PUCK_R + 4;
        if (K.vx < 0) { K.vx = -K.vx * 0.94; if (Math.abs(K.vx) > 180) { audio.wall(); burst(K.x, K.y, "#9fd8ef", 5, 170, 2.2); } }
      } else if (K.x > W - PUCK_R - 4) {
        K.x = W - PUCK_R - 4;
        if (K.vx > 0) { K.vx = -K.vx * 0.94; if (Math.abs(K.vx) > 180) { audio.wall(); burst(K.x, K.y, "#9fd8ef", 5, 170, 2.2); } }
      }
      const inGoalX = K.x > GOAL_X0 + 4 && K.x < GOAL_X1 - 4;
      if (e.phase === "menu") {
        if (K.y < PUCK_R + 4) { K.y = PUCK_R + 4; K.vy = Math.abs(K.vy) * 0.94; }
        if (K.y > H - PUCK_R - 4) { K.y = H - PUCK_R - 4; K.vy = -Math.abs(K.vy) * 0.94; }
      } else {
        // top wall / goal (player attacks top)
        if (K.y < PUCK_R + 2) {
          if (inGoalX) {
            if (K.y < 4) onGoal("player");
          } else {
            K.y = PUCK_R + 2;
            if (K.vy < 0) { K.vy = -K.vy * 0.94; if (Math.abs(K.vy) > 180) { audio.wall(); burst(K.x, K.y, "#ffb3c2", 5, 170, 2.2); } }
          }
        }
        // goal posts (top)
        if (K.y < 26 && K.vy < 0) {
          for (const px of [GOAL_X0, GOAL_X1]) {
            const d = Math.hypot(K.x - px, K.y - 6);
            if (d < PUCK_R + 5 && d > 0.01) {
              const nx = (K.x - px) / d, ny = (K.y - 6) / d;
              K.x = px + nx * (PUCK_R + 5); K.y = 6 + ny * (PUCK_R + 5);
              const dot = K.vx * nx + K.vy * ny;
              if (dot < 0) { K.vx -= 1.9 * dot * nx; K.vy -= 1.9 * dot * ny; audio.wall(); burst(px, 6, WHITE, 8, 220, 2.4); e.shake = Math.min(10, e.shake + 3); }
            }
          }
        }
        if (K.y > H - PUCK_R - 2) {
          if (inGoalX) {
            if (K.y > H - 4) onGoal("ai");
          } else {
            K.y = H - PUCK_R - 2;
            if (K.vy > 0) { K.vy = -K.vy * 0.94; if (Math.abs(K.vy) > 180) { audio.wall(); burst(K.x, K.y, "#a5f3fc", 5, 170, 2.2); } }
          }
        }
        if (K.y > H - 26 && K.vy > 0) {
          for (const px of [GOAL_X0, GOAL_X1]) {
            const d = Math.hypot(K.x - px, K.y - (H - 6));
            if (d < PUCK_R + 5 && d > 0.01) {
              const nx = (K.x - px) / d, ny = (K.y - (H - 6)) / d;
              K.x = px + nx * (PUCK_R + 5); K.y = H - 6 + ny * (PUCK_R + 5);
              const dot = K.vx * nx + K.vy * ny;
              if (dot < 0) { K.vx -= 1.9 * dot * nx; K.vy -= 1.9 * dot * ny; audio.wall(); burst(px, H - 6, WHITE, 8, 220, 2.4); e.shake = Math.min(10, e.shake + 3); }
            }
          }
        }
      }

      // paddle collisions (both paddles, menu AI/paddles are ghosts)
      if (e.phase === "playing") {
        for (const [pad, isPlayer] of [[P, true], [A, false]] as [Body & { squash: number }, boolean][]) {
          const dx = K.x - pad.x, dy = K.y - pad.y;
          const dist = Math.hypot(dx, dy);
          const minD = PAD_R + PUCK_R;
          if (dist < minD && dist > 0.001) {
            const nx = dx / dist, ny = dy / dist;
            K.x = pad.x + nx * minD; K.y = pad.y + ny * minD;
            const rvx = K.vx - pad.vx, rvy = K.vy - pad.vy;
            const dot = rvx * nx + rvy * ny;
            if (dot < 0) {
              const rest = 1.04;
              K.vx -= (1 + rest) * dot * nx;
              K.vy -= (1 + rest) * dot * ny;
              // transfer mallet momentum — smashing feels powerful
              K.vx += pad.vx * 0.32; K.vy += pad.vy * 0.32;
              const impact = -dot;
              pad.squash = 1;
              const col = isPlayer ? CYAN : ROSE;
              if (impact > 90) {
                audio.hit(impact + Math.hypot(pad.vx, pad.vy) * 0.4);
                burst(K.x - nx * 8, K.y - ny * 8, col, Math.min(16, 4 + impact / 55), 150 + impact * 0.35, 2.8);
              }
              if (impact > 520) { e.shake = Math.min(13, e.shake + (impact - 480) / 60); e.hitStop = 0.028; }
              else if (impact > 300) e.shake = Math.min(8, e.shake + 1.6);
              // nudge minimum exit speed so puck never sticks
              const out = Math.hypot(K.vx, K.vy);
              if (out < 130) { K.vx += nx * 110; K.vy += ny * 110; }
            }
          }
        }
      }
      // trail
      K.trail.unshift({ x: K.x, y: K.y });
      if (K.trail.length > 13) K.trail.pop();
    }

    /* ---- particles / texts / shake ---- */
    for (let i = e.particles.length - 1; i >= 0; i--) {
      const p = e.particles[i];
      p.life += dt;
      if (p.life >= p.max) { e.particles.splice(i, 1); continue; }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (let i = e.texts.length - 1; i >= 0; i--) {
      const t = e.texts[i];
      t.life += dt; t.y -= 34 * dt;
      if (t.life >= t.max) e.texts.splice(i, 1);
    }
    e.flash = Math.max(0, e.flash - dt * 2.4);
    e.shake *= Math.exp(-7.5 * dt);
    if (e.shake < 0.05) e.shake = 0;

    // HUD timer (DOM write, no React rerender)
    const whole = Math.floor(e.time);
    if (whole !== e.lastWholeSec) {
      e.lastWholeSec = whole;
      if (timerElRef.current) timerElRef.current.textContent = fmtTime(whole);
    }
  }, [audio, burst, finishMatch, onGoal, serve]);

  /* ================= DRAW ================= */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const e = engRef.current;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = W * dpr, ch = H * dpr;
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const shX = e.shake ? (Math.random() * 2 - 1) * e.shake : 0;
    const shY = e.shake ? (Math.random() * 2 - 1) * e.shake : 0;
    ctx.save();
    ctx.translate(shX, shY);

    // table body
    ctx.fillStyle = "#081120";
    ctx.fillRect(-24, -24, W + 48, H + 48);
    // rounded ice clip
    const R = 22;
    ctx.beginPath();
    ctx.roundRect(3, 3, W - 6, H - 6, R);
    ctx.fillStyle = "#0c1a2e";
    ctx.fill();
    ctx.save();
    ctx.clip();
    // halves tint (solid translucent overlays)
    ctx.fillStyle = "rgba(251,113,133,0.055)";
    ctx.fillRect(0, 0, W, H / 2);
    ctx.fillStyle = "rgba(34,211,238,0.055)";
    ctx.fillRect(0, H / 2, W, H / 2);
    // ice dots
    ctx.fillStyle = "rgba(180,220,255,0.05)";
    for (let x = 22; x < W; x += 34) for (let y = 22; y < H; y += 34) {
      ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill();
    }
    // glow under puck speed
    const K = e.puck;
    const spd = Math.hypot(K.vx, K.vy);
    if ((e.phase === "playing" || e.phase === "menu") && spd > 260) {
      const g = ctx.createRadialGradient(K.x, K.y, 2, K.x, K.y, 54);
      g.addColorStop(0, "rgba(165,243,252,0.20)");
      g.addColorStop(1, "rgba(165,243,252,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(K.x, K.y, 54, 0, Math.PI * 2); ctx.fill();
    }

    // centre markings
    ctx.strokeStyle = "rgba(226,244,255,0.28)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(10, H / 2); ctx.lineTo(W - 10, H / 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 62, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(226,244,255,0.35)";
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 5, 0, Math.PI * 2); ctx.fill();
    // creases
    ctx.strokeStyle = "rgba(251,113,133,0.4)";
    ctx.beginPath(); ctx.arc(W / 2, 4, 74, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    ctx.strokeStyle = "rgba(34,211,238,0.4)";
    ctx.beginPath(); ctx.arc(W / 2, H - 4, 74, 1.15 * Math.PI, 1.85 * Math.PI); ctx.stroke();

    // goals
    const goalPulse = 0.65 + Math.sin(e.tGlobal * 4) * 0.18;
    ctx.fillStyle = "#020610";
    ctx.fillRect(GOAL_X0, 0, GOAL_W, 12);
    ctx.fillRect(GOAL_X0, H - 12, GOAL_W, 12);
    ctx.fillStyle = `rgba(251,113,133,${goalPulse})`;
    ctx.fillRect(GOAL_X0, 9, GOAL_W, 3);
    ctx.fillStyle = `rgba(34,211,238,${goalPulse})`;
    ctx.fillRect(GOAL_X0, H - 12, GOAL_W, 3);
    // posts
    ctx.fillStyle = WHITE;
    for (const [px, py] of [[GOAL_X0, 6], [GOAL_X1, 6], [GOAL_X0, H - 6], [GOAL_X1, H - 6]] as const) {
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
    }

    // puck trail
    if (e.phase !== "goal") {
      for (let i = K.trail.length - 1; i >= 2; i--) {
        const t = K.trail[i];
        const a = (1 - i / K.trail.length) * 0.16;
        ctx.fillStyle = `rgba(190,240,255,${a})`;
        ctx.beginPath(); ctx.arc(t.x, t.y, PUCK_R * (1 - i / (K.trail.length * 1.6)), 0, Math.PI * 2); ctx.fill();
      }
    }

    // particles (additive sparks)
    ctx.globalCompositeOperation = "lighter";
    for (const p of e.particles) {
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * a + 0.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    // puck
    if (e.phase !== "over") {
      ctx.save();
      ctx.shadowColor = "rgba(190,240,255,0.85)";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "#f6fbff";
      ctx.beginPath(); ctx.arc(K.x, K.y, PUCK_R, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = "#c7dff2";
      ctx.beginPath(); ctx.arc(K.x, K.y, PUCK_R - 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#eef8ff";
      ctx.beginPath(); ctx.arc(K.x - 3, K.y - 3, 3.4, 0, Math.PI * 2); ctx.fill();
    }

    // paddles
    const drawPaddle = (p: Body & { squash: number }, color: string, dark: string) => {
      const sq = 1 - p.squash * 0.16;
      const sy = 1 + p.squash * 0.13;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(sq, sy);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath(); ctx.ellipse(0, 7, PAD_R, PAD_R * 0.82, 0, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = color;
      ctx.shadowBlur = 16;
      ctx.fillStyle = dark;
      ctx.beginPath(); ctx.arc(0, 0, PAD_R, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 3.5; ctx.strokeStyle = color;
      ctx.beginPath(); ctx.arc(0, 0, PAD_R - 1.5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(0, 0, 12.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#07111f";
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    drawPaddle(e.ai, ROSE, "#2a1018");
    drawPaddle(e.player, CYAN, "#0a2432");

    // floating texts
    for (const t of e.texts) {
      const a = t.life < 0.12 ? t.life / 0.12 : 1 - Math.max(0, (t.life - t.max * 0.62) / (t.max * 0.38));
      const scale = t.life < 0.16 ? 0.6 + (t.life / 0.16) * 0.4 : 1;
      ctx.save();
      ctx.translate(t.x, t.y); ctx.scale(scale, scale);
      ctx.globalAlpha = Math.max(0, a);
      ctx.font = `900 ${t.size}px Orbitron, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.shadowColor = t.color; ctx.shadowBlur = 18;
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    }

    // goal flash
    if (e.flash > 0 && e.goalScorer) {
      ctx.fillStyle = e.goalScorer === "player" ? `rgba(34,211,238,${e.flash * 0.16})` : `rgba(251,113,133,${e.flash * 0.16})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore(); // unclip

    // frame
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#22385a";
    ctx.beginPath(); ctx.roundRect(3, 3, W - 6, H - 6, R); ctx.stroke();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(140,210,255,0.35)";
    ctx.beginPath(); ctx.roundRect(6.5, 6.5, W - 13, H - 13, R - 3); ctx.stroke();
    ctx.restore();
  }, []);

  /* ================= LOOP ================= */
  useEffect(() => {
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const e = engRef.current;
      if (e.phase !== "paused" && e.phase !== "over") update(Math.min(dt, 0.05));
      else if (e.phase === "over") {
        // keep particles alive on game-over backdrop
        const d2 = Math.min(dt, 0.05);
        for (let i = e.particles.length - 1; i >= 0; i--) {
          const p = e.particles[i]; p.life += d2;
          if (p.life >= p.max) { e.particles.splice(i, 1); continue; }
          const dr = Math.exp(-p.drag * d2); p.vx *= dr; p.vy *= dr; p.x += p.vx * d2; p.y += p.vy * d2;
        }
      }
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [update, draw]);

  /* celebration confetti on win screen mount */
  useEffect(() => {
    if (screen === "gameover" && winner === "player") {
      const id = window.setInterval(() => {
        burst(Math.random() * W, H * 0.3 + Math.random() * H * 0.3, Math.random() > 0.5 ? CYAN : "#fbbf24", 10, 260, 3);
      }, 420);
      return () => window.clearInterval(id);
    }
  }, [screen, winner, burst]);

  /* ================= INPUT ================= */
  const setPointerFromEvent = useCallback((ev: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    pointerRef.current.x = ((ev.clientX - rect.left) / rect.width) * W;
    pointerRef.current.y = ((ev.clientY - rect.top) / rect.height) * H;
    pointerRef.current.active = true;
    engRef.current.player.usingKeys = false;
  }, []);

  useEffect(() => {
    const down = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) ev.preventDefault();
      if (ev.repeat && [" ", "enter", "p", "з", "escape", "r", "к", "m", "ь", "f", "а"].includes(k)) return;
      if (k === "f" || k === "а") {
        toggleFullscreen();
        return;
      }
      if (k === " ") {
        if (screenRef.current === "menu") startMatch();
        else if (screenRef.current === "gameover") startMatch();
        else if (screenRef.current === "paused") resume();
        return;
      }
      if (k === "enter") {
        if (screenRef.current === "menu" || screenRef.current === "gameover") startMatch();
        return;
      }
      if (k === "p" || k === "з" || k === "escape") {
        if (screenRef.current === "playing" || screenRef.current === "paused") togglePause();
        return;
      }
      if (k === "r" || k === "к") {
        if (screenRef.current === "playing" || screenRef.current === "paused" || screenRef.current === "gameover") startMatch();
        return;
      }
      if (k === "m" || k === "ь") { setMuted(m => { mutedRef.current = !m; return !m; }); return; }
      keysRef.current.add(k);
    };
    const up = (ev: KeyboardEvent) => keysRef.current.delete(ev.key.toLowerCase());
    const blur = () => {
      keysRef.current.clear();
      const e = engRef.current;
      if (e.phase === "playing" || e.phase === "countdown" || e.phase === "goal") { e.prevPhase = e.phase; e.phase = "paused"; e.shake = 0; setScreenBoth("paused"); }
    };
    const vis = () => { if (document.hidden) blur(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [startMatch, togglePause, resume, setScreenBoth, toggleFullscreen]);

  const toMenu = useCallback(() => {
    const e = engRef.current;
    e.phase = "menu"; e.scoreP = 0; e.scoreA = 0; e.particles = []; e.texts = [];
    e.puck.x = W / 2; e.puck.y = H / 2; e.puck.vx = 130; e.puck.vy = 190;
    setScoreP(0); setScoreA(0); setWinner(null); setGoalBanner(null); setCountdownVal(null);
    setScreenBoth("menu");
    audio.click();
  }, [audio, setScreenBoth]);

  /* derived stats */
  const wins = scores.filter(s => s.result === "ПОБЕДА" || (s.result as string) === "WIN").length;
  const bestWin = scores.filter(s => s.result === "ПОБЕДА" || (s.result as string) === "WIN").sort((a, b) => (b.player - b.ai) - (a.player - a.ai))[0];
  let streak = 0;
  for (const s of scores) { if (s.result === "ПОБЕДА" || (s.result as string) === "WIN") streak++; else break; }

  const diff = DIFFS[difficulty];

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#05080f] text-slate-100 select-none">
      {/* ambient solid glows (radial, decorative) */}
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[820px] -translate-x-1/2 rounded-full opacity-25 blur-3xl" style={{ background: "radial-gradient(closest-side, #164e63 0%, transparent 100%)" }} />
      <div aria-hidden className="pointer-events-none absolute bottom-0 right-0 h-[380px] w-[520px] rounded-full opacity-15 blur-3xl" style={{ background: "radial-gradient(closest-side, #881337 0%, transparent 100%)" }} />

      {/* ---------- header ---------- */}
      <header className="relative z-10 mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between gap-3 px-4 pt-2.5 pb-1 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-400 text-slate-950 shadow-[0_0_20px_rgba(34,211,238,0.45)] sm:h-9 sm:w-9">
            <Zap className="h-4.5 w-4.5" strokeWidth={2.6} />
          </div>
          <div className="leading-none">
            <p className="font-display text-[13px] font-black tracking-[0.16em] text-white sm:text-[15px]">НЕОНОВЫЙ АЭРОХОККЕЙ</p>
            <p className="mt-0.5 text-[10px] font-semibold tracking-[0.24em] text-cyan-300/80">АРКАДНАЯ ДУЭЛЬ · ДО {WIN_SCORE} ГОЛОВ</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          {streak >= 2 && (
            <span className="hidden items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-bold text-amber-300 sm:inline-flex">
              <Flame className="h-3.5 w-3.5" /> СЕРИЯ: {streak} ПОБЕД
            </span>
          )}
          <button
            onClick={toggleFullscreen}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700 bg-[#0b1526] text-slate-300 transition hover:border-cyan-400/60 hover:text-cyan-300 active:scale-95"
            aria-label="Полный экран"
            title="Полный экран (F)"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            onClick={() => { setMuted(m => { mutedRef.current = !m; return !m; }); }}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700 bg-[#0b1526] text-slate-300 transition hover:border-cyan-400/60 hover:text-cyan-300 active:scale-95"
            aria-label="Переключить звук"
            title="Звук (M)"
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          {(screen === "playing") && (
            <>
              <button
                onClick={() => startMatch()}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700 bg-[#0b1526] text-slate-300 transition hover:border-cyan-400/60 hover:text-cyan-300 active:scale-95"
                title="Заново (R)"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                onClick={togglePause}
                className="flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-[#0b1526] px-2.5 text-xs font-bold text-slate-200 transition hover:border-cyan-400/60 hover:text-cyan-300 active:scale-95"
                title="Пауза (P / Esc)"
              >
                <Pause className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Пауза</span>
              </button>
            </>
          )}
        </div>
      </header>

      {/* ---------- main layout ---------- */}
      <main className="relative z-10 mx-auto flex min-h-0 w-full max-w-6xl flex-1 items-center justify-center gap-6 px-3 pb-2.5 pt-1 sm:px-6">
        {/* ===== GAME COLUMN ===== */}
        <section className="flex h-full min-h-0 flex-col items-center justify-center">
          {/* HUD (compact with integrated progress pips) */}
          <div className="mb-1.5 w-full shrink-0 rounded-2xl border border-slate-800 bg-[#0a1322]/90 px-3 py-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.45)]">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.9)]" />
                <div className="leading-none">
                  <p className="text-[9px] font-bold tracking-[0.2em] text-cyan-300">ВЫ</p>
                  <p key={`p-${scoreP}`} className="anim-score-pop font-display text-[22px] font-black leading-none text-white">{scoreP}</p>
                </div>
              </div>
              <div className="text-center leading-none">
                <p className="flex items-center justify-center gap-1 text-[9px] font-bold tracking-[0.18em] text-slate-400"><Timer className="h-2.5 w-2.5" /> ВРЕМЯ</p>
                <span ref={timerElRef} className="font-display text-xs font-bold text-slate-200">0:00</span>
              </div>
              <div className="flex items-center justify-end gap-2">
                <div className="text-right leading-none">
                  <p className="text-[9px] font-bold tracking-[0.2em] text-rose-300">БОТ · {diff.label}</p>
                  <p key={`a-${scoreA}`} className="anim-score-pop font-display text-[22px] font-black leading-none text-white">{scoreA}</p>
                </div>
                <span className="h-2 w-2 shrink-0 rounded-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.9)]" />
              </div>
            </div>
            {/* progress pips inside HUD */}
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <div className="flex gap-1">
                {Array.from({ length: WIN_SCORE }).map((_, i) => (
                  <span key={i} className={`h-1 w-3.5 rounded-full transition-all duration-300 sm:w-4 ${i < scoreP ? "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)]" : "bg-slate-800"}`} />
                ))}
              </div>
              <span className="font-display text-[8px] font-bold tracking-[0.2em] text-slate-500">ДО {WIN_SCORE}</span>
              <div className="flex gap-1">
                {Array.from({ length: WIN_SCORE }).map((_, i) => (
                  <span key={i} className={`h-1 w-3.5 rounded-full transition-all duration-300 sm:w-4 ${i < scoreA ? "bg-rose-400 shadow-[0_0_6px_rgba(251,113,133,0.8)]" : "bg-slate-800"}`} />
                ))}
              </div>
            </div>
          </div>

          {/* ===== TABLE FRAME ===== */}
          <div
            className="anim-frame-glow relative min-h-0 flex-1 overflow-hidden rounded-[24px] border border-[#1d3355] bg-[#081120] p-1.5"
            style={{
              aspectRatio: `${W} / ${H}`,
              maxHeight: "calc(100dvh - 126px)",
              maxWidth: "min(94vw, 450px)",
            }}
          >
            <canvas
              ref={canvasRef}
              className="block h-full w-full touch-none rounded-[18px]"
              onPointerDown={(ev) => { (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId); pointerRef.current.id = ev.pointerId; setPointerFromEvent(ev); audio.unlock(); }}
              onPointerMove={(ev) => { if (pointerRef.current.id === null || pointerRef.current.id === ev.pointerId || ev.pointerType === "mouse") setPointerFromEvent(ev); }}
              onPointerUp={(ev) => { if (pointerRef.current.id === ev.pointerId) pointerRef.current.id = null; }}
              onPointerCancel={() => { pointerRef.current.id = null; }}
            />

            {/* countdown */}
            {countdownVal !== null && screen === "playing" && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span key={countdownVal} className="anim-count font-display text-[84px] font-black text-white drop-shadow-[0_0_30px_rgba(34,211,238,0.8)]">{countdownVal}</span>
              </div>
            )}

            {/* goal banner */}
            {goalBanner && screen === "playing" && countdownVal === null && (
              <div key={goalBanner.id} className="pointer-events-none absolute inset-x-0 top-[16%] flex flex-col items-center">
                <span className={`anim-banner font-display text-[38px] font-black sm:text-[46px] ${goalBanner.scorer === "player" ? "text-cyan-300 drop-shadow-[0_0_26px_rgba(34,211,238,0.9)]" : "text-rose-400 drop-shadow-[0_0_26px_rgba(251,113,133,0.9)]"}`}>
                  {goalBanner.scorer === "player" ? "ГОЛ!" : "ПРОПУЩЕН"}
                </span>
                <span className="anim-rise mt-1 rounded-full border border-white/15 bg-black/50 px-3 py-1 text-[11px] font-bold tracking-[0.2em] text-white/90">
                  {goalBanner.scorer === "player" ? `${scoreP} — ${scoreA} · ВАША ПОДАЧА` : `${scoreP} — ${scoreA} · ЗАЩИЩАЙТЕСЬ!`}
                </span>
              </div>
            )}

            {/* ============ MENU OVERLAY ============ */}
            {screen === "menu" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center overflow-y-auto bg-[#04070d]/72 px-4 py-3 text-center backdrop-blur-[2px]">
                <div className="anim-float-slow flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan-400 text-slate-950 shadow-[0_0_36px_rgba(34,211,238,0.55)]">
                  <Zap className="h-6 w-6" strokeWidth={2.6} />
                </div>
                <h1 className="anim-rise font-display mt-3 text-[28px] font-black leading-[0.95] tracking-wide text-white sm:text-[34px]">
                  АЭРО<br />ХОККЕЙ
                </h1>
                <p className="anim-rise mt-1.5 max-w-[260px] text-[13px] font-semibold leading-snug text-slate-300" style={{ animationDelay: "60ms" }}>
                  Забивай шайбу в ворота бота. Первый до {WIN_SCORE} очков побеждает.
                </p>

                {/* difficulty picker */}
                <div className="anim-rise mt-3 grid w-full max-w-[290px] grid-cols-3 gap-1 rounded-2xl border border-slate-700/80 bg-[#0a1424] p-1" style={{ animationDelay: "110ms" }}>
                  {(Object.keys(DIFFS) as Difficulty[]).map(d => (
                    <button
                      key={d}
                      onClick={() => { diffRef.current = d; setDifficulty(d); audio.click(); }}
                      className={`rounded-xl px-2 py-1.5 text-[11px] font-black tracking-wider transition active:scale-95 ${difficulty === d ? "bg-slate-100 text-slate-950" : "text-slate-400 hover:text-white"}`}
                    >
                      {DIFFS[d].label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 h-4 text-[11px] font-semibold" style={{ color: diff.color }}>{diff.desc}</p>

                <button
                  onClick={() => startMatch()}
                  className="group anim-rise mt-2.5 flex items-center gap-2 rounded-2xl bg-cyan-400 px-7 py-3 font-display text-sm font-black tracking-[0.14em] text-slate-950 shadow-[0_0_34px_rgba(34,211,238,0.5)] transition hover:bg-cyan-300 active:scale-95"
                  style={{ animationDelay: "160ms" }}
                >
                  <Play className="h-4.5 w-4.5 fill-slate-950 transition group-hover:scale-110" /> ИГРАТЬ
                </button>
                <p className="anim-blink-soft mt-2 text-[10px] font-bold tracking-[0.2em] text-slate-400">НАЖМИТЕ ПРОБЕЛ ИЛИ КНОПКУ</p>

                <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-[10px] font-semibold text-slate-400">
                  <span className="flex items-center gap-1"><MousePointer2 className="h-3 w-3 text-cyan-300" /> Мышь</span>
                  <span className="flex items-center gap-1"><Hand className="h-3 w-3 text-cyan-300" /> Тач / Сенсор</span>
                  <span className="flex items-center gap-1"><Keyboard className="h-3 w-3 text-cyan-300" /> WASD / Стрелки</span>
                </div>
                {scores.length > 0 && (
                  <button onClick={() => setShowScoresMobile(v => !v)} className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-bold text-amber-300 lg:hidden">
                    <Trophy className="h-3 w-3" /> {showScoresMobile ? "Скрыть" : "Показать"} историю <ChevronRight className={`h-3 w-3 transition ${showScoresMobile ? "rotate-90" : ""}`} />
                  </button>
                )}
                {showScoresMobile && scores.length > 0 && (
                  <div className="mt-2 w-full max-w-[300px] lg:hidden"><ScoreTable scores={scores.slice(0, 4)} compact /></div>
                )}
              </div>
            )}

            {/* ============ PAUSE OVERLAY ============ */}
            {screen === "paused" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#04070d]/78 px-5 text-center backdrop-blur-[3px]">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-700 bg-[#0b1526] text-cyan-300"><Pause className="h-5 w-5" /></span>
                <h2 className="font-display mt-3 text-2xl font-black tracking-wider text-white">ПАУЗА</h2>
                <p className="mt-1 text-xs font-semibold text-slate-400">Счёт зафиксирован: {scoreP} — {scoreA}. Переведите дыхание.</p>
                <div className="mt-4 flex w-full max-w-[250px] flex-col gap-2">
                  <button onClick={resume} className="flex items-center justify-center gap-2 rounded-2xl bg-cyan-400 px-5 py-2.5 font-display text-xs font-black tracking-widest text-slate-950 transition hover:bg-cyan-300 active:scale-95">
                    <Play className="h-3.5 w-3.5 fill-slate-950" /> ПРОДОЛЖИТЬ
                  </button>
                  <button onClick={() => startMatch()} className="flex items-center justify-center gap-2 rounded-2xl border border-slate-600 bg-[#0b1526] px-5 py-2.5 font-display text-xs font-black tracking-widest text-white transition hover:border-slate-400 active:scale-95">
                    <RotateCcw className="h-3.5 w-3.5" /> НАЧАТЬ ЗАНОВО
                  </button>
                  <button onClick={toMenu} className="flex items-center justify-center gap-1.5 rounded-2xl px-5 py-1.5 text-xs font-bold text-slate-400 transition hover:text-white active:scale-95">
                    <X className="h-3.5 w-3.5" /> В главное меню
                  </button>
                </div>
                <p className="mt-3 text-[10px] font-bold tracking-[0.18em] text-slate-500">ESC / P — ПРОДОЛЖИТЬ · R — ПЕРЕЗАПУСК</p>
              </div>
            )}

            {/* ============ GAME OVER OVERLAY ============ */}
            {screen === "gameover" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#04070d]/80 px-5 text-center backdrop-blur-[3px]">
                {winner === "player" ? (
                  <span className="anim-float-slow flex h-14 w-14 items-center justify-center rounded-full bg-amber-400 text-slate-950 shadow-[0_0_40px_rgba(251,191,36,0.55)]"><Crown className="h-7 w-7" strokeWidth={2.4} /></span>
                ) : (
                  <span className="flex h-14 w-14 items-center justify-center rounded-full border border-rose-400/50 bg-rose-500/15 text-rose-300"><Shield className="h-7 w-7" strokeWidth={2.2} /></span>
                )}
                <h2 className={`anim-banner font-display mt-3 text-[32px] font-black leading-none ${winner === "player" ? "text-amber-300 drop-shadow-[0_0_26px_rgba(251,191,36,0.7)]" : "text-rose-400 drop-shadow-[0_0_26px_rgba(251,113,133,0.7)]"}`}>
                  {winner === "player" ? "ПОБЕДА!" : "ПОРАЖЕНИЕ"}
                </h2>
                <p className="font-display mt-2 text-3xl font-black text-white">{scoreP} <span className="text-slate-500">—</span> {scoreA}</p>
                <p className="mt-1 text-xs font-semibold text-slate-300">
                  {winner === "player"
                    ? scoreA <= 2 ? "Полное доминирование. Арена под вашим контролем!" : scoreA <= 5 ? "Отличная игра и мастерские удары!" : "Невероятный камбэк и валидольная концовка!"
                    : scoreP <= 2 ? "Тяжёлый матч. Возьмите реванш!" : "Было близко — попробуйте ещё раз!"}
                </p>
                <div className="mt-3 grid w-full max-w-[270px] grid-cols-3 gap-1.5 text-center">
                  <div className="rounded-xl border border-slate-800 bg-[#0a1424] px-2 py-2">
                    <p className="text-[8px] font-bold tracking-[0.16em] text-slate-500">СЛОЖНОСТЬ</p>
                    <p className="font-display mt-0.5 text-[11px] font-black" style={{ color: diff.color }}>{diff.label}</p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-[#0a1424] px-2 py-2">
                    <p className="text-[8px] font-bold tracking-[0.16em] text-slate-500">РАЗНИЦА</p>
                    <p className="font-display mt-0.5 text-[11px] font-black text-white">{scoreP > scoreA ? "+" : ""}{scoreP - scoreA}</p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-[#0a1424] px-2 py-2">
                    <p className="text-[8px] font-bold tracking-[0.16em] text-slate-500">СЕРИЯ</p>
                    <p className="font-display mt-0.5 flex items-center justify-center gap-1 text-[11px] font-black text-amber-300"><Flame className="h-3 w-3" />{streak}</p>
                  </div>
                </div>
                <div className="mt-4 flex w-full max-w-[270px] flex-col gap-1.5">
                  <button onClick={() => startMatch()} autoFocus className="flex items-center justify-center gap-2 rounded-2xl bg-cyan-400 px-5 py-3 font-display text-xs font-black tracking-widest text-slate-950 shadow-[0_0_30px_rgba(34,211,238,0.45)] transition hover:bg-cyan-300 active:scale-95">
                    <RotateCcw className="h-4 w-4" strokeWidth={2.6} /> РЕВАНШ
                  </button>
                  <button onClick={toMenu} className="rounded-2xl border border-slate-700 bg-[#0b1526] px-5 py-2.5 font-display text-xs font-black tracking-widest text-slate-200 transition hover:border-slate-500 active:scale-95">
                    В ГЛАВНОЕ МЕНЮ
                  </button>
                </div>
                <p className="anim-blink-soft mt-2.5 text-[10px] font-bold tracking-[0.2em] text-slate-500">НАЖМИТЕ R ИЛИ ПРОБЕЛ ДЛЯ РЕВАНША</p>
              </div>
            )}
          </div>
        </section>

        {/* ===== SIDE PANEL (desktop) ===== */}
        <aside className="hidden h-full max-h-[calc(100dvh-70px)] w-[350px] shrink-0 flex-col justify-center gap-3 overflow-y-auto pr-1 lg:flex">
          {/* how to play */}
          <div className="anim-rise rounded-2xl border border-slate-800 bg-[#0a1322]/90 p-4">
            <h3 className="font-display flex items-center gap-2 text-xs font-black tracking-[0.16em] text-white"><Swords className="h-4 w-4 text-cyan-300" /> КАК ИГРАТЬ</h3>
            <ul className="mt-2.5 space-y-2 text-[13px] font-semibold leading-snug text-slate-300">
              <li className="flex gap-2.5"><MousePointer2 className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" /> <span>Двигайте мышь или ведите пальцем — бита следует за курсором. Резкий мах ускоряет шайбу.</span></li>
              <li className="flex gap-2.5"><Keyboard className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" /> <span>Клавиатура: клавиши <span className="kbd">W</span> <span className="kbd">A</span> <span className="kbd">S</span> <span className="kbd">D</span> или стрелки.</span></li>
              <li className="flex gap-2.5"><Target className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" /> <span>Рикошеты от бортов: бот перекрывает центр, бейте по диагоналям в углы.</span></li>
              <li className="flex gap-2.5"><Gauge className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /> <span>До {WIN_SCORE} голов. <span className="kbd">P</span> пауза · <span className="kbd">R</span> заново · <span className="kbd">M</span> звук · <span className="kbd">F</span> экран.</span></li>
            </ul>
            <div className="mt-3">
              <p className="text-[9px] font-bold tracking-[0.2em] text-slate-500">СЛОЖНОСТЬ ДЛЯ СЛЕДУЮЩЕГО МАТЧА</p>
              <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-xl border border-slate-800 bg-[#081120] p-1">
                {(Object.keys(DIFFS) as Difficulty[]).map(d => (
                  <button key={d} onClick={() => { diffRef.current = d; setDifficulty(d); audio.click(); }} className={`rounded-lg px-2 py-1.5 text-[11px] font-black tracking-wider transition active:scale-95 ${difficulty === d ? "bg-slate-100 text-slate-950" : "text-slate-400 hover:text-white"}`}>
                    {DIFFS[d].label}
                  </button>
                ))}
              </div>
              {screen !== "playing" && (
                <button onClick={() => startMatch()} className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 font-display text-xs font-black tracking-widest text-slate-950 transition hover:bg-cyan-300 active:scale-95">
                  <Play className="h-3.5 w-3.5 fill-slate-950" /> НАЧАТЬ МАТЧ
                </button>
              )}
            </div>
          </div>

          {/* stats + history */}
          <div className="anim-rise flex min-h-0 flex-col rounded-2xl border border-slate-800 bg-[#0a1322]/90 p-4" style={{ animationDelay: "70ms" }}>
            <div className="flex items-center justify-between">
              <h3 className="font-display flex items-center gap-2 text-xs font-black tracking-[0.16em] text-white"><Trophy className="h-4 w-4 text-amber-300" /> СТАТИСТИКА И РЕКОРДЫ</h3>
              {scores.length > 0 && (
                <button onClick={() => { setScores([]); try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ } }} className="flex items-center gap-1 text-[11px] font-bold text-slate-500 transition hover:text-rose-300">
                  <Trash2 className="h-3 w-3" /> Очистить
                </button>
              )}
            </div>
            <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-[#081120] px-2 py-2">
                <p className="font-display text-lg font-black text-white">{scores.length}</p>
                <p className="text-[8px] font-bold tracking-[0.18em] text-slate-500">МАТЧЕЙ</p>
              </div>
              <div className="rounded-xl bg-[#081120] px-2 py-2">
                <p className="font-display text-lg font-black text-cyan-300">{scores.length ? Math.round((wins / scores.length) * 100) : 0}%</p>
                <p className="text-[8px] font-bold tracking-[0.18em] text-slate-500">ПОБЕД</p>
              </div>
              <div className="rounded-xl bg-[#081120] px-2 py-2">
                <p className="font-display flex items-center justify-center gap-1 text-lg font-black text-amber-300"><Flame className="h-3.5 w-3.5" />{streak}</p>
                <p className="text-[8px] font-bold tracking-[0.18em] text-slate-500">СЕРИЯ</p>
              </div>
            </div>
            {bestWin && (
              <p className="mt-2.5 flex items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-400/8 px-2.5 py-1.5 text-[12px] font-bold text-amber-200">
                <Medal className="h-3.5 w-3.5 shrink-0" /> Рекорд: {bestWin.player}—{bestWin.ai} ({bestWin.difficulty}) · {bestWin.date}
              </p>
            )}
            <div className="mt-2.5 max-h-[190px] overflow-y-auto">
              {scores.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-800 px-3 py-4 text-center">
                  <Trophy className="mx-auto h-5 w-5 text-slate-600" />
                  <p className="mt-1.5 text-xs font-bold text-slate-400">Матчей пока нет</p>
                  <p className="text-[11px] font-semibold text-slate-500">Сыграйте матч, и результаты сохранятся здесь.</p>
                </div>
              ) : (
                <ScoreTable scores={scores.slice(0, 6)} />
              )}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function ScoreTable({ scores, compact = false }: { scores: ScoreEntry[]; compact?: boolean }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="bg-[#0d1930] text-[9px] font-black tracking-[0.18em] text-slate-500">
            <th className="px-3 py-2">ИТОГ</th>
            <th className="px-3 py-2">СЧЁТ</th>
            {!compact && <th className="px-3 py-2">РЕЖИМ</th>}
            <th className="px-3 py-2 text-right">ВРЕМЯ</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((s, i) => (
            <tr key={s.id} className={`border-t border-slate-800/70 ${i === 0 ? "bg-white/[0.03]" : ""}`}>
              <td className="px-3 py-2">
                <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-display text-[10px] font-black tracking-wider ${s.result === "ПОБЕДА" || (s.result as string) === "WIN" ? "bg-cyan-400/15 text-cyan-300" : "bg-rose-400/15 text-rose-300"}`}>{s.result}</span>
              </td>
              <td className="px-3 py-2 font-display font-black text-white">{s.player}—{s.ai}</td>
              {!compact && <td className="px-3 py-2 font-bold text-slate-400">{s.difficulty}</td>}
              <td className="px-3 py-2 text-right font-semibold text-slate-400">{fmtTime(s.duration)}<span className="block text-[10px] font-semibold text-slate-600">{s.date}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
