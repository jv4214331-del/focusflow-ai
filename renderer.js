// renderer.js (v2)
// FocusFlow AI: orquesta el SDK de SmartSpectra, el consentimiento, el motor de reglas,
// el asistente AURA (EN + ES), el audio y la recuperación automática del error 14.
// Basado en el quickstart de Presage Technologies (SPDX-License-Identifier: LicenseRef-Proprietary).
//
// Flujo: Cámara -> SmartSpectra SDK -> buffer de telemetría en memoria ->
//        Motor de reglas (cooldowns) -> UI bio-adaptativa.
// Nada se guarda en disco ni se envía a servidores propios.
'use strict';

const {
    SmartSpectraSDK,
    ProcessingStatus,
    ValidationCode,
    breathingMetrics,
    cardioMetrics,
    faceMetrics,
} = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
const { RulesEngine } = require('./rulesEngine');
const { Coherence } = require('./coherence');
const { Aura } = require('./aura');
const { AudioSynth } = require('./audioSynth');
const { Vision } = require('./vision');
const { LightAssist, ExposureController } = require('./lighting');
const { probeAll, FPS_OK } = require('./camera-probe');
const { PerfGovernor } = require('./perf');
const { M, HINTS, POSE_HINTS, bi, lowFpsMsg, darkAssistMsg, FRAMING_HINT } = require('./i18n');

// La clave se inyecta al compilar desde .env (ver build.js). No está en el código fuente.
const API_KEY = process.env.PRESAGE_API_KEY || '';

const EXPRESSION_HAPPY = 5;        // presage.smartspectra.ExpressionType.HAPPY
const ERR_LOW_FPS = 14;            // SmartSpectraErrorCode.kSustainedLowFrameRate
const SMILE_CONFIRM_MS = 1500;     // sonreír 1.5 s confirma la pausa
const AWAY_AFTER_MS = 5000;        // sin rostro 5 s = "te levantaste"
const SAMPLE_CAP = 3600;           // buffer de telemetría acotado (~1 h)

// DOM -------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
    gate: $('consent-gate'), consent1: $('consent-1'), consent2: $('consent-2'),
    optFace: $('opt-face'), btnAccept: $('btn-accept'), auraGate: $('aura-gate'),
    preview: $('preview'), previewCanvas: $('preview-canvas'), previewBox: $('preview-box'), valEn: $('val-en'), valEs: $('val-es'),
    statusBadge: $('status-badge'), errorBanner: $('error-banner'),
    errorCode: $('error-code'), errorMessage: $('error-message'),
    btnStart: $('btn-start'), btnStop: $('btn-stop'), btnWipe: $('btn-wipe'), btnMute: $('btn-mute'),
    aura: $('aura'), guideText: $('guide-text'), guideEn: $('guide-en'), guideEs: $('guide-es'),
    bubble: $('bubble'), bubbleEn: $('bubble-en'), bubbleEs: $('bubble-es'),
    pillGuide: $('pill-guide'), pillFocus: $('pill-focus'), pillEye: $('pill-eye'),
    vPulse: $('v-pulse'), vBr: $('v-br'), vHrv: $('v-hrv'), vBlink: $('v-blink'),
    vStress: $('v-stress'), vFlow: $('v-flow'),
    rulesBody: $('rules-body'), eventLog: $('event-log'),
    optDemo: $('opt-demo'), optAssist: $('opt-assist'), optFree: $('opt-free'), btnLight: $('btn-light'), btnExport: $('btn-export'),
    optPretest: $('opt-pretest'), camDevice: $('cam-device'), btnCamTest: $('btn-cam-test'),
    btnCamTips: $('btn-cam-tips'), camReport: $('cam-report'), camTips: $('cam-tips'),
    voiceEn: $('voice-en'), voiceEs: $('voice-es'), btnVoiceTest: $('btn-voice-test'),
    voiceStatusEn: $('voice-status-en'), voiceStatusEs: $('voice-status-es'), voiceStatus: $('voice-status'),
    voiceEngine: $('voice-engine'), voiceSid: $('voice-sid'), voiceSpeed: $('voice-speed'),
    voiceSpeedVal: $('voice-speed-val'), btnVoiceRecheck: $('btn-voice-recheck'),
};

const STATUS_NAMES = Object.fromEntries(
    Object.entries(ProcessingStatus).map(([k, v]) => [v, k.replace(/^k/, '')]));
const VALIDATION_NAMES = Object.fromEntries(
    Object.entries(ValidationCode).map(([k, v]) => [v, k.replace(/^k/, '')]));

const RULE_LABELS = {
    eyeStrain: { name: { en: 'Visual fatigue', es: 'Fatiga visual' },
                 thr: { en: 'Blinks < 8/min', es: 'Parpadeo < 8/min' } },
    overload:  { name: { en: 'Cognitive overload', es: 'Sobrecarga cognitiva' },
                 thr: { en: 'Breathing > 20 RPM or HRV -20%', es: 'Respiración > 20 RPM o HRV -20%' } },
    flow:      { name: { en: 'Deep flow', es: 'Flujo profundo' },
                 thr: { en: 'Pulse 60-85 · breathing 12-16', es: 'Pulso 60-85 · respiración 12-16' } },
};

// Estado ----------------------------------------------------------------------
const engine = new RulesEngine();
const coherence = new Coherence();
const audio = new AudioSynth();
const aura = new Aura(els.aura);
const gateAura = new Aura(els.auraGate);       // AURA dormida en la pantalla de consentimiento
gateAura.setMode('sleep');
aura.setMode('sleep');
const vision = new Vision(els.previewCanvas, els.preview);
const assist = new LightAssist(vision);
const exposure = new ExposureController();
const perf = new PerfGovernor({ vision, aura, onPreempt: () => preemptiveRecover(), onLevel: (l) => onPerfLevel(l) });

