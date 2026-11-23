// camera-probe.js
// Prueba previa de cámara: en vez de adivinar el modo, mide cuántos cuadros por segundo ENTREGA de verdad
// cada cámara y cada resolución, y elige la mejor. Es la causa nº 1 del error 14: pedir un modo que la
// cámara no sostiene. Nada se guarda: cada cuadro se cuenta y se descarta.
// v6: (a) los cuadros se cuentan en la propia pista de la cámara (MediaStreamTrackProcessor), sin depender de que
// un <video> se dibuje; (b) antes de medir se devuelve la cámara a automático (un ajuste manual que quedó en el
// driver de Windows hacía medir ~16 fps y una imagen gris); (c) se mide el contraste para detectar imagen plana.
'use strict';

const { resetCameraAuto } = require('./lighting');

const FPS_OK = 27;                                   // por encima de esto el SDK trabaja con holgura (mínimo duro: 25)
const MODES = [
    { w: 640,  h: 480 },                              // el más ligero que da buena imagen: se prefiere
    { w: 800,  h: 600 },
    { w: 1280, h: 720 },
];
const FALLBACK_MODES = [{ w: 480, h: 360 }, { w: 320, h: 240 }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { const e = new Error('timeout'); e.name = 'TimeoutError'; reject(e); }, ms);
        promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}

// Controles de la cámara que el driver deja usar desde el navegador.
function describeControls(track) {
    let caps = {};
    try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch { caps = {}; }
    return ['exposureTime', 'exposureMode', 'exposureCompensation', 'brightness', 'contrast', 'iso'].filter((k) => caps[k] != null);
}

// Limita la exposición a ~33 ms (≈30 fps). Devuelve true si el driver lo aceptó.
async function capExposure(track) {
    try {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (!caps.exposureTime || !caps.exposureMode) return false;
        if (Array.isArray(caps.exposureMode) && !caps.exposureMode.includes('manual')) return false;
        await track.applyConstraints({ advanced: [{ exposureMode: 'manual' }] });
        await track.applyConstraints({ advanced: [{ exposureTime: Math.min(Math.max(333, caps.exposureTime.min), caps.exposureTime.max) }] });
        return true;
    } catch { return false; }
}

async function open(deviceId, w, h) {
    const video = {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 },
    };
    const p = navigator.mediaDevices.getUserMedia({ video, audio: false });
    // Si llega tarde (después del tiempo límite) se libera sola.
    return withTimeout(p, 6000).catch((e) => { p.then((s) => s.getTracks().forEach((t) => t.stop()), () => {}); throw e; });
}

// Cuenta cuadros REALES de la cámara leyendo la pista directamente: no depende de que el <video> se pinte
// (un <video> oculto o fuera de pantalla hace que requestVideoFrameCallback se estrangule y mida de menos).
async function countFramesTrack(track, ms, settleMs) {
    if (typeof MediaStreamTrackProcessor === 'undefined' || !track) return null;
    let reader = null;
    try {
        reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
        const t0 = performance.now(), stamps = [];
        while (performance.now() - t0 < ms + settleMs) {
            const r = await withTimeout(reader.read(), 1500);
            if (r.done) break;
            const now = performance.now();
            try { if (r.value && r.value.close) r.value.close(); } catch { /* ya cerrado */ }
            if (now - t0 >= settleMs) stamps.push(now);
        }
        if (stamps.length < 3) return null;
        return { fps: (stamps.length - 1) / ((stamps[stamps.length - 1] - stamps[0]) / 1000), count: stamps.length, method: 'track' };
    } catch { return null; }
    finally { if (reader) { try { await reader.cancel(); } catch { /* sin lector */ } } }
}

// Plan B: cuadros presentados por el <video> (usa presentedFrames si el navegador lo da; si no, cuenta llamadas).
function countFramesVideo(v, ms, settleMs) {
    return new Promise((resolve) => {
        let first = null, last = null, calls = 0, start = 0;
        const end = performance.now() + ms + settleMs;
        const tick = (_now, meta) => {
            const t = performance.now();
            if (!start) start = t;
            else if (t - start >= settleMs) {
                const p = meta && typeof meta.presentedFrames === 'number' ? meta.presentedFrames : null;
                if (!first) first = { t, p };
                last = { t, p }; calls += 1;
            }
            if (t < end) { if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick); else requestAnimationFrame(tick); }
            else {
                if (!first || !last || last.t - first.t < 200) return resolve({ fps: 0, count: calls, method: 'video' });
                const n = (first.p != null && last.p != null) ? last.p - first.p : calls - 1;
                resolve({ fps: n / ((last.t - first.t) / 1000), count: calls, method: 'video' });
            }
        };
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
    });
}

