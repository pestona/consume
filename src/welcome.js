import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import { kvGet, kvSet } from "./db.js";
import { DEFAULT_WELCOME_PANEL_TEXT, getConfig } from "./config.js";
import { COLOR_BLUE, COLOR_DARK, logJson, MSK } from "./util.js";

function normalizeImageUrl(raw) {
  let s = String(raw || "").trim().replace(/^<|>$/g, "").trim();
  const found = s.match(/https?:\/\/[^\s<>"'`]+/i);
  if (!found) return null;
  let url = found[0].replace(/[),.;]+$/g, "");
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return url.slice(0, 2048);
}

function mentionOrDash(id) {
  return id ? `<#${id}>` : "не задан";
}

export function welcomeLinkChannels(cfg) {
  return {
    nova: cfg.welcomeNovaLinkChannelId || cfg.panelChannels?.novaApps || null,
    rp: cfg.welcomeRpLinkChannelId || cfg.panelChannels?.apps || null,
  };
}

function linkButtons(guildId, nova, rp) {
  const links = [];
  if (nova) {
    links.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Nova RP")
        .setURL(`https://discord.com/channels/${guildId}/${nova}`),
    );
  }
  if (rp) {
    links.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("5 RP")
        .setURL(`https://discord.com/channels/${guildId}/${rp}`),
    );
  }
  return links;
}

function joinStamp(date = new Date()) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MSK,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function panelsStore() {
  const data = kvGet("welcomePanels") || {};
  data.byGuild = data.byGuild && typeof data.byGuild === "object" ? data.byGuild : {};
  return data;
}

function savePanels(data) {
  kvSet("welcomePanels", { byGuild: data.byGuild });
}

export function registerWelcomePanel(guildId, channelId, messageId) {
  const data = panelsStore();
  const gid = String(guildId);
  const list = Array.isArray(data.byGuild[gid]) ? data.byGuild[gid] : [];
  const mid = String(messageId);
  data.byGuild[gid] = [
    ...list.filter((p) => String(p.messageId) !== mid),
    { channelId: String(channelId), messageId: mid },
  ].slice(-20);
  savePanels(data);
}

export function welcomePanelPayload(guildId) {
  const cfg = getConfig(guildId);
  const { nova, rp } = welcomeLinkChannels(cfg);
  const gif = normalizeImageUrl(cfg.welcomeGifUrl);
  const raw = String(cfg.welcomePanelText || DEFAULT_WELCOME_PANEL_TEXT);
  const body =
    `## Приветствие\n` +
    raw
      .replaceAll("{nova}", mentionOrDash(nova))
      .replaceAll("{5rp}", mentionOrDash(rp))
      .replaceAll("{rp}", mentionOrDash(rp))
      .slice(0, 3500);

  const container = new ContainerBuilder().setAccentColor(COLOR_BLUE);
  if (gif) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(gif)),
    );
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));

  const links = linkButtons(guildId, nova, rp);
  if (links.length) container.addActionRowComponents(new ActionRowBuilder().addComponents(...links));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function welcomeJoinPayload(member) {
  const guild = member.guild;
  const cfg = getConfig(guild.id);
  const { nova, rp } = welcomeLinkChannels(cfg);
  const gif = normalizeImageUrl(cfg.welcomeGifUrl);
  const name = member.user?.username || member.displayName || member.id;
  const embed = new EmbedBuilder()
    .setColor(COLOR_DARK)
    .setTitle(`Приветствуем тебя, @${name}!`)
    .setDescription(`Добро пожаловать на сервер **${guild.name}**!`)
    .setFooter({ text: `ID участника: ${member.id} • ${joinStamp()}` });
  if (gif) embed.setImage(gif);

  const lines = [`Приветствую тебя, <@${member.id}>! Подать заявку в семью можно тут:`];
  if (nova) lines.push(`**Nova RP** — <#${nova}>`);
  if (rp) lines.push(`**5 RP** — <#${rp}>`);
  const links = linkButtons(guild.id, nova, rp);

  return {
    embed: { embeds: [embed] },
    followUp: {
      content: lines.join("\n"),
      components: links.length ? [new ActionRowBuilder().addComponents(...links)] : [],
    },
  };
}

export async function onMemberJoinWelcome(member) {
  if (!member?.guild || member.user?.bot) return;
  const cfg = getConfig(member.guild.id);
  const channelId = cfg.welcomeJoinChannelId || cfg.panelChannels?.welcome || null;
  if (!channelId) return;
  const channel =
    member.guild.channels.cache.get(String(channelId)) ||
    (await member.guild.channels.fetch(String(channelId)).catch(() => null));
  if (!channel?.isTextBased?.()) return;

  const payload = welcomeJoinPayload(member);
  try {
    await channel.send(payload.embed);
    await channel.send(payload.followUp);
  } catch (err) {
    logJson("WARN", "welcome join не отправлен", {
      guildId: member.guild.id,
      channelId,
      error: String(err),
    });
  }
}

export async function refreshWelcomePanels(client, guildId) {
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) return;
  const data = panelsStore();
  const list = Array.isArray(data.byGuild[String(guildId)]) ? data.byGuild[String(guildId)] : [];
  const payload = welcomePanelPayload(guildId);
  let changed = false;
  const next = [];
  for (const panel of list) {
    const ch = guild.channels.cache.get(panel.channelId);
    if (!ch?.isTextBased?.()) {
      changed = true;
      continue;
    }
    try {
      const msg = await ch.messages.fetch(panel.messageId);
      await msg.edit({ content: null, embeds: [], ...payload });
      next.push(panel);
    } catch (err) {
      if (err?.code === 10008 || err?.code === 50001) changed = true;
      else next.push(panel);
    }
  }
  if (changed || next.length !== list.length) {
    data.byGuild[String(guildId)] = next;
    savePanels(data);
  }
}
