/* =========================================================================
   SAMPLE community data, generated so the layout has something to show.
   Swap these for real data from your backend when you have one.
   ========================================================================= */
const SAMPLE = (() => {
  let s = 7; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(r() * a.length)];
  const names = ["Ava Reyes","Jonah Park","Mei Lin","Theo Kaplan","Priya Shah","Marcus Dale","Lena Voss","Kofi Asante","Sofia Marín","Ravi Nair","Hana Takeda","Diego Fuentes","Nora Brandt","Isaac Wells","Yuki Ono","Amara Eze","Felix Grün","Zara Haddad","Owen Cole","Lucía Rojas","Sam Jordan","Inès Quentin","Kai Zhou","Maya Singh","Elio Bassi","Ruth Okafor","Tomás Vega","June Albright"];
  const people = names.map((n, i) => ({ id: i, name: n, handle: "@" + n.toLowerCase().split(" ")[0] + (10 + Math.floor(r() * 89)), h: Math.floor(r() * 360) }));
  const REL = {
    inspired: { label: "Inspired", c: "#f0a25c", total: 812, verbs: ["picked up digital painting after seeing", "started a daily sky study habit because of", "tried their first lighting pass after", "made their first fan piece from"] },
    learned: { label: "Learned", c: "#7cc4ff", total: 344, verbs: ["learned color keying from", "rebuilt their brush set after studying", "used as a reference for school work:", "broke down the values in"] },
    mentored: { label: "Mentored", c: "#b79cff", total: 46, verbs: ["got portfolio feedback alongside", "was mentored through a background like", "got critique notes on a study inspired by"] },
    collab: { label: "Collaborated", c: "#7fe0b4", total: 19, verbs: ["co-painted the layout for", "animated a scene on top of", "wrote the story that became"] },
    commission: { label: "Commissioned", c: "#ff8fb0", total: 63, verbs: ["commissioned a piece after seeing", "hired the artist for a cover after", "ordered a portrait in the style of"] },
  };
  const relations = people.slice(0, 18).map((p, i) => {
    const type = pick(Object.keys(REL)); const piece = Math.floor(r() * 19);
    return { person: p.id, type, piece, verb: pick(REL[type].verbs), impact: 2 + Math.floor(r() * (type === "inspired" ? 60 : 24)), days: 1 + Math.floor(r() * 240),
      quote: pick(["The way the light falls in this one changed how I paint skies.", "I keep this open on my second monitor while I work.", "Honestly the reason I bought a tablet.", "Studied this for a week and my values finally clicked.", "Such a generous artist — answered every question I had.", "Showed it to my whole class.", "The colors stuck with me for days."]) };
  });
  const followers = people.map(p => ({ person: p.id, days: 1 + Math.floor(r() * 400), mutual: r() > .6 })).sort((a, b) => a.days - b.days);
  const following = people.filter((_, i) => i % 3 === 0).map(p => ({ person: p.id, days: 1 + Math.floor(r() * 600) }));
  const viewers = people.slice(4, 22).map(p => ({ person: p.id, mins: Math.floor(r() * 4000), visits: 1 + Math.floor(r() * 12) })).sort((a, b) => a.mins - b.mins);
  const week = [312, 401, 356, 520, 610, 488, 734];
  const lines = ["The lighting here is unreal 🔥", "How long did this take?", "Those colors!! I'd hang this in my room.", "Every time I come back I notice something new.", "The atmosphere in this is so calm.", "Brush work is so clean.", "Need a print of this.", "This palette is perfect.", "Love the composition."];
  const artComments = {}; PIECES.forEach(p => { artComments[p.id] = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ person: Math.floor(r() * names.length), text: pick(lines), mins: 30 + Math.floor(r() * 30000), likes: Math.floor(r() * 40) })); });
  const stats = PIECES.map(() => ({ likes: 40 + Math.floor(r() * 900), views: 900 + Math.floor(r() * 24000) }));
  const supporters = PIECES.map(() => Math.floor(r() * 30));
  const profComments = [
    { person: 2, text: "Your sky studies got me through art school. Thank you for posting them!", mins: 80, likes: 24 },
    { person: 9, text: "Any chance you'll do prints of the Red Room series?", mins: 1440, likes: 11 },
    { person: 15, text: "Following since the Toasty days. The growth is incredible.", mins: 4300, likes: 37 },
    { person: 21, text: "Would love a breakdown of how you light interiors.", mins: 9000, likes: 8 },
  ];
  return { people, REL, relations, followers, following, viewers, week, artComments, stats, supporters, profComments, base: { followers: 4812, following: following.length, views: 128400 } };
})();
