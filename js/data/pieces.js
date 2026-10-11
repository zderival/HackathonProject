/* =========================================================================
   DATA: your artwork. Same files as before: thumbs/ for the ring, art/ for full size.
   `hue` tints the space around each piece. `desc` shows on the art page.
   ========================================================================= */
const PIECES = [
  { t: "Ami's Room", k: "Night lighting pass", d: "", n: "14", ar: 1.7778, hue: 250 },
  { t: "Glumshroom Thicket", k: "ANIM 325 · Background painting", d: "", n: "15", ar: 1.7778, hue: 160 },
  { t: "Mango Park", k: "ANIM 325 · Background painting", d: "", n: "16", ar: 1.7778, hue: 40 },
  { t: "Cloud Study", k: "Sky painting", d: "", n: "17", ar: 0.6948, hue: 205 },
  { t: "Head in the Clouds", k: "Self-portrait", d: "08/24", n: "03", ar: 1, hue: 215 },
  { t: "Red Room I", k: "Lighting study", d: "08/24", n: "04", ar: 1, hue: 355 },
  { t: "Red Room II", k: "Lighting study", d: "08/24", n: "05", ar: 1, hue: 345 },
  { t: "Last Light", k: "Sky study", d: "07/26", n: "06", ar: 1.7778, hue: 25 },
  { t: "Intersection", k: "Sky study", d: "07/26", n: "07", ar: 1.7778, hue: 15 },
  { t: "Horizon", k: "Sky study", d: "07/26", n: "08", ar: 1.7778, hue: 200 },
  { t: "Lounge Singer", k: "Character illustration", d: "07/26", n: "09", ar: 1, hue: 290 },
  { t: "Fangs", k: "Color study", d: "08/26", n: "10", ar: 1, hue: 330 },
  { t: "Toast", k: "Painting", d: "08/26", n: "18", ar: 1, hue: 35 },
  { t: "Daydream", k: "Self-portrait", d: "", n: "12", ar: 1, hue: 270 },
  { t: "Apple Houses", k: "Painting", d: "08/26", n: "02", ar: 0.7998, hue: 10 },
  { t: "Character Sheet", k: "Turnaround & expressions", d: "", n: "01", ar: 1.2503, hue: 190 },
  { t: "Mustache", k: "Sketch", d: "10/25", n: "13", ar: 1, hue: 30 },
  { t: "Toasty, Becoming Corrupt", k: "Character illustration", d: "05/21", n: "19", ar: 0.8945, hue: 280 },
  { t: "Toasty", k: "Character illustration", d: "05/21", n: "11", ar: 0.8945, hue: 30 },
  { t: "Spider-Man Speed Paint", k: "Process timelapse · sketch to final", d: "0:30", video: true, ar: 1.9048, hue: 355 },
].map((p, i) => ({ ...p, id: i, thumb: p.video ? "thumbs/video-poster.jpg" : `thumbs/${p.n}.jpg`, src: p.video ? "" : `art/${p.n}.jpg` }));

const CATS = [
  ["all", "All", () => true],
  ["sky", "Skies", p => /sky|cloud|horizon/i.test(p.k + p.t)],
  ["char", "Characters", p => /character|portrait|turnaround/i.test(p.k)],
  ["light", "Lighting", p => /lighting|night/i.test(p.k)],
  ["bg", "Backgrounds", p => /background/i.test(p.k)],
  ["study", "Studies & sketches", p => /study|sketch/i.test(p.k)],
  ["video", "Process", p => !!p.video],
];
