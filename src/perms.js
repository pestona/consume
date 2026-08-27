import { getConfig, roleIdsOrModeration } from "./config.js";
import { hasAnyRole, isGuildManager, resolveMember } from "./util.js";

export async function canEditSettings(interaction) {
  const member = await resolveMember(interaction);
  if (!member) return false;
  return isGuildManager(member);
}

export async function canOpenPanel(interaction) {
  const member = await resolveMember(interaction);
  if (!member) return false;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(interaction.guildId);
  return hasAnyRole(member, cfg.moderatorRoleIds);
}

export async function canModerate(interaction) {
  return canOpenPanel(interaction);
}

export async function canHandleTicket(interaction) {
  const member = await resolveMember(interaction);
  if (!member) return false;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(interaction.guildId);
  if (hasAnyRole(member, cfg.ticketStaffRoleIds)) return true;
  return hasAnyRole(member, cfg.moderatorRoleIds);
}

export async function canSpam(interaction) {
  const member = await resolveMember(interaction);
  if (!member) return false;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(interaction.guildId);
  return hasAnyRole(member, cfg.spamCommandRoleIds);
}

export async function canPostKontrakt(interaction) {
  const member = await resolveMember(interaction);
  if (!member) return false;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(interaction.guildId);
  return hasAnyRole(member, roleIdsOrModeration(cfg, cfg.kontraktPostRoleIds));
}

export async function canManageKontrakt(interaction) {
  const member = await resolveMember(interaction);
  if (!member) return false;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(interaction.guildId);
  return hasAnyRole(member, roleIdsOrModeration(cfg, cfg.kontraktManagerRoleIds));
}

export async function canManageAutopark(interaction) {
  const member = await resolveMember(interaction);
  if (!member) return false;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(interaction.guildId);
  return hasAnyRole(member, cfg.autoparkManagerRoleIds);
}

export function canTriggerRoleMentionDm(member, cfg) {
  if (!cfg.roleMentionDmTriggerRoleIds?.length) return true;
  return hasAnyRole(member, cfg.roleMentionDmTriggerRoleIds);
}

export function mentionWatchMatchesChannel(channel, cfg) {
  const channelId = channel.id;
  const parentId = channel.parentId ?? channel.parent?.id ?? null;
  let categoryId = channel.parentId ?? null;
  if (channel.isThread?.()) {
    categoryId = channel.parent?.parentId ?? channel.parent?.parent?.id ?? null;
  } else {
    categoryId = channel.parentId ?? null;
  }

  const chIds = (cfg.roleMentionDmChannelIds || []).map(String);
  const catIds = (cfg.roleMentionDmCategoryIds || []).map(String);
  if (chIds.length) {
    if (chIds.includes(String(channelId))) return true;
    if (parentId && chIds.includes(String(parentId))) return true;
  }
  if (catIds.length && categoryId && catIds.includes(String(categoryId))) return true;
  return false;
}
