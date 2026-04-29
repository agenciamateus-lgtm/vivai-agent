/**
 * index.js — Servidor principal VIVAI
 * Banco de dados: PostgreSQL (Railway)
 */

require("dotenv").config();

const express    = require("express");
const bodyParser = require("body-parser");
const path       = require("path");
const { execSync } = require("child_process");
const os         = require("os");
const fs         = require("fs");

const app  = express();
const port = process.env.PORT || 8080;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json({ limit: "10mb" }));

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL não definida. Configure no Railway > Variables.");
  process.exit(1);
}
const dbUrlMasked = process.env.DATABASE_URL.replace(/:\/\/[^@]+@/, "://*****@");
console.log("🔌 Banco:", dbUrlMasked);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_data (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO crm_data (key, value) VALUES
      ('clients',      '[]'::jsonb),
      ('interactions', '[]'::jsonb),
      ('tasks',        '[]'::jsonb),
      ('finance',      '[]'::jsonb)
    ON CONFLICT (key) DO NOTHING;
  `);

  // Migração automática do JSON local (se existir)
  const localFile = path.join(__dirname, "crm-data.json");
  if (fs.existsSync(localFile)) {
    try {
      const local = JSON.parse(fs.readFileSync(localFile, "utf-8"));
      for (const [key, value] of Object.entries(local)) {
        if (Array.isArray(value) && value.length > 0) {
          await pool.query(
            `INSERT INTO crm_data (key, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
            [key, JSON.stringify(value)]
          );
        }
      }
      fs.renameSync(localFile, localFile + ".migrated");
      console.log("✅ Dados migrados do JSON para PostgreSQL");
    } catch (e) {
      console.error("⚠️  Migração:", e.message);
    }
  }

  console.log("✅ PostgreSQL pronto");
}

async function readData() {
  const { rows } = await pool.query("SELECT key, value FROM crm_data");
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function writeData(updates) {
  for (const [key, value] of Object.entries(updates)) {
    await pool.query(
      `INSERT INTO crm_data (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }
}

// ── Páginas ───────────────────────────────────────────────────────────────────
app.get("/",      (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/quote", (req, res) => res.sendFile(path.join(__dirname, "quote.html")));

// ── API CRM ───────────────────────────────────────────────────────────────────
app.get("/api/data", async (req, res) => {
  try {
    res.json(await readData());
  } catch (e) {
    console.error("GET /api/data:", e.message);
    res.json({ clients: [], interactions: [], tasks: [] });
  }
});

app.post("/api/data", async (req, res) => {
  try {
    await writeData(req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/data:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PDF ───────────────────────────────────────────────────────────────────────
app.post("/api/quote/pdf", async (req, res) => {
  try {
    const ts = Date.now();
    const tmpJson = path.join(os.tmpdir(), `p_${ts}.json`);
    const tmpOut  = path.join(os.tmpdir(), `p_${ts}.pdf`);
    const pyScript = path.join(__dirname, "generate_pdf.py");
    const logoPath = path.join(__dirname, "logo.png");
    fs.writeFileSync(tmpJson, JSON.stringify(req.body), "utf8");
    const logoArg = fs.existsSync(logoPath) ? ` '${logoPath}'` : "";
    try { execSync(`python3 '${pyScript}' '${tmpJson}' '${tmpOut}'${logoArg}`, { timeout: 30000 }); }
    finally { try { fs.unlinkSync(tmpJson); } catch (_) {} }
    const buf = fs.readFileSync(tmpOut); fs.unlinkSync(tmpOut);
    const name = (req.body.client || "proposta").replace(/[^a-zA-Z0-9]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Proposta_VIVAI_${name}.pdf"`);
    res.send(buf);
  } catch (err) { console.error("PDF:", err.message); res.status(500).json({ error: err.message }); }
});