const session = { startedAt: null, events: [], samples: [] };
let sdk = null;
let hostStream = null;
let running = false;
let consented = false;
let faceRequested = true;                      // lo que el usuario eligió
let faceOn = true;                             // lo que está activo (puede bajar a modo ligero)
let tickTimer = null;
let bubbleTimer = null;
let recovering = false;
let recoverAttempts = 0;
let recoverWindowStart = 0;
let guidedManual = false;
let guidedUntil = 0;
let offerUntil = 0;
let smileSince = null;
let noFaceSince = null;
let away = false;
let eyeRestTimer = null;
let camProfile = null;                         // { deviceId, w, h, fps } elegido por la prueba previa
let tickN = 0;
let camLevel = 0;                              // 0 = 640x480 con mínimo 25 fps; sube si el error 14 se repite
let lightLevel = 0;                            // luz de pantalla: 0 apagada, 1 encendida, 2 máxima
let autoLightTried = false;
let sdkHint = null;                            // última pista de validación del SDK
let holdMode = false;                          // v5c: la cámara real entrega <25 fps; el SDK recibe 30 Hz con cuadros repetidos
let assistUsed = false;                        // el SDK está recibiendo la imagen corregida
let assistFailed = false;                      // si el SDK no la acepta, se vuelve a la cámara directa
let runStartedAt = 0;
let sdkAliveAt = 0;                            // último evento del SDK que prueba que está leyendo cuadros

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOf = (a) => (a && a.length ? a[a.length - 1] : null);
const fmt = (v, d = 0) => (v == null ? '—' : v.toFixed(d));

function tsToNumber(ts) {
    if (ts == null) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts === 'bigint') return Number(ts);
    if (typeof ts.toNumber === 'function') return ts.toNumber();
    return Number(ts);
}

// Historial bilingüe ------------------------------------------------------------
function logEvent(m) {
    session.events.push({ t: Date.now(), en: m.en, es: m.es });
    renderLog();
}
function renderLog() {
    els.eventLog.textContent = '';
    if (!session.events.length) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = 'No events yet. / Sin eventos todavía.';
        els.eventLog.appendChild(li);
        return;
    }
    for (const e of session.events.slice(-6).reverse()) {
        const li = document.createElement('li');
        const en = document.createElement('div');
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = new Date(e.t).toLocaleTimeString();
        en.append(t, document.createTextNode(e.en));
        const es = document.createElement('div');
        es.className = 'es';
        es.textContent = e.es;
        li.append(en, es);
        els.eventLog.appendChild(li);
    }
}

// Burbuja de AURA (EN arriba, ES abajo) -------------------------------------------
function hideBubble() {
    if (bubbleTimer) { clearInterval(bubbleTimer); bubbleTimer = null; }
    els.bubble.hidden = true;
}
function showBubble(m, seconds = 8, countdown = false) {
    hideBubble();
    let left = seconds;
    const paint = () => {
        const tail = countdown ? ` (${left}s)` : '';
        els.bubbleEn.textContent = m.en + tail;
        els.bubbleEs.textContent = m.es + tail;
    };
    els.bubble.hidden = false;
    paint();
    bubbleTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) hideBubble(); else paint();
    }, 1000);
}

// AURA habla: burbuja + historial + voz EN y luego ES. En Deep Flow solo lo urgente interrumpe.
function say(m, { urgent = true, seconds = 8, countdown = false } = {}) {
    logEvent(m);
    if (!urgent && engine.isActive('flow')) return;
    showBubble(m, seconds, countdown);
    audio.speak(m);
}

// Modo ambiental: Calma (regla o guía manual) > Flujo > Normal ----------------------
function refreshMode() {
    if (!running) {
        aura.setMode('sleep');
        aura.stopGuide();
        coherence.stop();
        document.body.classList.remove('calm', 'flow');
        els.previewBox.dataset.state = 'none';
        audio.off();
        return;
    }
    const calm = engine.isActive('overload') || guidedManual;
    const flow = !calm && engine.isActive('flow');
    const eye = engine.isActive('eyeStrain');

    aura.setMode(calm ? 'calm' : flow ? 'flow' : 'normal');
    document.body.classList.toggle('calm', calm);
    document.body.classList.toggle('flow', flow);
    els.previewBox.dataset.state = calm ? 'calm' : eye ? 'fatigue' : flow ? 'flow' : 'none';

    if (calm) {
        audio.calm();
        if (!aura.isGuiding()) { aura.startGuide(); coherence.start(Date.now()); }
    } else {
        if (aura.isGuiding()) { aura.stopGuide(); coherence.stop(); }
        if (flow) audio.flow(); else audio.off();
    }
}

// Pausa de respiración guiada (manual o por sonrisa) ------------------------------------
function startGuidedBreathing(seconds = 60) {
    guidedManual = true;
    guidedUntil = Date.now() + seconds * 1000;
    offerUntil = 0;
    say(M.guideStart, { seconds: 6 });
    refreshMode();
}
function offerBreathReset() {
    if (!faceOn || !running) return;
    offerUntil = Date.now() + 20000;
    smileSince = null;
    say(M.offerReset, { urgent: false, seconds: 20, countdown: true });
}

// Descanso visual de 20 s ----------------------------------------------------------------
function beginEyeRest(m) {
    aura.setSleepy(true);
    say(m, { urgent: false, seconds: engine.T.eyeNotice, countdown: true });
}
function finishEyeRest() {
    aura.setSleepy(false);
    hideBubble();
    say(M.eyeRestDone, { urgent: false, seconds: 6 });
    offerBreathReset();
}
function manualEyeRest() {
    if (eyeRestTimer) clearTimeout(eyeRestTimer);
    beginEyeRest(M.eyeRest);
    eyeRestTimer = setTimeout(() => { eyeRestTimer = null; finishEyeRest(); }, 20000);
}

// Revisar enfoque ------------------------------------------------------------------------
function checkFocus() {
    const now = Date.now();
    const p = engine.avg('pulse', now, 10);
    const br = engine.avg('br', now, 10);
    const stress = engine.stress(now);
    const blink = engine.blinkRate(now);
    let m;
    if (p == null && br == null) {
        m = { en: 'Not enough data yet — give me a few seconds.', es: 'Aún no hay datos — dame unos segundos.' };
    } else {
        let tip = { en: 'Looking good.', es: 'Vas bien.' };
        if (engine.isActive('flow')) tip = { en: 'You are in flow — keep going!', es: '¡Estás en flujo — sigue así!' };
        else if (stress != null && stress >= 60) tip = { en: 'Take a short breathing break.', es: 'Haz una pausa de respiración.' };
        else if (blink != null && blink < 8) tip = { en: 'Blink more often.', es: 'Parpadea más seguido.' };
        const bits = [p != null ? `${p.toFixed(0)} BPM` : null, br != null ? `${br.toFixed(0)} RPM` : null,
            stress != null ? `${stress}%` : null].filter(Boolean).join(' · ');
        m = { en: `Focus check: ${bits}. ${tip.en}`, es: `Revisión de enfoque: ${bits}. ${tip.es}` };
    }
    say(m, { seconds: 10 });
}

