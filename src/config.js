import { getGuildConfigRaw, setGuildConfigRaw } from "./db.js";

export const DEFAULT_KONTRAKT_RULES =
  "Здесь будут правила контрактов.\n\nЗадайте текст в панели бота: Контракты → Текст правил.";

export function defaultConfig() {
  return {
    moderatorRoleIds: [],
    ticketStaffRoleIds: [],
    ticketPingRoleIds: [],
    ticketCategoryId: null,
    acceptRoleIdsAcademy: [],
    acceptRoleIdsMain: [],
    botActionLogChannelId: null,
    modLogChannelId: null,
    leaveLogChannelId: null,
    leaveLogPingRoleId: null,
    familyRoleIds: [],
    tempVoiceCreateChannelId: null,
    tempVoiceCategoryId: null,
    kontraktChannelId: null,
    kontraktPostRoleIds: [],
    kontraktManagerRoleIds: [],
    kontraktNewContractPingRoleIds: [],
    kontraktRulesText: DEFAULT_KONTRAKT_RULES,
    spamCommandRoleIds: [],
    autoparkManagerRoleIds: [],
    autoparkReserveMinutes: 60,
    antinukeEnabled: true,
    antinukeBanLimit: 10,
    antinukeBanWindowSec: 60,
    antinukeChannelDeleteLimit: 8,
    antinukeChannelDeleteWindowSec: 60,
    antinukeWhitelistRoleIds: [],
    antinukeWhitelistUserIds: [],
    publishChannelId: null,
    controlMessageId: null,
    panelChannels: {
      control: null,
      apps: null,
      maps: null,
      kontrakt: null,
      autopark: null,
      voice: null,
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