// ── DOCX ──────────────────────────────────────────────────────────────────────
app.post("/api/quote/docx", async (req, res) => {
  try {
    const ts = Date.now();
    const tmpJson = path.join(os.tmpdir(), `p_${ts}.json`);
    const tmpOut  = path.join(os.tmpdir(), `p_${ts}.docx`);
    const pyScript = path.join(__dirname, "generate_docx.py");
    fs.writeFileSync(tmpJson, JSON.stringify(req.body), "utf8");
    try { execSync(`python3 '${pyScript}' '${tmpJson}' '${tmpOut}'`, { timeout: 30000 }); }
    finally { try { fs.unlinkSync(tmpJson); } catch (_) {} }
    const buf = fs.readFileSync(tmpOut); fs.unlinkSync(tmpOut);
    const name = (req.body.client || "proposta").replace(/[^a-zA-Z0-9]/g, "_");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="Proposta_VIVAI_${name}.docx"`);
    res.send(buf);
  } catch (err) { console.error("DOCX:", err.message); res.status(500).json({ error: err.message }); }
});

// ── IA ────────────────────────────────────────────────────────────────────────
async function callAI(params, retries = 3, delay = 2000) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  for (let i = 1; i <= retries; i++) {
    try { return await ai.messages.create(params); }
    catch (err) {
      const retry = err.status === 529 || err.status === 429 || (err.message||"").includes("overloaded");
      if (retry && i < retries) { await new Promise(r => setTimeout(r, delay * i)); continue; }
      throw err;
    }
  }
}

app.post("/api/chat", async (req, res) => {
  try {
    const { system, messages, max_tokens } = req.body;
    const r = await callAI({ model: "claude-sonnet-4-20250514", max_tokens: max_tokens||600, system, messages });
    res.json({ content: r.content });
  } catch (err) {
    if (err.status === 529 || (err.message||"").includes("overloaded"))
      return res.status(529).json({ content: [{ type:"text", text:"⏳ IA sobrecarregada, tente novamente." }] });
    res.status(err.status||500).json({ error: err.message });
  }
});

app.post("/api/analyze-leads", async (req, res) => {
  try {
    const { clients=[], interactions=[], tasks=[] } = req.body;
    const active = clients.filter(c => c.stage !== "Fechado").slice(0, 15).map(c => ({
      id: c.id, name: c.name, stage: c.stage, value: c.value,
      interactions: interactions.filter(i=>i.clientId===c.id).slice(0,3).map(i=>`${i.date} [${i.type}]: ${i.note}`),
      tasks: tasks.filter(t=>t.clientId===c.id&&!t.done).map(t=>t.title),
    }));
    const r = await callAI({ model:"claude-sonnet-4-20250514", max_tokens:2000, messages:[{
      role:"user",
      content:`Analise os leads VIVAI Studio e retorne APENAS JSON:\n{"scores":{"<id>":{"score":<0-100>,"temp":"<quente|morno|frio>","summary":"<frase curta>"}}}\nquente>=65 morno=35-64 frio<35\nLeads:${JSON.stringify(active)}`
    }]});
    const raw = r.content.find(b=>b.type==="text")?.text||"{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g,"").trim());
    const scores = {};
    Object.entries(parsed.scores||{}).forEach(([k,v])=>{ scores[Number(k)]=v; });
    res.json({ scores });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── WhatsApp ──────────────────────────────────────────────────────────────────
const twilio = require("twilio");
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.post("/webhook/whatsapp", async (req, res) => {
  const from = req.body.From;
  const message = req.body.Body?.trim() || "";
  const numMedia = parseInt(req.body.NumMedia||"0",10);
  if (!from) return res.status(400).send("Bad Request");
  const mediaList = [];
  for (let i=0;i<numMedia;i++) mediaList.push({ url:req.body[`MediaUrl${i}`], contentType:req.body[`MediaContentType${i}`] });
  console.log(`📩 [${from}]: ${message||"(sem texto)"}${mediaList.length?` + ${mediaList.length} mídia(s)`:""}`);
  res.set("Content-Type","text/xml");
  res.send("<Response></Response>");
  try {
    const { processMessage } = require("./agent");
    const reply = await processMessage(from, message, mediaList);
    await twilioClient.messages.create({ from:process.env.TWILIO_WHATSAPP_NUMBER, to:from, body:reply });
  } catch (err) {
    console.error("❌ Webhook:", err.message);
    try { await twilioClient.messages.create({ from:process.env.TWILIO_WHATSAPP_NUMBER, to:from, body:"Erro interno. Tente novamente." }); } catch(_){}
  }
});

app.post("/test", async (req, res) => {
  const { userId="test-user", message } = req.body;
  if (!message) return res.status(400).json({ error:"message obrigatório" });
  try {
    const { processMessage } = require("./agent");
    res.json({ reply: await processMessage(userId, message) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
initDB()
  .then(() => app.listen(port, () => {
    console.log(`\n🌿 VIVAI Agent rodando na porta ${port}`);
    console.log(`   Webhook: POST /webhook/whatsapp`);
    console.log(`   Teste:   POST /test\n`);
  }))
  .catch(err => { console.error("❌ Banco:", err.message); process.exit(1); });