// Reglas -> efectos ------------------------------------------------------------------------
function handleRuleEvent(ev) {
    const up = ev.type === 'triggered';
    if (ev.id === 'eyeStrain') {
        if (up) beginEyeRest(M.eyeStrain); else finishEyeRest();
    } else if (ev.id === 'overload') {
        if (up) say(M.calmOn);
        else { aura.celebrate(); say(M.calmOff); }
    } else if (ev.id === 'flow') {
        if (up) say(M.flowOn, { seconds: 6 }); else logEvent(M.flowOff);
    }
    refreshMode();
}

// Presencia: sin rostro 5 s = ausente; al volver, bienvenida --------------------------------------
function presenceTick(now) {
    if (noFaceSince != null && !away && now - noFaceSince >= AWAY_AFTER_MS) {
        away = true;
        aura.setAway(true);
        say(M.away, { urgent: false, seconds: 6 });
    }
}
function faceSeen() {
    noFaceSince = null;
    if (away) {
        away = false;
        aura.setAway(false);
        aura.celebrate(2000);
        say(M.back, { urgent: false, seconds: 6 });
    }
}

// Tick de 1 s: reglas, coherencia y UI ---------------------------------------------------------------
function tick() {
    const now = Date.now();
    engine.tick(now).forEach(handleRuleEvent);
    presenceTick(now);

    if (guidedManual && now >= guidedUntil && !engine.isActive('overload')) {
        guidedManual = false;
        say(M.guideEnd, { urgent: false, seconds: 5 });
        refreshMode();
    }
    if (aura.isGuiding()) {
        const c = coherence.update(now);
        aura.setCoherence(c.progress);
        if (c.achieved) { aura.celebrate(3000); say(M.coherence, { seconds: 10 }); }
    }

    const la = assist.status();
    vision.setAssist(la);
    exposure.update({ roiLuma: la.roiLuma ?? vision.luma, fps: holdMode ? null : vision.fps });
    if (assistUsed && !sdkAliveAt && now - runStartedAt > 10000 && !recovering) setTimeout(assistFallback, 0);
    perf.update(holdMode ? 30 : vision.fps, performance.now());     // con retención el límite lo pone la cámara, no la carga de la app
    vision.setPerfLevel(perf.level);
    tickN += 1;
    if (!perf.slowUi || tickN % 3 === 0) { renderRules(now); renderCards(now); }       // en modo rendimiento la interfaz se refresca más despacio
    paintHint();
    session.samples.push({
        t: now, pulse: engine.avg('pulse', now, 8), br: engine.avg('br', now, 8),
        hrv: engine.avg('hrv', now, 15), blink: engine.blinkRate(now), stress: engine.stress(now), lightGain: Number(la.gain.toFixed(2)),
    });
    if (session.samples.length > SAMPLE_CAP) session.samples.shift();
}
function startTick() { if (!tickTimer) tickTimer = setInterval(tick, 1000); }
function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

function renderCards(now) {
    els.vPulse.textContent = fmt(engine.avg('pulse', now, 8));
    els.vBr.textContent = fmt(engine.avg('br', now, 8));
    els.vHrv.textContent = fmt(engine.avg('hrv', now, 15));
    els.vBlink.textContent = faceOn ? fmt(engine.blinkRate(now)) : 'off';
    els.vBlink.classList.toggle('off', !faceOn);
    els.vStress.textContent = fmt(engine.stress(now));
    els.vFlow.textContent = engine.flowMinutes.toFixed(1);
}

function biCell(m) {
    const td = document.createElement('td');
    const en = document.createElement('div');
    en.textContent = m.en;
    const es = document.createElement('div');
    es.className = 'es';
    es.textContent = m.es;
    td.append(en, es);
    return td;
}

function renderRules(now) {
    els.rulesBody.textContent = '';
    for (const r of engine.snapshot(now)) {
        const lab = RULE_LABELS[r.id] || { name: { en: r.name, es: '' }, thr: { en: r.threshold, es: '' } };
        const tr = document.createElement('tr');
        tr.append(biCell(lab.name), biCell(lab.thr));
        const read = document.createElement('td');
        read.className = 'num';
        read.textContent = r.detail || '—';
        tr.appendChild(read);
        const td = document.createElement('td');
        const pill = document.createElement('span');
        pill.className = 'pill ' + r.state.toLowerCase();
        pill.textContent = r.label;
        td.appendChild(pill);
        tr.appendChild(td);
        els.rulesBody.appendChild(tr);
    }
}

// Texto de la respiración guiada (EN + ES) sigue la fase del orbe ------------------------------------
setInterval(() => {
    const g = aura.guide();
    els.guideText.hidden = !g;
    if (g) { els.guideEn.textContent = g.en; els.guideEs.textContent = g.es; }
}, 250);

// Métricas del SDK -----------------------------------------------------------------------------------
function handleMetrics(m) {
    const now = Date.now();

    const p = lastOf(m.cardio?.pulseRate);
    if (p && p.value > 0) {
        engine.push('pulse', p.value, now, p.stable);
        aura.setSignals({ bpm: p.value });
    }
    const b = lastOf(m.breathing?.rate);
    if (b && b.value > 0) {
        engine.push('br', b.value, now, b.stable);
        aura.setSignals({ br: b.value });
    }
    const h = lastOf(m.cardio?.hrv);
    if (h && h.rmssd > 0) engine.push('hrv', h.rmssd, now, h.stable);

    // Trazo respiratorio -> coherencia con la guía.
    const tr = m.breathing?.upperTrace;
    if (tr && tr.length && coherence.active) {
        const lastTs = tsToNumber(tr[tr.length - 1].timestamp);
        for (const e of tr) coherence.push(e.value, now - (lastTs - tsToNumber(e.timestamp)) / 1000);
    }

    // Recuadro del rostro (visión): sale de los landmarks del SDK, sin modelos ni carga extra.
    const lm = lastOf(m.face?.landmarks);
    if (lm && lm.value && lm.value.length) vision.setFaceFromLandmarks(lm.value);

    // Parpadeo: cada flanco "no parpadea -> parpadea" es un parpadeo; AURA parpadea al instante.
    const bl = m.face?.blinking;
    if (bl && bl.length) {
        const lastTs = tsToNumber(bl[bl.length - 1].timestamp);
        for (const e of bl) {
            const t = now - (lastTs - tsToNumber(e.timestamp)) / 1000;
            if (engine.pushBlink(!!e.detected, t)) aura.blink();
        }
    }

    // Sonrisa: expresión dominante HAPPY. Si AURA ofreció una pausa, sonreír 1.5 s la confirma.
    const ex = lastOf(m.face?.expression);
    if (ex && ex.scores && ex.scores.length) {
        const top = ex.scores.reduce((a, c) => (c.confidence > a.confidence ? c : a));
        const happy = top.type === EXPRESSION_HAPPY && top.confidence >= 60;
        if (happy) {
            aura.smile();
            if (smileSince == null) smileSince = now;
            if (offerUntil > now && now - smileSince >= SMILE_CONFIRM_MS) startGuidedBreathing(60);
        } else {
            smileSince = null;
        }
    }
}

