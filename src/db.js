import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "bot.json");
const DB_TMP = path.join(DATA_DIR, "bot.json.tmp");
const DB_BAK = path.join(DATA_DIR, "bot.json.bak");

const empty = () => ({
  kv: {},
  contracts: {},
  autoparkCars: {},
  autoparkPanels: {},
  guildConfig: {},
  sbors: {},
});

let state = empty();

function normalize(parsed) {
  const next = { ...empty(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
  next.kv = next.kv && typeof next.kv === "object" ? next.kv : {};
  next.contracts = next.contracts && typeof next.contracts === "object" ? next.contracts : {};
  next.autoparkCars =
    next.autoparkCars && typeof next.autoparkCars === "object" ? next.autoparkCars : {};
  next.autoparkPanels =
    next.autoparkPanels && typeof next.autoparkPanels === "object" ? next.autoparkPanels : {};
  next.guildConfig =
    next.guildConfig && typeof next.guildConfig === "object" ? next.guildConfig : {};
  next.sbors = next.sbors && typeof next.sbors === "object" ? next.sbors : {};
  return next;
}

function tryRead(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

function load() {
  const primary = tryRead(DB_PATH);
  if (primary) {
    state = primary;
    return;
  }
  const bak = tryRead(DB_BAK);
  if (bak) {
    state = bak;
    console.error("[WARN] bot.json повреждён — восстановлен из bot.json.bak");
    save();
    return;
  }
  state = empty();
  if (!fs.existsSync(DB_PATH)) save();
  else console.error("[ERROR] bot.json повреждён и бэкапа нет — стартую с пустым state (файл не затёр)");
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const body = JSON.stringify(state);
  fs.writeFileSync(DB_TMP, body);
  try {
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, DB_BAK);
  } catch {
    /* ignore backup errors */
  }
  fs.renameSync(DB_TMP, DB_PATH);
}

load();

export function kvGet(key) {
  const v = state.kv[key];
  return v && typeof v === "object" ? v : null;
}

export function kvSet(key, value) {
  state.kv[key] = value;
  save();
}

export function getGuildConfigRaw(guildId) {
  return state.guildConfig[String(guildId)] || null;
}

export function setGuildConfigRaw(guildId, cfg) {
  state.guildConfig[String(guildId)] = cfg;
  save();
}

export function getContract(messageId) {
  return state.contracts[String(messageId)] || null;
}

export function setContract(messageId, data) {
  state.contracts[String(messageId)] = data;
  save();
}

export function getAllSbors() {
  return { ...state.sbors };
}

export function getSbor(messageId) {
  return state.sbors[String(messageId)] || null;
}

export function setSbor(messageId, data) {
  state.sbors[String(messageId)] = data;
  save();
}

export function deleteSbor(messageId) {
  delete state.sbors[String(messageId)];
  save();
}

function carKey(guildId, carKeyId) {
  return `${guildId}:${carKeyId}`;
}

export function listAutoparkCars(guildId) {
  const prefix = `${guildId}:`;
  return Object.entries(state.autoparkCars)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v)
    .sort((a, b) => String(a.label).localeCompare(String(b.label), "ru"));
}

export function getAutoparkCar(guildId, key) {
  return state.autoparkCars[carKey(guildId, key)] || null;
}

export function upsertAutoparkCar(guildId, car) {
  state.autoparkCars[carKey(guildId, car.key)] = car;
  save();
}

export function deleteAutoparkCar(guildId, key) {
  const k = carKey(guildId, key);
  const existed = Boolean(state.autoparkCars[k]);
  delete state.autoparkCars[k];
  if (existed) save();
  return existed;
}

export function registerAutoparkPanel(guildId, channelId, messageId) {
  state.autoparkPanels[String(messageId)] = {
    guildId: String(guildId),
    channelId: String(channelId),
    messageId: String(messageId),
  };
  save();
}

export function listAutoparkPanels(guildId) {
  const gid = String(guildId);
  return Object.values(state.autoparkPanels).filter((p) => p.guildId === gid);
}

export function removeAutoparkPanel(messageId) {
  delete state.autoparkPanels[String(messageId)];
  save();
}

export function allAutoparkCarsEntries() {
  return Object.entries(state.autoparkCars);
}
