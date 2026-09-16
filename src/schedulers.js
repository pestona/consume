import http from "node:http";
import { EmbedBuilder } from "discord.js";
import { getConfig } from "./config.js";
import { COLOR_DARK, logJson } from "./util.js";

export function startHealthServerIfNeeded() {
  if (!process.env.FLY_APP_NAME && !process.env.PORT) return;
  const port = Number(process.env.PORT || 8080) || 8080;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  server.listen(port, "0.0.0.0", () => {
    logJson("INFO", `health-check на порту ${port}`);
  });
}

export async function logBotAction(interaction) {
  if (!interaction.guildId || interaction.user?.bot) return;
  if (!interaction.isChatInputCommand?.()) return;
  const cfg = getConfig(interaction.guildId);
  if (!cfg.botActionLogChannelId) return;

  const guild = interaction.guild;
  const logCh = guild?.channels.cache.get(String(cfg.botActionLogChannelId));
  if (!logCh?.isTextBased?.()) return;

  const name = interaction.commandName === "sbor" ? "сбор" : interaction.commandName;
  const detail = actionDetail(interaction);
  const emb = new EmbedBuilder()
    .setColor(COLOR_DARK)
    .setTitle(`Команда /${name}`)
    .addFields(
      { name: "Кто", value: `${interaction.user} (\`${interaction.user.tag}\`)`, inline: false },
      { name: "Где", value: interaction.channelId ? `<#${interaction.channelId}>` : "—", inline: true },
    )
    .setTimestamp(new Date())
    .setFooter({ text: "Лог команд" });
  if (detail) emb.addFields({ name: "Параметры", value: detail.slice(0, 1000), inline: false });

  try {
    await logCh.send({ embeds: [emb] });
  } catch (err) {
    logJson("WARN", "Не удалось отправить лог команды", { error: String(err) });
  }
}

/** Лог изменений / выбора в админке. */
export async function logAdminChange(interaction, title, changes) {
  if (!interaction.guildId || interaction.user?.bot) return;
  const cfg = getConfig(interaction.guildId);
  if (!cfg.botActionLogChannelId) return;
  const logCh = interaction.guild?.channels.cache.get(String(cfg.botActionLogChannelId));
  if (!logCh?.isTextBased?.()) return;

  const lines = Array.isArray(changes) ? changes.filter(Boolean) : [String(changes || "")];
  const emb = new EmbedBuilder()
    .setColor(COLOR_DARK)
    .setTitle(title)
    .addFields(
      { name: "Кто", value: `${interaction.user} (\`${interaction.user.tag}\`)`, inline: false },
      {
        name: "Что изменил / выбрал",
        value: (lines.length ? lines.map((l) => `• ${l}`).join("\n") : "—").slice(0, 1000),
        inline: false,
      },
    )
    .setTimestamp(new Date())
    .setFooter({ text: "Лог админки" });

  try {
    await logCh.send({ embeds: [emb] });
  } catch (err) {
    logJson("WARN", "Не удалось отправить лог админки", { error: String(err) });
  }
}

function actionDetail(interaction) {
  if (interaction.isChatInputCommand?.()) {
    const opts = interaction.options?.data || [];
    if (!opts.length) return null;
    return opts
      .map((o) => {
        const v = o.user || o.role || o.channel || o.value;
        const shown = v?.toString?.() ?? String(v ?? "—");
        return `• **${o.name}:** ${shown}`;
      })
      .join("\n");
  }
  return null;
}
