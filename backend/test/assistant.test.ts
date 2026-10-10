// Assistant pipeline tests with a DETERMINISTIC FAKE provider. They verify the backend's
// handling of plans (validation, commit, conflicts, permissions, speech, cancellation).
// They do NOT show that Gemini understands any language: see `npm run smoke:gemini`.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider, ops, rawPlan } from '../src/assistant/fake.js';
import { pcmToWav } from '../src/assistant/gemini.js';
import { ProviderError } from '../src/assistant/provider.js';
import { action, addMember, client, connectAndSync, createGallery, registerUser, startServer, type TestServer } from './helpers.js';

let srv: TestServer;
const fake = new FakeProvider();

beforeAll(async () => {
  srv = await startServer(
    (c) => {
      c.assistant.timeoutMs = 400;
      c.assistant.ttsTimeoutMs = 400;
      c.assistant.maxRetries = 0;
      c.assistant.commandsPerMinute = 1000;
      c.assistant.maxAudioSeconds = 5;
    },
    { assistantProvider: fake },
  );
});
afterAll(async () => srv?.close());
beforeEach(() => {
  fake.calls = [];
  fake.speakCalls = [];
  fake.delayMs = 0;
  fake.speakFn = () => ({ audio: pcmToWav(Buffer.alloc(4800), 24000, 1), mimeType: 'audio/wav' });
});

async function setup(lang = 'en') {
  const owner = await registerUser(srv.base, 'Owner');
  const g = await createGallery(owner.api);
  const conv = await owner.api.post(`/v1/galleries/${g.id}/assistant/conversations`, { language: lang });
  expect(conv.status).toBe(201);
  return { owner, g, conv: conv.body };
}

const say = (api: any, convId: string, text: string, extra: Record<string, unknown> = {}) =>
  api.post(`/v1/assistant/conversations/${convId}/commands`, { requestId: randomUUID(), text, ...extra });

async function settle(api: any, commandId: string) {
  await srv.app.deps.assistant.whenIdle();
  return (await api.get(`/v1/assistant/commands/${commandId}`)).body;
}

const sceneOf = async (api: any, id: string) => (await api.get(`/v1/galleries/${id}/scene`)).body;

