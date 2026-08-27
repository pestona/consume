import { getGuildConfigRaw, setGuildConfigRaw } from "./db.js";

export const DEFAULT_KONTRAKT_RULES =
  "Здесь будут правила контрактов.\n\nЗадайте текст в панели бота: Настройки → Тексты и время.";

export function defaultConfig() {
  return {
    moderatorRoleIds: [],
    ticketStaffRoleIds: [],
    ticketPingRoleIds: [],
    ticketCategoryId: null,
    acceptRoleIdsAcademy: [],
    acceptRoleIdsMain: [],
    botActionLogChannelId: null,
    roleMentionDmTargetRoleIds: [],
    roleMentionDmCategoryIds: [],
    roleMentionDmChannelIds: [],
    roleMentionDmTriggerRoleIds: [],
    dailyRolePingChannelId: null,
    dailyRolePingRoleId: null,
    dailyRolePingIntervalHours: 23,
    dailyRolePingMessage: "",
    dailyRolePingTimes: "",
    dailyRolePingTimezone: "Europe/Moscow",
    kontraktChannelId: null,
    kontraktPostRoleIds: [],
    kontraktManagerRoleIds: [],
    kontraktNewContractPingRoleIds: [],
    kontraktRulesText: DEFAULT_KONTRAKT_RULES,
    spamCommandRoleIds: [],
    autoparkManagerRoleIds: [],
    autoparkReserveMinutes: 60,
    publishChannelId: null,
    controlMessageId: null,
    panelChannels: {
      control: null,
      apps: null,
      maps: null,
      kontrakt: null,
      autopark: null,
    },
  };
}

export function getConfig(guildId) {
  const raw = getGuildConfigRaw(guildId);
  const base = defaultConfig();
  const merged = { ...base, ...(raw && typeof raw === "object" ? raw : {}) };
  merged.panelChannels = {
    ...base.panelChannels,
    ...(raw?.panelChannels && typeof raw.panelChannels === "object" ? raw.panelChannels : {}),
  };
  return merged;
}

export function setConfig(guildId, patch) {
  const cur = getConfig(guildId);
  const next = { ...cur, ...patch };
  if (patch.panelChannels && typeof patch.panelChannels === "object") {
    next.panelChannels = { ...cur.panelChannels, ...patch.panelChannels };
  }
  setGuildConfigRaw(guildId, next);
  return next;
}

export function roleIdsOrModeration(cfg, ids) {
  return ids?.length ? ids.map(String) : (cfg.moderatorRoleIds || []).map(String);
}

export function parseDailyTimes(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw || "").split(",")) {
    const bit = part.trim();
    if (!bit) continue;
    const m = bit.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    const key = `${h}:${min}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push([h, min]);
    }
  }
  return out;
}
