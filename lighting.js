// lighting.js
// Asistente de luz: ayuda al SDK cuando hay poca o demasiada luz, sin modelos pesados.
//
//  1) Medición en TU ROSTRO. El "detector de objetos" es el propio SDK (sus landmarks dan el recuadro del
//     rostro); si todavía no te ha encontrado, se mide la zona central donde se espera tu cara. Así se
//     distingue "la habitación está oscura" de "estás a contraluz".
//  2) Exposición de la cámara. Si el controlador de la webcam lo permite, sube o baja la compensación de
//     exposición/brillo, y fija un tiempo de exposición máximo si la cámara pierde cuadros por poca luz.
//  3) Normalizador de brillo. La imagen que recibe el SDK pasa por un canvas con una ganancia SUAVE
//     (cambios lentos para no meter artefactos en la señal del pulso) que lleva la luz de tu rostro hacia
//     un nivel útil. Solo actúa cuando la luz está fuera de rango; en rango la imagen pasa sin cambios.
//     No inventa cuadros: solo dibuja los que entrega la cámara.
// Nada se guarda: cada cuadro se procesa y se descarta.
'use strict';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const TARGET = 118;                 // luminosidad objetivo del rostro (0-255)
const OK_LOW = 95, OK_HIGH = 150;   // zona sin corrección
const G_MIN = 0.55, G_MAX = 2.8;    // límites de la ganancia
const FACE_ZONE = { cx: 0.5, cy: 0.34, rx: 0.15, ry: 0.23 };   // misma zona objetivo que vision.js

class LightAssist {
    constructor(vision) {
        this.vision = vision;
        this.enabled = true;
        this.active = false;
        this.cv = document.createElement('canvas');
        this.ctx = this.cv.getContext('2d', { alpha: false });
        this.probe = document.createElement('canvas');
        this.probe.width = 64; this.probe.height = 48;
        this.pctx = this.probe.getContext('2d', { willReadFrequently: true });
        this.gain = 1;
        this.gTarget = 1;
        this.roiLuma = null; this.bgLuma = null; this.rawLuma = null;
        this.video = null;
        this.out = null;
        this.hold = false;          // v5c: si la cámara real da <25 fps, se re-emite a 30 Hz repitiendo el último cuadro real
        this._holdTimer = null;
        this._pumpRaf = 0;
        this._next = 0;             // v6: instante del próximo cuadro de salida (reloj propio, sin depender de setInterval)
        this._outTrack = null;
        this._manual = false;       // true si la salida emite con requestFrame() (cadencia exacta)
        this._probeAt = 0;
        this._onFrame = this._onFrame.bind(this);
    }

    // Devuelve el MediaStream que debe recibir el SDK (con la luz corregida).
    async start(video) {
        this.video = video;
        this.active = true;
        this.gain = 1; this.gTarget = 1;
        // Salida con cadencia exacta: captureStream(0) + requestFrame(). Si el navegador no lo ofrece, cae a captureStream(30).
        this.out = this.cv.captureStream(0);
        this._outTrack = this.out.getVideoTracks()[0] || null;
        this._manual = !!(this._outTrack && typeof this._outTrack.requestFrame === 'function');
        if (!this._manual) { this.out.getTracks().forEach((t) => t.stop()); this.out = this.cv.captureStream(30); this._outTrack = null; }
        await this._firstFrame(video);
        this._schedule();
        // Modo compatibilidad: el SDK exige 25+ cuadros por segundo. Cada cuadro REAL se mantiene hasta que llega el
        // siguiente (muestreo-retención), así la línea de tiempo no se altera: solo se repite el último cuadro real.
        // v6: el reloj de 30 Hz usa requestAnimationFrame (+ un temporizador de respaldo). Con solo setInterval(33),
        // Windows redondea a 15,6 ms y a veces entrega ~21 cuadros/s: justo lo que dispara el error 14.
        if (this.hold) this._startPump();
        else this._emit();
        return this.out;
    }

    stop() {
        this.active = false;
        if (this._holdTimer) { clearInterval(this._holdTimer); this._holdTimer = null; }
        if (this._pumpRaf) { cancelAnimationFrame(this._pumpRaf); this._pumpRaf = 0; }
        this._outTrack = null; this._manual = false;
        this.roiLuma = this.bgLuma = this.rawLuma = null;
        this.gain = 1; this.gTarget = 1;
        if (this.out) { for (const t of this.out.getTracks()) t.stop(); this.out = null; }
    }

    get canvas() { return this.cv; }