// Cámara ----------------------------------------------------------------------------------------------------
// getUserMedia con tiempo límite: si la cámara está ocupada o bloqueada, la app lo dice en vez de quedarse esperando.
function gum(video, ms) {
    return new Promise((resolve, reject) => {
        let done = false;
        const to = setTimeout(() => {
            done = true;
            const e = new Error('timeout');
            e.name = 'TimeoutError';
            reject(e);
        }, ms);
        navigator.mediaDevices.getUserMedia({ video, audio: false }).then((s) => {
            if (done) { s.getTracks().forEach((t) => t.stop()); return; }   // llegó tarde: se libera
            clearTimeout(to); done = true; resolve(s);
        }).catch((e) => {
            if (done) return;
            clearTimeout(to); done = true; reject(e);
        });
    });
}

// Escalera de modos de cámara: el nivel 0 es el que eligió la prueba previa (o 640x480); cada reinicio por
// error 14 baja la exigencia (menos píxeles = menos carga). Se conserva la cámara elegida.
function camLevels() {
    const dev = (els.camDevice.value || (camProfile && camProfile.deviceId))
        ? { deviceId: { exact: els.camDevice.value || camProfile.deviceId } }
        : { facingMode: 'user' };
    const mk = (w, h, strict) => ({ ...dev, width: { ideal: w }, height: { ideal: h }, frameRate: strict ? { min: 25, ideal: 30 } : { ideal: 30 } });
    const p = camProfile ? [camProfile.w, camProfile.h] : [640, 480];
    return [
        [mk(p[0], p[1], true), mk(p[0], p[1], false)],
        [mk(640, 480, false)],
        [mk(480, 360, false)],
        [mk(320, 240, false)],
    ];
}

async function acquireStream(level = 0) {
    const levels = camLevels();
    const attempts = levels[Math.min(level, levels.length - 1)];
    let error = null;
    for (const video of attempts) {
        try { return { stream: await gum(video, 7000), error: null }; }
        catch (e) {
            error = e;
            console.warn('[focusflow] getUserMedia falló con', JSON.stringify(video), e && e.name);
            if (e && (e.name === 'NotAllowedError' || e.name === 'NotReadableError' || e.name === 'NotFoundError' || e.name === 'TimeoutError')) break;
        }
    }
    return { stream: null, error };
}

function cameraMessage(err) {
    switch (err && err.name) {
        case 'NotAllowedError': case 'SecurityError': return M.camBlocked;
        case 'NotReadableError': case 'AbortError': return M.camBusy;
        case 'NotFoundError': return M.camNone;
        case 'TimeoutError': return M.camTimeout;
        default: return M.camGeneric;
    }
}

function paintCameraReport(rep) {
    const box = els.camReport;
    box.textContent = '';
    box.hidden = false;
    const head = (t) => { const d = document.createElement('div'); d.className = 'head'; d.textContent = t; box.appendChild(d); };
    const row = (l, r, cls = '') => {
        const d = document.createElement('div'); d.className = 'row ' + cls;
        const a = document.createElement('span'); a.textContent = l;
        const b = document.createElement('span'); b.textContent = r;
        d.append(a, b); box.appendChild(d);
    };
    head('Cameras · Cámaras');
    for (const c of rep.cameras) row(c.label, c.error ? `error ${c.error}` : `${c.fps.toFixed(1)} fps`, c.fps >= FPS_OK ? '' : 'bad');
    head('Modes · Modos');
    for (const m of rep.modes) row(m.id.replace('x', '×'), m.error ? `error ${m.error}` : `${m.fps.toFixed(1)} fps`, m.fps >= FPS_OK ? '' : 'bad');
    if (rep.best && rep.best.method) row('Frame count · Conteo de cuadros', rep.best.method === 'track' ? 'camera track · pista de la cámara' : 'video element · elemento de video', '');
    if (rep.best && rep.best.lumaStd != null) row('Image contrast · Contraste de imagen', rep.best.lumaStd.toFixed(0), rep.best.lumaStd >= 25 ? '' : 'bad');
    if (rep.uiFps) row('Interface · Interfaz', `${rep.uiFps.toFixed(0)} fps`, rep.uiFps >= 40 ? '' : 'bad');
    row('Camera controls · Controles', (rep.controls && rep.controls.length) ? rep.controls.join(', ') : 'none · ninguno', '');
    if (rep.afterCap) row('With exposure limit · Con límite de exposición', rep.afterCap.applied ? `${rep.afterCap.fps.toFixed(1)} fps` : 'not accepted · no aceptado', rep.afterCap.applied && rep.afterCap.fps >= FPS_OK ? 'best' : 'bad');
    if (rep.afterLight) row('With screen light · Con luz de pantalla', rep.afterLight.error ? `error ${rep.afterLight.error}` : `${rep.afterLight.fps.toFixed(1)} fps`, rep.afterLight.fps >= FPS_OK ? 'best' : 'bad');
    if (rep.best) row(`Chosen · Elegido: ${rep.best.w}×${rep.best.h}`, `${rep.best.fps.toFixed(1)} fps`, rep.ok ? 'best' : 'bad');
}

function fillCameraSelect(rep) {
    const keep = els.camDevice.value;
    els.camDevice.textContent = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Auto (best) · Automática (la mejor)';
    els.camDevice.appendChild(auto);
    for (const c of rep.cameras) {
        if (!c.deviceId) continue;
        const o = document.createElement('option');
        o.value = c.deviceId;
        o.textContent = `${c.label} — ${c.error ? 'error' : c.fps.toFixed(0) + ' fps'}`;
        els.camDevice.appendChild(o);
    }
    els.camDevice.value = [...els.camDevice.options].some((o) => o.value === keep) ? keep : '';
}

