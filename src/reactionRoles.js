import { EmbedBuilder } from "discord.js";
import { getConfig } from "./config.js";
import { kvGet, kvSet } from "./db.js";
import { COLOR_BLUE, logJson, withLock } from "./util.js";

export const MAX_REACTION_ROLES = 20;

function panelsStore() {
  const data = kvGet("reactionRolePanels") || {};
  data.byGuild = data.byGuild && typeof data.byGuild === "object" ? data.byGuild : {};
  return data;
}

function savePanels(data) {
  kvSet("reactionRolePanels", { byGuild: data.byGuild });
}

export function reactionRoleItems(cfg) {
  const source = Array.isArray(cfg?.reactionRoles) ? cfg.reactionRoles : [];
  return source
    .map((item) => ({
      emoji: String(item?.emoji || "").trim(),
      emojiKey: String(item?.emojiKey || "").trim(),
      roleId: String(item?.roleId || "").trim(),
      label: String(item?.label || "").trim().slice(0, 80),
    }))
    .filter((item) => item.emoji && item.emojiKey && item.roleId)
    .slice(0, MAX_REACTION_ROLES);
}

export function parseReactionEmoji(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  const custom = value.match(/^<a?:([A-Za-z0-9_]+):(\d{15,25})>$/);
  if (custom) {
    return {
      emoji: value,
      emojiKey: `id:${custom[2]}`,
      reactValue: custom[2],
    };
  }
  if (/^\d{15,25}$/.test(value)) {
    return {
      emoji: `<:emoji:${value}>`,
      emojiKey: `id:${value}`,
      reactValue: value,
    };
  }

  const chars = [...value];
  const looksLikeEmoji =
    /\p{Extended_Pictographic}/u.test(value) ||
    /\p{Regional_Indicator}/u.test(value) ||
    /[0-9#*]\uFE0F?\u20E3/u.test(value);
  if (!chars.length || chars.length > 16 || !looksLikeEmoji) return null;
  return {
    emoji: value,
    emojiKey: `unicode:${value}`,
    reactValue: value,
  };
}

function reactionKey(reaction) {
  return reaction.emoji?.id
    ? `id:${reaction.emoji.id}`
    : `unicode:${String(reaction.emoji?.name || "")}`;
}

export function reactionRolePanelEmbed(guildId) {
  const cfg = getConfig(guildId);
  const items = reactionRoleItems(cfg);
  const lines = items.map(
    (item) => `${item.emoji} — ${item.label || `<@&${item.roleId}>`} · <@&${item.roleId}>`,
  );
  return new EmbedBuilder()
    .setColor(COLOR_BLUE)
    .setTitle("Автоматическая выдача ролей")
    .setDescription(
      `${String(cfg.reactionRolePanelText || "Нажмите на реакцию под сообщением, чтобы получить роль. Уберите реакцию, чтобы снять её.").slice(0, 2500)}\n\n` +
        (lines.length ? lines.join("\n").slice(0, 1500) : "Роли пока не настроены."),
    );
}

async function addPanelReactions(message, items) {
  for (const item of items) {
    const parsed = parseReactionEmoji(item.emoji);
    if (!parsed) continue;
    await message.react(parsed.reactValue);
  }
}

export async function publishReactionRolePanel(channel, guildId) {
  const items = reactionRoleItems(getConfig(guildId));
  if (!items.length) throw new Error("Сначала добавьте хотя бы одну автороль.");
  const message = await channel.send({
    embeds: [reactionRolePanelEmbed(guildId)],
    allowedMentions: { parse: [] },
  });
  await addPanelReactions(message, items);
  registerReactionRolePanel(guildId, channel.id, message.id);
  return message;
}

export function registerReactionRolePanel(guildId, channelId, messageId) {
  const data = panelsStore();
  const gid = String(guildId);
  const list = Array.isArray(data.byGuild[gid]) ? data.byGuild[gid] : [];
  const mid = String(messageId);
  data.byGuild[gid] = [
    ...list.filter((panel) => String(panel.messageId) !== mid),
    { channelId: String(channelId), messageId: mid },
  ].slice(-20);
  savePanels(data);
}

function isReactionRolePanel(guildId, messageId) {
  const list = panelsStore().byGuild[String(guildId)];
  return Array.isArray(list) && list.some((panel) => String(panel.messageId) === String(messageId));
}

export async function refreshReactionRolePanels(client, guildId) {
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) return;
  const data = panelsStore();
  const list = Array.isArray(data.byGuild[String(guildId)]) ? data.byGuild[String(guildId)] : [];
  const items = reactionRoleItems(getConfig(guildId));
  const next = [];
  for (const panel of list) {
    const channel = guild.channels.cache.get(String(panel.channelId));
    if (!channel?.isTextBased?.()) continue;
    try {
      const message = await channel.messages.fetch(String(panel.messageId));
      await message.edit({ embeds: [reactionRolePanelEmbed(guildId)] });
      await addPanelReactions(message, items);
      next.push(panel);
    } catch (err) {
      if (err?.code !== 10008 && err?.code !== 50001) {
        next.push(panel);
        logJson("WARN", "reaction roles refresh", { guildId, error: String(err) });
      }
    }
  }
  if (next.length !== list.length) {
    data.byGuild[String(guildId)] = next;
    savePanels(data);
  }
}

export async function onReactionRole(reaction, user, added) {
  if (!user || user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const message = reaction.message;
  if (!message?.guild || !isReactionRolePanel(message.guild.id, message.id)) return;

  const item = reactionRoleItems(getConfig(message.guild.id)).find(
    (candidate) => candidate.emojiKey === reactionKey(reaction),
  );
  if (!item) return;

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  const role = message.guild.roles.cache.get(item.roleId);
  if (!member || !role || role.managed) {
    if (added) await reaction.users.remove(user.id).catch(() => null);
    return;
  }

  await withLock(`reaction-role:${message.guild.id}:${user.id}:${role.id}`, async () => {
    try {
      if (added) await member.roles.add(role, "Автороль по реакции");
      else await member.roles.remove(role, "Снятие автороли по реакции");
    } catch (err) {
      logJson("ERROR", "reaction role change", {
        guildId: message.guild.id,
        userId: user.id,
        roleId: role.id,
        added,
        error: String(err),
      });
      if (added) await reaction.users.remove(user.id).catch(() => null);
    }
  });
}