    // Publica el contenido actual del canvas como un cuadro de salida.
    _emit() {
        if (this._manual && this._outTrack) { try { this._outTrack.requestFrame(); } catch { /* pista cerrada */ } }
        else this._draw();                  // captureStream(30): redibujar fuerza el cuadro
    }

    _startPump() {
        const period = 1000 / 30;
        this._next = performance.now();
        const run = () => {
            if (!this.active || !this.hold) return;
            const now = performance.now();
            if (now >= this._next - 2) {                              // 2 ms de holgura por la granularidad de rAF
                this._next = Math.max(this._next + period, now - period);   // cadencia media exacta de 30 Hz
                this._emit();
            }
        };
        const loop = () => { if (!this.active || !this.hold) return; run(); this._pumpRaf = requestAnimationFrame(loop); };
        this._pumpRaf = requestAnimationFrame(loop);
        this._holdTimer = setInterval(run, 8);                      // respaldo si la ventana no recibe rAF
    }

    _firstFrame(video) {
        return new Promise((resolve) => {
            const t = setTimeout(resolve, 2500);
            const done = () => { clearTimeout(t); resolve(); };
            if (video.videoWidth) { this._draw(); return done(); }
            if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { this._draw(); done(); });
            else video.addEventListener('loadeddata', () => { this._draw(); done(); }, { once: true });
        });
    }

    _schedule() {
        if (!this.active || !this.video) return;
        if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(this._onFrame);
        else requestAnimationFrame(this._onFrame);
    }

    _onFrame() {
        if (!this.active) return;
        this._schedule();
        const now = performance.now();
        if (now - this._probeAt >= 125) { this._probeAt = now; this._meter(now); }
        this._step();
        this._draw();
        if (!this.hold) this._emit();       // sin retención: un cuadro de salida por cada cuadro real. Con retención lo emite el reloj de 30 Hz
    }

    // Rectángulo del rostro (normalizado, sin espejo): el del SDK si es reciente; si no, la zona central.
    _roi(now) {
        const v = this.vision;
        if (v && v.face && now - v.faceAt < 1500) {
            const f = v.face, m = 0.06;
            return { x0: clamp(f.x0 - m, 0, 1), y0: clamp(f.y0 - m, 0, 1), x1: clamp(f.x1 + m, 0, 1), y1: clamp(f.y1 + m, 0, 1), fromSdk: true };
        }
        return { x0: FACE_ZONE.cx - FACE_ZONE.rx, x1: FACE_ZONE.cx + FACE_ZONE.rx, y0: FACE_ZONE.cy - FACE_ZONE.ry, y1: FACE_ZONE.cy + FACE_ZONE.ry, fromSdk: false };
    }

    // Mide la luz del rostro y del fondo sobre la imagen ORIGINAL de la cámara.
    _meter(now) {
        const v = this.video;
        if (!v || !v.videoWidth) return;
        try {
            this.pctx.drawImage(v, 0, 0, 64, 48);
            const d = this.pctx.getImageData(0, 0, 64, 48).data;
            const r = this._roi(now);
            let rs = 0, rn = 0, bs = 0, bn = 0, all = 0;
            for (let y = 0; y < 48; y++) {
                for (let x = 0; x < 64; x++) {
                    const i = (y * 64 + x) * 4;
                    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                    all += l;
                    const u = (x + 0.5) / 64, w = (y + 0.5) / 48;
                    if (u >= r.x0 && u <= r.x1 && w >= r.y0 && w <= r.y1) { rs += l; rn++; } else { bs += l; bn++; }
                }
            }
            this.rawLuma = all / (64 * 48);
            this.roiLuma = rn ? rs / rn : this.rawLuma;
            this.bgLuma = bn ? bs / bn : this.rawLuma;
            this.roiFromSdk = r.fromSdk;
            this._decide();
        } catch { /* sin acceso al cuadro todavía */ }
    }

    // Decide la ganancia objetivo: 1 si la luz del rostro es buena; si no, la necesaria para llegar al objetivo.
    _decide() {
        if (!this.enabled) { this.gTarget = 1; return; }
        const l = Math.max(8, this.roiLuma);
        if (l >= OK_LOW && l <= OK_HIGH) this.gTarget = 1;
        else this.gTarget = clamp(TARGET / l, G_MIN, G_MAX);
    }

    // Cambios lentos de ganancia (≈ 0.1 por segundo): evita saltos que ensucien la señal del pulso.
    _step() {
        const d = this.gTarget - this.gain;
        if (Math.abs(d) < 0.01) return;
        this.gain += clamp(d, -0.004, 0.006);
    }

    _draw() {
        const v = this.video;
        if (!v || !v.videoWidth) return;
        if (this.cv.width !== v.videoWidth || this.cv.height !== v.videoHeight) {
            this.cv.width = v.videoWidth; this.cv.height = v.videoHeight;
        }
        const g = this.gain;
        this.ctx.filter = Math.abs(g - 1) < 0.015 ? 'none' : `brightness(${g.toFixed(3)}) contrast(${(1 + Math.min(0.2, Math.abs(g - 1) * 0.12)).toFixed(3)})`;
        this.ctx.drawImage(v, 0, 0, this.cv.width, this.cv.height);
        this.ctx.filter = 'none';
    }

    status() {
        const backlit = this.roiLuma != null && this.bgLuma != null && this.bgLuma > 110 && this.roiLuma / this.bgLuma < 0.7;
        return {
            active: this.active, enabled: this.enabled, gain: this.gain,
            rawLuma: this.rawLuma, roiLuma: this.roiLuma, bgLuma: this.bgLuma,
            backlit, compensating: this.active && Math.abs(this.gain - 1) >= 0.05,
            capped: this.gTarget >= G_MAX - 0.01 || this.gTarget <= G_MIN + 0.01,
        };
    }
}

