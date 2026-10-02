const { KNOWLEDGE } = require("../lib/knowledge");

const SYSTEM = `Tu es l'assistant virtuel expert du stand d'AIC (Application Industrielle de Caoutchouc) au salon SIREXE.
Missions : présenter les services clés d'AIC — bandes transporteuses, garnissage caoutchouc/PVC, rouleaux, joints, et maintenance / vulcanisation à chaud et à froid sur sites industriels et miniers.
Règles :
- Réponds dans la langue du visiteur (français par défaut), en 2 à 3 phrases MAXIMUM.
- Ton ultra-professionnel, courtois et dynamique (B2B). Adapte tes exemples au secteur du visiteur (mine, industrie, négoce…).
- Appuie-toi UNIQUEMENT sur la base de connaissances ci-dessous. Si l'information manque, ne l'invente pas : renvoie vers un ingénieur. Ne promets ni prix ni délai précis.
- Termine SYSTÉMATIQUEMENT en proposant d'échanger avec un ingénieur présent sur le stand ou de laisser ses coordonnées (Nom, Entreprise, Téléphone/WhatsApp).

BASE DE CONNAISSANCES AIC :
${KNOWLEDGE}`;

const signal = (ms) => AbortSignal.timeout(ms);

async function gemini(msgs, key) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    signal: signal(15000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: msgs.map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.text }] })),
      generationConfig: { temperature: 0.6, maxOutputTokens: 350, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!r.ok) throw new Error("gemini " + r.status);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
}

// Groq et Mistral utilisent le format compatible OpenAI
const openaiLike = (url, model) => async (msgs, key) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    signal: signal(15000),
    body: JSON.stringify({
      model,
      temperature: 0.6,
      max_tokens: 350,
      messages: [{ role: "system", content: SYSTEM }, ...msgs.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }))],
    }),
  });
  if (!r.ok) throw new Error(model + " " + r.status);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim();
};

const PROVIDERS = [
  { name: "gemini", key: () => process.env.GEMINI_API_KEY, call: gemini },
  { name: "groq", key: () => process.env.GROQ_API_KEY, call: openaiLike("https://api.groq.com/openai/v1/chat/completions", "llama-3.3-70b-versatile") },
  { name: "mistral", key: () => process.env.MISTRAL_API_KEY, call: openaiLike("https://api.mistral.ai/v1/chat/completions", "mistral-small-latest") },
];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const msgs = raw
    .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string")
    .slice(-12)
    .map((m) => ({ role: m.role, text: m.text.slice(0, 1000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ error: "Message invalide" });

  // Basculement automatique : on passe au fournisseur suivant en cas d'erreur
  for (const p of PROVIDERS) {
    const key = p.key();
    if (!key) continue;
    try {
      const reply = await p.call(msgs, key);
      if (!reply) throw new Error("réponse vide");

      // Capture de lead (optionnelle) : si le visiteur laisse un numéro et qu'un webhook est configuré
      const last = msgs[msgs.length - 1].text;
      if (process.env.LEAD_WEBHOOK_URL && /\+?\d[\d\s.-]{7,}/.test(last)) {
        await fetch(process.env.LEAD_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: signal(4000),
          body: JSON.stringify({ date: new Date().toISOString(), salon: "SIREXE", conversation: msgs }),
        }).catch(() => {});
      }
      return res.status(200).json({ reply, provider: p.name });
    } catch (e) {
      console.error("Échec fournisseur", p.name, e.message);
    }
  }
  return res.status(503).json({ error: "Aucun fournisseur IA disponible" });
};
