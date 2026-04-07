/**
 * agent.js — Agente VIVAI com Visão, Áudio e Tool Use
 * Processa texto, imagens (prints, cartões, anúncios) e áudios do WhatsApp
 */

const Anthropic = require("@anthropic-ai/sdk");
const crm = require("./crm");
const https = require("https");
const http = require("http");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Histórico por usuário ─────────────────────────────────────────────────────
const conversationHistory = new Map();
function getHistory(userId) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  return conversationHistory.get(userId);
}
function clearHistory(userId) { conversationHistory.set(userId, []); }

// ── Download de mídia do Twilio ───────────────────────────────────────────────
function downloadMedia(url, accountSid, authToken) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    function doRequest(targetUrl, redirectCount) {
      if (redirectCount > 5) return reject(new Error("Too many redirects"));
      const lib = targetUrl.startsWith("https") ? https : http;
      const parsed = new URL(targetUrl);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { "Authorization": `Basic ${auth}` },
        method: "GET",
      };
      lib.request(options, (res) => {
        if ([301, 302, 307].includes(res.statusCode)) {
          return doRequest(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const contentType = res.headers["content-type"] || "";
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType }));
        res.on("error", reject);
      }).on("error", reject).end();
    }

    doRequest(url, 0);
  });
}

// ── Transcrição de áudio via OpenAI Whisper (usando https nativo) ─────────────
async function transcribeAudio(audioBuffer, contentType) {
  if (!process.env.OPENAI_API_KEY) {
    return "[Áudio recebido — adicione OPENAI_API_KEY para transcrição automática]";
  }
  try {
    const ext = contentType?.includes("ogg") ? "ogg"
              : contentType?.includes("mp4") ? "mp4"
              : contentType?.includes("3gpp") ? "3gp" : "mp3";
    const boundary = "----VIVAIBoundary" + Date.now();
    const filename = `audio.${ext}`;

    // Montar multipart/form-data manualmente
    const parts = [];
    parts.push(Buffer.from(
      `--${boundary}
` +
      `Content-Disposition: form-data; name="model"

whisper-1
`
    ));
    parts.push(Buffer.from(
      `--${boundary}
` +
      `Content-Disposition: form-data; name="language"

pt
`
    ));
    parts.push(Buffer.from(
      `--${boundary}
` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"
` +
      `Content-Type: ${contentType || "audio/ogg"}

`
    ));
    parts.push(audioBuffer);
    parts.push(Buffer.from(`
--${boundary}--
`));

    const body = Buffer.concat(parts);

    return new Promise((resolve) => {
      const options = {
        hostname: "api.openai.com",
        path: "/v1/audio/transcriptions",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            console.log("🎤 Resposta Whisper:", JSON.stringify(data).substring(0, 200));
            resolve(data.text || "[Áudio recebido mas sem conteúdo identificado]");
          } catch (e) {
            resolve("[Erro ao interpretar resposta do Whisper]");
          }
        });
      });
      req.on("error", (e) => {
        console.error("Erro Whisper:", e.message);
        resolve("[Erro de conexão com Whisper]");
      });
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error("Erro na transcrição:", err.message);
    return "[Erro ao transcrever áudio]";
  }
}

// ── Ferramentas do CRM ────────────────────────────────────────────────────────
const CRM_TOOLS = [
  {
    name: "listar_clientes",
    description: "Lista os clientes do CRM. Pode filtrar por nome ou empresa.",
    input_schema: { type: "object", properties: { busca: { type: "string" } } },
  },
  {
    name: "adicionar_cliente",
    description: "Adiciona um novo cliente ao CRM.",
    input_schema: {
      type: "object",
      properties: {
        name:    { type: "string", description: "Nome completo" },
        email:   { type: "string" },
        phone:   { type: "string" },
        company: { type: "string" },
        stage:   { type: "string", enum: ["Lead", "Qualificado", "Proposta", "Negociação", "Fechado"] },
        value:   { type: "number" },
        tags:    { type: "array", items: { type: "string" } },
      },
      required: ["name"],
    },
  },
  {
    name: "atualizar_etapa",
    description: "Atualiza a etapa do pipeline de um cliente.",
    input_schema: {
      type: "object",
      properties: {
        clientName: { type: "string" },
        newStage:   { type: "string", enum: ["Lead", "Qualificado", "Proposta", "Negociação", "Fechado"] },
      },
      required: ["clientName", "newStage"],
    },
  },
  {
    name: "registrar_interacao",
    description: "Registra uma interação com um cliente.",
    input_schema: {
      type: "object",
      properties: {
        clientName: { type: "string" },
        type:       { type: "string", enum: ["Ligação", "E-mail", "Reunião", "WhatsApp", "Visita"] },
        note:       { type: "string" },
        author:     { type: "string" },
      },
      required: ["clientName", "type", "note"],
    },
  },
  {
    name: "listar_tarefas",
    description: "Lista as tarefas pendentes.",
    input_schema: { type: "object", properties: { apenasPendentes: { type: "boolean" } } },
  },
  {
    name: "adicionar_tarefa",
    description: "Cria uma nova tarefa de follow-up.",
    input_schema: {
      type: "object",
      properties: {
        clientName: { type: "string" },
        title:      { type: "string" },
        dueDate:    { type: "string", description: "YYYY-MM-DD" },
        priority:   { type: "string", enum: ["Alta", "Média", "Baixa"] },
        assignee:   { type: "string" },
      },
      required: ["clientName", "title"],
    },
  },
  {
    name: "concluir_tarefa",
    description: "Marca uma tarefa como concluída.",
    input_schema: { type: "object", properties: { taskId: { type: "number" } }, required: ["taskId"] },
  },
  {
    name: "resumo_dashboard",
    description: "Retorna resumo completo do CRM.",
    input_schema: { type: "object", properties: {} },
  },
];

// ── Execução das ferramentas ──────────────────────────────────────────────────
function executeTool(name, input) {
  switch (name) {
    case "listar_clientes": {
      const clients = crm.listClients(input.busca || "");
      if (!clients.length) return "Nenhum cliente encontrado.";
      return clients.map(c => `• *${c.name}* (${c.company||"—"}) | ${c.stage} | R$ ${(c.value||0).toLocaleString("pt-BR")}`).join("\n");
    }
    case "adicionar_cliente": {
      const c = crm.addClient(input);
      return `✅ Cliente *${c.name}* adicionado! ID: ${c.id}`;
    }
    case "atualizar_etapa": {
      const c = crm.updateStage(input.clientName, input.newStage);
      if (!c) return `❌ Cliente "${input.clientName}" não encontrado.`;
      return `✅ *${c.name}* movido para *${c.stage}*.`;
    }
    case "registrar_interacao": {
      const i = crm.addInteraction(input);
      if (!i) return `❌ Cliente "${input.clientName}" não encontrado.`;
      return `✅ Interação registrada para *${i.clientName}* (${i.type}).`;
    }
    case "listar_tarefas": {
      const tasks = crm.listTasks(input.apenasPendentes !== false);
      if (!tasks.length) return "Nenhuma tarefa encontrada.";
      const t = new Date().toISOString().split("T")[0];
      return tasks.map(tk => `${tk.done?"✅":"⏳"}${!tk.done&&tk.dueDate<t?" ⚠️":""} *[${tk.id}]* ${tk.title} — ${tk.clientName} | ${tk.dueDate} | ${tk.priority}`).join("\n");
    }
    case "adicionar_tarefa": {
      const t = crm.addTask(input);
      return `✅ Tarefa *"${t.title}"* criada para ${t.clientName} (vence ${t.dueDate}).`;
    }
    case "concluir_tarefa": {
      const t = crm.completeTask(input.taskId);
      if (!t) return `❌ Tarefa ${input.taskId} não encontrada.`;
      return `✅ Tarefa *"${t.title}"* concluída!`;
    }
    case "resumo_dashboard": {
      const s = crm.getDashboardSummary();
      const fmt = v => `R$ ${v.toLocaleString("pt-BR")}`;
      return [
        `📊 *Resumo VIVAI CRM*`, ``,
        `👥 Clientes: ${s.totalClients}`,
        `💰 Pipeline total: ${fmt(s.totalPipeline)}`,
        `✅ Fechados: ${s.closedDeals} negócios (${fmt(s.closedValue)})`,
        `📋 Tarefas pendentes: ${s.pendingTasks}${s.overdueTasks>0?` (⚠️ ${s.overdueTasks} em atraso)`:""}`,
        `💬 Interações: ${s.totalInteractions}`, ``,
        `*Pipeline por etapa:*`,
        ...s.byStage.map(b => `  › ${b.stage}: ${b.count} clientes (${fmt(b.value)})`),
      ].join("\n");
    }
    default: return `Ferramenta desconhecida: ${name}`;
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente de IA da VIVAI Audiovisual, operando via WhatsApp.
Você tem acesso total ao CRM e capacidade de analisar imagens e textos transcritos de áudio.

QUANDO RECEBER UMA IMAGEM, analise e extraia automaticamente:
- 📱 Prints de conversa (WhatsApp, Instagram, DM): nome do contato, telefone/user, assunto, interesse demonstrado, contexto
- 💼 Cartões de visita: nome, empresa, cargo, telefone, e-mail
- 👤 Perfis de redes sociais (Instagram, LinkedIn, Facebook): nome, empresa, segmento, possível serviço de interesse
- 📢 Anúncios: empresa anunciante, produto/serviço, contato se visível
- 🌐 Sites: nome da empresa, segmento, contato disponível
- 📧 E-mails: remetente, assunto, contexto, próximos passos
- 📝 Anotações escritas: qualquer dado de cliente, tarefa ou follow-up

FLUXO AUTOMÁTICO AO RECEBER IMAGEM:
1. Informe o que identificou na imagem (resumo rápido)
2. Cadastre o cliente no CRM (se ainda não existir)
3. Registre a interação com contexto extraído
4. Crie tarefa de follow-up se houver próximo passo claro
5. Confirme tudo que foi salvo

QUANDO RECEBER ÁUDIO TRANSCRITO:
- Trate como nota de voz com informações de cliente ou tarefa
- Extraia e cadastre dados relevantes automaticamente

REGRAS:
- Se o nome do cliente não estiver claro na imagem, use o nome do perfil/contato visível
- Stage padrão para novos contatos: "Lead"
- Seja conciso — confirme o cadastro em poucas linhas
- Responda sempre em português brasileiro
- Se realmente não conseguir identificar nenhum dado útil, informe o que viu e peça mais contexto

Hoje é: ${new Date().toLocaleDateString("pt-BR", { weekday:"long", year:"numeric", month:"long", day:"numeric" })}`;

// ── Processamento principal ───────────────────────────────────────────────────
async function processMessage(userId, userMessage, mediaList = []) {
  const history = getHistory(userId);

  if (/^(limpar|reiniciar|reset|nova conversa)/i.test(userMessage?.trim())) {
    clearHistory(userId);
    return "🔄 Conversa reiniciada! Como posso ajudar?";
  }

  const content = [];

  // Processar mídias (imagens e áudios)
  console.log(`📦 Total de mídias recebidas: ${mediaList.length}`);
  for (const media of mediaList) {
    console.log(`📎 Mídia: url=${media.url?.substring(0,60)} contentType=${media.contentType}`);
    try {
      const { buffer, contentType } = await downloadMedia(
        media.url,
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );

      const isImage = contentType?.startsWith("image/");
      const isAudio = contentType?.includes("audio") || 
                      contentType?.includes("ogg") || 
                      contentType?.includes("mpeg") ||
                      contentType?.includes("opus") ||
                      contentType?.includes("mp4") ||
                      contentType?.includes("3gpp") ||
                      media.contentType?.includes("audio") ||
                      media.contentType?.includes("ogg");

      if (isAudio) {
        console.log(`🎤 Áudio recebido (${contentType}), transcrevendo...`);
        const transcription = await transcribeAudio(buffer, contentType);
        console.log(`📝 Transcrição: ${transcription.substring(0, 150)}`);
        content.push({ type: "text", text: `[Áudio transcrito do WhatsApp]: ${transcription}` });
      } else if (isImage) {
        const mediaType = contentType.includes("png") ? "image/png"
          : contentType.includes("gif") ? "image/gif"
          : contentType.includes("webp") ? "image/webp" : "image/jpeg";
        content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") } });
        console.log(`🖼️ Imagem recebida (${mediaType}, ${Math.round(buffer.length/1024)}KB)`);
      } else {
        console.log(`❓ Tipo de mídia não reconhecido: ${contentType}`);
      }
    } catch (err) {
      console.error(`❌ Erro ao processar mídia: ${err.message}`);
    }
  }

  // Texto da mensagem
  if (userMessage?.trim()) {
    content.push({ type: "text", text: userMessage });
  }

  // Imagem sem texto → instrução implícita
  if (mediaList.length > 0 && !userMessage?.trim()) {
    content.push({ type: "text", text: "Analise esta imagem e cadastre os dados relevantes no CRM da VIVAI." });
  }

  if (!content.length) content.push({ type: "text", text: "Olá!" });

  history.push({ role: "user", content });

  // Loop agente
  let iterations = 0;
  while (iterations < 6) {
    iterations++;
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: CRM_TOOLS,
      messages: history,
    });

    history.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      return response.content.filter(b => b.type === "text").map(b => b.text).join("");
    }

    if (response.stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`🔧 Tool: ${block.name}`, block.input);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: executeTool(block.name, block.input) });
        }
      }
      history.push({ role: "user", content: toolResults });
      continue;
    }
    break;
  }

  return "Desculpe, não consegui processar. Tente novamente.";
}

module.exports = { processMessage };
