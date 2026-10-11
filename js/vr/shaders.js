/* VR SHADERS
   GLSL for the sky, floor, dome shell, ribbons, particles and the plain "show it exactly as it is" media shader.
   Everything that makes up the *background* goes through grade() so the Overall look sliders apply to it.
   Media (your pictures and videos) never goes through grade(): TEX_FS only samples the texture. */
const VRShaders = (() => {
  const HEAD = "#version 300 es\nprecision highp float;\n";
  const NOISE = `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float v = 0., a = .5; for(int i=0;i<5;i++){ v += a*noise(p); p = p*2.03 + 1.7; a *= .5; } return v; }`;
  const GRADE = `
  uniform vec4 uGrade; uniform vec3 uTint; uniform float uHue;
  vec3 grade(vec3 c){
    if (uHue != 0.) { float cs = cos(uHue), sn = sin(uHue);
      c = vec3(dot(c, vec3(.213+cs*.787-sn*.213, .715-cs*.715-sn*.715, .072-cs*.072+sn*.928)),
               dot(c, vec3(.213-cs*.213+sn*.143, .715+cs*.285+sn*.140, .072-cs*.072-sn*.283)),
               dot(c, vec3(.213-cs*.213-sn*.787, .715-cs*.715+sn*.715, .072+cs*.928+sn*.072))); }
    c *= uGrade.x;
    c = max((c - .25) * uGrade.y + .25, 0.);
    float l = dot(c, vec3(.299, .587, .114));
    c = mix(vec3(l), c, uGrade.z);
    return mix(c, uTint * (l * 1.6 + .04), uGrade.w);
  }`;

  const VS = HEAD + `layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUv; layout(location=2) in vec3 aNormal;
  uniform mat4 uP, uV, uM; out vec2 vUv; out vec3 vW; out vec3 vN;
  void main(){ vec4 w = uM * vec4(aPos, 1.); vW = w.xyz; vUv = aUv; vN = mat3(uM) * aNormal; gl_Position = uP * uV * w; }`;

  /* ---------------- sky ---------------- */
  const SKY_VS = HEAD + `layout(location=0) in vec3 aPos; uniform mat4 uP, uV; out vec3 vDir;
  void main(){ vDir = aPos; vec4 p = uP * mat4(mat3(uV)) * vec4(aPos, 1.); gl_Position = p.xyww; }`;
  const SKY_FS = HEAD + NOISE + GRADE + `in vec3 vDir; out vec4 o;
  uniform vec3 uTop, uMid, uBot, uSun, uSunCol, uNebCol, uCloudCol, uAurA, uAurB;
  uniform float uHorizon, uSunK, uSunSize, uClouds, uStars, uTwinkle, uNeb, uNebS, uAur, uTime, uCTime;
  uniform sampler2D uPano; uniform vec4 uPanoA; uniform vec2 uPanoOff; uniform float uUsePano;
  void main(){
    vec3 d = normalize(vDir); float h = d.y;
    vec3 col = vec3(0.);
    float pano = uUsePano * uPanoA.x;
    if (pano < .999) {
      col = h > 0. ? mix(uMid, uTop, pow(clamp(h,0.,1.), uHorizon)) : mix(uMid, uBot, pow(clamp(-h,0.,1.), .35));
      float s = max(dot(d, normalize(uSun)), 0.), sz = max(uSunSize, .1);
      col += uSunCol * uSunK * (pow(s, 900. / (sz*sz)) * 3. + pow(s, 14. / sz) * .4 + pow(s, 3. / sz) * .14);
      vec2 np = vec2(atan(d.z, d.x) * 1.3, d.y * 2.2) * uNebS;
      float n = pow(fbm(np * 1.6 + vec2(uTime * .004, 0.)), 2.6);
      col += uNebCol * n * uNeb * 1.6 * smoothstep(-.2, .3, h);
      vec2 sg = vec2(atan(d.z, d.x) * 140., asin(clamp(d.y,-1.,1.)) * 140.);
      vec2 si = floor(sg); float r = hash(si);
      float star = step(.988, r) * smoothstep(.45, 0., length(fract(sg) - .5 - (vec2(hash(si+3.), hash(si+7.)) - .5) * .5));
      star *= 1. - uTwinkle * .4 + uTwinkle * .4 * sin(uTime * (1. + r * 3.) + r * 40.);
      col += vec3(star) * uStars * smoothstep(-.05, .25, h);
      if (uAur > 0. && h > 0.) {
        float ax = atan(d.z, d.x);
        float w = fbm(vec2(ax * .6 + uTime * .05, uTime * .03));
        float curtain = smoothstep(.34, 0., abs(h - (.12 + w * .42)));
        float rays = .5 + .5 * sin(ax * 18. + fbm(vec2(ax * 2., uTime * .2)) * 6.);
        col += mix(uAurA, uAurB, smoothstep(.1, .7, h + w * .3)) * curtain * mix(.4, 1., rays) * smoothstep(0., .12, h) * uAur * 1.2;
      }
      if (h > -.02) {
        vec2 cp = d.xz / (h + .18);
        float c = fbm(cp * .9 + vec2(uCTime * .012, uCTime * .004));
        c = smoothstep(.48, .82, c) * uClouds * smoothstep(-.02, .2, h) * (1. - smoothstep(.55, .95, h));
        col = mix(col, mix(uCloudCol, uSunCol, .35 * pow(s, 4.)), c * .75);
      }
    }
    if (pano > .001) {
      float az = atan(d.x, -d.z), el = asin(clamp(d.y, -1., 1.));
      vec2 uv = vec2(az / 6.2831853 + .5 + uPanoA.y / 6.2831853, el / 3.14159265 + .5);
      uv = (uv - .5) / uPanoA.z + .5 + uPanoOff * vec2(1., .5);
      vec2 gx = dFdx(uv), gy = dFdy(uv); gx.x -= floor(gx.x + .5); gy.x -= floor(gy.x + .5);
      vec3 pc = textureGrad(uPano, vec2(uv.x, clamp(uv.y, .002, .998)), gx, gy).rgb;
      col = mix(col, pc, pano);
    }
    o = vec4(grade(col), 1.);
  }`;

  /* ---------------- the platform you stand on (a disc the size of the dome) ---------------- */
  const FLOOR_FS = HEAD + NOISE + GRADE + `in vec3 vW; out vec4 o;
  uniform vec3 uFloor, uGlow, uMid; uniform float uTime, uR, uGlowK, uPat, uRim; uniform int uStyle;
  void main(){
    float r = length(vW.xz), rn = r / uR, aa = max(length(fwidth(vW.xz)), 1e-4);
    float cell = .5 * uPat;
    vec3 col = uFloor * (1. - .35 * rn) + uMid * .06 * (.7 + .3 * fbm(vW.xz * .4));
    float pat = 0.;
    if (uStyle == 0) { float d = abs(fract(r / cell - .5) - .5) * cell; pat = (1. - smoothstep(.006, .006 + aa * 1.5, d)) * .45; }
    else if (uStyle == 1) { vec2 g = abs(fract(vW.xz / cell - .5) - .5) * cell; pat = (1. - smoothstep(.005, .005 + aa * 1.5, min(g.x, g.y))) * .4; }
    else if (uStyle == 2) { vec2 c = floor(vW.xz / cell); float k = mod(c.x + c.y, 2.); col *= .85 + .3 * k; pat = k * .08; }
    else if (uStyle == 3) { float a = atan(vW.z, vW.x) / 6.2831853 * 48.; float d = abs(fract(a + .5) - .5) * r * 6.2831853 / 48.; pat = (1. - smoothstep(.005, .005 + aa * 1.5, d)) * .4 * smoothstep(.2, 1., rn); }
    else if (uStyle == 4) { float w = sin(r * 7. / uPat - uTime * 1.6) * .5 + fbm(vW.xz * 1.4 / uPat + uTime * .1) - .5; col = mix(col, uMid * .45 + uFloor, .35); pat = pow(max(w, 0.), 2.) * .55; }
    float falloff = exp(-r * .35 / max(uR / 4.5, .3));
    col += uGlow * uGlowK * (pat * (.35 + .65 * falloff) + .22 * exp(-r * r / (uR * uR * .06)));
    float edge = abs(rn - 1.);
    float inside = 1. - smoothstep(.992, 1., rn);
    float rimLine = (1. - smoothstep(0., .02, edge)) * uRim;
    float halo = exp(-max(rn - 1., 0.) * 9.) * .5 * uRim * step(1., rn) + exp(-max(1. - rn, 0.) * 14.) * .35 * uRim * step(rn, 1.);
    vec3 lit = grade(col);
    vec3 add = grade(uGlow) * (rimLine * .9 + halo) * .75;
    o = vec4(lit * inside + add * (1. - .0), inside);
    o.rgb = min(o.rgb, vec3(4.));
  }`;

  /* ---------------- the dome shell ---------------- */
  const SHELL_FS = HEAD + GRADE + `in vec3 vW; in vec3 vN; out vec4 o;
  uniform vec3 uCam, uCol; uniform float uR, uOp; uniform int uStyle;
  void main(){
    vec3 p = vW / uR; float az = atan(p.x, -p.z), el = asin(clamp(p.y, -1., 1.));
    float fres = pow(1. - abs(dot(normalize(vN), normalize(uCam - vW))), 2.);
    float a = 0.;
    if (uStyle == 1) a = .05 + fres * .5 + pow(1. - clamp(p.y, 0., 1.), 7.) * .8;
    else {
      float va = az / 6.2831853 * 24., ve = el / 1.5707963 * 6.;
      float la = (1. - smoothstep(0., max(fwidth(va), 1e-3) * 1.4, abs(fract(va + .5) - .5))) * smoothstep(1.4, .85, el);
      float le = 1. - smoothstep(0., max(fwidth(ve), 1e-3) * 1.4, abs(fract(ve + .5) - .5));
      a = (uStyle == 2 ? max(la, le) * .75 : le * .75 + pow(1. - clamp(p.y, 0., 1.), 8.) * .5) * (.3 + fres * .7);
    }
    o = vec4(grade(uCol), clamp(a * uOp * 1.6, 0., 1.));
  }`;

  /* ---------------- your media: texture straight to screen, nothing added ---------------- */
  const TEX_FS = HEAD + `in vec2 vUv; out vec4 o; uniform sampler2D uTex; uniform float uAlpha;
  void main(){ vec4 c = texture(uTex, vUv); o = vec4(c.rgb, c.a * uAlpha); }`;

  const PLATE_FS = HEAD + `in vec2 vUv; out vec4 o; uniform vec2 uSize, uArt; uniform float uMode, uSel, uAlpha; uniform vec3 uCol;
  float rr(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
  void main(){
    vec2 p = (vUv - .5) * uSize;
    float d = rr(p, uArt * .5 + .045, .05);
    float body = 1. - smoothstep(0., .006, d);
    float rim = 1. - smoothstep(0., .01, abs(d + .012));
    float glow = exp(-max(d, 0.) * (22. - uSel * 10.)) * uSel * (1. - body);
    vec3 dark = mix(vec3(.07,.06,.1), vec3(.16,.14,.22), smoothstep(-uArt.y*.5, uArt.y*.5, p.y));
    float plate = uMode > 1.5 ? body : 0.;
    float line = uMode > .5 ? rim * (uMode > 1.5 ? .35 * body : .8) : 0.;
    vec3 col = dark * plate + vec3(1.) * line + uCol * glow;
    o = vec4(col, max(max(plate, line), glow * .9) * uAlpha);
  }`;

  const SOLID_FS = HEAD + GRADE + `in vec3 vW; in vec3 vN; out vec4 o; uniform vec3 uCol, uEmit, uLight, uLightDir, uFog, uCam; uniform float uAmb, uFogK;
  void main(){
    vec3 n = normalize(vN); float dif = max(dot(n, normalize(uLightDir)), 0.);
    float rim = pow(1. - max(dot(n, normalize(uCam - vW)), 0.), 3.);
    vec3 col = uCol * (uAmb + dif * uLight) + uEmit + uLight * rim * .25;
    float f = 1. - exp(-length(vW - uCam) * uFogK);
    o = vec4(grade(mix(col, uFog, f * .85)), 1.);
  }`;

  /* ---------------- light ribbons ---------------- */
  const RIB_VS = HEAD + `layout(location=0) in vec3 aPos; uniform mat4 uP, uV; uniform float uTime, uR, uY, uAmp, uPh, uWave; out float vSide; out float vStrand;
  void main(){
    float a = aPos.x, side = aPos.y, st = aPos.z, ph = uPh + st * .11;
    float y = uY + sin(a*3. + uTime*.22 + ph) * uAmp + sin(a*5. - uTime*.16 + uPh) * uAmp * .5 + cos(a*11. + uTime*.4 + st) * uAmp * .05;
    float r = uR + sin(a*2. + uTime*.09 + ph) * uWave + st * .05 * uWave;
    y += side * (.02 + .018 * mod(st, 4.)) * (uR / 4.);
    vSide = side; vStrand = st;
    gl_Position = uP * uV * vec4(cos(a) * r, y, sin(a) * r, 1.);
  }`;
  const RIB_FS = HEAD + GRADE + `in float vSide; in float vStrand; out vec4 o; uniform vec3 uCol; uniform float uK;
  void main(){ float k = (1. - abs(vSide)) * (mod(vStrand, 4.) < 1. ? 1.4 : .55); o = vec4(grade(uCol) * k * uK, 1.); }`;

  /* ---------------- particles (dust / fireflies / snow / embers) ---------------- */
  const MOTE_VS = HEAD + `layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUv; uniform mat4 uP, uV; uniform float uTime, uSize, uR, uH; uniform int uMode; out float vTw;
  void main(){
    float s = aUv.x, s2 = aUv.y, rad = (.8 + aPos.x * .27) * uR, ang = aPos.z, y = aPos.y * uH, tw = 1.; vec3 p;
    if (uMode == 0) {
      y = mod(y + uTime * (.05 + s * .12), uH);
      p = vec3(cos(ang) * rad + sin(uTime * .3 + s * 20.) * .15, y, sin(ang) * rad + cos(uTime * .25 + s * 13.) * .15);
      tw = (.45 + .55 * sin(uTime * 2. + s * 40.)) * smoothstep(0., .4, y) * smoothstep(uH, uH - 1., y);
    } else if (uMode == 1) {
      float t = uTime * .35;
      p = vec3(cos(ang) * rad, y * .6 + .3, sin(ang) * rad) + vec3(sin(t * (1. + s) + s * 30.), sin(t * 1.3 * (1. + s2) + s2 * 20.) * .4, cos(t * (1. + s2) + s * 11.)) * .5;
      tw = pow(.5 + .5 * sin(uTime * (1.2 + s * 2.) + s * 60.), 3.);
    } else if (uMode == 2) {
      y = uH - mod(uTime * (.15 + s * .25) + (1. - aPos.y) * uH, uH);
      p = vec3(cos(ang) * rad + sin(uTime * .5 + s * 30.) * .25, y, sin(ang) * rad + cos(uTime * .4 + s2 * 30.) * .25);
      tw = .55 + .45 * sin(uTime + s * 50.);
    } else {
      y = mod(y + uTime * (.25 + s * .5), uH);
      p = vec3(cos(ang) * rad + sin(uTime * .9 + y * 2. + s * 20.) * .3, y, sin(ang) * rad + cos(uTime * .8 + y * 1.7 + s2 * 20.) * .3);
      tw = (.5 + .5 * sin(uTime * 9. + s * 80.)) * smoothstep(uH, uH * .3, y) * smoothstep(0., .3, y);
    }
    vec4 mv = uV * vec4(p, 1.);
    gl_PointSize = clamp(uSize * (.5 + s) * (14. / max(-mv.z, .3)), 1., 48.);
    vTw = tw; gl_Position = uP * mv;
  }`;
  const MOTE_FS = HEAD + GRADE + `in float vTw; out vec4 o; uniform vec3 uCol; uniform float uK;
  void main(){ float d = length(gl_PointCoord - .5); o = vec4(grade(uCol) * smoothstep(.5, 0., d) * vTw * uK, 1.); }`;

  /* ---------------- gaze dot ---------------- */
  const RETICLE_FS = HEAD + `in vec2 vUv; out vec4 o; uniform float uProg;
  void main(){ vec2 p = vUv - .5; float r = length(p) * 2.;
    float ring = smoothstep(.07, .02, abs(r - .8)) * (.25 + .75 * uProg);
    float dot_ = smoothstep(.2, .14, r);
    float halo = smoothstep(.2, 0., abs(r - .8)) * .35 * uProg + smoothstep(.45, 0., r) * .25;
    float a = max(max(ring * .9, dot_ * .95), halo);
    o = vec4(vec3(1.), a); }`;

  return { VS, SKY_VS, SKY_FS, FLOOR_FS, SHELL_FS, TEX_FS, PLATE_FS, SOLID_FS, RIB_VS, RIB_FS, MOTE_VS, MOTE_FS, RETICLE_FS };
})();