// Luz de pantalla: el monitor se vuelve un aro de luz cálida alrededor de la app (la cámara pierde cuadros con poca luz).
function setScreenLight(level, announce = true) {
    lightLevel = level;
    document.body.classList.toggle('screenlight', level > 0);
    document.body.classList.toggle('maxlight', level === 2);
    document.body.classList.toggle('fulllight', level === 3);
    els.btnLight.setAttribute('aria-pressed', String(level > 0));
    els.btnLight.textContent = level === 3 ? 'Screen light: FULL ' : level === 2 ? 'Screen light: MAX ' : level === 1 ? 'Screen light: ON ' : 'Screen light ';
    const es = document.createElement('span');
    es.className = 'es';
    es.textContent = level === 3 ? 'Luz de pantalla: TOTAL' : level === 2 ? 'Luz de pantalla: MÁX' : level === 1 ? 'Luz de pantalla: SÍ' : 'Luz de pantalla';
    els.btnLight.appendChild(es);
    if (announce) say(level === 0 ? M.lightOff : level === 1 ? M.lightOn1 : level === 2 ? M.lightOn2 : M.lightOn3, { urgent: false, seconds: 9 });
}
els.btnLight.addEventListener('click', () => setScreenLight((lightLevel + 1) % 4));

// Posición libre: sin óvalo, pecho ni flechas; las pistas de postura del SDK no se muestran como error.
try { els.optFree.checked = localStorage.getItem('ff.free') !== '0'; } catch { /* sin almacenamiento */ }
vision.setFree(els.optFree.checked);
els.optFree.addEventListener('change', () => {
    vision.setFree(els.optFree.checked);
    try { localStorage.setItem('ff.free', els.optFree.checked ? '1' : '0'); } catch { /* sin almacenamiento */ }
    if (running) paintHint();
});

async function runCameraTest(manual = false) {
    if (running) return null;
    els.btnCamTest.disabled = true;
    setHintText(M.camTesting, 'hint hint-warn');
    let rep = null;
    try {
        rep = await probeAll({
            preferred: els.camDevice.value || null,
            light: { on: async () => setScreenLight(3, false), off: () => setScreenLight(0, false) },
            onProgress: (d, t, label) => setHintText({
                en: `${M.camTesting.en} (${Math.min(d + 1, t)}/${t}) ${label}`,
                es: `${M.camTesting.es} (${Math.min(d + 1, t)}/${t}) ${label}`,
            }, 'hint hint-warn'),
        });
    } catch (e) { console.warn('[focusflow] prueba de cámara falló:', e); }
    els.btnCamTest.disabled = false;
    if (!rep || !rep.best) { setHintText(M.camNoneTest, 'hint hint-err'); if (rep) paintCameraReport(rep); return null; }
    camProfile = rep.best;
    paintCameraReport(rep);
    if (!els.camDevice.value) fillCameraSelect(rep);
    let m = rep.ok ? M.camTestDone : M.camTestWeak;
    if (rep.ok && rep.lightHelped) m = M.camLightHelped;
    else if (!rep.ok && rep.uiFps && rep.uiFps < 40) m = M.camUiBusy;
    else if (!rep.ok && rep.afterLight && !rep.lightHelped) m = M.camHard;
    setHintText(m, rep.ok ? 'hint hint-ok' : 'hint hint-warn');
    if (rep.uniformLow) logEvent({
        en: 'All resolutions give the same low frame rate: it is not the resolution. Usually low light or the camera driver lowering fps (look for "low-light compensation" or "dynamic frame rate" in the camera app).',
        es: 'Todas las resoluciones dan los mismos pocos cuadros: no es la resolución. Suele ser poca luz o el driver de la cámara bajando los fps (busca "compensación de poca luz" o "frecuencia de cuadros dinámica" en la app de la cámara).',
    });
    if (rep.best && rep.best.lumaStd != null && rep.best.lumaStd < 25) logEvent({
        en: 'The image looks flat and gray (very low contrast). Check the lens, the room light and any manual camera settings.',
        es: 'La imagen se ve plana y gris (contraste muy bajo). Revisa el lente, la luz del cuarto y cualquier ajuste manual de la cámara.',
    });
    if (manual || !rep.ok) logEvent({ en: `Camera test: ${rep.best.w}×${rep.best.h} at ${rep.best.fps.toFixed(1)} fps. ${m.en}`, es: `Prueba de cámara: ${rep.best.w}×${rep.best.h} a ${rep.best.fps.toFixed(1)} fps. ${m.es}` });
    return rep;
}

function setHintText(m, cls = 'hint') {
    els.valEn.textContent = m.en;
    els.valEs.textContent = m.es;
    els.valEn.parentElement.className = cls;
}

// SDK --------------------------------------------------------------------------------------------------------------
function setButtons(start, stop) {
    els.btnStart.disabled = !(start && consented);
    els.btnStop.disabled = !stop;
    const on = running;
    els.pillGuide.disabled = !on;
    els.pillFocus.disabled = !on;
    els.pillEye.disabled = !on;
}

function showError(code, message) {
    els.errorBanner.hidden = false;
    els.errorCode.textContent = code;
    els.errorMessage.textContent = message;
}

function setHint(code, hint) {
    const name = VALIDATION_NAMES[code] || `Code(${code})`;
    const h = HINTS[name] || { en: `${name}${hint ? ' — ' + hint : ''}`, es: '' };
    els.valEn.textContent = h.en;
    els.valEs.textContent = h.es;
    els.valEn.parentElement.className = 'hint ' + (
        code === ValidationCode.kOk ? 'hint-ok' :
        code === ValidationCode.kCameraTuning ? 'hint-warn' : 'hint-err');
    return name;
}

// Pista visible bajo la cámara: primero lo que mide la imagen (luz, fps, imagen plana), luego el SDK, luego el encuadre.
function paintHint() {
    if (!running) return;
    const st = vision.status();
    const a = assist.status();
    if ((st.dark || st.lowFps) && lightLevel === 0 && !autoLightTried) { autoLightTried = true; setScreenLight(1); }   // poca luz: que el monitor ilumine tu rostro
    if (st.blank) return setHintText(M.camBlank, 'hint hint-err');
    if (a.backlit) return setHintText(M.backlit, 'hint hint-warn');
    if (st.dark) return a.compensating ? setHintText(darkAssistMsg(a.gain), 'hint hint-warn') : setHintText(M.tooDark, 'hint hint-err');
    if (vision.luma != null && vision.luma > 215) return setHintText(M.tooBright, 'hint hint-warn');
    if (st.lowFps && holdMode) return setHintText({
        en: `Camera runs at ${st.fps.toFixed(0)} fps — compatibility mode on (readings may be less precise).`,
        es: `La cámara va a ${st.fps.toFixed(0)} fps — modo compatibilidad activo (las lecturas pueden ser menos precisas).`,
    }, 'hint hint-warn');
    if (st.lowFps) return setHintText(lowFpsMsg(st.fps), 'hint hint-warn');
    if (sdkHint && sdkHint.name !== 'Ok' && sdkHint.name !== 'CameraTuning') {
        if (vision.free && POSE_HINTS.has(sdkHint.name)) return setHintText(HINTS.FreePose, 'hint hint-ok');   // la postura nunca bloquea ni regaña
        setHint(sdkHint.code, sdkHint.hint);
        return;
    }
    const fr = vision.framing();
    if (fr && fr.key !== 'ok') return setHintText(HINTS[FRAMING_HINT[fr.key]], 'hint hint-warn');
    if (sdkHint) setHint(sdkHint.code, sdkHint.hint);
    else if (fr && fr.key === 'ok') setHintText(HINTS.Ok, 'hint hint-ok');
}

