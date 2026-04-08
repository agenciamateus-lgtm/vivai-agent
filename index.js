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

// ── Dashboard ─────────────────────────────────────────────────────────────────
const path = require("path");
const fs   = require("fs");
const DATA_FILE = path.join(__dirname, "crm-data.json");

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// API: leitura dos dados
app.get("/api/data", (req, res) => {
  try {
    const data = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) : { clients: [], interactions: [], tasks: [] };
    res.json(data);
  } catch (e) {
    res.json({ clients: [], interactions: [], tasks: [] });
  }
});

// API: atualização parcial dos dados
app.post("/api/data", (req, res) => {
  try {
    const current = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) : { clients: [], interactions: [], tasks: [] };
    const updated = { ...current, ...req.body };
    fs.writeFileSync(DATA_FILE, JSON.stringify(updated, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Webhook do WhatsApp (Twilio) ──────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  // Validar assinatura Twilio (segurança)
  // Validação de assinatura ignorada no sandbox — segura para desenvolvimento
  // Para produção com número aprovado, reativar a validação

  const from    = req.body.From;
  const message = req.body.Body?.trim() || "";
  const numMedia = parseInt(req.body.NumMedia || "0", 10);

  if (!from) return res.status(400).send("Bad Request");

  // Coletar mídias (imagens, áudios)
  const mediaList = [];
  for (let i = 0; i < numMedia; i++) {
    mediaList.push({
      url: req.body[`MediaUrl${i}`],
      contentType: req.body[`MediaContentType${i}`],
    });
  }

  console.log(`📩 [${from}]: ${message || "(sem texto)"}${mediaList.length ? ` + ${mediaList.length} mídia(s)` : ""}`);

  // Resposta imediata ao Twilio
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  // Processar com IA
  try {
    const reply = await processMessage(from, message, mediaList);
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


// ── Gerador de PDF de proposta ────────────────────────────────────────────────
const { execSync } = require("child_process");
const os = require("os");

app.post("/api/quote/pdf", async (req, res) => {
  try {
    const data = req.body;
    const tmpOut = path.join(os.tmpdir(), `proposta_${Date.now()}.pdf`);
    const logoPath = path.join(__dirname, "logo.png");
    const pyScript = path.join(__dirname, "generate_pdf.py");
    const jsonStr = JSON.stringify(data).replace(/'/g, "\'");
    const logoArg = require("fs").existsSync(logoPath) ? ` '${logoPath}'` : "";
    execSync(`python3 '${pyScript}' '${jsonStr}' '${tmpOut}'${logoArg}`, { timeout: 30000 });
    const pdfBuffer = require("fs").readFileSync(tmpOut);
    require("fs").unlinkSync(tmpOut);
    const clientName = (data.client || "proposta").replace(/[^a-zA-Z0-9]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Proposta_VIVAI_${clientName}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Erro ao gerar PDF:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`\n🌿 VIVAI Agent rodando na porta ${port}`);
  console.log(`   Webhook: POST /webhook/whatsapp`);
  console.log(`   Teste:   POST /test\n`);
});