// Devuelve la cámara a su modo automático. Los ajustes manuales (exposición, ISO, brillo, contraste) se quedan
// guardados en el driver de Windows aunque la app se cierre: una cámara que quedó en manual se ve plana y gris
// en TODAS las sesiones siguientes. Se llama al abrir y al cerrar la cámara, y tras la prueba previa.
async function resetCameraAuto(track) {
    if (!track || track.readyState !== 'live' || typeof track.getCapabilities !== 'function') return null;
    let caps; try { caps = track.getCapabilities(); } catch { return null; }
    const applied = [];
    // Un driver que no responde no debe colgar el arranque: cada ajuste tiene un máximo de 1,5 s.
    const one = (c) => new Promise((resolve) => {
        let done = false;
        const fin = (ok) => { if (!done) { done = true; clearTimeout(t); if (ok) applied.push(Object.keys(c)[0]); resolve(ok); } };
        const t = setTimeout(() => fin(false), 1500);
        try { track.applyConstraints({ advanced: [c] }).then(() => fin(true), () => fin(false)); } catch { fin(false); }
    });
    const can = (k, v) => caps[k] != null && (!Array.isArray(caps[k]) || caps[k].includes(v));
    if (can('exposureMode', 'continuous')) await one({ exposureMode: 'continuous' });
    if (can('whiteBalanceMode', 'continuous')) await one({ whiteBalanceMode: 'continuous' });
    if (can('focusMode', 'continuous')) await one({ focusMode: 'continuous' });
    const mid = (r) => { const step = r.step || 1; return Math.round(((r.min + r.max) / 2) / step) * step; };
    if (caps.exposureCompensation && typeof caps.exposureCompensation.min === 'number') {
        const r = caps.exposureCompensation; await one({ exposureCompensation: Math.min(r.max, Math.max(r.min, 0)) });
    }
    // Brillo, contraste y saturación también se quedan guardados en el driver: una saturación baja da imagen gris.
    for (const k of ['brightness', 'contrast', 'saturation']) {
        if (caps[k] && typeof caps[k].min === 'number') await one({ [k]: mid(caps[k]) });
    }
    let settings = null; try { settings = track.getSettings(); } catch { /* sin ajustes */ }
    return { applied, settings };
}

// Controles de la propia cámara (si el driver los expone): exposición/brillo y tiempo de exposición máximo.
class ExposureController {
    constructor() { this.track = null; this.caps = null; this.lastAt = 0; this.steps = 0; this.manual = false; this.applied = []; this.ready = Promise.resolve(null); }

    attach(track) {
        this.track = track || null;
        this.steps = 0; this.manual = false; this.applied = []; this.lastAt = 0;
        this._ec = undefined; this._br = undefined;   // v6: tras el reinicio a automático los valores de la sesión anterior ya no valen
        try { this.caps = track && track.getCapabilities ? track.getCapabilities() : null; } catch { this.caps = null; }
        // Repara una cámara que quedó en manual de una sesión anterior. Devuelve la promesa para poder esperarla.
        this._readyDone = false;
        this.ready = Promise.resolve(resetCameraAuto(track)).catch(() => null);
        this.ready.then(() => { if (this.track === track) this._readyDone = true; });
        return this.ready;
    }

