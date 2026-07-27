import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import {
  Conversation,
  type InputText,
  type Message,
  type TelegramClient,
  type tl,
} from "@mtcute/node";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { logger } from "@utils/logger";
import { sleep } from "@utils/asyncHelpers";

const BOT = "@ParseHubot";
const FIRST_RESPONSE_TIMEOUT_MS = 120_000;
const RESULT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 700;
const RESULT_SETTLE_MS = 5_000;
const MAX_RESULT_MESSAGES = 30;

const prefixes = getPrefixes();
const commandName = `${prefixes[0] || "."}jx`;
const helpText = `
jx

依赖 ${BOT}

${commandName} 待解析内容
将内容交给解析机器人，并把结果无来源复制回当前对话。

示例：${commandName} https://example.com/video
`;

let queueTail: Promise<void> = Promise.resolve();
let pendingRequests = 0;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function getParseInput(msg: MessageContext): InputText | null {
  const source = msg.text || "";
  const command = source.match(/^\S+/u)?.[0];
  if (!command) return null;

  let start = command.length;
  while (start < source.length && /\s/u.test(source[start])) start += 1;

  let end = source.length;
  while (end > start && /\s/u.test(source[end - 1])) end -= 1;
  if (start >= end) return null;

  const text = source.slice(start, end);
  const raw = msg.raw as typeof msg.raw & {
    entities?: tl.TypeMessageEntity[];
  };
  const entities = (raw.entities || []).flatMap((entity) => {
    const overlapStart = Math.max(entity.offset, start);
    const overlapEnd = Math.min(entity.offset + entity.length, end);
    if (overlapStart >= overlapEnd) return [];

    return [
      {
        ...entity,
        offset: overlapStart - start,
        length: overlapEnd - overlapStart,
      } as tl.TypeMessageEntity,
    ];
  });

  return entities.length > 0 ? { text, entities } : text;
}

function getThreadId(msg: MessageContext): number | undefined {
  const threadId = msg.replyToMessage?.threadId;
  return typeof threadId === "number" && threadId > 0 ? threadId : undefined;
}

function isIncomingResult(message: Message, sentMessageId: number): boolean {
  return (
    !message.isOutgoing &&
    !message.isService &&
    Number(message.id) > sentMessageId
  );
}

function isTransientStatus(message: Message): boolean {
  if (message.media || message.richMessage) return false;

  const text = message.text.trim();
  if (!text) return true;
  if (text.length > 120) return false;

  const normalized = text
    .replace(/^[🔍🔎⏳⌛♻️🔄🕐🕑🕒🕓🕔🕕🕖🕗🕘🕙🕚🕛\s]+/u, "")
    .trim();

  if (/^(?:loading|processing)(?:\.{0,3}|…+)?$/iu.test(normalized)) {
    return true;
  }

  if (
    /^(?:正在)?(?:解析|处理)(?:中)?(?:[，,\s]*(?:请稍候|请稍等|稍候|稍等))?[。.！!…\s]*$/u.test(
      normalized,
    )
  ) {
    return true;
  }

  return /^(?:请稍候|请稍等|稍候|稍等)(?:[，,\s]*(?:正在)?(?:解析|处理)(?:中)?)?[。.！!…\s]*$/u.test(
    normalized,
  );
}

function messageFingerprint(message: Message): string {
  const raw = message.raw as typeof message.raw & {
    media?: { _?: string };
    replyMarkup?: { _?: string };
  };
  return JSON.stringify([
    message.id,
    message.editDate?.getTime() || 0,
    message.text,
    message.groupedIdUnique,
    raw.media?._ || "",
    raw.replyMarkup?._ || "",
  ]);
}

async function getBotMessages(
  client: TelegramClient,
  sentMessageId: number,
): Promise<Message[]> {
  const history = await client.getHistory(BOT, {
    minId: sentMessageId,
    limit: MAX_RESULT_MESSAGES,
  });

  return Array.from(history)
    .filter((message) => isIncomingResult(message, sentMessageId))
    .sort((left, right) => Number(left.id) - Number(right.id));
}

