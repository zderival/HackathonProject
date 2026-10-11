/* ASSISTANT: the studio's helper for the creator (editor window only).
   Type, or hold the mic and talk. The backend's assistant reads your world, makes the change itself as ONE undo step
   (the dome moves live as it happens), and answers in your language. If a request is unclear it asks instead of guessing.
   The AI key lives on the server only; this page never sees it. Needs: signed in + a world open (Cloud tab). */
const Assistant = (() => {
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in attrs) { const v = attrs[k]; if (k === "class") e.className = v; else if (k.startsWith("on")) e[k] = v; else if (v === true) e.setAttribute(k, ""); else if (v !== false && v != null) e.setAttribute(k, v); }
    kids.flat().forEach(c => c != null && c !== false && e.append(c.nodeType ? c : document.createTextNode(c)));
    return e;
  };
  const LS = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const LANGS = [["en", "English"], ["ht", "Kreyòl ayisyen"], ["fr", "Français"], ["es", "Español"], ["ko", "한국어"]];

  /* ---------- words (short, so every language reads naturally) ---------- */
  const T = {
    en: { title: "Studio assistant", lang: "Language", ph: "Say what you want changed, or ask for ideas…", send: "Send", thinking: "Thinking…", working: "Working on it…", mic: "Talk", stop: "Stop", mute: "Voice replies off", unmute: "Voice replies on",
      hi: "Tell me the feeling you want a visitor to have, or what to change: “move Moon to the left”, “make the background darker”, “add text Welcome”. I make the change, you can undo it.",
      chips: ["Make the background darker", "Make the picture bigger", "Add text Welcome", "What should I add next?"],
      applied: "Done · one step, you can undo it", undo: "Undo", undone: "Put back.", heard: "I heard:", failed: "That didn't work: ", needsSignIn: "Sign in and open a world in the Cloud tab to use the assistant. It runs on the server so the AI key never touches this page.", viewOnly: "You can look at this world but not change it, so the assistant is off here.", notOn: "The assistant isn't switched on for this server. The person running it adds a GEMINI_API_KEY to the backend settings (the key stays on the server, never in this page).", noMic: "This browser can't record voice.", micDenied: "Allow the microphone to talk to the assistant." },
    ht: { title: "Asistan estidyo a", lang: "Lang", ph: "Di sa ou vle chanje, oswa mande lide…", send: "Voye", thinking: "Mwen ap reflechi…", working: "M ap travay sou li…", mic: "Pale", stop: "Sispann", mute: "Repons ak vwa fèmen", unmute: "Repons ak vwa louvri",
      hi: "Di m ki santiman ou vle yon vizitè santi, oswa kisa pou chanje: “mete Moon agoch”, “fè background lan pi fonse”, “ajoute tèks Byenveni”. M fè chanjman an, epi ou ka defèt li.",
      chips: ["Fè background lan pi fonse", "Fè imaj la pi gwo", "Ajoute tèks Byenveni", "Kisa pou m ajoute apre?"],
      applied: "Fèt · yon etap, ou ka defèt li", undo: "Defèt", undone: "Mwen remèt li.", heard: "Men sa m tande:", failed: "Sa pa t mache: ", needsSignIn: "Konekte w epi louvri yon mond nan onglè Cloud la pou itilize asistan an.", viewOnly: "Ou ka gade mond sa a men ou pa ka chanje l, kidonk asistan an fèmen.", noMic: "Navigatè sa a pa ka anrejistre vwa.", micDenied: "Pèmèt mikwofòn nan pou pale ak asistan an." },
    fr: { title: "Assistant du studio", lang: "Langue", ph: "Dites ce qu'il faut changer, ou demandez des idées…", send: "Envoyer", thinking: "Je réfléchis…", working: "J'y travaille…", mic: "Parler", stop: "Stop", mute: "Réponses vocales coupées", unmute: "Réponses vocales activées",
      hi: "Dites-moi l'impression à donner, ou quoi changer : « déplace Moon à gauche », « assombris le fond », « ajoute le texte Bienvenue ». Je fais le changement, vous pouvez l'annuler.",
      chips: ["Assombris le fond", "Agrandis l'image", "Ajoute le texte Bienvenue", "Que dois-je ajouter ensuite ?"],
      applied: "Fait · une seule étape, annulable", undo: "Annuler", undone: "Remis comme avant.", heard: "J'ai entendu :", failed: "Ça n'a pas marché : ", needsSignIn: "Connectez-vous et ouvrez un monde dans l'onglet Cloud pour utiliser l'assistant.", viewOnly: "Vous pouvez regarder ce monde sans le modifier : l'assistant est désactivé.", noMic: "Ce navigateur ne peut pas enregistrer la voix.", micDenied: "Autorisez le micro pour parler à l'assistant." },
    es: { title: "Asistente del estudio", lang: "Idioma", ph: "Di qué quieres cambiar, o pide ideas…", send: "Enviar", thinking: "Pensando…", working: "Trabajando en ello…", mic: "Hablar", stop: "Parar", mute: "Respuestas de voz desactivadas", unmute: "Respuestas de voz activadas",
      hi: "Cuéntame la sensación que quieres dar, o qué cambiar: «mueve Moon a la izquierda», «oscurece el fondo», «añade el texto Bienvenida». Hago el cambio y puedes deshacerlo.",
      chips: ["Oscurece el fondo", "Haz la imagen más grande", "Añade el texto Bienvenida", "¿Qué debería añadir ahora?"],
      applied: "Hecho · un solo paso, se puede deshacer", undo: "Deshacer", undone: "Vuelto a como estaba.", heard: "Escuché:", failed: "No funcionó: ", needsSignIn: "Inicia sesión y abre un mundo en la pestaña Cloud para usar el asistente.", viewOnly: "Puedes ver este mundo pero no cambiarlo, así que el asistente está apagado.", noMic: "Este navegador no puede grabar voz.", micDenied: "Permite el micrófono para hablar con el asistente." },
    ko: { title: "스튜디오 도우미", lang: "언어", ph: "바꾸고 싶은 것을 말하거나 아이디어를 물어보세요…", send: "보내기", thinking: "생각 중…", working: "작업 중…", mic: "말하기", stop: "중지", mute: "음성 답변 꺼짐", unmute: "음성 답변 켜짐",
      hi: "방문자가 느꼈으면 하는 분위기나 바꿀 것을 알려 주세요: “Moon을 왼쪽으로 옮겨줘”, “배경을 더 어둡게”, “텍스트 환영합니다 추가”. 제가 바꾸고, 되돌릴 수 있어요.",
      chips: ["배경을 더 어둡게", "그림을 더 크게", "텍스트 환영합니다 추가", "다음에 뭘 추가할까요?"],
      applied: "완료 · 한 단계, 되돌릴 수 있어요", undo: "되돌리기", undone: "원래대로 돌려놓았어요.", heard: "들은 내용:", failed: "잘 안 됐어요: ", needsSignIn: "Cloud 탭에서 로그인하고 월드를 열면 도우미를 쓸 수 있어요.", viewOnly: "이 월드는 보기만 가능해서 도우미가 꺼져 있어요.", noMic: "이 브라우저는 음성을 녹음할 수 없어요.", micDenied: "도우미와 말하려면 마이크를 허용하세요." },
  };
  let lang = LS.get("mw.ai.lang", "en"); if (!T[lang]) lang = "en";
  const t = k => (T[lang][k] ?? T.en[k]);

  function build() {
    const log = h("div", { class: "ai-log", role: "log", "aria-live": "polite" });
    const input = h("textarea", { class: "field ai-in", rows: "2", maxlength: "1000" });
    const sendBtn = h("button", { type: "button", class: "btn primary glass pill press sm" });
    const micBtn = h("button", { type: "button", class: "btn glass pill press sm mic", "aria-pressed": "false" });
    const muteBtn = h("button", { type: "button", class: "btn glass pill press sm", "aria-pressed": "true" });
    const langSel = h("select", { class: "field sel ai-lang", "aria-label": "Language" }, LANGS.map(([v, l]) => h("option", { value: v }, l)));
    const note = h("div", { class: "ai-off", hidden: true });
    const chips = h("div", { class: "ai-chips" });
    const title = h("span", { class: "lbl first" });
    let busy = false, muted = LS.get("mw.ai.muted", "1") === "1", lastUndo = null, rec = null;

    const say = (who, ...kids) => { const m = h("div", { class: "ai-msg " + who }, h("div", { class: "ai-bub" }, ...kids)); log.append(m); log.scrollTop = log.scrollHeight; return m; };
    const status = () => {
      const s = Cloud.state; let msg = "";
      if (!s.gallery) msg = t("needsSignIn"); else if (s.readOnly) msg = t("viewOnly"); else if (!Cloud.assistantReady()) msg = t("notOn");
      note.hidden = !msg; note.textContent = msg; input.disabled = sendBtn.disabled = micBtn.disabled = !!msg || busy;
    };
    const paintText = () => {
      title.textContent = t("title"); input.placeholder = t("ph"); sendBtn.textContent = t("send"); langSel.value = lang;
      micBtn.textContent = (rec ? "■ " + t("stop") : "● " + t("mic")); muteBtn.textContent = muted ? "🔇 " + t("mute") : "🔊 " + t("unmute"); muteBtn.setAttribute("aria-pressed", String(!muted));
      chips.replaceChildren(...T[lang].chips.map(c => h("button", { type: "button", class: "aichip", onclick: () => { input.value = c; send(); } }, c)));
      const first = log.querySelector(".ai-msg.hello .ai-bub"); if (first) first.textContent = t("hi");
      micBtn.hidden = !(navigator.mediaDevices && window.MediaRecorder);
      status();
    };
    langSel.onchange = () => { lang = langSel.value; LS.set("mw.ai.lang", lang); paintText(); };
    muteBtn.onclick = () => { muted = !muted; LS.set("mw.ai.muted", muted ? "1" : "0"); paintText(); };

    async function playSpeech(cmd) {
      if (muted || !cmd.speech || cmd.speech.status === "disabled" || cmd.speech.status === "failed") return;
      try {
        let c = cmd;
        for (let i = 0; i < 20 && c.speech.status === "pending"; i++) { await new Promise(r => setTimeout(r, 900)); c = await Api.getCommand(cmd.id); }
        if (c.speech.status !== "ready") return;
        const blob = await Api.speechAudio(cmd.id); const a = new Audio(URL.createObjectURL(blob)); await a.play();
      } catch (e) { console.warn("speech", e); }
    }
    function show(cmd) {
      const bits = [];
      if (cmd.transcript) bits.push(h("div", { class: "ai-heard" }, t("heard") + " “" + cmd.transcript + "”"));
      if (cmd.status === "failed") bits.push(t("failed") + ((cmd.error && cmd.error.message) || ""));
      else if (cmd.status === "cancelled") bits.push("…");
      else { if (cmd.reply) bits.push(cmd.reply); if (cmd.question) bits.push(h("div", { class: "ai-q" }, cmd.question)); if (!cmd.reply && !cmd.question) bits.push("…"); }
      const m = say("ai", ...bits);
      if (cmd.suggestions && cmd.suggestions.length) m.append(h("div", { class: "ai-chips" }, cmd.suggestions.slice(0, 4).map(sg => h("button", { type: "button", class: "aichip", onclick: () => { input.value = sg; input.focus(); } }, sg))));
      if (cmd.status === "applied") {
        const row = h("div", { class: "ai-act" }, h("span", { class: "muted" }, t("applied")));
        const undo = h("button", { type: "button", class: "btn glass pill press sm", onclick: async () => { undo.disabled = true; try { await Cloud.undo(); row.replaceChildren(h("span", { class: "muted" }, t("undone"))); } catch (e) { row.replaceChildren(h("span", { class: "muted" }, t("failed") + e.message)); } } }, t("undo"));
        row.append(undo); m.append(row); lastUndo = undo;
      }
      log.scrollTop = log.scrollHeight;
      playSpeech(cmd);
    }
    async function run(userText, call) {
      busy = true; status(); say("me", userText);
      const wait = say("ai", t("thinking")); wait.classList.add("wait");
      const to = setTimeout(() => { wait.querySelector(".ai-bub").textContent = t("working"); }, 2500);
      try { const cmd = await call(); wait.remove(); show(cmd); }
      catch (e) { wait.remove(); say("ai", t("failed") + e.message); }
      clearTimeout(to); busy = false; status();
    }
    function send() {
      const text = input.value.trim(); if (!text || busy) return; input.value = "";
      return run(text, () => Cloud.ask({ text, language: lang, muted, selected: World.selected || "" }));
    }
    micBtn.onclick = async () => {
      if (rec) { rec.stop(); return; }
      if (!window.MediaRecorder) { say("ai", t("noMic")); return; }
      let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { say("ai", t("micDenied")); return; }
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(m => MediaRecorder.isTypeSupported(m)) || "";
      const chunks = [], t0 = Date.now(), r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); rec = r;
      r.ondataavailable = e => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach(x => x.stop()); rec = null; micBtn.setAttribute("aria-pressed", "false"); paintText();
        const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" }), ms = Date.now() - t0; if (ms < 400 || !blob.size) return;
        run("🎤 …", () => Cloud.askVoice({ blob, language: lang, muted, selected: World.selected || "", durationMs: ms }));
      };
      r.start(); micBtn.setAttribute("aria-pressed", "true"); paintText(); setTimeout(() => r.state === "recording" && r.stop(), 25000);
    };
    sendBtn.onclick = send;
    input.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };

    log.append(h("div", { class: "ai-msg ai hello" }, h("div", { class: "ai-bub" }, "")));
    const pane = h("div", { class: "pane", "data-pane": "ai", hidden: true },
      title, h("div", { class: "cr cs" }, h("span", { class: "cl" }, t("lang")), langSel), note, log,
      h("div", { class: "ai-compose" }, input, h("div", { class: "ai-btns" }, sendBtn, micBtn)), muteBtn, chips);
    paintText(); Cloud.subscribe(status);
    return pane;
  }
  return { build };
})();
