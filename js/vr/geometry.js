/* VR GEOMETRY
   Procedural meshes: quad, sphere, curved screen segment, icosahedron, ring. */
const VRGeometry = (() => {
  const { TAU, norm, lerp } = VRMath;
  const GEO = {
    quad() { return { p: [-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, -.5, 0, .5, .5, 0, -.5, .5, 0], uv: [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], n: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1] }; },
    sphere(lat, lon, maxTheta = Math.PI) {
      const p = [], uv = [], n = [], idx = [];
      for (let i = 0; i <= lat; i++) { const th = i / lat * maxTheta; for (let j = 0; j <= lon; j++) { const ph = j / lon * TAU; const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph); p.push(x, y, z); n.push(x, y, z); uv.push(j / lon, 1 - i / lat); } }
      for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) { const a = i * (lon + 1) + j, b = a + lon + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
      return { p, uv, n, idx };
    },
    cylSeg(R, H, a0, a1, segs) {
      const p = [], uv = [];
      for (let i = 0; i < segs; i++) {
        const u0 = i / segs, u1 = (i + 1) / segs, f0 = lerp(a0, a1, u0), f1 = lerp(a0, a1, u1);
        const A = [Math.sin(f0) * R, -H / 2, -Math.cos(f0) * R], B = [Math.sin(f1) * R, -H / 2, -Math.cos(f1) * R], C = [B[0], H / 2, B[2]], D = [A[0], H / 2, A[2]];
        p.push(...A, ...B, ...C, ...A, ...C, ...D); uv.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
      }
      return { p, uv };
    },
    tube(segs, r = 1) { // open cylinder of height 1 (y 0..1), with normals
      const p = [], n = [];
      for (let i = 0; i < segs; i++) { const a = i / segs * TAU, b = (i + 1) / segs * TAU; const A = [Math.cos(a), Math.sin(a)], B = [Math.cos(b), Math.sin(b)];
        p.push(A[0] * r, 0, A[1] * r, B[0] * r, 0, B[1] * r, B[0] * r, 1, B[1] * r, A[0] * r, 0, A[1] * r, B[0] * r, 1, B[1] * r, A[0] * r, 1, A[1] * r);
        n.push(A[0], 0, A[1], B[0], 0, B[1], B[0], 0, B[1], A[0], 0, A[1], B[0], 0, B[1], A[0], 0, A[1]); }
      return { p, n };
    },
    flat(verts, faces) { const p = [], n = []; faces.forEach(([a, b, c]) => { const A = verts[a], B = verts[b], C = verts[c]; const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]]; const nn = norm([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]); p.push(...A, ...B, ...C); n.push(...nn, ...nn, ...nn); }); return { p, n }; },
    icosa() { const t = (1 + Math.sqrt(5)) / 2; const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
      return GEO.flat(v, [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]); },
    octa() { const v = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]; return GEO.flat(v, [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]]); },
    annulus(r0, r1, segs) { const p = [], n = []; for (let i = 0; i < segs; i++) { const a = i / segs * TAU, b = (i + 1) / segs * TAU; const A0 = [Math.cos(a) * r0, 0, Math.sin(a) * r0], A1 = [Math.cos(a) * r1, 0, Math.sin(a) * r1], B0 = [Math.cos(b) * r0, 0, Math.sin(b) * r0], B1 = [Math.cos(b) * r1, 0, Math.sin(b) * r1]; p.push(...A0, ...A1, ...B1, ...A0, ...B1, ...B0); for (let k = 0; k < 6; k++) n.push(0, 1, 0); } return { p, n }; },
  };

  return GEO;
})();