function buildSdk() {
    const requested = [...breathingMetrics, ...cardioMetrics, ...(faceOn ? faceMetrics : [])];
    console.log('[focusflow] requestedMetrics =', requested, 'face =', faceOn);

    sdk = new SmartSpectraSDK({
        apiKey: API_KEY,
        requestedMetrics: requested,
        enableAccumulatedOutput: false,
    });

    sdk.on('processingStatus', (status) => {
        const label = STATUS_NAMES[status] || `Status(${status})`;
        els.statusBadge.textContent = label;
        els.statusBadge.className = `status status-${label.toLowerCase()}`;
        if (recovering) return;
        if (status === ProcessingStatus.kStarting || status === ProcessingStatus.kRunning) {
            setButtons(false, true);
        } else if (status === ProcessingStatus.kStopping) {
            setButtons(false, false);
        } else if (status === ProcessingStatus.kError) {
            running = false;
            stopTick();
            refreshMode();
            setButtons(false, true);       // "Detener cámara" libera el SDK para reintentar
        } else if (status === ProcessingStatus.kIdle || status === ProcessingStatus.kUninitialized) {
            setButtons(true, false);
        }
    });

    sdk.on('validationStatus', (code, timestampUs, hint) => {
        sdkAliveAt = Date.now();
        const name = VALIDATION_NAMES[code] || `Code(${code})`;
        sdkHint = { code, hint, name };
        vision.setGuide(name === 'Ok' || name === 'CameraTuning' ? null : name);
        if (running) paintHint(); else setHint(code, hint);
        if (name === 'NoFaceFound') { if (noFaceSince == null) noFaceSince = Date.now(); }
        else faceSeen();
    });

    sdk.on('metrics', (buf, timestampUs) => {
        sdkAliveAt = Date.now();
        try {
            handleMetrics(decodeMetrics(buf));
        } catch (e) {
            console.error(`[focusflow] no se pudo decodificar Metrics (${buf.byteLength}B ts=${timestampUs}):`, e);
        }
    });

    sdk.on('error', (code, message, retryable) => {
        console.error(`[focusflow] error code=${code} retryable=${retryable}: ${message}`);
        if (Number(code) === ERR_LOW_FPS) {
            showError(code, `${message} — recovering automatically / recuperando automáticamente`);
            setTimeout(recoverFromLowFps, 0);          // fuera del callback del SDK
            return;
        }
        showError(code, retryable ? `${message} (retryable)` : message);
    });

    sdk.on('streamAvailable', (stream) => {
        els.preview.srcObject = stream;
        els.preview.play().catch(() => {});
    });
}

async function teardownSdk() {
    try { if (sdk) await sdk.stop(); } catch (err) { console.error('stop() falló:', err); }
    try { await exposure.restore(); } catch { /* sin controles de cámara */ }   // deja la cámara en automático antes de soltarla
    if (hostStream) { hostStream.getTracks().forEach((t) => t.stop()); hostStream = null; }
    els.preview.srcObject = null;
    if (sdk) { try { sdk.destroy(); } catch { /* ya destruido */ } sdk = null; }
    running = false;
    perf.reset();
    vision.setPerfLevel(0);
    assist.stop();
    vision.setSource(null);
    exposure.detach();
    vision.stop();
    stopTick();
}

async function startMeasurement({ keepData = false } = {}) {
    if (!API_KEY) { showError('KEY', bi(M.noKey)); return; }
    if (!recovering) els.errorBanner.hidden = true;
    els.btnStart.disabled = true;
    if (!keepData) {
        engine.reset();
        coherence.reset();
        aura.clearSignals();
        away = false; noFaceSince = null; smileSince = null; offerUntil = 0; sdkHint = null;
        aura.setAway(false);
        if (!faceOn) faceOn = faceRequested;           // sesión nueva: vuelve a lo que eligió el usuario
        recoverAttempts = 0;
        autoLightTried = false;
        camLevel = 0;
        assistFailed = false;
        perf.reset();
    }
    engine.setDemo(els.optDemo.checked);
    engine.begin(Date.now(), faceOn);
    engine.setFaceEnabled(faceOn);
    aura.setAutoBlink(!faceOn);
    if (!session.startedAt) session.startedAt = Date.now();
    try {
        if (!keepData && els.optPretest.checked && !camProfile) {
            await runCameraTest(false);
            els.btnStart.disabled = true;
        }
        setHintText(M.camStarting, 'hint hint-warn');
        buildSdk();
        const { stream, error: camError } = await acquireStream(camLevel);
        if (!stream && camError) {
            const m = cameraMessage(camError);
            setHintText(m, 'hint hint-err');
            logEvent(m);
            console.warn('[focusflow] cámara propia no disponible:', camError && camError.name, camError && camError.message);
        }
        assistUsed = false;
        if (stream) {
            hostStream = stream;
            els.preview.srcObject = stream;
            els.preview.play().catch(() => {});
            const track = stream.getVideoTracks()[0];
            console.log('[focusflow] cámara:', JSON.stringify(track.getSettings()));
            // v6: se ESPERA (máx. 3 s) a que la cámara vuelva a automático antes de entregarla al SDK; así arranca sin ajustes manuales viejos.
            await Promise.race([exposure.attach(track), sleep(3000)]);
            try { console.log('[focusflow] cámara tras volver a automático:', JSON.stringify(track.getSettings())); } catch { /* sin ajustes */ }
            // Con poca luz la cámara alarga la exposición y baja los cuadros: se limita a ~33 ms desde el inicio.
            exposure.capForFps(false)   // v5c: nunca se fuerza; solo actúa si la cámara ya expone más de ~33 ms
                .then((r) => { if (r) console.log('[focusflow] exposición limitada a ~33 ms para sostener los cuadros'); })
                .catch(() => {});
            let feed = stream;
            assist.enabled = els.optAssist.checked;
            if (assist.enabled && !assistFailed) {
                try {
                    holdMode = !!(camProfile && camProfile.fps && camProfile.fps < 25) || recoverAttempts > 0;
                    assist.hold = holdMode;
                    feed = await assist.start(els.preview); vision.setSource(assist.canvas); assistUsed = true;
                }
                catch (e) { console.warn('[focusflow] asistente de luz no disponible:', e && e.message); feed = stream; }
            }
            sdk.useMediaStream(feed);
        }
        runStartedAt = Date.now();
        sdkAliveAt = 0;
        await Promise.race([
            sdk.start(),
            new Promise((_, reject) => setTimeout(() => {
                const e = new Error(bi(M.camTimeout));
                e.code = 'TIMEOUT';
                reject(e);
            }, 25000)),
        ]);
        running = true;
        vision.start();
        startTick();
        refreshMode();
        setButtons(false, true);
        if (!keepData) say(M.started, { urgent: false, seconds: 4 });
    } catch (err) {
        showError(err.code ?? 'JS', err.message);
        await teardownSdk();
        setButtons(true, false);
    }
}

