/**
 * crm.js — Camada de dados do VIVAI CRM
 * Persiste em crm-data.json (fácil de migrar para DB real depois)
 */

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "crm-data.json");

const INITIAL_DATA = {
  clients: [],
  interactions: [],
  tasks: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(INITIAL_DATA, null, 2));
    return structuredClone(INITIAL_DATA);
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function nextId(list) {
  return list.length === 0 ? 1 : Math.max(...list.map((i) => i.id)) + 1;
}

function today() {
  return new Date().toISOString().split("T")[0];
}

// ── Clients ───────────────────────────────────────────────────────────────────

function listClients(search = "") {
  const db = load();
  const q = search.toLowerCase();
  return q
    ? db.clients.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.company?.toLowerCase().includes(q)
      )
    : db.clients;
}

function getClient(id) {
  const db = load();
  return db.clients.find((c) => c.id === Number(id)) || null;
}

function addClient({ name, email, phone, company, stage = "Lead", value = 0, tags = [] }) {
  const db = load();
  const client = {
    id: nextId(db.clients),
    name,
    email: email || "",
    phone: phone || "",
    company: company || "",
    stage,
    value: Number(value) || 0,
    tags,
    createdAt: today(),
  };
  db.clients.push(client);
  save(db);
  return client;
}

function updateClient(id, fields) {
  const db = load();
  const idx = db.clients.findIndex((c) => c.id === Number(id));
  if (idx === -1) return null;
  db.clients[idx] = { ...db.clients[idx], ...fields };
  save(db);
  return db.clients[idx];
}

function updateStage(clientName, newStage) {
  const db = load();
  const client = db.clients.find((c) =>
    c.name.toLowerCase().includes(clientName.toLowerCase())
  );
  if (!client) return null;
  client.stage = newStage;
  save(db);
  return client;
}

// ── Interactions ──────────────────────────────────────────────────────────────

function listInteractions(clientId = null) {
  const db = load();
  const all = clientId
    ? db.interactions.filter((i) => i.clientId === Number(clientId))
    : db.interactions;
  return all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
}

function addInteraction({ clientName, type, note, author = "Agente IA" }) {
  const db = load();
  const client = db.clients.find((c) =>
    c.name.toLowerCase().includes(clientName.toLowerCase())
  );
  if (!client) return null;
  const interaction = {
    id: nextId(db.interactions),
    clientId: client.id,
    clientName: client.name,
    type,
    note,
    author,
    date: today(),
  };
  db.interactions.push(interaction);
  save(db);
  return interaction;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

function listTasks(onlyPending = true) {
  const db = load();
  const tasks = onlyPending ? db.tasks.filter((t) => !t.done) : db.tasks;
  return tasks.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function addTask({ clientName, title, dueDate, priority = "Média", assignee = "Time" }) {
  const db = load();
  const client = db.clients.find((c) =>
    c.name.toLowerCase().includes(clientName.toLowerCase())
  );
  const task = {
    id: nextId(db.tasks),
    clientId: client?.id || null,
    clientName: client?.name || clientName,
    title,
    dueDate: dueDate || today(),
    priority,
    assignee,
    done: false,
    createdAt: today(),
  };
  db.tasks.push(task);
  save(db);
  return task;
}

function completeTask(taskId) {
  const db = load();
  const task = db.tasks.find((t) => t.id === Number(taskId));
  if (!task) return null;
  task.done = true;
  save(db);
  return task;
}

// ── Dashboard Summary ─────────────────────────────────────────────────────────

function getDashboardSummary() {
  const db = load();
  const totalPipeline = db.clients.reduce((s, c) => s + (c.value || 0), 0);
  const closed = db.clients.filter((c) => c.stage === "Fechado");
  const closedValue = closed.reduce((s, c) => s + (c.value || 0), 0);
  const pendingTasks = db.tasks.filter((t) => !t.done);
  const overdueTasks = pendingTasks.filter((t) => t.dueDate < today());

  const byStage = ["Lead", "Qualificado", "Proposta", "Negociação", "Fechado"].map(
    (stage) => ({
      stage,
      count: db.clients.filter((c) => c.stage === stage).length,
      value: db.clients
        .filter((c) => c.stage === stage)
        .reduce((s, c) => s + (c.value || 0), 0),
    })
  );

  return {
    totalClients: db.clients.length,
    totalPipeline,
    closedValue,
    closedDeals: closed.length,
    pendingTasks: pendingTasks.length,
    overdueTasks: overdueTasks.length,
    totalInteractions: db.interactions.length,
    byStage,
  };
}

module.exports = {
  listClients,
  getClient,
  addClient,
  updateClient,
  updateStage,
  listInteractions,
  addInteraction,
  listTasks,
  addTask,
  completeTask,
  getDashboardSummary,
};
