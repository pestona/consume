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
