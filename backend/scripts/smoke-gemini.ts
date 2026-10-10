// LIVE Gemini smoke test: `npm run smoke:gemini` (needs GEMINI_API_KEY in .env).
//
// For each language (en, ht, fr, es, ko) it checks, separately:
//   text         the example command produces a schema-valid plan that applies cleanly to a
//                real scene AND does what the example asks (heuristic check)
//   speechOutput the TTS model returns playable audio for a reply in that language
//   audioInput   the spoken example (synthesized by the TTS model; NOT a human recording)
//                is transcribed and planned correctly
// Results go to reports/gemini-smoke.json, which /v1/capabilities reports per language.
// "passed" means this automated check passed once with these models; it is not a
// human evaluation of translation or audio quality.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GeminiProvider } from '../src/assistant/gemini.js';
import { buildContext, systemInstruction } from '../src/assistant/prompt.js';
import type { RawPlan } from '../src/assistant/provider.js';
import { normalizePlan, parseOperations } from '../src/assistant/service.js';
import { SMOKE_REPORT_PATH } from '../src/capabilities/routes.js';
import { loadConfig } from '../src/config.js';
import type { Lang } from '../src/lib/i18n.js';
import { buildNode, starterScene } from '../src/scene/defaults.js';
import { compileOps } from '../src/scene/engine.js';
import { validateScene } from '../src/scene/validate.js';

const config = loadConfig();
const a = config.assistant;
if (!a.geminiApiKey) {
  console.error('GEMINI_API_KEY is not set. Add it to .env (never commit it) and rerun.');
  process.exit(1);
}
const only = process.argv.slice(2).filter((x) => !x.startsWith('-')) as Lang[];
const provider = new GeminiProvider({ apiKey: a.geminiApiKey, planModel: a.planModel, ttsModel: a.ttsModel, ttsVoice: a.ttsVoice, timeoutMs: 60_000, ttsTimeoutMs: 90_000 });

// Scene: starter room + one framed painting on the north wall, selected.
const scene = starterScene({ title: 'Smoke test' });
const assetId = randomUUID();
scene.nodes['art-1'] = buildNode({
  id: 'art-1',
  type: 'artwork',
  name: 'Blue painting',
  parentId: 'wall-north',
  transform: { position: [0, -0.1, 0.095] },
  props: { assetId, width: 1.2, height: 0.9, title: 'Blue painting' },
});
const assets = [{ id: assetId, title: 'Blue painting', width: 1600, height: 1200 }];
const assetMap = new Map(assets.map((x) => [x.id, { ...x, description: '', attribution: '' }]));

type Check = (s: typeof scene) => boolean;
const color = (s: any, id: string) => (s.nodes[id]?.props?.material?.color ?? '').toLowerCase();
const isLight = (hex: string) => parseInt(hex.slice(1, 3), 16) > 0xe0 && parseInt(hex.slice(3, 5), 16) > 0xe0 && parseInt(hex.slice(5, 7), 16) > 0xe0;
const warmer = (before: string, after: string) => parseInt(after.slice(1, 3), 16) - parseInt(after.slice(5, 7), 16) > parseInt(before.slice(1, 3), 16) - parseInt(before.slice(5, 7), 16);

const CASES: Record<Lang, { text: string; selected: string[]; check: Check; expect: string }> = {
  en: {
    text: 'Move the selected painting to the left wall and make its frame black.',
    selected: ['art-1'],
    expect: 'art-1 on wall-west with a black frame',
    check: (s: any) => s.nodes['art-1'].parentId === 'wall-west' && /^#(0[0-9a-f]){3}$|^#000000$/.test(s.nodes['art-1'].props.frame.color.toLowerCase()),
  },
  ht: {
    text: 'Mete mi yo blan.',
    selected: [],
    expect: 'all four walls white',
    check: (s: any) => ['north', 'south', 'east', 'west'].every((w) => isLight(color(s, `wall-${w}`))),
  },
  fr: {
    text: 'Déplace ce tableau sur le mur de gauche.',
    selected: ['art-1'],
    expect: 'art-1 on wall-west',
    check: (s: any) => s.nodes['art-1'].parentId === 'wall-west',
  },
  es: {
    text: 'Haz que la iluminación sea más cálida.',
    selected: [],
    expect: 'a light or the ambient color becomes warmer',
    check: (s: any) =>
      warmer((scene.nodes['light-key'].props as any).color, (s.nodes['light-key'].props as any).color) ||
      warmer(scene.environment.ambientColor, s.environment.ambientColor),
  },
  ko: {
    text: '이 그림을 조금 더 크게 해 주세요.',
    selected: ['art-1'],
    expect: 'art-1 larger (width or scale)',
    check: (s: any) => s.nodes['art-1'].props.width > 1.2 || s.nodes['art-1'].transform.scale[0] > 1,
  },
};