// Mide los cuadros por segundo y la luz/contraste de una cámara abierta.
async function measure(stream, ms, settleMs = 500, opts = {}) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.className = 'video-src';
    // Se mantiene "visible" para el navegador (1 px, casi transparente) para que no lo estrangule; sin display:none.
    v.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.02;pointer-events:none;';
    v.srcObject = stream;
    document.body.appendChild(v);
    try {
        await v.play();
        const t0 = performance.now();
        while (!v.videoWidth && performance.now() - t0 < 2500) await sleep(50);
        if (!v.videoWidth) return { fps: 0, luma: null, lumaStd: null, width: 0, height: 0, controls: [], capApplied: false };
        const track = stream.getVideoTracks()[0];
        const controls = describeControls(track);
        const capApplied = opts.cap ? await capExposure(track) : false;
        let declared = null; try { declared = (track.getSettings() || {}).frameRate || null; } catch { /* sin ajustes */ }
        let uiFrames = 0, uiOn = true;
        const uiStart = performance.now();
        const uiLoop = () => { uiFrames += 1; if (uiOn) requestAnimationFrame(uiLoop); };   // ¿la interfaz va fluida? (descarta una app saturada)
        requestAnimationFrame(uiLoop);
        const [viaTrack, viaVideo] = await Promise.all([countFramesTrack(track, ms, settleMs), countFramesVideo(v, ms, settleMs)]);
        uiOn = false;
        const uiFps = (uiFrames * 1000) / Math.max(200, performance.now() - uiStart);
        const res = (viaTrack && viaTrack.fps > 0) ? viaTrack : viaVideo;
        let luma = null, lumaStd = null;
        try {
            const c = document.createElement('canvas'); c.width = 64; c.height = 48;
            const x = c.getContext('2d', { willReadFrequently: true });
            x.drawImage(v, 0, 0, 64, 48);
            const d = x.getImageData(0, 0, 64, 48).data;
            let s = 0, s2 = 0; const n = d.length / 4;
            for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; s += l; s2 += l * l; }
            luma = s / n; lumaStd = Math.sqrt(Math.max(0, s2 / n - luma * luma));
        } catch { /* sin acceso al cuadro */ }
        return { fps: res.fps, fpsVideo: viaVideo.fps, declaredFps: declared, method: res.method, luma, lumaStd, width: v.videoWidth, height: v.videoHeight, uiFps, controls, capApplied };
    } finally {
        v.remove();
        v.srcObject = null;
    }
}

async function listCameras() {
    try {
        const all = await navigator.mediaDevices.enumerateDevices();
        return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    } catch { return []; }
}

async function trial(deviceId, mode, ms, settleMs = 500, opts = {}) {
    let stream = null;
    try {
        stream = await open(deviceId, mode.w, mode.h);
        // Un ajuste manual que quedó en el driver (de otra sesión o de otra app) baja los cuadros y aplana la imagen:
        // se mide siempre desde automático, salvo en la prueba que quiere probar el límite de exposición a propósito.
        if (!opts.cap) { try { await resetCameraAuto(stream.getVideoTracks()[0]); await sleep(350); } catch { /* sin soporte */ } }
        const r = await measure(stream, ms, settleMs, opts);
        return { ...r, error: null };
    } catch (e) {
        return { fps: 0, luma: null, lumaStd: null, width: 0, height: 0, error: (e && e.name) || 'error' };
    } finally {
        if (stream) {
            for (const t of stream.getVideoTracks()) { try { await resetCameraAuto(t); } catch { /* sin soporte */ } }   // la prueba usa exposición manual: se deshace
            stream.getTracks().forEach((t) => t.stop());
        }
        await sleep(150);                                                  // deja que el driver libere la cámara
    }
}

