/**
 * agent.js — Agente de IA da VIVAI com Tool Use
 * Usa Claude claude-sonnet-4-20250514 com ferramentas para operar o CRM
 */

const Anthropic = require("@anthropic-ai/sdk");
const crm = require("./crm");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Histórico de conversa por usuário (em memória — por sessão) ───────────────
const conversationHistory = new Map();

function getHistory(userId) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  return conversationHistory.get(userId);
}

function clearHistory(userId) {
  conversationHistory.set(userId, []);
}

// ── Definição das ferramentas do CRM ──────────────────────────────────────────
const CRM_TOOLS = [
  {
    name: "listar_clientes",
    description: "Lista os clientes do CRM. Pode filtrar por nome ou empresa.",
    input_schema: {
      type: "object",
      properties: {
        busca: { type: "string", description: "Texto para filtrar (opcional)" },
      },
    },
  },
  {
    name: "adicionar_cliente",
    description: "Adiciona um novo cliente ao CRM.",
    input_schema: {
      type: "object",
      properties: {
        name:    { type: "string", description: "Nome completo do cliente" },
        email:   { type: "string", description: "E-mail" },
        phone:   { type: "string", description: "Telefone" },
        company: { type: "string", description: "Empresa" },
        stage:   { type: "string", enum: ["Lead", "Qualificado", "Proposta", "Negociação", "Fechado"] },
        value:   { type: "number", description: "Valor estimado do negócio em R$" },
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
        clientName: { type: "string", description: "Nome (ou parte do nome) do cliente" },
        newStage:   { type: "string", enum: ["Lead", "Qualificado", "Proposta", "Negociação", "Fechado"] },
      },
      required: ["clientName", "newStage"],
    },
  },
  {
    name: "registrar_interacao",
    description: "Registra uma interação com um cliente (ligação, reunião, e-mail, WhatsApp, visita).",
    input_schema: {
      type: "object",
      properties: {
        clientName: { type: "string", description: "Nome do cliente" },
        type:       { type: "string", enum: ["Ligação", "E-mail", "Reunião", "WhatsApp", "Visita"] },
        note:       { type: "string", description: "Resumo da interação" },
        author:     { type: "string", description: "Nome de quem está registrando" },
      },
      required: ["clientName", "type", "note"],
    },
  },
  {
    name: "listar_tarefas",
    description: "Lista as tarefas pendentes ou todas as tarefas.",
    input_schema: {
      type: "object",
      properties: {
        apenasPendentes: { type: "boolean", description: "true para mostrar só pendentes" },
      },
    },
  },
  {
    name: "adicionar_tarefa",
    description: "Cria uma nova tarefa de follow-up.",
    input_schema: {
      type: "object",
      properties: {
        clientName: { type: "string", description: "Nome do cliente relacionado" },
        title:      { type: "string", description: "Título da tarefa" },
        dueDate:    { type: "string", description: "Data limite (YYYY-MM-DD)" },
        priority:   { type: "string", enum: ["Alta", "Média", "Baixa"] },
        assignee:   { type: "string", description: "Responsável pela tarefa" },
      },
      required: ["clientName", "title"],
    },
  },
  {
    name: "concluir_tarefa",
    description: "Marca uma tarefa como concluída pelo seu ID.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "number", description: "ID numérico da tarefa" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "resumo_dashboard",
    description: "Retorna um resumo completo do CRM: pipeline, negócios fechados, tarefas.",
    input_schema: { type: "object", properties: {} },
  },
];