describe('assistant: text commands', () => {
  it('applies a clear multi-object request immediately as one action, replies, then speaks', async () => {
    const { owner, g, conv } = await setup();
    const viewer = await connectAndSync(owner.api, g.id, 'view');
    const editorWs = await connectAndSync(owner.api, g.id, 'edit');
    fake.planFn = () =>
      rawPlan({
        intent: 'edit',
        operations: ops(
          { op: 'node.setMaterial', nodeId: 'wall-west', material: { color: '#000000' } },
          { op: 'node.update', nodeId: 'light-key', set: { 'props.color': '#ffd6a0' } },
        ),
        reply: 'I painted the left wall black and warmed the light.',
        question: 'Does that look right?',
        suggestions: ['Add a spotlight on the artwork'],
      });

    const r = await say(owner.api, conv.id, 'Paint the left wall black and make the light warmer', { selectedNodeIds: ['wall-west'] });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('queued');
    const cmd = await settle(owner.api, r.body.id);
    expect(cmd).toMatchObject({ status: 'applied', final: true, revision: 1, reply: 'I painted the left wall black and warmed the light.', question: 'Does that look right?' });
    expect(cmd.suggestions).toEqual(['Add a spotlight on the artwork']);
    const scene = (await sceneOf(owner.api, g.id)).scene;
    expect(scene.nodes['wall-west'].props.material.color).toBe('#000000');
    expect(scene.nodes['light-key'].props.color).toBe('#ffd6a0');

    // One action = one undo step, broadcast like any edit, attributed to the user.
    await viewer.waitForRevision(1);
    expect(viewer.messages.find((m) => m.type === 'ops')).toMatchObject({ source: 'ai', actionId: cmd.actionId, actor: { userId: owner.id } });
    // Private status updates reach only the requester's editor connections.
    await editorWs.waitFor((m) => m.type === 'assistant' && m.command.status === 'applied');
    expect(viewer.messages.some((m) => m.type === 'assistant')).toBe(false);

    // Speech is generated after the written reply and retrievable.
    expect(cmd.speech.status).toBe('ready');
    expect(fake.speakCalls[0].text).toContain('I painted the left wall black');
    const speech = await owner.api.get(`/v1/assistant/commands/${cmd.id}/speech`);
    expect(speech.body).toMatchObject({ mimeType: 'audio/wav' });
    const audio = await fetch(`${srv.base}${speech.body.proxyPath}`, { headers: { authorization: `Bearer ${owner.tokens.accessToken}` } });
    expect(Buffer.from(await audio.arrayBuffer()).subarray(0, 4).toString()).toBe('RIFF');

    // The prompt carried the selection and the viewer-relative wall mapping.
    const ctx = JSON.parse(fake.calls[0].context.replace(/^CONTEXT_JSON:\s*/, ''));
    expect(ctx.selectedNodeIds).toEqual(['wall-west']);
    expect(ctx.viewer.relativeWalls.left).toContain('wall-west');
    expect(ctx.viewer.relativeWalls.front).toContain('wall-north');
    viewer.close();
    editorWs.close();
  });

  it('mute: audioEnabled=false never generates speech', async () => {
    const { owner, conv } = await setup();
    fake.planFn = () => rawPlan({ intent: 'answer', reply: 'Try a darker floor.' });
    const r = await say(owner.api, conv.id, 'Any ideas?', { audioEnabled: false });
    const cmd = await settle(owner.api, r.body.id);
    expect(cmd).toMatchObject({ status: 'answered', reply: 'Try a darker floor.', speech: { status: 'disabled' } });
    expect(fake.speakCalls).toHaveLength(0);
  });

  it('speech failure after a successful edit keeps the edit and the written reply', async () => {
    const { owner, g, conv } = await setup();
    fake.planFn = () => rawPlan({ intent: 'edit', operations: ops({ op: 'node.setVisibility', nodeId: 'label-welcome', visible: false }), reply: 'Hidden.' });
    fake.speakFn = () => {
      throw new ProviderError('fatal', 'tts down');
    };
    const cmd = await settle(owner.api, (await say(owner.api, conv.id, 'hide the label')).body.id);
    expect(cmd).toMatchObject({ status: 'applied', reply: 'Hidden.', speech: { status: 'failed' } });
    expect((await sceneOf(owner.api, g.id)).scene.nodes['label-welcome'].visible).toBe(false);
  });

  it('asks a focused clarification for an ambiguous request without changing the scene', async () => {
    const { owner, g, conv } = await setup();
    fake.planFn = () => rawPlan({ intent: 'clarify', reply: 'There are several walls.', question: 'Which wall do you mean?' });
    const cmd = await settle(owner.api, (await say(owner.api, conv.id, 'make it blue')).body.id);
    expect(cmd).toMatchObject({ status: 'needs_clarification', question: 'Which wall do you mean?', actionId: null });
    expect((await sceneOf(owner.api, g.id)).revision).toBe(0);
  });

  it('repairs a malformed plan once, and fails cleanly when it stays malformed', async () => {
    const { owner, g, conv } = await setup();
    // First plan has an out-of-range value; the repair attempt fixes it.
    fake.planFn = (input) =>
      input.repair
        ? rawPlan({ intent: 'edit', operations: ops({ op: 'node.setTransform', nodeId: 'light-key', position: [0, 3, 0] }), reply: 'Moved.' })
        : rawPlan({ intent: 'edit', operations: ops({ op: 'node.setTransform', nodeId: 'light-key', position: [0, 99999, 0] }), reply: 'Moved.' });
    let cmd = await settle(owner.api, (await say(owner.api, conv.id, 'move the light')).body.id);
    expect(cmd.status).toBe('applied');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].repair?.error).toMatch(/position/);

    // Never valid: unknown tool name / garbage args / nonexistent node -> nothing applied.
    fake.calls = [];
    fake.planFn = () =>
      rawPlan({ intent: 'edit', operations: [{ op: 'gallery.grantRole', argsJson: '{"userId":"x","role":"owner"}' }, { op: 'node.remove', argsJson: 'not json' }], reply: 'Done!' });
    cmd = await settle(owner.api, (await say(owner.api, conv.id, 'make me owner')).body.id);
    expect(cmd).toMatchObject({ status: 'failed', error: { code: 'AI_INVALID_PLAN' } });
    expect(cmd.reply).not.toBe('Done!'); // a failed operation is never described as completed
    expect((await sceneOf(owner.api, g.id)).revision).toBe(1);
  });

  it('reports a provider timeout as AI_TIMEOUT without changes', async () => {
    const { owner, g, conv } = await setup();
    fake.delayMs = 2000;
    fake.planFn = () => rawPlan({ intent: 'edit', operations: ops({ op: 'node.setVisibility', nodeId: 'light-key', visible: false }) });
    const cmd = await settle(owner.api, (await say(owner.api, conv.id, 'hide the light')).body.id);
    expect(cmd).toMatchObject({ status: 'failed', error: { code: 'AI_TIMEOUT' } });
    expect(cmd.error.message).toBeTruthy();
    expect((await sceneOf(owner.api, g.id)).revision).toBe(0);
  });

  it('retried requestIds return the same command and apply once', async () => {
    const { owner, g, conv } = await setup();
    fake.planFn = () => rawPlan({ intent: 'edit', operations: ops({ op: 'node.setText', nodeId: 'label-welcome', text: 'Hello' }), reply: 'Done.' });
    const body = { requestId: randomUUID(), text: 'rename the label to Hello' };
    const [a, b] = await Promise.all([
      owner.api.post(`/v1/assistant/conversations/${conv.id}/commands`, body),
      owner.api.post(`/v1/assistant/conversations/${conv.id}/commands`, body),
    ]);
    expect(a.body.id).toBe(b.body.id);
    await settle(owner.api, a.body.id);
    expect((await owner.api.post(`/v1/assistant/conversations/${conv.id}/commands`, body)).body.status).toBe('applied');
    expect((await sceneOf(owner.api, g.id)).revision).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect((await owner.api.post(`/v1/assistant/conversations/${conv.id}/commands`, { ...body, text: 'different' })).body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });
});