// Prueba cámaras y modos. onProgress(hecho, total, texto) para mostrar avance.
//  - preferred: deviceId elegido a mano (si hay uno, solo se prueba esa cámara).
async function probeAll({ preferred = null, onProgress = () => {}, light = null } = {}) {
    let cams = await listCameras();
    if (!cams.length || cams.some((c) => !c.deviceId)) {                  // sin permiso aún: se abre una vez la cámara para obtener ids y nombres
        try { const s = await open(null, 640, 480); s.getTracks().forEach((t) => t.stop()); await sleep(250); } catch { /* se sigue */ }
        cams = await listCameras();
    }
    if (preferred) cams = cams.filter((c) => c.deviceId === preferred);
    if (!cams.length) cams = [{ deviceId: null, label: 'Default camera' }];
    cams = cams.slice(0, 3);

    const totalSteps = cams.length + 2;
    let done = 0;
    const report = { cameras: [], modes: [], best: null, ok: false, uiFps: null, afterLight: null, lightHelped: false };

    // 1) ¿Qué cámara entrega más cuadros en el modo ligero?
    for (const c of cams) {
        onProgress(done, totalSteps, c.label);
        const r = await trial(c.deviceId, MODES[0], 1200);
        report.cameras.push({ deviceId: c.deviceId, label: c.label, fps: r.fps, luma: r.luma, lumaStd: r.lumaStd, method: r.method, declaredFps: r.declaredFps, error: r.error, controls: r.controls || [] });
        if (r.uiFps) report.uiFps = Math.max(report.uiFps || 0, r.uiFps);
        done += 1;
    }
    const usable = report.cameras.filter((c) => !c.error && c.fps > 0).sort((a, b) => b.fps - a.fps);
    if (!usable.length) return report;
    const cam = usable[0];

    // 2) En esa cámara, ¿qué modo sostiene mejor los cuadros? Se prefiere el más ligero que llegue a FPS_OK.
    const first = { w: MODES[0].w, h: MODES[0].h, fps: cam.fps, luma: cam.luma, lumaStd: cam.lumaStd, method: cam.method };
    report.modes.push({ id: `${first.w}x${first.h}`, fps: first.fps, luma: first.luma });
    let best = first;
    if (first.fps < FPS_OK) {
        for (const m of MODES.slice(1)) {
            onProgress(done, totalSteps, `${m.w}×${m.h}`);
            const r = await trial(cam.deviceId, m, 1200);
            report.modes.push({ id: `${m.w}x${m.h}`, fps: r.fps, luma: r.luma, error: r.error });
            if (!r.error && r.fps > best.fps + 1) best = { w: m.w, h: m.h, fps: r.fps, luma: r.luma, lumaStd: r.lumaStd, method: r.method };
            if (best.fps >= FPS_OK) break;
        }
        if (best.fps < 25) {                                               // ninguna cámara llega: se prueban modos aún más ligeros
            for (const m of FALLBACK_MODES) {
                onProgress(done, totalSteps, `${m.w}×${m.h}`);
                const r = await trial(cam.deviceId, m, 1200);
                report.modes.push({ id: `${m.w}x${m.h}`, fps: r.fps, luma: r.luma, error: r.error });
                if (!r.error && r.fps > best.fps + 1) best = { w: m.w, h: m.h, fps: r.fps, luma: r.luma, lumaStd: r.lumaStd, method: r.method };
                if (best.fps >= FPS_OK) break;
            }
        }
    }
    done = totalSteps;
    onProgress(done, totalSteps, '');
    report.controls = cam.controls || [];
    report.best = { deviceId: cam.deviceId, label: cam.label, w: best.w, h: best.h, fps: best.fps, luma: best.luma, lumaStd: best.lumaStd, method: best.method, cap: false };
    report.ok = best.fps >= 25;
    // Si TODOS los modos dan casi los mismos cuadros (<25), no es la resolución: es la luz o el driver de la cámara.
    const fl = report.modes.map((m) => m.fps).filter((f) => f > 0);
    report.uniformLow = fl.length >= 2 && Math.max(...fl) < 25 && Math.max(...fl) - Math.min(...fl) < 2.5;

    // 3) Si sigue por debajo de 25 fps: casi siempre es poca luz (la cámara alarga la exposición y baja los cuadros).
    //    a) limitar la exposición a ~33 ms (si el driver lo permite); b) luz de pantalla (con el límite si sirvió).
    if (!report.ok) {
        const mode = { w: best.w, h: best.h };
        const keep = (r, cap) => {
            if (r.error || !(r.fps > best.fps + 1)) return false;
            best = { ...best, fps: r.fps, luma: r.luma, lumaStd: r.lumaStd, cap };
            report.best = { deviceId: cam.deviceId, label: cam.label, w: best.w, h: best.h, fps: best.fps, luma: best.luma, lumaStd: best.lumaStd, method: best.method, cap };
            report.ok = best.fps >= 25;
            return true;
        };
        if (report.controls.includes('exposureTime')) {
            onProgress(totalSteps - 1, totalSteps, 'exposure limit · límite de exposición');
            const r = await trial(cam.deviceId, mode, 2500, 1500, { cap: true });
            report.afterCap = { fps: r.fps, applied: !!r.capApplied, error: r.error };
            if (r.capApplied) keep(r, true);
        }
        if (!report.ok && light && light.on) {
            onProgress(totalSteps - 1, totalSteps, 'screen light · luz de pantalla');
            await light.on();
            await sleep(2500);
            const useCap = !!(report.afterCap && report.afterCap.applied);
            const r = await trial(cam.deviceId, mode, 2500, 1200, { cap: useCap });
            report.afterLight = { fps: r.fps, luma: r.luma, error: r.error };
            if (keep(r, useCap)) report.lightHelped = report.ok || r.fps >= 20;
            if (!report.lightHelped && light.off) light.off();
        }
    }
    return report;
}

module.exports = { probeAll, listCameras, FPS_OK };