async function stopMeasurement() {
    els.btnStop.disabled = true;
    await teardownSdk();
    guidedManual = false;
    offerUntil = 0;
    hideBubble();
    aura.setSleepy(false);
    refreshMode();
    setButtons(true, false);
    if (consented) logEvent(M.stopped);
}

// Modo rendimiento automático (ver perf.js).
function onPerfLevel(l) {
    vision.setPerfLevel(l);
    if (l === 1) say(M.perfL1, { urgent: false, seconds: 6 });
    else if (l === 2) say(M.perfL2, { urgent: false, seconds: 6 });
    else if (l === 0) say(M.perfBack, { urgent: false, seconds: 5 });
}
function preemptiveRecover() {
    if (!running || recovering) return;
    setTimeout(() => recoverFromLowFps({ preemptive: true }), 0);
}

// Salvaguarda: si en 10 s el SDK no da señales de leer la imagen corregida, se vuelve a la cámara directa.
async function assistFallback() {
    if (recovering || !assistUsed || !consented) return;
    recovering = true;
    assistFailed = true;
    say(M.assistOff, { urgent: false, seconds: 8 });
    await teardownSdk();
    await sleep(500);
    recovering = false;
    await startMeasurement({ keepData: true });
}

// Error 14 (pocos cuadros por segundo): reinicia sola conservando los datos; si se repite, pasa a modo ligero.
async function recoverFromLowFps(opts = {}) {
    if (recovering || !consented) return;
    recovering = true;
    const now = Date.now();
    if (now - recoverWindowStart > 5 * 60 * 1000) { recoverWindowStart = now; recoverAttempts = 0; }
    recoverAttempts += 1;
    if (lightLevel < 3) setScreenLight(Math.min(3, lightLevel + 1), false);          // más luz en el rostro en cada reintento
    try {
        await teardownSdk();
        if (recoverAttempts > 3) {
            say(M.giveUp, { seconds: 12 });
            recovering = false;
            setButtons(true, false);
            refreshMode();
            return;
        }
        camLevel = Math.min(3, recoverAttempts);        // baja la exigencia de la cámara
        say(opts.preemptive ? M.perfL3 : M.lowFps, { urgent: false, seconds: 6 });
        if (faceOn && recoverAttempts >= 2) {
            faceOn = false;
            say(M.lite, { urgent: false, seconds: 8 });
        }
        await sleep(800);
        recovering = false;
        await startMeasurement({ keepData: true });
    } catch (e) {
        console.error('[focusflow] recuperación falló:', e);
        recovering = false;
        setButtons(true, false);
    }
}

// Detener cámara y borrar TODO lo que hay en memoria de la sesión.
async function wipeSession() {
    recovering = false;
    if (eyeRestTimer) { clearTimeout(eyeRestTimer); eyeRestTimer = null; }
    await stopMeasurement();
    engine.reset();
    coherence.reset();
    session.startedAt = null;
    session.events = [];
    session.samples = [];
    aura.clearSignals();
    aura.setAway(false);
    away = false; noFaceSince = null; smileSince = null;
    hideBubble();
    renderLog();
    renderRules(Date.now());
    for (const el of [els.vPulse, els.vBr, els.vHrv, els.vBlink, els.vStress]) el.textContent = '—';
    els.vFlow.textContent = '0.0';
    els.valEn.textContent = M.wiped.en;
    els.valEs.textContent = M.wiped.es;
    els.valEn.parentElement.className = 'hint';
    els.errorBanner.hidden = true;
    audio.dispose();
    consented = false;
    els.consent1.checked = false;
    els.consent2.checked = false;
    els.btnAccept.disabled = true;
    els.btnStart.disabled = true;
    els.btnWipe.disabled = true;
    els.gate.classList.remove('hidden');
    setGateOpen(true);
}