async function collectStableResults(
  client: TelegramClient,
  sentMessageId: number,
): Promise<Message[]> {
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  let latestMessages: Message[] = [];
  let lastFingerprint = "";
  let stableSince = 0;

  while (Date.now() < deadline) {
    latestMessages = await getBotMessages(client, sentMessageId);
    const results = latestMessages.filter((message) => !isTransientStatus(message));

    if (results.length > 0) {
      const fingerprint = results.map(messageFingerprint).join("|");
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= RESULT_SETTLE_MS) {
        return results;
      }
    } else {
      lastFingerprint = "";
      stableSince = 0;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const finalResults = latestMessages.filter(
    (message) => !isTransientStatus(message),
  );
  if (finalResults.length > 0) return finalResults;

  throw new Error("解析机器人长时间没有返回可用结果");
}

async function requestParse(
  client: TelegramClient,
  input: InputText,
): Promise<Message[]> {
  const conversation = new Conversation(client, BOT);

  return conversation.with(async () => {
    const sent = await conversation.sendText(input);
    await conversation.waitForResponse(
      (message) => isIncomingResult(message, sent.id),
      {
        message: sent.id,
        timeout: FIRST_RESPONSE_TIMEOUT_MS,
      },
    );

    return collectStableResults(client, sent.id);
  });
}

function groupResults(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  const handled = new Set<number>();

  for (const message of messages) {
    if (handled.has(message.id)) continue;

    const groupedId = message.groupedIdUnique;
    if (!groupedId) {
      handled.add(message.id);
      groups.push([message]);
      continue;
    }

    const group = messages.filter(
      (candidate) => candidate.groupedIdUnique === groupedId,
    );
    for (const item of group) handled.add(item.id);
    groups.push(group);
  }

  return groups;
}

async function copySingleResult(
  client: TelegramClient,
  target: MessageContext,
  result: Message,
): Promise<void> {
  const threadId = getThreadId(target);

  try {
    await client.sendCopy({
      toChatId: target.chat.id,
      message: result,
      ...(threadId ? { threadId } : {}),
    });
    return;
  } catch (copyError: unknown) {
    logger.warn("[jx] sendCopy failed, trying no-author forwarding:", copyError);
  }

  try {
    await client.forwardMessages({
      toChatId: target.chat.id,
      messages: [result],
      noAuthor: true,
      ...(threadId ? { toThreadId: threadId } : {}),
    });
    return;
  } catch (forwardError: unknown) {
    logger.warn("[jx] no-author forwarding failed:", forwardError);
  }

  if (result.text) {
    await client.sendText(target.chat.id, result.textWithEntities, {
      ...(threadId ? { threadId } : {}),
    });
    return;
  }

  throw new Error(`无法无来源复制机器人消息 ${result.id}`);
}

async function copyResultGroup(
  client: TelegramClient,
  target: MessageContext,
  group: Message[],
): Promise<void> {
  if (group.length === 1) {
    await copySingleResult(client, target, group[0]);
    return;
  }

  const threadId = getThreadId(target);
  try {
    await client.sendCopyGroup({
      toChatId: target.chat.id,
      messages: group,
      ...(threadId ? { threadId } : {}),
    });
    return;
  } catch (copyError: unknown) {
    logger.warn(
      "[jx] sendCopyGroup failed, trying no-author forwarding:",
      copyError,
    );
  }

  try {
    await client.forwardMessages({
      toChatId: target.chat.id,
      messages: group,
      noAuthor: true,
      ...(threadId ? { toThreadId: threadId } : {}),
    });
    return;
  } catch (forwardError: unknown) {
    logger.warn("[jx] no-author group forwarding failed:", forwardError);
  }

  for (const result of group) {
    await copySingleResult(client, target, result);
  }
}

async function copyResults(
  client: TelegramClient,
  target: MessageContext,
  results: Message[],
): Promise<void> {
  for (const group of groupResults(results)) {
    await copyResultGroup(client, target, group);
  }
}

function enqueueRequest<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function editStatus(msg: MessageContext, text: string): Promise<void> {
  try {
    await msg.edit({ text });
  } catch (error: unknown) {
    logger.warn("[jx] failed to edit command status:", error);
  }
}

async function handleJx(msg: MessageContext): Promise<void> {
  const input = getParseInput(msg);
  if (!input) {
    await msg.edit({ text: helpText });
    return;
  }

  const queuePosition = pendingRequests + 1;
  pendingRequests += 1;

  if (queuePosition > 1) {
    await editStatus(
      msg,
      `⏳ 已加入解析队列，前面还有 ${queuePosition - 1} 个请求`,
    );
  }

  try {
    await enqueueRequest(async () => {
      await editStatus(msg, `🔎 正在交给 ${BOT} 解析…`);
      const client = await getGlobalClient();
      const results = await requestParse(client, input);
      await copyResults(client, msg, results);

      try {
        await msg.delete();
      } catch (error: unknown) {
        logger.warn("[jx] failed to delete command message:", error);
      }
    });
  } catch (error: unknown) {
    logger.error("[jx] parse failed:", error);
    const reason = getErrorMessage(error).slice(0, 500);
    await editStatus(msg, `❌ 解析失败：${reason}`);
  } finally {
    pendingRequests -= 1;
  }
}

class JxPlugin extends Plugin {
  description: string = helpText;

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    jx: handleJx,
  };
}

export default new JxPlugin();
