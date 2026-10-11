/* ========================================================================= AMBIENT FLOW (PS5-style) */
const cv = $("#flow"), cx = cv.getContext("2d");
let hue = 30, hueTarget = 30, W = 0, Hh = 0, DPR = 1, motes = [];
function sizeFlow() {
  DPR = Math.min(devicePixelRatio || 1, 1.5);
  W = cv.width = innerWidth * DPR; Hh = cv.height = innerHeight * DPR;
  motes = Array.from({ length: Math.round(innerWidth / 18) }, () => ({ x: Math.random() * W, y: Math.random() * Hh, r: (Math.random() * 1.6 + .4) * DPR, s: Math.random() * .4 + .1, p: Math.random() * 6.28 }));
}
function drawFlow(now) {
  let dh = ((hueTarget - hue + 540) % 360) - 180; hue = (hue + dh * .03 + 360) % 360;
  document.documentElement.style.setProperty("--hue", hue.toFixed(1));
  if (!S.settings.ambient || S.settings.calm) { if (cv.dataset.on !== "0") { cx.clearRect(0, 0, W, Hh); cv.dataset.on = "0"; } return; }
  cv.dataset.on = "1";
  const t = now / 1000, k = S.settings.intensity / 100;
  cx.clearRect(0, 0, W, Hh);
  cx.globalCompositeOperation = "lighter";
  // ribbons: bundles of thin sine lines that braid and breathe
  for (let b = 0; b < 3; b++) {
    const base = Hh * (.58 + b * .13), amp = Hh * (.07 + b * .025), h = hue + b * 28 - 20;
    for (let l = 0; l < 16; l++) {
      cx.beginPath();
      const ph = l * .09 + b * 2.1, a = amp * (1 + l * .025);
      for (let x = -20; x <= W + 20; x += 18 * DPR) {
        const u = x / W;
        const y = base + Math.sin(u * 5.2 + t * .35 * (1 + b * .2) + ph) * a + Math.sin(u * 2.1 - t * .22 + b) * a * .9 + Math.cos(u * 11 + t * .5 + l * .3) * a * .08;
        x <= -20 ? cx.moveTo(x, y) : cx.lineTo(x, y);
      }
      cx.strokeStyle = `hsla(${h + l * 2}, 85%, ${62 + l}%, ${(.028 + (l % 4 === 0 ? .03 : 0)) * k * 1.6})`;
      cx.lineWidth = DPR * (l % 4 === 0 ? 1.4 : .8);
      cx.stroke();
    }
  }
  // drifting motes
  for (const m of motes) {
    m.y -= m.s * DPR * (.5 + k); m.x += Math.sin(t * .6 + m.p) * .3 * DPR;
    if (m.y < -10) { m.y = Hh + 10; m.x = Math.random() * W; }
    const tw = .45 + .55 * Math.sin(t * 2 + m.p);
    cx.beginPath(); cx.arc(m.x, m.y, m.r, 0, 6.283);
    cx.fillStyle = `hsla(${hue + 20}, 90%, 80%, ${.5 * tw * k})`; cx.fill();
  }
  cx.globalCompositeOperation = "source-over";
}