describe('assistant: revisions, undo and concurrency', () => {
  it('follow-ups see the previous action; "undo that" reverts only the assistant change', async () => {
    const { owner, g, conv } = await setup();
    const editor = await registerUser(srv.base, 'Editor');
    await addMember(srv.db, g.id, editor.id, 'editor');

    fake.planFn = () => rawPlan({ intent: 'edit', operations: ops({ op: 'artwork.setFrame', nodeId: 'x', frame: { color: '#000000' } }) });
    // Place an artwork-like change: paint the floor.
    fake.planFn = () => rawPlan({ intent: 'edit', operations: ops({ op: 'node.setMaterial', nodeId: 'floor-main', material: { color: '#222222' } }), reply: 'Darker floor.' });
    const first = await settle(owner.api, (await say(owner.api, conv.id, 'make the floor dark')).body.id);
    expect(first.status).toBe('applied');

    // "a little lighter" -> the model sees the previous action with before/after values.
    fake.planFn = (_input, { context }) => {
      const prev = context.recentActions.find((a: any) => a.actionId === first.actionId);
      expect(prev.changes[0]).toMatchObject({ nodeId: 'floor-main', path: 'props.material.color', before: '#8a7560', after: '#222222' });
      expect(context.conversation.at(-1)).toMatchObject({ user: 'make the floor dark', actionId: first.actionId });
      return rawPlan({ intent: 'edit', operations: ops({ op: 'node.setMaterial', nodeId: 'floor-main', material: { color: '#333333' } }), reply: 'A bit lighter.' });
    };
    const second = await settle(owner.api, (await say(owner.api, conv.id, 'a little lighter')).body.id);
    expect(second.status).toBe('applied');

    // A collaborator edits something else meanwhile.
    await editor.api.post(`/v1/galleries/${g.id}/actions`, action(2, [{ op: 'node.setVisibility', nodeId: 'light-key', visible: false }]));

    fake.planFn = () => rawPlan({ intent: 'undo', undoActionId: null, reply: 'Undone' });
    const undo = await settle(owner.api, (await say(owner.api, conv.id, 'undo that')).body.id);
    expect(undo).toMatchObject({ status: 'applied', intent: 'undo' });
    const s = (await sceneOf(owner.api, g.id)).scene;
    expect(s.nodes['floor-main'].props.material.color).toBe('#222222'); // second assistant edit reverted
    expect(s.nodes['light-key'].visible).toBe(false); // collaborator change kept
  });

  it('re-plans once when a collaborator changed the same property during inference', async () => {
    const { owner, g, conv } = await setup();
    const editor = await registerUser(srv.base, 'Editor');
    await addMember(srv.db, g.id, editor.id, 'editor');
    fake.planFn = async (_input, { call, context }) => {
      if (call === 1) {
        // While the model "thinks", someone else recolors the same wall.
        await editor.api.post(`/v1/galleries/${g.id}/actions`, action(context.galleryRevision, [{ op: 'node.setMaterial', nodeId: 'wall-north', material: { color: '#ff0000' } }]));
      }
      return rawPlan({ intent: 'edit', operations: ops({ op: 'node.setMaterial', nodeId: 'wall-north', material: { color: '#00ff00' } }), reply: 'Green.' });
    };
    const cmd = await settle(owner.api, (await say(owner.api, conv.id, 'paint the north wall green')).body.id);
    expect(fake.calls).toHaveLength(2);
    const ctx2 = JSON.parse(fake.calls[1].context.replace(/^CONTEXT_JSON:\s*/, ''));
    expect(ctx2.galleryRevision).toBe(1); // re-grounded on the newer scene
    expect(cmd).toMatchObject({ status: 'applied', revision: 2 });
  });

  it('rechecks permission before committing: a downgrade during inference blocks the edit', async () => {
    const owner = await registerUser(srv.base, 'Owner');
    const editor = await registerUser(srv.base, 'Editor');
    const g = await createGallery(owner.api);
    await addMember(srv.db, g.id, editor.id, 'editor');
    const conv = (await editor.api.post(`/v1/galleries/${g.id}/assistant/conversations`, {})).body;
    fake.planFn = async () => {
      await owner.api.put(`/v1/galleries/${g.id}/members/${editor.id}`, { role: 'viewer' });
      return rawPlan({ intent: 'edit', operations: ops({ op: 'node.setVisibility', nodeId: 'light-key', visible: false }), reply: 'Hidden.' });
    };
    const cmd = await settle(editor.api, (await say(editor.api, conv.id, 'hide the light')).body.id);
    expect(cmd).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect((await sceneOf(owner.api, g.id)).revision).toBe(0);
  });

  it('cancelling while processing changes nothing', async () => {
    const { owner, g, conv } = await setup();
    fake.delayMs = 300;
    fake.planFn = () => rawPlan({ intent: 'edit', operations: ops({ op: 'node.setVisibility', nodeId: 'light-key', visible: false }) });
    const r = await say(owner.api, conv.id, 'hide the light');
    await new Promise((res) => setTimeout(res, 50));
    const c = await owner.api.post(`/v1/assistant/commands/${r.body.id}/cancel`, {});
    expect(c.body.status).toBe('cancelled');
    const cmd = await settle(owner.api, r.body.id);
    expect(cmd.status).toBe('cancelled');
    expect((await sceneOf(owner.api, g.id)).revision).toBe(0);
  });
});