// ── Execução das ferramentas ───────────────────────────────────────────────────
function executeTool(name, input) {
  switch (name) {
    case "listar_clientes": {
      const clients = crm.listClients(input.busca || "");
      if (clients.length === 0) return "Nenhum cliente encontrado.";
      return clients
        .map(
          (c) =>
            `• *${c.name}* (${c.company || "—"}) | ${c.stage} | R$ ${c.value?.toLocaleString("pt-BR") || 0}`
        )
        .join("\n");
    }

    case "adicionar_cliente": {
      const c = crm.addClient(input);
      return `✅ Cliente *${c.name}* adicionado com sucesso! ID: ${c.id}`;
    }

    case "atualizar_etapa": {
      const c = crm.updateStage(input.clientName, input.newStage);
      if (!c) return `❌ Cliente "${input.clientName}" não encontrado.`;
      return `✅ *${c.name}* movido para *${c.stage}* no pipeline.`;
    }

    case "registrar_interacao": {
      const i = crm.addInteraction(input);
      if (!i) return `❌ Cliente "${input.clientName}" não encontrado.`;
      return `✅ Interação registrada para *${i.clientName}* (${i.type}).`;
    }

    case "listar_tarefas": {
      const tasks = crm.listTasks(input.apenasPendentes !== false);
      if (tasks.length === 0) return "Nenhuma tarefa encontrada.";
      const today = new Date().toISOString().split("T")[0];
      return tasks
        .map((t) => {
          const overdue = !t.done && t.dueDate < today ? "⚠️ " : "";
          const status = t.done ? "✅" : "⏳";
          return `${status} ${overdue}*[${t.id}]* ${t.title} — ${t.clientName} | ${t.dueDate} | ${t.priority}`;
        })
        .join("\n");
    }

    case "adicionar_tarefa": {
      const t = crm.addTask(input);
      return `✅ Tarefa *"${t.title}"* criada para ${t.clientName} (vence em ${t.dueDate}).`;
    }

    case "concluir_tarefa": {
      const t = crm.completeTask(input.taskId);
      if (!t) return `❌ Tarefa ID ${input.taskId} não encontrada.`;
      return `✅ Tarefa *"${t.title}"* marcada como concluída!`;
    }

    case "resumo_dashboard": {
      const s = crm.getDashboardSummary();
      const fmt = (v) => `R$ ${v.toLocaleString("pt-BR")}`;
      const pipeline = s.byStage
        .map((b) => `  › ${b.stage}: ${b.count} clientes (${fmt(b.value)})`)
        .join("\n");
      return [
        `📊 *Resumo VIVAI CRM*`,
        ``,
        `👥 Clientes: ${s.totalClients}`,
        `💰 Pipeline total: ${fmt(s.totalPipeline)}`,
        `✅ Fechados: ${s.closedDeals} negócios (${fmt(s.closedValue)})`,
        `📋 Tarefas pendentes: ${s.pendingTasks}${s.overdueTasks > 0 ? ` (⚠️ ${s.overdueTasks} em atraso)` : ""}`,
        `💬 Interações registradas: ${s.totalInteractions}`,
        ``,
        `*Pipeline por etapa:*`,
        pipeline,
      ].join("\n");
    }

    default:
      return `Ferramenta desconhecida: ${name}`;
  }
}

// ── Prompt do sistema ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente de IA da VIVAI, uma empresa especializada em soluções de crescimento.
Você opera via WhatsApp e tem acesso total ao CRM da empresa.

Suas responsabilidades:
- Consultar e atualizar clientes no pipeline
- Registrar interações e follow-ups
- Gerenciar tarefas da equipe
- Dar resumos rápidos do dashboard

Estilo de comunicação:
- Seja conciso, objetivo e amigável
- Use emojis com moderação para tornar as mensagens mais legíveis
- Responda sempre em português brasileiro
- Para ações no CRM, confirme o que foi feito de forma clara
- Se não tiver informações suficientes para executar uma ação, peça o mínimo necessário

Hoje é: ${new Date().toLocaleDateString("pt-BR", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;

// ── Função principal de processamento ────────────────────────────────────────
async function processMessage(userId, userMessage) {
  const history = getHistory(userId);

  // Limpar histórico se o usuário pedir
  if (/^(limpar|reiniciar|reset|nova conversa)/i.test(userMessage.trim())) {
    clearHistory(userId);
    return "🔄 Conversa reiniciada! Como posso ajudar?";
  }

  history.push({ role: "user", content: userMessage });

  // Loop de tool use (agente autônomo)
  let iterations = 0;
  const MAX_ITER = 5;

  while (iterations < MAX_ITER) {
    iterations++;

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: CRM_TOOLS,
      messages: history,
    });

    // Adicionar resposta ao histórico
    history.push({ role: "assistant", content: response.content });

    // Resposta final sem mais ferramentas
    if (response.stop_reason === "end_turn") {
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      return text;
    }

    // Processar tool_use
    if (response.stop_reason === "tool_use") {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`🔧 Tool: ${block.name}`, block.input);
          const result = executeTool(block.name, block.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      // Adicionar resultados ao histórico
      history.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  return "Desculpe, não consegui processar sua solicitação. Tente novamente.";
}

module.exports = { processMessage };
