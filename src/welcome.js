import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import { kvGet, kvSet } from "./db.js";
import { DEFAULT_WELCOME_PANEL_TEXT, getConfig } from "./config.js";
import { COLOR_BLUE, logJson } from "./util.js";

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
  if (links.length) container.addActionRowComponents(new ActionRowBuilder().addComponents(...links));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
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
