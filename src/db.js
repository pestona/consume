import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function resolveDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  // Railway volume обычно смонтирован сюда
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
    return "/app/data";
  }
  return path.join(ROOT, "data");
}
export const DATA_DIR = resolveDataDir();
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
  } catch (err) {
    console.error(`[ERROR] не прочитан ${filePath}: ${String(err)}`);
    return null;
  }
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const size = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  console.log(`[INFO] DATA_DIR=${DATA_DIR} bot.json=${size}b cwd=${process.cwd()}`);
  const primary = tryRead(DB_PATH);
  if (primary) {
    state = primary;
    const guilds = Object.keys(state.guildConfig || {}).length;
    console.log(`[INFO] bot.json загружен: guilds=${guilds} kv=${Object.keys(state.kv || {}).length}`);
    return;
  }
  const bak = tryRead(DB_BAK);
  if (bak) {
    state = bak;
    console.error("[WARN] bot.json повреждён — восстановлен из bot.json.bak");
    save({ force: true });
    return;
  }
  state = empty();
  if (!fs.existsSync(DB_PATH)) save({ force: true });
  else console.error("[ERROR] bot.json повреждён и бэкапа нет — стартую с пустым state (файл не затёр)");
  console.log("[WARN] bot.json пустой — старт с чистого state");
}

function save(opts = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const body = JSON.stringify(state);
  // Не затираем свежезалитый больший bot.json урезанным state из RAM
  if (!opts.force && fs.existsSync(DB_PATH)) {
    const diskSize = fs.statSync(DB_PATH).size;
    if (diskSize > body.length * 1.5 && diskSize > 4000) {
      const existing = tryRead(DB_PATH);
      if (existing && Object.keys(existing.guildConfig || {}).length > 0) {
        console.error(
          `[WARN] save() отменён: диск ${diskSize}b > RAM ${body.length}b. Перечитываю bot.json.`,
        );
        state = existing;
        return;
      }
    }
  }
  fs.writeFileSync(DB_TMP, body);
  try {
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, DB_BAK);
  } catch {
    /* ignore backup errors */
  }
  fs.renameSync(DB_TMP, DB_PATH);
}

let lastDiskCheck = 0;
/** Если на volume внезапно появился больший bot.json (после upload) — подхватываем без редеплоя */
export function maybeReloadFromDisk() {
  const now = Date.now();
  if (now - lastDiskCheck < 2000) return;
  lastDiskCheck = now;
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const diskSize = fs.statSync(DB_PATH).size;
    const memSize = JSON.stringify(state).length;
    if (diskSize > memSize * 1.5 && diskSize > 4000) {
      const existing = tryRead(DB_PATH);
      if (existing) {
        state = existing;
        console.log(`[INFO] bot.json перечитан с диска: ${diskSize}b guilds=${Object.keys(state.guildConfig || {}).length}`);
      }
    }
  } catch (err) {
    console.error(`[WARN] maybeReloadFromDisk: ${String(err)}`);
  }
}

load();

export function kvGet(key) {
  maybeReloadFromDisk();
  const v = state.kv[key];
  return v && typeof v === "object" ? v : null;
}

export function kvSet(key, value) {
  maybeReloadFromDisk();
  state.kv[key] = value;
  save();
}

export function getGuildConfigRaw(guildId) {
  maybeReloadFromDisk();
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
