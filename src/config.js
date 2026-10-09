import { getGuildConfigRaw, setGuildConfigRaw } from "./db.js";

export const DEFAULT_KONTRAKT_RULES =
  "Здесь будут правила контрактов.\n\nЗадайте текст в панели бота: Контракты → Текст правил.";

export const DEFAULT_NOVA_PANEL_TEXT =
  "После подачи заявка отправляется на рассмотрение персоналу.\n" +
  "> В среднем заявки обрабатываются в течение 1–2 дней\n\n" +
  "Следите за статусом набора.\n" +
  "**Если возможности заполнить заявку нет — набор закрыт.**\n" +
  "Каждое открытие набора сопровождается тегами в этом канале.\n" +
  "> В случае отказа можете подать заявку повторно через {cooldown} дн.\n\n" +
  "**Статус набора:** {status}\n" +
  "**Подать заявку:**";

export const DEFAULT_5RP_PANEL_TEXT =
  "После отправки анкеты создаётся отдельный тикет для рассмотрения.\n" +
  "> В случае отказа повторную заявку можно подать через {cooldown} дн.\n\n" +
  "**RP:** {rp_status}\n" +
  "**VZP:** {vzp_status}\n\n" +
  "**Выберите тип заявки:**";

export const MAX_NOVA_QUESTIONS = 5;

export const DEFAULT_WELCOME_PANEL_TEXT =
  "Приветствуем тебя!\n\n" +
  "Заявку можно подать тут:\n" +
  "**Nova RP** — {nova}\n" +
  "**5 RP** — {5rp}";

export const DEFAULT_NOVA_QUESTIONS = [
  { label: "Возраст", placeholder: "Пример: 18", long: false },
  { label: "Онлайн", placeholder: "Пример: 4-6 часов", long: false },
  { label: "В каких семьях были", placeholder: "Пример: Killa, Kai, Black", long: false },
  { label: "Откат стрельбы", placeholder: "Ссылка на YouTube", long: true },
];

export const DEFAULT_RP_QUESTIONS = [
  { label: "Возраст", placeholder: "Пример: 18", long: false },
  { label: "Онлайн", placeholder: "Пример: 4-6 часов", long: false },
  { label: "Список семей, в которых были", placeholder: "Пример: Killa, Kai, Black", long: false },
  { label: "Откуда узнали о семье Consume", placeholder: "От друга или из рекламы", long: true },
  { label: "Откат стрельбы DM 10.500 урона", placeholder: "Ссылка на YouTube | Нету = academy", long: true },
];

export const DEFAULT_VZP_QUESTIONS = [
  { label: "Возраст", placeholder: "Пример: 18", long: false },
  { label: "Онлайн", placeholder: "Пример: 4-6 часов", long: false },
  { label: "В каких семьях были", placeholder: "Пример: Killa, Kai, Black", long: false },
  { label: "Откат с VZP/DM", placeholder: "Ссылка на YouTube", long: true },
];

export function defaultConfig() {
  return {
    moderatorRoleIds: [],
    panelManagerRoleIds: [],
    panelPublisherRoleIds: [],
    ticketStaffRoleIds: [],
    ticketPingRoleIds: [],
    ticketCategoryId: null,
    ticketGifUrl: null,
    ticketPanelText: DEFAULT_5RP_PANEL_TEXT,
    ticketCooldownDays: 0,
    rpTicketQuestions: DEFAULT_RP_QUESTIONS,
    vzpTicketQuestions: DEFAULT_VZP_QUESTIONS,
    novaTicketCategoryId: null,
    novaTicketStaffRoleIds: [],
    novaTicketPingRoleIds: [],
    novaAcceptRoleId: null,
    novaTicketGifUrl: null,
    novaTicketPanelText: DEFAULT_NOVA_PANEL_TEXT,
    novaTicketCooldownDays: 0,
    novaTicketQuestions: DEFAULT_NOVA_QUESTIONS,
    welcomeGifUrl: null,
    welcomePanelText: DEFAULT_WELCOME_PANEL_TEXT,
    welcomeNovaLinkChannelId: null,
    welcomeRpLinkChannelId: null,
    reactionRoles: [],
    reactionRolePanelText:
      "Нажмите на реакцию под сообщением, чтобы получить роль. Уберите реакцию, чтобы снять её.",
    acceptRoleIdsAcademy: [],
    acceptRoleIdsMain: [],
    botActionLogChannelId: null,
    modLogChannelId: null,
    leaveLogChannelId: null,
    leaveLogPingRoleId: null,
    leaveLogTrackRoleIds: [],
    leaveLogIncludeNoRoles: true,
    sborAccessRoleIds: [],
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
    archiveCategoryId: null,
    archiveModRoleIds: [],
    archiveTier1RoleId: null,
    archiveTier2RoleId: null,
    archiveTier3RoleId: null,
    archiveRankLowRoleId: null,
    archiveRankHighRoleId: null,
    archiveRankChainRoleIds: [],
    afkInactiveRoleId: null,
    publishChannelId: null,
    controlMessageId: null,
    adminHubDept: "5rp",
    panelChannels: {
      control: null,
      apps: null,
      maps: null,
      kontrakt: null,
      autopark: null,
      voice: null,
      archive: null,
      afk: null,
      novaApps: null,
      welcome: null,
      reactionRoles: null,
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
  if (!Array.isArray(merged.novaTicketQuestions) || !merged.novaTicketQuestions.length) {
    merged.novaTicketQuestions = DEFAULT_NOVA_QUESTIONS;
  }
  if (!Array.isArray(merged.rpTicketQuestions) || !merged.rpTicketQuestions.length) {
    merged.rpTicketQuestions = DEFAULT_RP_QUESTIONS;
  }
  if (!Array.isArray(merged.vzpTicketQuestions) || !merged.vzpTicketQuestions.length) {
    merged.vzpTicketQuestions = DEFAULT_VZP_QUESTIONS;
  }
  if (!String(merged.novaTicketPanelText || "").trim()) {
    merged.novaTicketPanelText = DEFAULT_NOVA_PANEL_TEXT;
  }
  if (!String(merged.ticketPanelText || "").trim()) {
    merged.ticketPanelText = DEFAULT_5RP_PANEL_TEXT;
  }
  if (!String(merged.welcomePanelText || "").trim()) {
    merged.welcomePanelText = DEFAULT_WELCOME_PANEL_TEXT;
  }
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