describe('assistant: languages and voice (fake provider)', () => {
  it('passes the reply language through (Haitian Creole distinct from French) and keeps operations language-independent', async () => {
    const { owner, g, conv } = await setup('ht');
    fake.planFn = (_i, { context }) => {
      expect(context.replyLanguage).toBe('ht');
      expect(context.replyLanguageName).toMatch(/Haitian Creole.*NOT French/);
      return rawPlan({
        intent: 'edit',
        detectedLanguage: 'ht',
        operations: ops(...['north', 'south', 'east', 'west'].map((s) => ({ op: 'node.setMaterial', nodeId: `wall-${s}`, material: { color: '#ffffff' } }))),
        reply: 'Mwen mete mi yo blan.',
        question: 'Èske sa bon konsa?',
      });
    };
    const cmd = await settle(owner.api, (await say(owner.api, conv.id, 'Mete mi yo blan.')).body.id);
    expect(cmd).toMatchObject({ status: 'applied', language: 'ht', reply: 'Mwen mete mi yo blan.' });
    expect(fake.speakCalls[0].lang).toBe('ht');
    const s = (await sceneOf(owner.api, g.id)).scene;
    for (const side of ['north', 'south', 'east', 'west']) expect(s.nodes[`wall-${side}`].props.material.color).toBe('#ffffff');
    // Server-written text is localized too.
    fake.planFn = () => rawPlan({ intent: 'edit', operations: [{ op: 'node.remove', argsJson: '[]' }] });
    const failed = await settle(owner.api, (await say(owner.api, conv.id, 'retire tout bagay')).body.id);
    expect(failed.reply).toBe('Asistan an pa t ka fè sa tounen yon chanjman ki valab. Anyen pa t chanje.');
  });

  it('accepts a push-to-talk clip, returns the transcript, and refuses unclear audio', async () => {
    const { owner, g, conv } = await setup('ko');
    const wav = pcmToWav(Buffer.alloc(16000 * 2), 16000, 1); // 1 s of silence
    const send = (file: Buffer, fields: Record<string, string> = {}) => {
      const fd = new FormData();
      fd.append('requestId', randomUUID());
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      fd.append('audio', new Blob([new Uint8Array(file)]), 'clip.wav');
      return owner.api.post(`/v1/assistant/conversations/${conv.id}/voice-commands`, fd);
    };

    fake.planFn = (input) => {
      expect(input.audio?.mimeType).toBe('audio/wav');
      return rawPlan({
        intent: 'edit',
        transcript: '이 조명을 숨겨 주세요',
        detectedLanguage: 'ko',
        operations: ops({ op: 'node.setVisibility', nodeId: 'light-key', visible: false }),
        reply: '조명을 숨겼습니다.',
      });
    };
    let r = await send(wav, { selectedNodeIds: '["light-key"]', audioEnabled: 'false' });
    expect(r.status).toBe(202);
    let cmd = await settle(owner.api, r.body.id);
    expect(cmd).toMatchObject({ status: 'applied', inputKind: 'audio', transcript: '이 조명을 숨겨 주세요', speech: { status: 'disabled' } });

    fake.planFn = () =>
      rawPlan({ intent: 'edit', transcript: '...', transcriptConfidence: 'low', operations: ops({ op: 'node.remove', nodeId: 'wall-north' }) });
    cmd = await settle(owner.api, (await send(wav)).body.id);
    expect(cmd.status).toBe('needs_clarification');
    expect(cmd.reply).toBe('잘 들리지 않았어요. 다시 말씀하시거나 입력해 주시겠어요?');
    expect((await sceneOf(owner.api, g.id)).scene.nodes['wall-north']).toBeTruthy();

    expect((await send(Buffer.from('definitely not audio, just text pretending'))).status).toBe(415);
    expect((await send(pcmToWav(Buffer.alloc(16000 * 2 * 6), 16000, 1))).status).toBe(413); // 6 s > 5 s limit
  });
});

