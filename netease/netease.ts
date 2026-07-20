import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { Message } from "@mtcute/node";
import { logger } from "@utils/logger";
import { sleep } from "@utils/asyncHelpers";
import { htmlEscape } from "@utils/htmlEscape";

// 参考 plugins/music_bot.ts 的结构与实现方式

const prefixes = getPrefixes();

const mainPrefix = prefixes[0];

const bot = "Music163bot"; // 与原实现保持一致（可用 @ 或不带 @）

const pluginName = "netease";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
依赖 @Music163bot

<code>${commandName} 关键词</code> 按关键词搜索并返回音频
<code>${commandName} 链接</code> 解析网易云链接并返回音频
<code>${commandName} ID</code> 通过歌曲ID返回音频

示例：
<code>${commandName} 晴天</code>
<code>${commandName} https://music.163.com/#/song?id=123456</code>
<code>${commandName} 123456</code>
`;

function getRemarkFromMsg(msg: MessageContext | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.text || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}

// 解析网易云链接获取ID
function extractSongId(text: string): string | null {
  const idMatch = text.match(/(?:song\?id=|\/song\/)(\d+)/);
  return idMatch ? idMatch[1] : null;
}

type BotSelection =
  | { kind: "callback"; data: string | Uint8Array }
  | { kind: "text"; text: string };

function messageDateSeconds(message: Message): number {
  const date = message.date;
  if (date && typeof (date as any).getTime === "function") {
    return Math.floor((date as any).getTime() / 1000);
  }
  const numericDate = Number(date || 0);
  if (!Number.isFinite(numericDate)) return 0;
  return numericDate > 1_000_000_000_000
    ? Math.floor(numericDate / 1000)
    : Math.floor(numericDate);
}

function isFreshBotMessage(
  message: Message,
  afterMessageId: number,
  startedAt: number,
): boolean {
  if (message.isOutgoing) return false;
  if (afterMessageId > 0 && Number(message.id) <= afterMessageId) return false;
  return messageDateSeconds(message) >= startedAt;
}

function getFirstBotSelection(message: Message): BotSelection | undefined {
  const highLevelMarkup = (message as any).markup;
  const rawMarkup = (message.raw as any)?.replyMarkup;
  const markupType =
    highLevelMarkup?.type === "inline" || rawMarkup?._ === "replyInlineMarkup"
      ? "inline"
      : highLevelMarkup?.type === "reply" || rawMarkup?._ === "replyKeyboardMarkup"
        ? "reply"
        : undefined;
  const rows = Array.isArray(highLevelMarkup?.buttons)
    ? highLevelMarkup.buttons
    : Array.isArray(rawMarkup?.rows)
      ? rawMarkup.rows.map((row: any) => row?.buttons || [])
      : [];

  if (!markupType) return undefined;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (markupType === "inline") {
        const data = button?.data;
        if (
          typeof data === "string" ||
          Buffer.isBuffer(data) ||
          data instanceof Uint8Array
        ) {
          return { kind: "callback", data };
        }
      } else {
        const text = String(button?.text || "").trim();
        if (text) return { kind: "text", text };
      }
    }
  }
  return undefined;
}

function isAudioMessage(message: Message): boolean {
  const media = message.media as any;
  if (!media) return false;
  if (media.type === "audio") return true;
  const mimeType = String(media.mimeType || media.raw?.mimeType || "");
  if (media.type === "document" && mimeType.startsWith("audio/")) return true;
  const document = (message.raw as any)?.media?.document;
  return Boolean(
    document?.attributes?.some((attribute: any) =>
      String(attribute?._ || attribute?.type || attribute?.className || "")
        .toLowerCase()
        .includes("documentattributeaudio"),
    ),
  );
}

async function ensureBotReady() {
  const client = await getGlobalClient();
  // 解除拉黑
  try {
    await client.call({
      _: "contacts.unblock",
      id: await client.resolvePeer(bot),
    });
  } catch (e: unknown) { logger.warn('[netease] unblock bot failed:', e) }

  // 静音通知
  try {
    const inputPeer = await client.resolvePeer(bot);
    await client.call({
      _: "account.updateNotifySettings",
      peer: { _: "inputNotifyPeer", peer: inputPeer },
      settings: {
        _: "inputPeerNotifySettings",
        silent: true,
        muteUntil: 2147483647,
      },
    });
  } catch (e: unknown) { logger.warn('[netease] mute bot failed:', e) }
}

async function fetchAndSendAudio(
  msg: MessageContext,
  commandToBot: string,
  caption: string,
): Promise<boolean> {
  const client = await getGlobalClient();
  const startedAt = Math.floor(Date.now() / 1000);
  let commandMessage: Message | undefined;

  try {
    commandMessage = await client.sendText(bot, commandToBot) as Message;
  } catch (sendError: unknown) {
    logger.warn("[netease] send command failed, retrying after /start:", sendError);
    try {
      await client.sendText(bot, "/start");
      await sleep(800);
      commandMessage = await client.sendText(bot, commandToBot) as Message;
    } catch (startError: unknown) {
      logger.warn("[netease] retry after /start failed:", startError);
      const fallbackText = commandToBot.replace(/^\/(?:search|music)\s+/, "");
      try {
        commandMessage = await client.sendText(bot, fallbackText) as Message;
      } catch (fallbackError: unknown) {
        await msg.edit({
          text: html(
            "❌ 向机器人发送命令失败：" +
              htmlEscape(
                (fallbackError as { message?: string })?.message ||
                  String(fallbackError),
              ),
          ),
        });
        return false;
      }
    }
  }

  const commandMessageId = Number(commandMessage?.id || 0);
  let replyWithButtons: Message | undefined;
  let selection: BotSelection | undefined;
  let mediaMsg: Message | undefined;

  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(700);
    const messages = await client.getHistory(bot, { limit: 10 });
    for (const candidate of messages.slice().reverse()) {
      if (!isFreshBotMessage(candidate, commandMessageId, startedAt)) continue;
      if (isAudioMessage(candidate)) {
        mediaMsg = candidate;
        break;
      }
      const candidateSelection = getFirstBotSelection(candidate);
      if (candidateSelection) {
        replyWithButtons = candidate;
        selection = candidateSelection;
        break;
      }
    }
    if (mediaMsg || (replyWithButtons && selection)) break;
  }

  if (!mediaMsg && (!replyWithButtons || !selection)) {
    await msg.edit({ text: "❌ 机器人未返回歌曲选择按钮或音乐文件。" });
    return false;
  }

  if (!mediaMsg && replyWithButtons && selection) {
    try {
      if (selection.kind === "callback") {
        await client.getCallbackAnswer({
          chatId: replyWithButtons.chat.id,
          message: replyWithButtons.id,
          data: selection.data,
          fireAndForget: true,
        });
      } else {
        await client.sendText(bot, selection.text);
      }
    } catch (clickError: unknown) {
      logger.warn("[netease] selecting first search result failed:", clickError);
      try {
        await client.sendText(bot, "1");
      } catch (fallbackError: unknown) {
        await msg.edit({
          text: html(
            "❌ 选择第一首歌曲失败：" +
              htmlEscape(
                (fallbackError as { message?: string })?.message ||
                  String(fallbackError),
              ),
          ),
        });
        return false;
      }
    }

    const replyStartedAt = messageDateSeconds(replyWithButtons);
    const afterReplyId = Math.max(0, Number(replyWithButtons.id) - 1);
    for (let attempt = 0; attempt < 50; attempt++) {
      await sleep(700);
      const messages = await client.getHistory(bot, { limit: 10 });
      for (const candidate of messages.slice().reverse()) {
        if (!isFreshBotMessage(candidate, afterReplyId, replyStartedAt)) continue;
        if (isAudioMessage(candidate)) {
          mediaMsg = candidate;
          break;
        }
      }
      if (mediaMsg) break;
    }
  }

  if (!mediaMsg || !mediaMsg.media) {
    await msg.edit({ text: "❌ 已选择歌曲，但机器人未返回音乐文件。" });
    return false;
  }

  try {
    const buffer = await client.downloadAsBuffer(
      mediaMsg.media as Parameters<typeof client.downloadAsBuffer>[0],
    );
    const replyToId = msg.replyToMessage?.id;
    await client.sendMedia(
      msg.chat.id,
      {
        type: "audio",
        file: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
        fileName: "music.mp3",
      } as never,
      {
        caption,
        ...(replyToId ? { replyTo: replyToId } : {}),
      },
    );
    return true;
  } catch (uploadError: unknown) {
    logger.warn("[netease] reupload audio failed, forwarding instead:", uploadError);
    try {
      await client.forwardMessagesById({
        fromChatId: bot,
        messages: [mediaMsg.id],
        toChatId: msg.chat.id,
      });
      return true;
    } catch (forwardError: unknown) {
      logger.warn("[netease] forward message failed:", forwardError);
      await msg.edit({
        text: html(
          "❌ 音乐文件发送失败：" +
            htmlEscape(
              (forwardError as { message?: string })?.message ||
                String(forwardError),
            ),
        ),
      });
      return false;
    }
  }
}
class NeteasePlugin extends Plugin {

  description: string = `\nnetease\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    netease: async (msg: MessageContext) => {
      const keyword = getRemarkFromMsg(msg, 0);

      if (!keyword) {
        await msg.edit({ text: html(help_text) });
        return;
      }

      const client = await getGlobalClient();
      if (!client) return;

      try {
        await msg.edit({
          text: html(`🔎 处理中：<code>${htmlEscape(keyword)}</code>`),
        });
      } catch (e: unknown) { logger.warn('[netease] edit msg failed:', e) }

      await ensureBotReady();

      // 判定命令：ID -> /music，链接 -> 解析ID -> /music，否则 /search
      let commandToBot = `/search ${keyword}`;
      if (/^\d+$/.test(keyword.trim())) {
        commandToBot = `/music ${keyword.trim()}`;
      } else if (keyword.includes("music.163.com")) {
        const id = extractSongId(keyword);
        if (id) commandToBot = `/music ${id}`;
      }

      const caption = `🎵 ${htmlEscape(keyword)}`;
      const sent = await fetchAndSendAudio(msg, commandToBot, caption);
      if (!sent) return;

      try {
        await msg.delete();
      } catch (e: unknown) { logger.warn('[netease] delete msg failed:', e) }
    },
  };
}

export default new NeteasePlugin();