    // Antes de soltar la cámara: vuelve a automático para no dejar el driver con ajustes manuales.
    async restore() { const t = this.track; this.manual = false; if (t) await resetCameraAuto(t); }

    detach() { this.track = null; this.caps = null; }

    has(k) { return !!(this.caps && this.caps[k] != null); }
    get available() { return this.has('exposureCompensation') || this.has('brightness') || this.has('exposureTime'); }

    async _apply(c, key) {
        if (!this.track || !this.has(key)) return false;
        const range = this.caps[key];
        if (Array.isArray(range) && typeof Object.values(c)[0] === 'string' && !range.includes(Object.values(c)[0])) return false;
        try { await this.track.applyConstraints({ advanced: [c] }); this.applied.push(c); return true; }
        catch { return false; }
    }

    // Al abrir la cámara: limita la exposición a ~33 ms (≈30 fps). Es lo que más cuadros devuelve con poca luz;
    // la imagen queda más oscura y el asistente de luz la compensa por software.
    async capForFps(force = false) {
        const t = this.track;
        if (!t || !this.has('exposureTime') || !this.has('exposureMode')) return null;
        const modes = this.caps.exposureMode;
        if (Array.isArray(modes) && !modes.includes('manual')) return null;
        await this.ready;                                              // v6: primero termina el reinicio a automático (si no, podía deshacer el límite)
        await new Promise((r) => setTimeout(r, 1200));                 // deja que la autoexposición se acomode
        if (this.track !== t) return null;
        const et = this.caps.exposureTime, cap = clamp(333, et.min, et.max);   // unidades de 100 µs
        const s = t.getSettings ? t.getSettings() : {};
        if (typeof s.exposureTime === 'number' && s.exposureTime <= cap) return null;   // ya expone lo bastante rápido
        if (typeof s.exposureTime !== 'number' && !force) return null;
        if (await this._apply({ exposureMode: 'manual' }, 'exposureMode') && await this._apply({ exposureTime: cap }, 'exposureTime')) {
            this.manual = true;
            return 'exposure-capped';
        }
        return null;
    }

    // Llamar cada ~1 s con el estado de luz y los fps reales.
    async update({ roiLuma, fps }, now = performance.now()) {
        if (!this.track || !this._readyDone || roiLuma == null || now - this.lastAt < 2000) return null;   // v6: no tocar la cámara mientras se reinicia a automático
        const dark = roiLuma < OK_LOW - 10, bright = roiLuma > OK_HIGH + 25;
        if (!dark && !bright) return null;
        this.lastAt = now;

        // 1) Si la cámara pierde cuadros por poca luz: tope de exposición ≈ 33 ms (garantiza ~30 fps).
        if (dark && fps && fps < 25 && this.has('exposureTime') && !this.manual) {
            const et = this.caps.exposureTime;
            const cap = clamp(333, et.min, et.max);                     // unidades de 100 µs
            if (await this._apply({ exposureMode: 'manual' }, 'exposureMode') && await this._apply({ exposureTime: cap }, 'exposureTime')) {
                this.manual = true;
                if (this.has('iso')) await this._apply({ iso: clamp(this.caps.iso.max * 0.6, this.caps.iso.min, this.caps.iso.max) }, 'iso');
                return 'exposure-capped';
            }
        }
        // 2) Compensación de exposición o brillo, de a un paso.
        const dir = dark ? 1 : -1;
        if (this.has('exposureCompensation')) {
            const c = this.caps.exposureCompensation, step = c.step || 0.5;
            const next = clamp((this._ec ?? 0) + dir * step, c.min, c.max);
            if (next !== (this._ec ?? 0) && await this._apply({ exposureCompensation: next }, 'exposureCompensation')) { this._ec = next; this.steps++; return 'exposure-compensation'; }
        }
        if (this.has('brightness')) {
            const c = this.caps.brightness, span = c.max - c.min, step = Math.max(c.step || 1, span * 0.08);
            const cur = this._br ?? (this.track.getSettings && this.track.getSettings().brightness) ?? (c.min + span / 2);
            const next = clamp(cur + dir * step, c.min, c.max);
            if (next !== cur && await this._apply({ brightness: next }, 'brightness')) { this._br = next; this.steps++; return 'brightness'; }
        }
        return null;
    }
}

module.exports = { LightAssist, ExposureController, resetCameraAuto, TARGET, OK_LOW, OK_HIGH };
