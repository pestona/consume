import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { COLOR_DARK, safeReply } from "./util.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAPS_DIR = path.join(ROOT, "maps_vzp");
const EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

export const VZP_MAP_LABELS = [
  "Байкерка",
  "Большой миррор",
  "Веспуччи",
  "Ветряки",
  "Киностудия",
  "Лесопилка",
  "Маленький миррор",
  "Муравейник",
  "Мусорка",
  "Мясо",
  "Нефть",
  "Палетка",
  "Порт бизвар",
  "Сендик",
  "Стройка",
  "Татушка",
];

function mapImagePaths(num) {
  const paths = [];
  for (const ext of EXTS) {
    const p = path.join(MAPS_DIR, `${num}${ext}`);
    if (fs.existsSync(p)) {
      paths.push(p);
      break;
    }
  }
  if (num === 11) {
    for (const ext of EXTS) {
      const p = path.join(MAPS_DIR, `11_2${ext}`);
      if (fs.existsSync(p)) {
        paths.push(p);
        break;
      }
    }
  }
  return paths;
}

export function buildMapsEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_DARK)
    .setDescription(
      "**Все карты VZP**\n\n" +
        "> **Байкерка | Большой миррор | Веспуччи**\n" +
        "> **Ветряки | Киностудия | Лесопилка |  Маленький миррор**\n" +
        "> **Муравейник | Мусорка | Мясо | Нефть | Палетка **\n" +
        "> **Порт бизвар | Сендик | Стройка | Татушка**\n\n" +
        "**Выбери карту:**\n",
    );
}

export function mapsPanel() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("c:map:select")
      .setPlaceholder("Выбирай")
      .addOptions(
        VZP_MAP_LABELS.map(
          (label, i) => new StringSelectMenuOptionBuilder().setLabel(label.slice(0, 100)).setValue(String(i + 1)),
        ),
      ),
  );
}

export async function handleMapsInteraction(interaction) {
  if (!interaction.isStringSelectMenu() || interaction.customId !== "c:map:select") return false;
  const num = Number(interaction.values[0]);
  const label = VZP_MAP_LABELS[num - 1] || String(num);
  const paths = mapImagePaths(num);
  if (paths.length) {
    await interaction.reply({
      content: `**${label}**`,
      files: paths.map((p) => new AttachmentBuilder(p)),
      ephemeral: true,
    });
  } else {
    let hint = `\`${num}.png\``;
    if (num === 11) hint += " и при необходимости `11_2.png`";
    await safeReply(interaction, `Картинки для **${label}** нет. Положите ${hint} в \`maps_vzp\`.`);
  }
  return true;
}