describe('assistant: authorization', () => {
  it('viewers, phone sessions and outsiders cannot use the assistant', async () => {
    const { owner, g, conv } = await setup();
    const viewer = await registerUser(srv.base, 'Viewer');
    await addMember(srv.db, g.id, viewer.id, 'viewer');
    expect((await viewer.api.post(`/v1/galleries/${g.id}/assistant/conversations`, {})).status).toBe(403);
    // Another user cannot read or post into someone else's conversation.
    expect((await say(viewer.api, conv.id, 'hi')).status).toBe(404);
    const vs = await owner.api.post(`/v1/galleries/${g.id}/viewer-sessions`, {});
    const phone = client(srv.base, vs.body.viewerToken);
    expect((await say(phone, conv.id, 'hi')).status).toBe(401);
  });

  it('returns AI_UNAVAILABLE when no provider is configured', async () => {
    const off = await startServer(() => {}, { assistantProvider: null });
    try {
      const owner = await registerUser(off.base, 'Owner');
      const g = await createGallery(owner.api);
      const conv = (await owner.api.post(`/v1/galleries/${g.id}/assistant/conversations`, {})).body;
      const r = await owner.api.post(`/v1/assistant/conversations/${conv.id}/commands`, { requestId: randomUUID(), text: 'hi' });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('AI_UNAVAILABLE');
    } finally {
      await off.close();
    }
  });
});