// Exportación efímera desde la memoria.
function exportSession() {
    const now = Date.now();
    const report = {
        exportedAt: new Date(now).toISOString(),
        startedAt: session.startedAt ? new Date(session.startedAt).toISOString() : null,
        durationSec: session.startedAt ? Math.round((now - session.startedAt) / 1000) : 0,
        flowMinutes: Number(engine.flowMinutes.toFixed(2)),
        events: session.events.map((e) => ({ time: new Date(e.t).toISOString(), en: e.en, es: e.es })),
        samples: session.samples.map((s) => ({ ...s, t: new Date(s.t).toISOString() })),
        note: 'Generated in local memory. Stress is a heuristic index, not a medical measurement. / Generado en memoria local. El estrés es un índice heurístico, no una medida médica.',
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `focusflow-session-${now}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Voces: lista las instaladas, recuerda la elegida (solo el nombre de la voz) y permite probarla.
function fillVoices() {
    for (const [sel, lang, key] of [[els.voiceEn, 'en-US', 'ff.voice.en'], [els.voiceEs, 'es-MX', 'ff.voice.es']]) {
        const list = audio.voices(lang);
        let saved = null;
        try { saved = localStorage.getItem(key); } catch { /* sin almacenamiento */ }
        sel.textContent = '';
        for (const v of list) {
            const o = document.createElement('option');
            o.value = v.name;
            o.textContent = `${v.name}${v.localService ? '' : ' (online)'}`;
            sel.appendChild(o);
        }
        if (!list.length) { const o = document.createElement('option'); o.textContent = '—'; sel.appendChild(o); }
        const pick = (saved && list.find((v) => v.name === saved)) ? saved : (list[0] && list[0].name);
        if (pick) { sel.value = pick; audio.setPreferred(lang, pick); }
        sel.onchange = () => {
            audio.setPreferred(lang, sel.value);
            try { localStorage.setItem(key, sel.value); } catch { /* sin almacenamiento */ }
        };
    }
}
if ('speechSynthesis' in window) {
    window.speechSynthesis.addEventListener('voiceschanged', fillVoices);
    fillVoices();
}
els.btnVoiceTest.addEventListener('click', () => {
    audio.speak({ en: 'Hi, I am AURA. Let\'s breathe together.', es: 'Hola, soy AURA. Respiremos juntos.' }, true);
});

// Voz natural (neuronal, local): estado, motor, hablante y velocidad. Se recuerdan solo las preferencias.
function pref(key, fallback) { try { const v = localStorage.getItem('ff.voice.' + key); return v == null ? fallback : v; } catch { return fallback; } }
function savePref(key, value) { try { localStorage.setItem('ff.voice.' + key, String(value)); } catch { /* sin almacenamiento */ } }

function paintVoiceStatus() {
    const n = audio.native;
    const ok = n.en && n.es;
    const using = audio.engine === 'system' ? 'system' : (ok ? 'native' : 'system');
    let en, es, cls;
    if (!n.checked) { en = 'Checking natural voice…'; es = 'Comprobando la voz natural…'; cls = 'voice-status'; }
    else if (ok && using === 'native') { en = 'Natural voice ready (offline) ✓'; es = 'Voz natural lista (sin conexión) ✓'; cls = 'voice-status ok'; }
    else if (ok) { en = 'Natural voice installed — using the Windows voice.'; es = 'Voz natural instalada — usando la voz de Windows.'; cls = 'voice-status warn'; }
    else { en = 'Natural voice not installed — run: npm run voices'; es = 'Voz natural no instalada — ejecuta: npm run voices'; cls = 'voice-status warn'; }
    els.voiceStatusEn.textContent = en;
    els.voiceStatusEs.textContent = es;
    els.voiceStatus.className = cls;
}
async function checkNative() { await audio.refreshNative(); paintVoiceStatus(); }

audio.engine = pref('engine', 'auto');
audio.enSid = Number(pref('sid', 20));
audio.speed = Number(pref('speed', 1));
els.voiceEngine.value = audio.engine;
els.voiceSid.value = String(audio.enSid);
els.voiceSpeed.value = String(audio.speed);
els.voiceSpeedVal.textContent = `${audio.speed.toFixed(2)}×`;
els.voiceEngine.addEventListener('change', () => { audio.engine = els.voiceEngine.value; savePref('engine', audio.engine); paintVoiceStatus(); });
els.voiceSid.addEventListener('change', () => { audio.enSid = Number(els.voiceSid.value); savePref('sid', audio.enSid); });
els.voiceSpeed.addEventListener('input', () => {
    audio.speed = Number(els.voiceSpeed.value);
    els.voiceSpeedVal.textContent = `${audio.speed.toFixed(2)}×`;
    savePref('speed', audio.speed);
});
els.btnVoiceRecheck.addEventListener('click', checkNative);
checkNative();

// Botón silenciar (voz + sonido ambiental) -------------------------------------------------------------------
function paintMute() {
    els.btnMute.textContent = audio.muted ? 'Unmute ' : 'Mute ';
    const es = document.createElement('span');
    es.className = 'es';
    es.textContent = audio.muted ? 'Activar sonido' : 'Silenciar';
    els.btnMute.appendChild(es);
}
els.btnMute.addEventListener('click', () => { audio.setMuted(!audio.muted); paintMute(); });

// Eventos de UI ----------------------------------------------------------------------------------------------------
function updateAcceptState() {
    els.btnAccept.disabled = !(els.consent1.checked && els.consent2.checked);
}
els.consent1.addEventListener('change', updateAcceptState);
els.consent2.addEventListener('change', updateAcceptState);

els.btnAccept.addEventListener('click', () => {
    audio.init();                                    // requiere un gesto del usuario
    paintMute();
    faceRequested = els.optFace.checked;
    faceOn = faceRequested;
    consented = true;
    els.gate.classList.add('hidden');
    setGateOpen(false);
    els.btnWipe.disabled = false;
    startMeasurement();
});

els.btnStart.addEventListener('click', () => startMeasurement());
els.btnStop.addEventListener('click', stopMeasurement);
els.btnWipe.addEventListener('click', wipeSession);
els.btnExport.addEventListener('click', exportSession);
els.optDemo.addEventListener('change', () => engine.setDemo(els.optDemo.checked));
els.btnCamTest.addEventListener('click', () => runCameraTest(true));
els.btnCamTips.addEventListener('click', () => { els.camTips.hidden = !els.camTips.hidden; });
els.camDevice.addEventListener('change', () => { camProfile = null; });          // otra cámara: se vuelve a probar
try { els.optPretest.checked = localStorage.getItem('ff.pretest') !== '0'; } catch { /* sin almacenamiento */ }
els.optPretest.addEventListener('change', () => { try { localStorage.setItem('ff.pretest', els.optPretest.checked ? '1' : '0'); } catch { /* sin almacenamiento */ } });
try { els.optAssist.checked = localStorage.getItem('ff.assist2') !== '0'; } catch { /* sin almacenamiento */ }
els.optAssist.addEventListener('change', () => {
    try { localStorage.setItem('ff.assist2', els.optAssist.checked ? '1' : '0'); } catch { /* sin almacenamiento */ }
    if (running) say(els.optAssist.checked
        ? { en: 'Light assist will apply the next time you start the camera.', es: 'El asistente de luz se aplicará al volver a iniciar la cámara.' }
        : { en: 'Light assist will be off the next time you start the camera.', es: 'El asistente de luz se apagará al volver a iniciar la cámara.' }, { urgent: false, seconds: 6 });
});
els.pillGuide.addEventListener('click', () => startGuidedBreathing(60));
els.pillFocus.addEventListener('click', checkFocus);
els.pillEye.addEventListener('click', manualEyeRest);

function setGateOpen(open) {
    for (const el of document.querySelectorAll('header, main, footer')) {
        if (open) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    }
    if (open) els.consent1.focus();
}
setGateOpen(true);

renderRules(Date.now());
renderLog();
paintMute();

window.addEventListener('beforeunload', () => {
    if (hostStream) hostStream.getTracks().forEach((t) => t.stop());
    vision.destroy();
    if (sdk) { try { sdk.destroy(); } catch { /* ya destruido */ } }
    audio.dispose();
});
