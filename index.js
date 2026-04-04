/**
 * index.js — Servidor principal do Agente VIVAI
 * Recebe webhooks do Twilio (WhatsApp) e responde via Claude
 */

require("dotenv").config();

const express    = require("express");
const bodyParser = require("body-parser");
const twilio     = require("twilio");
const { processMessage } = require("./agent");

const app  = express();
const port = process.env.PORT || 3000;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "🌿 VIVAI Agent online",
    timestamp: new Date().toISOString(),
  });
});

// ── Webhook do WhatsApp (Twilio) ──────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  // Validar assinatura Twilio (segurança)
  const twilioSignature = req.headers["x-twilio-signature"];
  const webhookUrl = `${process.env.BASE_URL}/webhook/whatsapp`;

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    webhookUrl,
    req.body
  );

  // Em desenvolvimento, ignorar validação se BASE_URL não estiver configurada
  if (process.env.NODE_ENV === "production" && !isValid) {
    console.warn("⚠️  Assinatura Twilio inválida — requisição rejeitada");
    return res.status(403).send("Forbidden");
  }

  const from    = req.body.From;   // Ex: whatsapp:+5511999999999
  const to      = req.body.To;     // Número Twilio
  const message = req.body.Body?.trim();

  if (!message || !from) {
    return res.status(400).send("Bad Request");
  }

  console.log(`📩 [${from}]: ${message}`);

  // Resposta imediata ao Twilio (evita timeout de 15s)
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  // Processar com IA de forma assíncrona
  try {
    const reply = await processMessage(from, message);
    console.log(`🤖 [resposta para ${from}]: ${reply.substring(0, 100)}...`);

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: reply,
    });
  } catch (err) {
    console.error("❌ Erro ao processar mensagem:", err);
    try {
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: "Ocorreu um erro interno. Por favor, tente novamente em instantes.",
      });
    } catch (_) {}
  }
});

// ── Endpoint de teste (sem WhatsApp) ─────────────────────────────────────────
app.post("/test", async (req, res) => {
  const { userId = "test-user", message } = req.body;
  if (!message) return res.status(400).json({ error: "message é obrigatório" });

  try {
    const reply = await processMessage(userId, message);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`\n🌿 VIVAI Agent rodando na porta ${port}`);
  console.log(`   Webhook: POST /webhook/whatsapp`);
  console.log(`   Teste:   POST /test\n`);
});