async function plan(lang: Lang, input: { text?: string; audio?: { data: Buffer; mimeType: string } }, selected: string[]) {
  const context = buildContext({
    replyLanguage: lang,
    revision: 0,
    scene,
    selectedNodeIds: selected,
    assets,
    recentActions: [],
    conversation: [],
    maxNodes: a.maxContextNodes,
    inputKind: input.audio ? 'audio' : 'text',
  });
  const started = Date.now();
  const raw = normalizePlan(await provider.plan({ systemInstruction: systemInstruction(), context, ...input }, AbortSignal.timeout(60_000)));
  return { raw, ms: Date.now() - started };
}

function evaluate(raw: RawPlan, check: Check) {
  if (raw.intent !== 'edit') return { ok: false, why: `intent ${raw.intent}: ${raw.question ?? raw.reply}` };
  const parsed = parseOperations(raw);
  if ('error' in parsed) return { ok: false, why: parsed.error };
  try {
    const result = compileOps(scene, parsed.ops, { assets: assetMap });
    const issues = validateScene(result.scene, { maxNodes: 2000, maxSceneBytes: 2_000_000 });
    if (issues.length) return { ok: false, why: `invalid scene: ${JSON.stringify(issues.slice(0, 2))}` };
    return check(result.scene) ? { ok: true, why: 'valid and matches the request' } : { ok: false, why: 'valid plan but did not do what was asked' };
  } catch (err: any) {
    return { ok: false, why: `${err.code ?? 'error'}: ${JSON.stringify(err.details ?? err.message)}` };
  }
}

const today = new Date().toISOString().slice(0, 10);
const status = (ok: boolean, why: string) => (ok ? `passed (automated smoke test ${today})` : `failed (${today}): ${why}`.slice(0, 300));
const report: any = { at: new Date().toISOString(), models: { plan: a.planModel, speech: a.ttsModel, voice: a.ttsVoice }, languages: {}, details: {} };

for (const lang of (only.length ? only : (Object.keys(CASES) as Lang[]))) {
  const c = CASES[lang];
  const d: any = (report.details[lang] = { command: c.text, expected: c.expect });
  console.log(`\n== ${lang}: ${c.text}`);

  try {
    const { raw, ms } = await plan(lang, { text: c.text }, c.selected);
    const r = evaluate(raw, c.check);
    Object.assign(d, { textMs: ms, textReply: raw.reply, textQuestion: raw.question, textOps: raw.operations, detectedLanguage: raw.detectedLanguage });
    report.languages[lang] = { text: status(r.ok, r.why) };
    console.log(`  text: ${r.ok ? 'PASS' : 'FAIL'} (${ms} ms) ${r.why}\n  reply: ${raw.reply} ${raw.question ?? ''}`);
  } catch (err: any) {
    report.languages[lang] = { text: status(false, err.message) };
    console.log(`  text: ERROR ${err.message}`);
  }

  let spoken: Buffer | null = null;
  try {
    const started = Date.now();
    const out = await provider.speak(c.text, lang, AbortSignal.timeout(90_000));
    const seconds = out.audio.length > 44 && out.mimeType.includes('wav') ? (out.audio.length - 44) / (24000 * 2) : null;
    const ok = out.audio.length > 4000;
    spoken = ok ? out.audio : null;
    Object.assign(d, { speechMs: Date.now() - started, speechMime: out.mimeType, speechBytes: out.audio.length, speechSeconds: seconds });
    report.languages[lang].speechOutput = status(ok, 'empty audio');
    await mkdir('reports/audio', { recursive: true });
    await writeFile(path.join('reports/audio', `${lang}.wav`), out.audio);
    console.log(`  speech: ${ok ? 'PASS' : 'FAIL'} ${out.mimeType} ${out.audio.length} bytes (listen: reports/audio/${lang}.wav)`);
  } catch (err: any) {
    report.languages[lang].speechOutput = status(false, err.message);
    console.log(`  speech: ERROR ${err.message}`);
  }

  if (spoken) {
    try {
      const { raw, ms } = await plan(lang, { audio: { data: spoken, mimeType: 'audio/wav' } }, c.selected);
      const r = raw.transcriptConfidence === 'low' ? { ok: false, why: 'low transcript confidence' } : evaluate(raw, c.check);
      Object.assign(d, { audioMs: ms, transcript: raw.transcript });
      report.languages[lang].audioInput = status(r.ok, r.why) + (r.ok ? ' [synthesized speech, not a human recording]' : '');
      console.log(`  audio input: ${r.ok ? 'PASS' : 'FAIL'} (${ms} ms) transcript="${raw.transcript}" ${r.why}`);
    } catch (err: any) {
      report.languages[lang].audioInput = status(false, err.message);
      console.log(`  audio input: ERROR ${err.message}`);
    }
  } else report.languages[lang].audioInput = status(false, 'skipped: no synthesized audio to test with');
}

await mkdir(path.dirname(SMOKE_REPORT_PATH), { recursive: true });
await writeFile(SMOKE_REPORT_PATH, JSON.stringify(report, null, 2));
console.log(`\nReport written to ${SMOKE_REPORT_PATH}. Listen to reports/audio/*.wav before claiming speech quality.`);
