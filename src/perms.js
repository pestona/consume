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

/** Кто может /сбор и управлять сборами. Пустой список = как модераторы бота. */
export async function canUseSbor(interaction) {
  const member = await resolveMember(interaction);
  if (!member) return false;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(interaction.guildId);
  const ids = cfg.sborAccessRoleIds?.length ? cfg.sborAccessRoleIds : cfg.moderatorRoleIds;
  return hasAnyRole(member, ids);
}

export function memberCanUseSbor(member, guildId) {
  if (!member) return false;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(guildId);
  const ids = cfg.sborAccessRoleIds?.length ? cfg.sborAccessRoleIds : cfg.moderatorRoleIds;
  return hasAnyRole(member, ids);
}

export async function canHandleTicket(interaction) {
  const member = await resolveMember(interaction);
  if (!member) return false;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(interaction.guildId);
  if (hasAnyRole(member, cfg.ticketStaffRoleIds)) return true;
  if (hasAnyRole(member, cfg.novaTicketStaffRoleIds)) return true;
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
