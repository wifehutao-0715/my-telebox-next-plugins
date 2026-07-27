/**
 * ai.ts — TeleBox AI 助手
 *
 * 设计要点：
 * - 配置文件 assets/ai/config.json，与面板（src/utils/panel/aiPanelProviders.ts 的 "ai" 设置项）结构兼容，
 *   面板里改的供应商、默认模型、Prompt、折叠、超时都会被本插件直接读到。
 * - 模型调用复用 @utils/agentProvider 的 callModel：适配 openai / gemini / anthropic / responses
 *   四种接口协议，并统一处理图片、重试与错误信息。
 * - 支持保存多个 API，通过 .ai api 列表、切换和删除。
 *
 * 命令：.ai
 *   .ai                      → 菜单；若带回复（文字/文件/图片/贴纸）则直接进入对话
 *   .ai <内容>               → 正常对话（带会话记忆）
 *   其余子命令见 buildMenu()
 */

import path from "path";
import { createHash } from "crypto";
import axios from "axios";
import { JSONFilePreset } from "lowdb/node";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import type { InputText, TelegramClient } from "@mtcute/node";
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { htmlEscape } from "@utils/htmlEscape";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { safeGetMessages, safeGetReplyMessage } from "@utils/safeGetMessages";
import { callModel, formatProviderError } from "@utils/agentProvider";
import type { AIProvider, ChatImage, ChatMessage, Usage } from "@utils/agentTypes";

// ───────────────────────────── 常量 ─────────────────────────────

const AI_DIR = createDirectoryInAssets("ai");
const CONFIG_PATH = path.join(AI_DIR, "config.json");

const MSG_LIMIT = 3800; // 单条消息安全长度（HTML 标签也计入 4096）
const ANSWER_FILE_THRESHOLD = 12000; // 超过该长度的回答直接转成文件
const MAX_MEMORY = 50; // 会话记忆条数上限
const MAX_SESSIONS = 100; // 保留的会话数量
const MAX_MEMORY_CONTENT = 800; // 单条记忆最大字符：记忆只为连贯，不必存全文
const MAX_HISTORY_FETCH = 10000; // 单次读取聊天记录上限
const MAX_HISTORY_CHARS = 120000; // 聊天记录注入模型的字符预算，超出丢弃更早的
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 附件下载上限
const MAX_FILE_CHARS = 40000; // 附件文本注入上限
const MAX_IMAGES = 10; // 单次请求最多附带图片
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // 单张图片上限（base64 前）

/**
 * 真正会被解析成 MTProto 消息实体的标记。
 * mtcute HTML 解析器可识别的 Telegram 消息实体标记。
 */
const ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "s", "del",
  "code", "pre", "a", "blockquote", "spoiler", "tg-date",
]);

/** tg-date 的可选渲染标记 */
const DATE_FLAGS = ["relative", "short-time", "long-time", "short-date", "long-date", "day-of-week"];

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|log|env|properties|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|bat|ps1|sql|html?|xml|vue|svelte|css|scss|less|srt|vtt|tex|diff|patch)$/i;
const TEXT_MIMES =
  /^(text\/|application\/(json|xml|javascript|x-javascript|x-yaml|yaml|x-sh|x-python|toml|csv|sql|x-httpd-php))/i;

const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";

// ───────────────────────────── 类型 ─────────────────────────────

type ProviderType = "openai" | "gemini" | "anthropic" | "responses";

/** 与面板 AiProviderConfig 保持一致，model 为本插件扩展（每个供应商可记住自己的默认模型） */
interface ProviderEntry {
  tag: string;
  url: string;
  key: string;
  type?: string;
  stream: boolean;
  responses: boolean;
  model?: string;
}

interface MemoryEntry {
  role: "user" | "assistant";
  content: string;
  at: string;
}

interface SessionRecord {
  updatedAt: string;
  messages: MemoryEntry[];
  /** 写入这段记忆时用的 skill 指纹，skill 变了就丢弃旧记忆 */
  skill?: string;
}

interface AiConfig {
  // ── 面板已知字段（勿改名） ──
  configs: Record<string, ProviderEntry>;
  currentChatTag: string;
  currentChatModel: string;
  currentSearchTag: string;
  currentSearchModel: string;
  currentImageTag: string;
  currentImageModel: string;
  currentVideoTag: string;
  currentVideoModel: string;
  imagePreview: boolean;
  videoPreview: boolean;
  videoAudio: boolean;
  videoDuration: number;
  prompt: string;
  collapse: boolean;
  timeout: number;
  telegraphToken: string;
  telegraph: { enabled: boolean; limit: number; list: Array<{ url: string; title: string; createdAt: string }> };
  // ── 本插件扩展字段 ──
  /** 唯一的 skill（系统提示词），来源可以是文字、回复的消息或文件 */
  skill: string;
  /** skill 的来源标注，仅用于显示 */
  skillName: string;
  contextLimit: number;
  chatContextLimit: number;
  showMeta: boolean;
  sessions: Record<string, SessionRecord>;
}

interface ReplyContext {
  text: string;
  images: ChatImage[];
  notes: string[];
}

// ───────────────────────────── 内置技能（提示词） ─────────────────────────────


const RESERVED = new Set(["help", "s", "qh", "切换", "mx", "api", "skill", "new"]);

/**
 * 保留字只有在参数形态也对得上时才当作命令，
 * 这样「.ai new 一个方案」这类正常提问仍然按对话处理。
 */
function isCommand(command: string, rest: string): boolean {
  if (!RESERVED.has(command)) return false;
  const count = rest ? rest.split(/\s+/g).filter(Boolean).length : 0;
  switch (command) {
    case "help":
    case "new":
      return count === 0;
    case "s":
      return count === 0 || /^\d/.test(rest) || Boolean(parseRange(firstWord(rest)));
    default:
      // qh / mx / skill：参数就是取值本身
      return true;
  }
}

// ───────────────────────────── 配置读写 ─────────────────────────────

function defaultConfig(): AiConfig {
  return {
    configs: {},
    currentChatTag: "",
    currentChatModel: "",
    currentSearchTag: "",
    currentSearchModel: "",
    currentImageTag: "",
    currentImageModel: "",
    currentVideoTag: "",
    currentVideoModel: "",
    imagePreview: false,
    videoPreview: false,
    videoAudio: false,
    videoDuration: 5,
    prompt: "",
    collapse: false,
    timeout: 60000,
    telegraphToken: "",
    telegraph: { enabled: false, limit: 10, list: [] },
    skill: "",
    skillName: "",
    contextLimit: 8,
    chatContextLimit: 100,
    showMeta: true,
    sessions: {},
  };
}

/** 补齐历史配置缺失的字段（面板写入的文件可能没有扩展字段） */
function normalizeConfig(config: AiConfig): AiConfig {
  const base = defaultConfig();
  for (const key of Object.keys(base) as Array<keyof AiConfig>) {
    if (config[key] === undefined || config[key] === null) {
      (config as unknown as Record<string, unknown>)[key as string] = base[key];
    }
  }
  config.contextLimit = clampInt(config.contextLimit, 0, MAX_MEMORY, base.contextLimit);
  config.chatContextLimit = clampInt(config.chatContextLimit, 10, MAX_HISTORY_FETCH, base.chatContextLimit);
  config.timeout = clampInt(config.timeout, 5000, 600000, base.timeout);
  for (const [tag, entry] of Object.entries(config.configs || {})) {
    if (!entry || typeof entry !== "object") {
      delete config.configs[tag];
      continue;
    }
    entry.tag = entry.tag || tag;
    entry.url = String(entry.url || "");
    entry.key = String(entry.key || "");
    entry.stream = entry.stream ?? true;
    entry.responses = entry.responses ?? false;
  }
  const entries = Object.values(config.configs || {});
  if (!entries.length) {
    config.currentChatTag = "";
    config.currentChatModel = "";
  } else {
    const active = config.configs[config.currentChatTag] || entries[0];
    if (active.tag !== config.currentChatTag) {
      config.currentChatTag = active.tag;
      config.currentChatModel = active.model || "";
    } else if (config.currentChatModel) {
      active.model = config.currentChatModel;
    } else if (active.model) {
      config.currentChatModel = active.model;
    }
  }
  return config;
}

let writeQueue: Promise<unknown> = Promise.resolve();

async function readConfig(): Promise<AiConfig> {
  const db = await JSONFilePreset<AiConfig>(CONFIG_PATH, defaultConfig());
  return normalizeConfig(db.data);
}

async function updateConfig<T>(mutator: (config: AiConfig) => T): Promise<T> {
  const task = writeQueue.then(async () => {
    const db = await JSONFilePreset<AiConfig>(CONFIG_PATH, defaultConfig());
    normalizeConfig(db.data);
    const result = mutator(db.data);
    await db.write();
    return result;
  });
  writeQueue = task.catch(() => undefined);
  return task;
}

// ───────────────────────────── 基础工具 ─────────────────────────────

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function commandArgument(text: string): string {
  return String(text || "").trim().replace(/^\S+\s*/, "").trim();
}

function firstWord(text: string): string {
  return String(text || "").trim().split(/\s+/, 1)[0]?.toLowerCase() || "";
}

function restWords(text: string): string {
  return String(text || "").trim().replace(/^\S+\s*/, "").trim();
}

function compact(text: string, max = 160): string {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function truncate(text: string, max: number, note = "…（已截断）"): string {
  const value = String(text || "");
  return value.length <= max ? value : value.slice(0, max) + note;
}

function maskKey(key: string): string {
  const value = String(key || "");
  if (!value) return "未设置";
  if (value.length <= 10) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

/** 输出中抹掉密钥，避免报错信息把 key 带出去 */
function redact(text: string, provider?: AIProvider | null): string {
  let result = String(text || "");
  if (provider?.api_key && provider.api_key.length >= 8) {
    result = result.split(provider.api_key).join(maskKey(provider.api_key));
  }
  return result
    .replace(/\b(sk-[A-Za-z0-9._-]{10,})\b/g, (v) => `${v.slice(0, 5)}…${v.slice(-4)}`)
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi, (_m, p, v) => `${p}${String(v).slice(0, 5)}…${String(v).slice(-4)}`);
}

function formatTime(unixSeconds: number): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return "";
  }
}

function elapsedText(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/** 顶部三行：模型/token/耗时 → 思考 → 请求原文 */
function headerMarkdown(provider: AIProvider, tokens: string, startedAt: number, echo: string): string {
  return [
    `模型：\`${provider.model}\` | token: ${tokens} | 耗时: ${elapsedText(startedAt)}`,
    "**思考**",
    echo ? `> ${echo}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function headerHtml(provider: AIProvider, tokens: string, startedAt: number, echo: string): string {
  return [
    `模型：<code>${htmlEscape(provider.model)}</code> | token: ${htmlEscape(tokens)} | 耗时: ${htmlEscape(
      elapsedText(startedAt)
    )}`,
    "<b>思考</b>",
    echo ? `<blockquote>${htmlEscape(echo)}</blockquote>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function usageText(usage?: Usage): string {
  if (!usage) return "-";
  if (typeof usage.total === "number") return String(usage.total);
  const total = (usage.prompt || 0) + (usage.completion || 0);
  return total ? String(total) : "-";
}

function longToNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(String((value as { toString?: () => string })?.toString?.() ?? value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function chatIdOf(message: any): any {
  return message?.chat?.id;
}

function messageDateSeconds(message: any): number {
  const date = message?.date;
  if (date instanceof Date) return Math.floor(date.getTime() / 1000);
  const numeric = Number(date || 0);
  if (!Number.isFinite(numeric)) return 0;
  return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function quoteTextOf(message: any): string {
  return String(message?.replyToMessage?.quoteText ?? "").trim();
}

function htmlInput(value: string): InputText {
  try {
    return html(value);
  } catch {
    return stripHtml(value);
  }
}

// ───────────────────────────── Markdown → Telegram HTML ─────────────────────────────

/** 按行切分 Markdown，不破坏代码块 */
function splitMarkdown(text: string, max = 3000): string[] {
  const lines = String(text || "").split(/\r?\n/);
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  let fence = "";

  const flush = () => {
    if (!current.length) return;
    if (fence && !/^```\s*$/.test(current[current.length - 1] || "")) current.push("```");
    chunks.push(current.join("\n"));
    current = fence ? [fence] : [];
    length = current.join("\n").length;
  };

  for (const line of lines) {
    if (line.length > max) {
      flush();
      for (let index = 0; index < line.length; index += max) chunks.push(line.slice(index, index + max));
      continue;
    }
    if (length + line.length + 1 > max) flush();
    current.push(line);
    length += line.length + 1;
    if (/^```[^`]*$/.test(line)) fence = fence ? "" : line;
  }
  flush();
  return chunks.length ? chunks : [""];
}

/** 只生成 Telegram 支持的标签：b i u s a code pre blockquote */
function markdownToHtml(markdown: string): string {
  let source = String(markdown || "");
  const blocks: string[] = [];
  const inlines: string[] = [];

  source = source.replace(/```([a-z0-9_+.#-]+)?\r?\n([\s\S]*?)```/gi, (_m, lang, code) => {
    const cls = lang ? ` class="language-${htmlEscape(String(lang).toLowerCase())}"` : "";
    const index = blocks.push(`<pre><code${cls}>${htmlEscape(String(code).replace(/\n$/, ""))}</code></pre>`) - 1;
    return `\u0000B${index}\u0000`;
  });
  source = source.replace(/`([^`\n]+)`/g, (_m, code) => {
    const index = inlines.push(`<code>${htmlEscape(String(code))}</code>`) - 1;
    return `\u0000I${index}\u0000`;
  });

  let html = htmlEscape(source);
  html = html
    .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^\s{0,3}[-*+]\s+/gm, "• ")
    .replace(/^\s{0,3}&gt;\s?/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/\|\|([^|\n]+)\|\|/g, "<spoiler>$1</spoiler>")
    .replace(/==([^=\n]+)==/g, "<u>$1</u>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\u0000I(\d+)\u0000/g, (_m, index) => inlines[Number(index)] || "")
    .replace(/\u0000B(\d+)\u0000/g, (_m, index) => blocks[Number(index)] || "");
  return html.trim();
}

/** 正文里的裸 & < > 转义，已有的实体保持原样（避免二次转义） */
function escapeLoose(text: string): string {
  return String(text || "")
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,9}|#\d{1,6}|#x[0-9a-fA-F]{1,6});)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 按标签过滤属性；返回 null 表示整个标签不合法 */
function sanitizeAttributes(name: string, raw: string): string | null {
  const attrs = String(raw || "").trim();
  if (name === "a") {
    const href = attrs.match(/href\s*=\s*["']?([^"'\s>]+)/i);
    if (!href || !/^(?:https?:\/\/|tg:\/\/)/i.test(href[1])) return null;
    return ` href="${htmlEscape(href[1])}"`;
  }
  if (name === "code") {
    const cls = attrs.match(/class\s*=\s*["']?(language-[\w+.#-]+)/i);
    return cls ? ` class="${htmlEscape(cls[1])}"` : "";
  }
  if (name === "blockquote") {
    return /\bexpandable\b/i.test(attrs) ? " expandable" : "";
  }
  if (name === "tg-date") {
    const stamp = attrs.match(/timestamp\s*=\s*["']?(\d{1,15})/i);
    if (!stamp) return null;
    const flags = DATE_FLAGS.filter((flag) => new RegExp(`(?:^|\\s)${flag}(?:[\\s=]|$)`, "i").test(attrs));
    return ` timestamp="${stamp[1]}"${flags.length ? ` ${flags.join(" ")}` : ""}`;
  }
  // 其余标签不接受属性：这样「a &lt; b and c &gt; d」这种正文不会被误当成 <b …> 标签
  return attrs ? null : "";
}

/**
 * 清洗模型输出的 Telegram HTML：
 * - 白名单外的标签整体转义成可见文本，不会把消息发成解析失败
 * - 未闭合的标签在结尾补齐；落单的闭合标签直接丢弃（长回答分片时常见）
 */
function sanitizeTelegramHtml(input: string): string {
  const text = String(input || "");
  const pattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)\/?>/g;
  const stack: string[] = [];
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    out += escapeLoose(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const name = match[1].toLowerCase();
    const closing = match[0].startsWith("</");

    if (!ALLOWED_TAGS.has(name)) {
      out += htmlEscape(match[0]);
      continue;
    }
    if (closing) {
      if (!stack.includes(name)) continue;
      while (stack.length && stack[stack.length - 1] !== name) out += `</${stack.pop()}>`;
      stack.pop();
      out += `</${name}>`;
      continue;
    }
    const attrs = sanitizeAttributes(name, match[2] || "");
    if (attrs === null) {
      out += htmlEscape(match[0]);
      continue;
    }
    out += `<${name}${attrs}>`;
    stack.push(name);
  }

  out += escapeLoose(text.slice(cursor));
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

/** 富文本专有结构 → 消息实体能表达的形式（代码围栏内不动） */
function richToEntityMarkdown(markdown: string): string {
  const segments = String(markdown || "").split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) return segment; // 围栏内原样
      return segment
        .replace(/<\/?(?:details|summary|aside|cite|footer|sub|sup|mark|kbd)\b[^<>]*>/gi, "")
        .replace(/^(\s*)[-*+]\s+\[[xX]\]\s+/gm, "$1✅ ")
        .replace(/^(\s*)[-*+]\s+\[\s\]\s+/gm, "$1▫️ ")
        .replace(/^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/gm, "")
        .replace(/^\s*\|(.*)\|\s*$/gm, (row) => tableCells(row).join(" · "))
        .replace(/^\s*\[\^([^\]]+)\]:\s*/gm, "· ")
        .replace(/\[\^([^\]]+)\]/g, "[$1]")
        .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
        .replace(/\n{3,}/g, "\n\n");
    })
    .join("");
}

/** 模型输出 → 消息实体 HTML（仅在富文本不可用时使用） */
function renderRich(text: string): string {
  const value = richToEntityMarkdown(String(text || ""));
  const hasHtml =
    /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|spoiler|tg-spoiler|tg-date|span)\b[^>]*>/i.test(value);
  if (!hasHtml) return markdownToHtml(value);

  // 偶尔会混用 Markdown 代码围栏，先转成 pre/code 再统一清洗
  const merged = value.replace(/```([a-z0-9_+.#-]+)?\r?\n([\s\S]*?)```/gi, (_m, lang, code) => {
    const cls = lang ? ` class="language-${htmlEscape(String(lang).toLowerCase())}"` : "";
    return `<pre><code${cls}>${htmlEscape(String(code).replace(/\n$/, ""))}</code></pre>`;
  });

  // 模型可能写成 Bot API 的写法，先归一到 mtcute 解析器认识的标记
  const aliased = merged
    .replace(/<span(?:\s[^<>]*)?class\s*=\s*["']?tg-spoiler["']?[^<>]*>([\s\S]*?)<\/span>/gi, "<spoiler>$1</spoiler>")
    .replace(/<(\/?)tg-spoiler\s*>/gi, "<$1spoiler>")
    .replace(/<(\/?)ins\b[^<>]*>/gi, "<$1u>")
    .replace(/<(\/?)strike\b[^<>]*>/gi, "<$1s>");

  // Telegram 不支持的排版标签降级成换行/项目符号，而不是留成可见的原文
  const normalized = aliased
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6])>/gi, "\n")
    .replace(/<(?:p|div|h[1-6])(?:\s[^<>]*)?>/gi, "")
    .replace(/<li(?:\s[^<>]*)?>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/?(?:ul|ol)(?:\s[^<>]*)?>/gi, "");

  return sanitizeTelegramHtml(normalized).replace(/\*\*([^*<>\n]{1,200})\*\*/g, "<b>$1</b>");
}

// ───────────────────── Telegram 富文本准备与标准实体降级 ─────────────────────

const RICH_MAX_CHARS = 32_768;
const RICH_MAX_BLOCKS = 500;
const RICH_MAX_TABLE_COLUMNS = 20;
const PLAIN_FALLBACK_LIMIT = 3900;

/** Rich Markdown 里允许内嵌的 HTML 标签，其余标签只保留文字 */
const RICH_HTML_TAGS = new Set([
  "u", "sub", "sup", "aside", "cite", "details", "summary", "footer", "br",
  "b", "strong", "i", "em", "s", "code", "mark", "kbd",
]);

/** 剥掉富文本不认识的 HTML 标签（保留内部文字），避免服务端解析报错 */
function stripUnknownHtml(line: string): string {
  return line.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\/?>/g, (raw, name) =>
    RICH_HTML_TAGS.has(String(name).toLowerCase()) ? raw : ""
  );
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

/**
 * 自建的富文本预处理器：把模型输出整理成合法的 Telegram Rich Markdown。
 * 只做「保证服务端能解析」的整理，不改写语义：
 * - 代码围栏内原样保留，未闭合的围栏自动补上
 * - 表格补齐分隔行、对齐列数并裁到 20 列上限
 * - 剥掉不支持的 HTML 标签，补齐 details/aside/footer 的闭合
 * - 控制块数量与字符数上限
 */
function prepareRichMarkdown(source: string): { markdown: string; plain: string } {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const openTags: string[] = [];
  let fence = "";
  let blocks = 0;
  let chars = 0;
  let index = 0;

  const push = (line: string): boolean => {
    if (chars + line.length + 1 > RICH_MAX_CHARS) return false;
    out.push(line);
    chars += line.length + 1;
    return true;
  };

  while (index < lines.length) {
    const raw = lines[index];

    // 代码围栏：内部完全原样
    const fenceMark = raw.trim().match(/^(```|~~~)/);
    if (fenceMark) {
      if (!fence) {
        fence = fenceMark[1];
        blocks += 1;
      } else if (raw.trim().startsWith(fence)) {
        fence = "";
      }
      if (!push(raw)) break;
      index += 1;
      continue;
    }
    if (fence) {
      if (!push(raw)) break;
      index += 1;
      continue;
    }

    // 表格：整段收集后重建，保证 header + 分隔行 + 列数一致
    if (isTableRow(raw) && !isTableSeparator(raw)) {
      const rows: string[][] = [];
      let cursor = index;
      while (cursor < lines.length && (isTableRow(lines[cursor]) || isTableSeparator(lines[cursor]))) {
        if (!isTableSeparator(lines[cursor])) rows.push(tableCells(stripUnknownHtml(lines[cursor])));
        cursor += 1;
      }
      if (rows.length) {
        const columns = Math.min(
          RICH_MAX_TABLE_COLUMNS,
          rows.reduce((max, row) => Math.max(max, row.length), 0)
        );
        const render = (row: string[]) =>
          `| ${Array.from({ length: columns }, (_, cell) => row[cell] ?? "").join(" | ")} |`;
        if (!push(render(rows[0]))) break;
        if (!push(`|${" --- |".repeat(columns)}`)) break;
        for (const row of rows.slice(1)) {
          if (!push(render(row))) break;
        }
        blocks += 1;
        index = cursor;
        continue;
      }
    }

    const line = stripUnknownHtml(raw);
    for (const match of line.matchAll(/<(\/?)(details|aside|footer)\b[^<>]*>/gi)) {
      const name = match[2].toLowerCase();
      if (match[1]) {
        const at = openTags.lastIndexOf(name);
        if (at >= 0) openTags.splice(at, 1);
      } else {
        openTags.push(name);
      }
    }

    if (line.trim() && !out.length) blocks += 1;
    else if (line.trim() && !out[out.length - 1]?.trim()) blocks += 1;

    if (blocks > RICH_MAX_BLOCKS) {
      push("");
      push("_（内容过长，已截断）_");
      break;
    }
    if (!push(line)) break;
    index += 1;
  }

  if (fence) out.push(fence);
  while (openTags.length) out.push(`</${openTags.pop()}>`);

  const markdown = out.join("\n").trim();
  return { markdown, plain: truncate(richToPlain(markdown), PLAIN_FALLBACK_LIMIT) };
}

/** 富文本 → 纯文本，用于 message 字段兜底（老客户端/降级时显示） */
function richToPlain(markdown: string): string {
  return String(markdown || "")
    .replace(/```[a-z0-9_+.#-]*\n([\s\S]*?)```/gi, "$1")
    .replace(/^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/gm, "")
    .replace(/^\s*\|(.*)\|\s*$/gm, (row) => tableCells(row).join(" | "))
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/gm, "$1• ")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\|\|([^|]+)\|\|/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[\^[^\]]+\]:?/g, "")
    .replace(/<[^<>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** mtcute 版统一使用标准消息实体；保留返回值接口便于走现有降级链。 */
async function editRichMessage(_msg: any, _markdown: string, _plain: string): Promise<boolean> {
  return false;
}

function stripHtml(html: string): string {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ───────────────────────────── 消息输出 ─────────────────────────────

/** 去掉较新的实体标记：服务端或客户端不认时，至少保住基础格式 */
function stripAdvancedTags(html: string): string {
  return String(html || "").replace(/<\/?(?:tg-date|tg-emoji|spoiler)(?:\s[^<>]*)?>/gi, "");
}

/** 依次尝试：完整富文本 → 去掉新实体 → 纯文本 → 改为回复 */
function htmlVariants(html: string): string[] {
  const downgraded = stripAdvancedTags(html);
  return downgraded === html ? [html] : [html, downgraded];
}

async function sendReplyHtmlDirect(msg: any, html: string): Promise<any> {
  const client: TelegramClient = msg?.client || (await getGlobalClient());
  const chatId = chatIdOf(msg);
  for (const variant of htmlVariants(html)) {
    try {
      return await client.sendText(chatId, htmlInput(variant), {
        replyTo: Number(msg.id),
        disableWebPreview: true,
      });
    } catch {
      // 换下一个降级版本
    }
  }
  return client.sendText(chatId, stripHtml(html), { replyTo: Number(msg.id), disableWebPreview: true });
}

async function editHtml(msg: any, html: string): Promise<any> {
  return tgWrite(async () => {
    for (const variant of htmlVariants(html)) {
      try {
        return (await msg.edit({ text: htmlInput(variant), disableWebPreview: true })) || msg;
      } catch (error) {
        if (String((error as Error)?.message || "").includes("MESSAGE_NOT_MODIFIED")) return msg;
      }
    }
    try {
      return (await msg.edit({ text: stripHtml(html), disableWebPreview: true })) || msg;
    } catch {
      return sendReplyHtmlDirect(msg, html);
    }
  });
}

async function replyHtml(msg: any, html: string): Promise<any> {
  return tgWrite(() => sendReplyHtmlDirect(msg, html));
}

/**
 * 所有发往 Telegram 的写操作排队并限速。
 * 并发请求彼此独立，但共用一条连接：短时间内密集 editMessage 会触发 FLOOD_WAIT，
 * 底层客户端遇到 FLOOD_WAIT 时可能整体等待，把其它插件也一起堵住。
 */
const TG_WRITE_INTERVAL = 320;
let tgQueue: Promise<unknown> = Promise.resolve();
let tgLastWriteAt = 0;

function tgWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = tgQueue.then(async () => {
    const wait = tgLastWriteAt + TG_WRITE_INTERVAL - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    tgLastWriteAt = Date.now();
    return task();
  });
  tgQueue = run.catch(() => undefined);
  return run;
}

/**
 * 插件所有对外输出的统一出口：一律先按 Telegram 富文本发送，
 * 富文本不可用时自动降级成消息实体，再不行降级成纯文本。
 */
async function showRich(msg: any, markdown: string): Promise<any> {
  const rich = prepareRichMarkdown(markdown);
  if (await editRichMessage(msg, rich.markdown, rich.plain)) return msg;
  return showHtml(msg, sanitizeTelegramHtml(renderRich(markdown)));
}

/** 一段 HTML 太长时自动分片：首条编辑原消息，其余作为回复 */
async function showHtml(msg: any, html: string): Promise<any> {
  if (html.length <= MSG_LIMIT) return editHtml(msg, html);
  const chunks = splitMarkdown(stripHtml(html), MSG_LIMIT);
  let anchor = await editHtml(msg, htmlEscape(chunks[0]));
  for (const chunk of chunks.slice(1)) anchor = await replyHtml(anchor, htmlEscape(chunk));
  return anchor;
}

/** 表格单元格：竖线和换行会破坏表格结构 */
function cell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "｜").replace(/\r?\n/g, " · ").trim();
}

/** 键值卡片 → 富文本表格 */
function infoCard(title: string, rows: Array<[string, string]>, footer?: string): string {
  const lines = [`## ${title}`, "", "| 项目 | 值 |", "| :--- | :--- |"];
  for (const [label, value] of rows) lines.push(`| ${cell(label)} | ${cell(value)} |`);
  if (footer) lines.push("", footer);
  return lines.join("\n");
}

function okCard(title: string, detail = ""): string {
  const lines = [`## ✅ ${title}`];
  if (detail) lines.push("", detail);
  return lines.join("\n");
}

function errCard(message: string): string {
  return ["## ❌", "", "```", truncate(message, 1200).replace(/```/g, "ˋˋˋ"), "```"].join("\n");
}

async function sendTextFile(msg: any, name: string, content: string, caption: string): Promise<void> {
  await tgWrite(async () => {
    const client: TelegramClient = msg.client || (await getGlobalClient());
    const body = Buffer.from(content, "utf8");
    await client.sendMedia(
      chatIdOf(msg),
      { type: "document", file: body, fileName: name },
      { caption: htmlInput(caption), replyTo: Number(msg.id) },
    );
  });
}

// ───────────────────────────── 接口识别 ─────────────────────────────

/** 从地址（必要时结合模型名）推断接口协议 */
function detectProviderType(url: string, model = ""): ProviderType {
  const target = String(url || "").toLowerCase();
  if (/generativelanguage|googleapis|\/gemini/.test(target)) return "gemini";
  if (/anthropic/.test(target)) return "anthropic";
  if (/\/responses(\/|$)/.test(target)) return "responses";
  if (!target) {
    const hint = String(model || "").toLowerCase();
    if (hint.startsWith("gemini")) return "gemini";
    if (hint.startsWith("claude")) return "anthropic";
  }
  return "openai";
}

function normalizeType(value: unknown, url = "", model = ""): ProviderType {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "gemini" || raw === "google") return "gemini";
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  if (raw === "responses") return "responses";
  if (raw === "openai" || raw === "deepseek" || raw === "xai" || raw === "custom" || raw === "chat") return "openai";
  return detectProviderType(url, model);
}

/** 去掉地址末尾的具体端点，便于拼接 /v1/models 等路径 */
function normalizeBase(url: string): string {
  let base = String(url || "").trim().split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const patterns = [
    /\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/i,
    /\/(?:chat\/completions|completions|responses|messages)$/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = base.replace(pattern, "").replace(/\/+$/, "");
      if (next !== base) {
        base = next;
        changed = true;
      }
    }
  }
  return base;
}

function hasVersionPath(url: string): boolean {
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    return /\/v\d+(?:beta|alpha)?(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return /\/v\d+(?:beta|alpha)?(?:\/|$)/i.test(url);
  }
}

function sanitizeTag(value: string): string {
  const tag = String(value || "").trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  return tag || "provider";
}

function resolveEntry(config: AiConfig, tag?: string): ProviderEntry | null {
  const tags = Object.keys(config.configs || {});
  if (!tags.length) return null;
  const target = tag || config.currentChatTag || tags[0];
  return config.configs[target] || config.configs[tags[0]] || null;
}

function resolveProviderSelector(config: AiConfig, selector: string): ProviderEntry | null {
  const entries = Object.values(config.configs || {});
  const value = selector.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return entries[Number.parseInt(value, 10) - 1] || null;

  const lower = value.toLowerCase();
  const exact = entries.find((entry) => entry.tag.toLowerCase() === lower);
  if (exact) return exact;
  const partial = entries.filter((entry) => entry.tag.toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0] : null;
}

/** 把配置项转换成 agentProvider 需要的 AIProvider */
function toProvider(config: AiConfig, entry: ProviderEntry, modelOverride?: string): AIProvider {
  const activeModel = entry.tag === config.currentChatTag ? config.currentChatModel : "";
  const model = modelOverride || activeModel || entry.model || "";
  const type = entry.responses && !entry.type ? "responses" : normalizeType(entry.type, entry.url, model);
  return {
    name: entry.tag,
    type,
    model,
    base_url: entry.url,
    api_key: entry.key,
    auth_method: type === "gemini" ? "query_param" : "bearer",
  };
}

/** 取当前 API；没配置就返回 null，由调用方提示用 .ai qh 导入 */
async function resolveProvider(): Promise<{ config: AiConfig; provider: AIProvider | null }> {
  const config = await readConfig();
  const entry = resolveEntry(config);
  if (!entry || !entry.url || !entry.key) return { config, provider: null };
  return { config, provider: toProvider(config, entry) };
}

// ───────────────────────────── 流式对话 ─────────────────────────────

const STREAM_EDIT_INTERVAL = 2000; // 两次流式编辑之间至少间隔这么久，避免触发限流
const STREAM_TAIL_CHARS = 2500; // 消息有 4096 上限，流式期间只显示最新一段

/** 流式期间显示的正文：太长就只留最新的一段 */
function streamTail(text: string): string {
  const value = String(text || "");
  return value.length <= STREAM_TAIL_CHARS ? value : `…${value.slice(-STREAM_TAIL_CHARS)}`;
}

/** 把内部消息结构转成 OpenAI chat/completions 格式（含图片） */
function toOpenAIMessages(messages: ChatMessage[]): any[] {
  return messages.map((message) => {
    if (message.images?.length && message.role === "user") {
      return {
        role: message.role,
        content: [
          { type: "text", text: message.content },
          ...message.images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
          })),
        ],
      };
    }
    return { role: message.role, content: message.content || "" };
  });
}

function streamEndpoint(provider: AIProvider): string {
  const base = normalizeBase(provider.base_url);
  return hasVersionPath(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function streamAuth(provider: AIProvider): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.auth_method === "api_key_header") headers["X-API-Key"] = provider.api_key;
  else headers.Authorization = `Bearer ${provider.api_key}`;
  return headers;
}

/**
 * OpenAI 兼容接口的流式对话：边收边回调，方便按流式编辑消息。
 * 只处理 chat/completions 的 SSE；其它协议交给 callModel。
 */
async function streamChat(
  provider: AIProvider,
  messages: ChatMessage[],
  timeoutMs: number,
  onDelta: (partial: string) => void
): Promise<{ text: string; usage?: Usage }> {
  const response = await axios.post(
    streamEndpoint(provider),
    {
      model: provider.model,
      messages: toOpenAIMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 8192,
    },
    { headers: streamAuth(provider), timeout: timeoutMs, responseType: "stream" }
  );

  let text = "";
  let usage: Usage | undefined;
  let buffer = "";

  await new Promise<void>((resolve, reject) => {
    const stream: any = response.data;
    stream.on("data", (chunk: any) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            text += delta;
            onDelta(text);
          }
          if (json?.usage) {
            usage = {
              prompt: json.usage.prompt_tokens,
              completion: json.usage.completion_tokens,
              total: json.usage.total_tokens,
            };
          }
        } catch {
          // 单个分片解析失败就跳过
        }
      }
    });
    stream.on("end", () => resolve());
    stream.on("error", (error: any) => reject(error));
  });

  return { text: text.trim(), usage };
}

// ───────────────────────────── 模型列表 ─────────────────────────────

const modelListCache = new Map<string, string[]>();

interface ModelInfo {
  id: string;
  created?: number;
}

/** 非对话类模型：自动选最新时先排除它们 */
const NON_CHAT_MODEL =
  /(embedding|embed-|-embed|whisper|tts|speech|audio|transcrib|dall-?e|stable-?diffusion|midjourney|flux|image-|-image|moderation|rerank|realtime|sora|video|bge-|jina-|guard|ocr|upscal)/i;

/** 兼容 openai(data[].id/created)、gemini(models[].name)、anthropic(data[].created_at) 以及纯字符串数组 */
function toModelInfos(list: unknown): ModelInfo[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item: any) => {
      const id = String(item?.id || item?.name || (typeof item === "string" ? item : "") || "")
        .replace(/^models\//, "")
        .trim();
      const raw = item?.created ?? item?.created_at ?? item?.createdAt;
      let created: number | undefined;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        created = raw;
      } else if (raw) {
        const parsed = Date.parse(String(raw));
        if (Number.isFinite(parsed)) created = Math.floor(parsed / 1000);
      }
      return { id, created };
    })
    .filter((item) => item.id);
}

async function fetchModelList(entry: ProviderEntry, timeout: number): Promise<ModelInfo[]> {
  const type = normalizeType(entry.type, entry.url, entry.model);
  const base = normalizeBase(entry.url);
  const versioned = hasVersionPath(base);

  if (type === "gemini") {
    const url = versioned ? `${base}/models` : `${base}/v1beta/models`;
    const response = await axios.get(url, { params: { key: entry.key }, timeout });
    return toModelInfos(response.data?.models);
  }

  if (type === "anthropic") {
    const url = versioned ? `${base}/models` : `${base}/v1/models`;
    const response = await axios.get(url, {
      timeout,
      headers: { "x-api-key": entry.key, "anthropic-version": "2023-06-01" },
    });
    return toModelInfos(response.data?.data);
  }

  const url = versioned ? `${base}/models` : `${base}/v1/models`;
  const response = await axios.get(url, { timeout, headers: { Authorization: `Bearer ${entry.key}` } });
  return toModelInfos(response.data?.data || response.data?.models);
}

/**
 * 从模型名里解析版本号用于排序：gpt-5.6 → 5006、claude-opus-4-6 → 4006。
 * 5 位以上的数字（20250610 这类日期快照）先剔除，避免被当成版本号。
 */
function versionScore(id: string): number {
  const cleaned = id.toLowerCase().replace(/\d{5,}/g, " ");
  const match = cleaned.match(/(\d+)(?:[._-](\d+))?/);
  if (!match) return 0;
  const major = Number.parseInt(match[1], 10) || 0;
  const minor = Number.parseInt(match[2] || "0", 10) || 0;
  return major * 1000 + Math.min(minor, 999);
}

/**
 * 选“最新”模型：先排除非对话模型，然后依次尝试
 * 1) created 时间戳（很多聚合站所有模型时间戳相同，这时该信号无效，直接跳过）
 * 2) 名称里的版本号
 * 3) 接口返回顺序（多数供应商把最新的放最前）
 */
function pickLatestModel(models: ModelInfo[]): string {
  if (!models.length) return "";
  const chat = models.filter((item) => !NON_CHAT_MODEL.test(item.id));
  const pool = chat.length ? chat : models;

  const stamps = new Set(pool.map((item) => item.created).filter((value) => typeof value === "number" && value > 0));
  if (stamps.size > 1) {
    return pool
      .filter((item) => typeof item.created === "number")
      .reduce((best, item) => ((item.created as number) > (best.created as number) ? item : best)).id;
  }

  const scored = pool.map((item) => ({ id: item.id, score: versionScore(item.id) }));
  const top = scored.reduce((best, item) => (item.score > best.score ? item : best), scored[0]);
  return top.score > 0 ? top.id : pool[0].id;
}

/** 指定模型名：精确 → 忽略大小写 → 子串（多个取最短） */
function matchModel(models: ModelInfo[], wanted: string): string {
  const target = wanted.trim();
  if (!target) return "";
  const ids = models.map((item) => item.id);
  const exact = ids.find((id) => id === target);
  if (exact) return exact;
  const lower = target.toLowerCase();
  const insensitive = ids.find((id) => id.toLowerCase() === lower);
  if (insensitive) return insensitive;
  const partial = ids.filter((id) => id.toLowerCase().includes(lower));
  if (!partial.length) return "";
  return partial.sort((left, right) => left.length - right.length)[0];
}

// ───────────────────────────── 从文本中提取 API 配置 ─────────────────────────────

interface ExtractedApi {
  name: string;
  url: string;
  key: string;
  model: string;
  /** 文本里附带的模型列表（接口拉取失败时兜底） */
  models: string[];
  /** 文本里标注为可用（✅）的模型 */
  verified: string;
}

const LABEL_URL = /(?:base[\s_-]*url|接口地址|接口|地址|端点|endpoint|url|api)\s*[:：=]\s*(\S+)/i;
const LABEL_KEY = /(?:api[\s_-]*key|密钥|秘钥|钥匙|key|token|令牌)\s*[:：=]\s*(\S+)/i;
const LABEL_MODEL = /(?:当前模型|默认模型|模型|model)\s*[:：=]\s*([^\s,，、|]+)/i;
const LABEL_NAME = /(?:提供商|供应商|服务商|名称|名字|provider|name)\s*[:：=]\s*(.+)/i;
const LIST_LINE = /^\s*\d{1,3}\s*[.)、．]\s*(\S+)(.*)$/;
const CHECK_LINE = /^\s*[✅✔√☑]\s*([A-Za-z0-9][\w.:\-]*)/;
const MODEL_SHAPE = /^[A-Za-z0-9][\w.:\-]{1,63}$/;
const KEY_SHAPE = /^[A-Za-z0-9][\w.\-]{15,}$/;
const KEY_FALLBACK = /(sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9]{2,10}_[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{28,})/;

function trimEdge(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^[\s"'`<（(【\[]+/, "")
    .replace(/[\s"'`>，。、；;：:）)】\]]+$/, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname;
  } catch {
    return "";
  }
}

/** 去掉表情/装饰符号，取出一个可用作标签的名字 */
function cleanName(line: string): string {
  const words = String(line || "")
    .replace(/[^\p{L}\p{N}_.\- ]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const ascii = words.find((word) => /^[A-Za-z0-9][\w.-]{2,31}$/.test(word));
  return ascii || "";
}

/**
 * 从一段文本里识别 API 配置（兼容常见的“API 检测结果”消息格式）：
 * 地址/API 地址/base_url、密钥/API Key、模型/当前模型、以及编号形式的模型列表。
 */
function extractApiFromText(text: string): ExtractedApi | null {
  const source = String(text || "");
  if (!source.trim()) return null;
  const lines = source.split(/\r?\n/);

  // 地址：优先带标签的，其次全文第一个 http(s) 链接
  let url = "";
  const labeledUrl = source.match(LABEL_URL);
  if (labeledUrl) {
    const candidate = trimEdge(labeledUrl[1]);
    if (/^https?:\/\//i.test(candidate) || /^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(candidate)) {
      url = candidate;
    }
  }
  if (!url) {
    const plain = source.match(/https?:\/\/[^\s<>"'）)，。；]+/i);
    if (plain) url = trimEdge(plain[0]);
  }
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;

  // 密钥：优先带标签的，其次按常见密钥形状全文扫描（排除地址本身）
  let key = "";
  const labeledKey = source.match(LABEL_KEY);
  if (labeledKey) {
    const candidate = trimEdge(labeledKey[1]);
    if (candidate.length >= 4 && !candidate.includes("://")) key = candidate;
  }
  if (!key) {
    for (const token of source.split(/\s+/)) {
      const candidate = trimEdge(token);
      if (!candidate || candidate.includes("://") || (url && url.includes(candidate))) continue;
      const matched = candidate.match(KEY_FALLBACK);
      if (matched && KEY_SHAPE.test(matched[1]) && matched[1].length > key.length) key = matched[1];
    }
  }

  if (!url || !key) return null;

  // 模型列表与“可用”标记
  const models: string[] = [];
  let verified = "";
  for (const line of lines) {
    const listed = line.match(LIST_LINE);
    if (listed) {
      const name = trimEdge(listed[1]);
      if (MODEL_SHAPE.test(name)) {
        models.push(name);
        if (/[✅✔√☑]/.test(listed[2] || "") && !verified) verified = name;
      }
      continue;
    }
    const checked = line.match(CHECK_LINE);
    if (checked && !verified) {
      const name = trimEdge(checked[1]);
      if (MODEL_SHAPE.test(name)) verified = name;
    }
  }

  let model = verified;
  if (!model) {
    const labeledModel = source.match(LABEL_MODEL);
    const candidate = labeledModel ? trimEdge(labeledModel[1]) : "";
    if (MODEL_SHAPE.test(candidate)) model = candidate;
  }
  if (!model && models.length) model = models[0];

  // 名称：优先“提供商：xxx”，其次首个非空行，最后用域名
  let name = "";
  const labeledName = source.match(LABEL_NAME);
  if (labeledName) name = cleanName(labeledName[1]);
  if (!name) name = cleanName(lines.find((line) => line.trim()) || "");
  if (!name) name = hostOf(url).replace(/^www\./, "");

  return { name, url, key, model, models, verified };
}

/** 保存提取到的供应商并设为当前；仅地址与密钥都相同时更新原配置。 */
async function saveExtracted(item: ExtractedApi): Promise<{ tag: string; created: boolean }> {
  return updateConfig((config) => {
    const sameBase = normalizeBase(item.url);
    const entries = Object.values(config.configs);
    const existing = entries.find(
      (entry) => normalizeBase(entry.url) === sameBase && entry.key === item.key,
    );

    const type = detectProviderType(item.url, item.model);
    if (existing) {
      existing.url = item.url.replace(/\/+$/, "");
      existing.key = item.key;
      existing.type = existing.type || type;
      if (item.model) existing.model = item.model;
      config.currentChatTag = existing.tag;
      config.currentChatModel = existing.model || item.model || "";
      return { tag: existing.tag, created: false };
    }

    const base = sanitizeTag(item.name || hostOf(item.url) || "provider");
    let tag = base;
    let index = 2;
    while (config.configs[tag]) tag = `${base}${index++}`;
    config.configs[tag] = {
      tag,
      url: item.url.replace(/\/+$/, ""),
      key: item.key,
      type,
      stream: true,
      responses: type === "responses",
      model: item.model || "",
    };
    config.currentChatTag = tag;
    config.currentChatModel = item.model || "";
    return { tag, created: true };
  });
}

// ───────────────────────────── 媒体解析 ─────────────────────────────

let sharpModule: any;

function loadSharp(): any {
  if (sharpModule !== undefined) return sharpModule;
  try {
    // sharp 属于可选依赖：缺失时降级为直接把原图交给模型
    sharpModule = require("sharp");
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** 统一转成模型能吃的图片：webp/动图取首帧转 png，过大则缩放 */
async function toModelImage(buffer: Buffer, mimeHint = ""): Promise<ChatImage | null> {
  let data = buffer;
  let mime = detectImageMime(buffer) || String(mimeHint || "").toLowerCase();
  const sharp = loadSharp();

  if (sharp && (mime === "image/webp" || !IMAGE_MIMES.has(mime))) {
    try {
      data = await sharp(buffer).png().toBuffer();
      mime = "image/png";
    } catch {
      // 转换失败就用原始数据继续尝试
    }
  }

  if (sharp && data.length > MAX_IMAGE_BYTES) {
    try {
      data = await sharp(data).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      mime = "image/jpeg";
    } catch {
      // 忽略压缩失败
    }
  }

  if (!IMAGE_MIMES.has(mime) || data.length > MAX_IMAGE_BYTES) return null;
  return { mimeType: mime, base64: data.toString("base64") };
}

function documentFileName(document: any): string {
  return String(document?.fileName || "");
}

async function downloadDocument(client: TelegramClient, document: any): Promise<Buffer | null> {
  try {
    return Buffer.from(await client.downloadAsBuffer(document));
  } catch {
    return null;
  }
}

/** 动图/视频贴纸取静态缩略图 */
async function documentThumbImage(client: TelegramClient, document: any): Promise<ChatImage | null> {
  const thumbs = Array.from(document?.thumbnails || [])
    .filter((item: any) => !item?.isVideo)
    .sort((left: any, right: any) => {
      const leftArea = Number(left?.width || 0) * Number(left?.height || 0);
      const rightArea = Number(right?.width || 0) * Number(right?.height || 0);
      return rightArea - leftArea || Number(right?.fileSize || 0) - Number(left?.fileSize || 0);
    });

  for (const thumb of thumbs) {
    const buffer = await downloadDocument(client, thumb);
    if (!buffer) continue;
    const image = await toModelImage(buffer, "image/jpeg");
    if (image) return image;
  }
  return null;
}

async function stickerToImage(client: TelegramClient, document: any): Promise<ChatImage | null> {
  const mime = String(document?.mimeType || "").toLowerCase();
  const isStatic = document?.sourceType === "static" || mime === "image/webp" || mime.startsWith("image/");
  if (isStatic) {
    const buffer = await downloadDocument(client, document);
    if (buffer) {
      const image = await toModelImage(buffer, mime);
      if (image) return image;
    }
  }
  return documentThumbImage(client, document);
}

function stickerEmoji(document: any): string {
  return String(document?.emoji || "");
}

function describeMedia(message: any): string {
  const media = message?.media;
  if (!media) return "";
  if (media.type === "photo") return "[图片]";
  if (media.type === "web_page") return "";
  if (media.type === "sticker") return `[贴纸 ${stickerEmoji(media)}]`;
  if (media.type === "voice") return "[语音]";
  if (media.type === "audio") return "[音频]";
  if (media.type === "video") return media.isAnimation ? "[动图]" : "[视频]";
  if (media.type === "document") {
    const mime = String(media.mimeType || "");
    if (mime.startsWith("image/")) return "[图片]";
    return `[文件 ${documentFileName(media) || mime || "未知"}]`;
  }
  return `[${String(media.type || "媒体")}]`;
}

/** 从一条消息里抽取可用于模型的图片与文本附件 */
async function extractMedia(
  client: TelegramClient,
  message: any,
  budget: { images: number }
): Promise<{ images: ChatImage[]; texts: string[]; notes: string[] }> {
  const images: ChatImage[] = [];
  const texts: string[] = [];
  const notes: string[] = [];
  const media = message?.media;
  if (!media) return { images, texts, notes };

  if (media.type === "photo") {
    if (budget.images <= 0) return { images, texts, notes };
    const buffer = await downloadDocument(client, media);
    const image = buffer ? await toModelImage(buffer, "image/jpeg") : null;
    if (image) {
      images.push(image);
      budget.images -= 1;
    } else {
      notes.push("图片下载或转换失败");
    }
    return { images, texts, notes };
  }

  if (media.type === "sticker") {
    if (budget.images > 0) {
      const image = await stickerToImage(client, media);
      if (image) {
        images.push(image);
        budget.images -= 1;
        notes.push(`贴纸 ${stickerEmoji(media) || ""}`.trim());
      } else {
        notes.push("贴纸无法转换为图片（可能是动态贴纸且没有缩略图）");
      }
    }
    return { images, texts, notes };
  }

  if (media.type === "video") {
    if (budget.images > 0) {
      const image = await documentThumbImage(client, media);
      if (image) {
        images.push(image);
        budget.images -= 1;
        notes.push(media.isAnimation ? "动图预览" : "视频预览");
      }
    }
    return { images, texts, notes };
  }

  if (media.type !== "document") return { images, texts, notes };

  const document: any = media;
  const mime = String(document?.mimeType || "").toLowerCase();
  const name = documentFileName(document);
  const size = longToNumber(document?.fileSize);

  if (mime.startsWith("image/")) {
    if (budget.images > 0) {
      if (size > MAX_FILE_BYTES) {
        notes.push(`图片过大（${(size / 1024 / 1024).toFixed(1)}MB），已跳过`);
        return { images, texts, notes };
      }
      const buffer = await downloadDocument(client, document);
      const image = buffer ? await toModelImage(buffer, mime) : null;
      if (image) {
        images.push(image);
        budget.images -= 1;
      } else {
        notes.push("图片下载或转换失败");
      }
    }
    return { images, texts, notes };
  }

  const isText = TEXT_MIMES.test(mime) || TEXT_EXTENSIONS.test(name);
  if (!isText) {
    notes.push(`附件 ${name || mime || "未知类型"}（${(size / 1024).toFixed(0)}KB）无法解析内容，仅作说明`);
    return { images, texts, notes };
  }
  if (size > MAX_FILE_BYTES) {
    notes.push(`文本附件过大（${(size / 1024 / 1024).toFixed(1)}MB），已跳过`);
    return { images, texts, notes };
  }

  const buffer = await downloadDocument(client, document);
  if (!buffer) {
    notes.push("附件下载失败");
    return { images, texts, notes };
  }
  const content = buffer.toString("utf8");
  texts.push(`文件名：${name || "未命名"}\n内容：\n${truncate(content, MAX_FILE_CHARS)}`);
  return { images, texts, notes };
}

// ───────────────────────────── 上下文构建 ─────────────────────────────

/**
 * 富文本消息（Rich Message）的正文可能不在 text 字段里，
 * 这里兼容地把它挖出来，避免读到空字符串。
 */
function richMessageText(message: any): string {
  const rich = message?.richMessage;
  if (!rich) return "";

  for (const key of ["markdown", "html", "text", "message", "source"]) {
    const value = rich?.[key];
    if (typeof value === "string" && value.trim()) {
      return key === "html" ? stripHtml(value) : richToPlain(value);
    }
  }

  // 结构未知时递归收集文本节点
  const parts: string[] = [];
  const walk = (node: any, depth: number): void => {
    if (!node || depth > 6 || parts.length > 4000) return;
    if (typeof node === "string") {
      if (node.trim()) parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (const key of ["text", "message", "markdown", "caption", "title", "value"]) {
      const value = node[key];
      if (typeof value === "string" && value.trim()) parts.push(value);
    }
    for (const key of ["blocks", "items", "cells", "rows", "children", "content", "parts", "paragraphs"]) {
      if (node[key]) walk(node[key], depth + 1);
    }
  };
  walk(rich, 0);
  return parts.join("\n").trim();
}

/** 取一条消息的可读文本：普通文本取不到时回落到富文本正文 */
function messageText(message: any): string {
  const plain = String(message?.text || "").trim();
  if (plain) return plain;
  const rich = richMessageText(message);
  if (rich) return rich;
  return String(message?.text || "").trim();
}

/** id → 姓名缓存，避免同一个人反复拉实体 */
const nameCache = new Map<string, string>();

function rawSenderName(sender: any): string {
  if (!sender) return "";
  if (typeof sender === "string") return sender.trim();
  if (sender.displayName) return String(sender.displayName).trim();
  if (sender.title) return String(sender.title).trim();
  const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (sender.username) return `@${sender.username}`;
  return "";
}

function senderId(message: any): string {
  const id = message?.sender?.id ?? "";
  return id ? String(id) : "";
}

/** 同步取名：消息自带 sender 或缓存命中才有真名 */
function senderName(message: any): string {
  const direct = rawSenderName(message?.sender);
  if (direct) return direct;
  const id = senderId(message);
  if (id && nameCache.has(id)) return nameCache.get(id) as string;
  return id ? `用户${id}` : "未知";
}

/** 消息没带 sender 时按 id 拉一次实体补全姓名，结果缓存 */
async function ensureSenderName(client: any, message: any): Promise<string> {
  const direct = rawSenderName(message?.sender);
  if (direct) return direct;
  const id = senderId(message);
  if (!id) return "未知";
  if (nameCache.has(id)) return nameCache.get(id) as string;
  let name = `用户${id}`;
  try {
    name = rawSenderName(await client.getPeer(message?.sender?.id ?? Number(id))) || name;
  } catch {
    // 拿不到就用 id 兜底
  }
  nameCache.set(id, name);
  return name;
}

/** 姓名 + @用户名，都有才拼一起 */
function nameWithHandle(name: string, sender: any): string {
  const handle = sender?.username ? `@${sender.username}` : "";
  return handle && handle !== name ? `${name}（${handle}）` : name;
}

/**
 * 相册（media group）是多条消息：图片各占一条、文字通常只在其中一条上。
 * 只读被回复的那一条会漏图漏字，这里把同组的全部取回来。
 */
async function collectAlbum(client: any, msg: any, target: any): Promise<any[]> {
  const grouped = target?.groupedIdUnique;
  if (!grouped) return [target];
  try {
    const base = Number(target.id);
    const ids: number[] = [];
    for (let offset = -9; offset <= 9; offset += 1) {
      const id = base + offset;
      if (id > 0) ids.push(id);
    }
    const around = await safeGetMessages(client, chatIdOf(msg), { ids });
    const group = (around as any[])
      .filter((item) => item && String(item.groupedIdUnique ?? "") === String(grouped))
      .sort((left, right) => Number(left.id) - Number(right.id));
    return group.length ? group : [target];
  } catch {
    return [target];
  }
}

/** 转发来源 */
function forwardSource(message: any): string {
  const fwd = message?.forward;
  if (!fwd) return "";
  const name = rawSenderName(fwd.sender) || String(fwd.signature || "").trim();
  const date = fwd.date ? formatTime(messageDateSeconds(fwd)) : "";
  return [name || "（来源已隐藏）", date].filter(Boolean).join(" · ");
}

/** 被回复消息自己又回复了谁，带一句摘要 */
async function parentSummary(client: any, msg: any, target: any): Promise<string> {
  const parentId = target?.replyToMessage?.id;
  if (!parentId) return "";
  try {
    const [parent] = await safeGetMessages(client, chatIdOf(msg), { ids: [Number(parentId)] });
    if (!parent) return "";
    const name = await ensureSenderName(client, parent);
    const body = [describeMedia(parent), messageText(parent)].filter(Boolean).join(" ");
    return body ? `${name}：${compact(body, 200)}` : name;
  } catch {
    return "";
  }
}

/** 读取回复消息 + 引用片段 + 相册 + 附件，作为对话上下文 */
async function buildReplyContext(client: any, msg: any): Promise<ReplyContext> {
  const result: ReplyContext = { text: "", images: [], notes: [] };
  const budget = { images: MAX_IMAGES };
  const blocks: string[] = [];

  // 命令消息自带的媒体（发图片时用 .ai 当图注，可能是一整个相册）
  if (msg?.media) {
    const group = await collectAlbum(client, msg, msg);
    const captions: string[] = [];
    for (const item of group) {
      const own = await extractMedia(client, item, budget);
      result.images.push(...own.images);
      result.notes.push(...own.notes);
      for (const text of own.texts) blocks.push(`[我发送的附件]\n${text}`);
      if (String(item.id) !== String(msg.id)) {
        const caption = messageText(item);
        if (caption) captions.push(caption);
      }
    }
    if (group.length > 1 || captions.length) {
      blocks.push(
        [`[我发送的媒体] 共 ${group.length} 项`, captions.length ? `其它说明：\n${captions.join("\n")}` : ""]
          .filter(Boolean)
          .join("\n")
      );
    }
  }

  const replied = await safeGetReplyMessage(msg).catch(() => undefined);
  if (!replied) {
    result.text = blocks.join("\n\n");
    return result;
  }

  // 被回复的消息：把同相册的图片和文字全部收齐
  const group = await collectAlbum(client, msg, replied);
  const texts: string[] = [];
  const mediaNotes: string[] = [];
  for (const item of group) {
    const text = messageText(item);
    if (text) texts.push(text);
    const note = describeMedia(item);
    if (note) mediaNotes.push(note);
    const extracted = await extractMedia(client, item, budget);
    result.images.push(...extracted.images);
    result.notes.push(...extracted.notes);
    for (const file of extracted.texts) blocks.push(`[被回复消息的附件]\n${file}`);
  }

  const quote = quoteTextOf(msg);
  if (texts.length || mediaNotes.length || quote) {
    // 字段分行写清楚，避免昵称（比如「我是垃圾」）被当成正文
    const name = await ensureSenderName(client, replied);
    const forwarded = forwardSource(replied);
    const parent = await parentSummary(client, msg, replied);
    const fields = [
      "[被回复的消息]",
      `发送者：${nameWithHandle(name, (replied as any).sender)}`,
      replied.date ? `时间：${formatTime(messageDateSeconds(replied))}` : "",
      forwarded ? `转发自：${forwarded}` : "",
      group.length > 1 ? `相册：共 ${group.length} 项` : "",
      mediaNotes.length ? `媒体：${mediaNotes.join(" ")}` : "",
      parent ? `它回复的上一条：${parent}` : "",
      quote ? `用户选中的片段：\n${truncate(quote, 4000)}` : "",
      texts.length ? `正文：\n${truncate(texts.join("\n"), 8000)}` : "",
    ].filter(Boolean);
    blocks.push(fields.join("\n"));
  }

  result.text = blocks.join("\n\n");
  return result;
}

/** 会话资料缓存：同一个会话 10 分钟内只查一次，brief 常驻、full 按需 */
const chatInfoCache = new Map<string, { at: number; brief: string; full: string }>();
const CHAT_INFO_TTL = 10 * 60 * 1000;

/** 问题里提到会话本身时才附上完整资料（简介、成员数等） */
function needsChatProfile(text: string): boolean {
  return /群|频道|这里|本群|成员|人数|多少人|简介|介绍|公告|规则|对方|谁在|大家|group|channel|members|about/i.test(
    String(text || "")
  );
}

/** 拉取简介、成员数等完整资料，拿不到就算了 */
async function fetchChatDetail(client: any, chat: any): Promise<{ about?: string; members?: number }> {
  try {
    if (chat?.type === "user") {
      const full: any = await client.getFullUser(chat.id);
      return { about: full?.bio };
    }
    const full: any = await client.getFullChat(chat.id);
    return { about: full?.bio, members: Number(full?.membersCount || 0) || undefined };
  } catch {
    // 没权限或接口不支持时忽略
  }
  return {};
}

/**
 * 会话信息分两档：
 * - brief：一行，常驻，保证模型知道自己在哪、跟谁说话
 * - full：简介、成员数等，只有问题提到会话本身时才附上，省 token 也省思考时间
 */
async function describeChat(client: any, msg: any, detailed: boolean): Promise<string> {
  const key = String(chatIdOf(msg) ?? "");
  if (!key) return "";

  const cached = chatInfoCache.get(key);
  if (cached && Date.now() - cached.at < CHAT_INFO_TTL) return detailed ? cached.full : cached.brief;

  let brief = "";
  let full = "";
  try {
    const chat: any = msg?.chat || (await client.getPeer(chatIdOf(msg)));
    const isUser = chat?.type === "user";
    const extra: string[] = [];

    if (isUser) {
      const who = nameWithHandle(rawSenderName(chat) || `用户${chat.id}`, chat);
      brief = `[会话] 私聊 · ${who}${chat.isBot ? " · 机器人" : ""}`;
    } else {
      const title = String(chat?.title || "").trim();
      const kind = chat?.chatType === "channel" ? "频道" : "群组";
      brief = `[会话] ${kind} · ${title || key}`;
      if (chat?.username) extra.push(`用户名：@${chat.username}`);
    }

    const detail = await fetchChatDetail(client, chat);
    if (detail.members) extra.push(`成员数：${detail.members}`);
    if (detail.about) extra.push(`简介：${compact(detail.about, 500)}`);
    full = extra.length ? `${brief}\n${extra.join("\n")}` : brief;
  } catch {
    brief = "";
    full = "";
  }

  chatInfoCache.set(key, { at: Date.now(), brief, full });
  return detailed ? full : brief;
}

/** 读取当前会话最近的聊天记录 */
async function fetchChatHistory(
  client: any,
  msg: any,
  options: { limit: number; sinceTs?: number }
): Promise<{ lines: string[]; count: number; truncated: boolean }> {
  const limit = Math.min(Math.max(options.limit, 1), MAX_HISTORY_FETCH);
  const messages = await safeGetMessages(client, chatIdOf(msg), { limit: limit + 5 });

  // 消息里没带 sender 的，按 id 去重后补一批姓名（限量，避免大量请求）
  const missing: any[] = [];
  const seen = new Set<string>();
  for (const item of messages as any[]) {
    if (!item || rawSenderName(item.sender)) continue;
    const id = senderId(item);
    if (!id || seen.has(id) || nameCache.has(id)) continue;
    seen.add(id);
    missing.push(item);
    if (missing.length >= 30) break;
  }
  for (const item of missing) await ensureSenderName(client, item);

  const lines: string[] = [];
  let truncated = false;
  let chars = 0;

  // messages 是从新到旧，够数/超预算就停，最后再翻转成时间顺序
  for (const item of messages as any[]) {
    if (!item || item.id === msg.id) continue;
    if (options.sinceTs && messageDateSeconds(item) < options.sinceTs) {
      truncated = true;
      break;
    }
    if (lines.length >= limit) {
      truncated = true;
      break;
    }
    const text = messageText(item);
    const media = describeMedia(item);
    if (!text && !media) continue;
    const body = [media, text].filter(Boolean).join(" ");
    const line = `[${formatTime(messageDateSeconds(item))}] ${senderName(item)}：${compact(body, 500)}`;
    if (chars + line.length > MAX_HISTORY_CHARS) {
      truncated = true;
      break;
    }
    chars += line.length + 1;
    lines.push(line);
  }

  lines.reverse();
  return { lines, count: lines.length, truncated };
}

function parseRange(token: string): { count?: number; sinceTs?: number; label: string } | null {
  const value = String(token || "").trim().toLowerCase();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const count = clampInt(value, 1, MAX_HISTORY_FETCH, 100);
    return { count, label: `最近 ${count} 条` };
  }
  if (value === "today" || value === "今天") {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { sinceTs: Math.floor(start.getTime() / 1000), label: "今天" };
  }
  const match = value.match(/^(\d+)(m|min|h|hour|d|day|分钟|小时|天)$/);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const seconds = ["m", "min", "分钟"].includes(unit) ? 60 : ["h", "hour", "小时"].includes(unit) ? 3600 : 86400;
  return { sinceTs: Math.floor(Date.now() / 1000) - amount * seconds, label: `最近 ${amount}${unit}` };
}

// ───────────────────────────── 会话记忆 ─────────────────────────────

function sessionKey(msg: any): string {
  const chat = String(chatIdOf(msg) ?? "global");
  const sender = String(msg?.sender?.id ?? "me");
  return `${chat}:${sender}`.replace(/\s+/g, "");
}

/** skill 指纹：换了 skill 就认为旧记忆作废 */
function skillFingerprint(config: AiConfig): string {
  const content = String(config.skill || "");
  if (!content) return "";
  return createHash("sha256")
    .update(`${config.skillName || ""}\0${content}`)
    .digest("hex")
    .slice(0, 20);
}

function readMemory(config: AiConfig, key: string): ChatMessage[] {
  const record = config.sessions?.[key];
  if (!record?.messages?.length || config.contextLimit <= 0) return [];
  // 旧记忆是上一个 skill 的口吻，会把模型拉回旧人设
  if ((record.skill || "") !== skillFingerprint(config)) return [];
  return record.messages
    .slice(-config.contextLimit)
    .map((item) => ({ role: item.role, content: item.content } as ChatMessage));
}

async function appendMemory(key: string, entries: Array<{ role: "user" | "assistant"; content: string }>): Promise<void> {
  await updateConfig((config) => {
    const now = new Date().toISOString();
    const fingerprint = skillFingerprint(config);
    const previous = config.sessions[key];
    const record: SessionRecord =
      previous && (previous.skill || "") === fingerprint ? previous : { updatedAt: now, messages: [] };
    record.skill = fingerprint;
    record.updatedAt = now;
    record.messages = [
      ...record.messages,
      ...entries
        .filter((entry) => entry.content.trim())
        .map((entry) => ({ role: entry.role, content: truncate(entry.content, MAX_MEMORY_CONTENT), at: now })),
    ].slice(-MAX_MEMORY);
    config.sessions[key] = record;

    const ordered = Object.entries(config.sessions)
      .sort(([, left], [, right]) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, MAX_SESSIONS);
    config.sessions = Object.fromEntries(ordered);
  });
}

// ───────────────────────────── 系统提示词 ─────────────────────────────

function currentSkill(config: AiConfig): { name: string; content: string } {
  const content = String(config.skill || "").trim();
  return { name: content ? config.skillName || "自定义" : "", content };
}

/** 渲染层能表达的语法，仅此一段，其余人设/规则一律不注入 */
const FORMAT_NOTE = [
  "[格式] Telegram 富文本 Markdown，按内容自选，排版要整齐、层次分明：",
  "标题 ## ；重点 **粗**；术语/命令/路径 `代码`；引用 > ；分节 --- ；小字 <sub>注</sub>",
  "列表 - / 1. / - [x]；三项以上或多维信息用表格 | 表头 | 表头 | 配 | :--- | ---: | 分隔行（≤20 列）",
  "代码 ```语言 … ```；公式 $…$；剧透 ||…||；高亮 ==…==；<u>下划线</u> ~~删除~~",
  "长正文、原文摘录、日志、可选细节放进 <details><summary>标题</summary> 空行 内容 空行 </details> 折叠",
  "段落之间空一行；短回答别硬凑结构，长回答必须分节并折叠次要内容。",
  "禁止 <div> <span> <img> <script> 和 HTML 表格标签。",
].join("\n");

/** 面板 Prompt 为全局规则，skill 为当前人设。 */
function buildSystemPrompt(config: AiConfig, skill: { name: string; content: string }): string {
  return [String(config.prompt || "").trim(), skill.content, FORMAT_NOTE].filter(Boolean).join("\n\n");
}

// ───────────────────────────── 对话执行 ─────────────────────────────

interface ChatRequest {
  question: string;
  /** 附加上下文块（聊天记录等） */
  contexts?: string[];
  /** true 时不读写会话记忆 */
  stateless?: boolean;
  /** 状态行上的提示 */
  hint?: string;
  /** 回答顶部回显的原文；不传则用 question */
  echo?: string;
}

async function runChat(msg: any, request: ChatRequest): Promise<void> {
  const client = msg.client || (await getGlobalClient());
  const startedAt = Date.now();
  const { config, provider } = await resolveProvider();

  if (!provider) {
    await showRich(
      msg,
      [
        "## ❌ 还没有可用的 API",
        "",
        `回复一条含「地址 + 密钥」的消息，执行 \`${mainPrefix}ai qh\` 即可导入并使用。`,
        `先检测是否可用：回复同一条消息执行 \`${mainPrefix}cai\`。`,
      ].join("\n")
    );
    return;
  }

  if (!provider.model) {
    await showRich(msg, errCard(`还没选模型，执行 ${mainPrefix}ai qh 自动选一个，或 ${mainPrefix}ai mx 手动选`));
    return;
  }

  const skill = currentSkill(config);
  const reply = await buildReplyContext(client, msg);
  const images = reply.images.slice(0, MAX_IMAGES);

  const question = request.question.trim();
  if (!question && !reply.text && !images.length && !(request.contexts || []).length) {
    await editHtml(msg, buildMenu(config));
    return;
  }

  const echoText = compact(String(request.echo ?? question).replace(/`/g, "'"), 200);
  const extra = [
    request.hint || "",
    images.length ? `图 ${images.length}` : "",
    skill.name ? `skill ${skill.name}` : "",
  ].filter(Boolean);
  await editHtml(
    msg,
    [headerHtml(provider, "-", startedAt, echoText), extra.length ? `<i>${htmlEscape(extra.join(" · "))}</i>` : ""]
      .filter(Boolean)
      .join("\n")
  );

  const contextBlocks = [...(request.contexts || []), reply.text].filter((block) => block && block.trim());
  if (reply.notes.length) contextBlocks.push(`[附件说明]\n${reply.notes.join("\n")}`);

  // 有引用/记录等上下文时才给自己的话加标签，纯提问保持原样
  let userContent = question;
  if (contextBlocks.length) {
    const myName = await ensureSenderName(client, msg);
    const mine = question
      ? [`[我的消息]`, `发送者：${nameWithHandle(myName, msg.sender)}`, `正文：\n${question}`].join("\n")
      : "";
    userContent = [contextBlocks.join("\n\n"), mine].filter(Boolean).join("\n\n");
  }

  // 会话信息：默认只给一行；问题提到群/对方/简介时才补完整资料
  const chatInfo = await describeChat(client, msg, needsChatProfile(question));
  if (chatInfo) userContent = [chatInfo, userContent].filter(Boolean).join("\n\n");

  const sessionId = sessionKey(msg);
  const history = request.stateless ? [] : readMemory(config, sessionId);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(config, skill) },
    ...history,
    { role: "user", content: userContent, images },
  ];

  // 能流式就边收边改消息，像在打字一样；不支持的协议退回一次性返回
  const entry = resolveEntry(config);
  const canStream = String(provider.type || "openai") === "openai" && entry?.stream !== false;
  let result: { text: string; usage?: Usage };

  if (canStream) {
    let lastEditAt = 0;
    let editing = false;
    let streamed = "";
    const pushPartial = (partial: string) => {
      streamed = partial;
      const now = Date.now();
      if (editing || now - lastEditAt < STREAM_EDIT_INTERVAL || !partial.trim()) return;
      editing = true;
      lastEditAt = now;
      const body = htmlEscape(streamTail(partial));
      editHtml(msg, `${headerHtml(provider, "…", startedAt, echoText)}\n${body}`)
        .catch(() => undefined)
        .finally(() => {
          editing = false;
        });
    };
    try {
      result = await streamChat(provider, messages, config.timeout, pushPartial);
    } catch (error) {
      console.warn(`[ai] 流式中断：${(error as Error)?.message || String(error)}`);
      // 已经收到内容就用收到的，否则再走一次普通请求
      result = streamed.trim() ? { text: streamed } : await callModel(provider, messages, [], config.timeout);
    }
  } else {
    result = await callModel(provider, messages, [], config.timeout);
  }

  const answer = String(result.text || "").trim() || "（模型没有返回内容）";

  await renderAnswer(msg, config, provider, answer, {
    startedAt,
    usage: result.usage,
    skill: skill.name,
    echo: request.echo ?? question,
  });

  if (!request.stateless) {
    await appendMemory(sessionId, [
      { role: "user", content: question || compact(contextBlocks.join(" "), 500) || "（无文字请求）" },
      { role: "assistant", content: answer },
    ]);
  }
}

const COLLAPSE_THRESHOLD = 1200; // 超过这个长度就自动折叠尾部
const PREVIEW_MIN = 280; // 展开前至少露出这么多
const PREVIEW_MAX = 900; // 找不到分段点就放弃折叠

/**
 * 长回答自动折叠：保留开头一段，其余塞进 <details>。
 * 只在空行处切，且不会切进代码块；模型自己已经用了 <details> 就不再插手。
 */
function collapseLongAnswer(markdown: string): string {
  const text = String(markdown || "").trim();
  if (text.length <= COLLAPSE_THRESHOLD || /<details/i.test(text)) return text;

  const lines = text.split("\n");
  let fence = false;
  let chars = 0;
  let cut = -1;
  let lastSolid = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    chars += line.length + 1;
    if (chars > PREVIEW_MAX) break;
    if (fence || chars < PREVIEW_MIN) {
      if (line.trim()) lastSolid = line.trim();
      continue;
    }
    // 空行才切；但不要切在标题、分割线或表格中间，否则露出来的是个光杆标题
    if (line.trim() === "" && lastSolid && !/^#{1,6}\s|^-{3,}$|^\|/.test(lastSolid)) {
      cut = index;
      break;
    }
    if (line.trim()) lastSolid = line.trim();
  }
  if (cut < 0) return text;

  const head = lines.slice(0, cut).join("\n").trim();
  const rest = lines.slice(cut + 1).join("\n").trim();
  if (!head || !rest) return text;
  return `${head}\n\n<details><summary>展开剩余 ${rest.length} 字</summary>\n\n${rest}\n\n</details>`;
}

async function renderAnswer(
  msg: any,
  config: AiConfig,
  provider: AIProvider,
  answer: string,
  meta: { startedAt: number; usage?: Usage; skill?: string; echo?: string }
): Promise<void> {
  const clean = redact(answer, provider);
  // 顶部回显用户发的原文，独占一行
  const echo = compact(String(meta.echo || "").replace(/`/g, "'"), 200);

  // 1) 优先走 Telegram 原生富文本：单条最多 32768 字符，支持标题/表格/折叠块等
  if (clean.length <= RICH_MAX_CHARS) {
    const head = config.showMeta ? headerMarkdown(provider, usageText(meta.usage), meta.startedAt, echo) : "";
    const parts = [
      head,
      head && clean.length > 400 ? "---" : "", // 长回答才加分割线，短的不显得笨重
      config.collapse ? collapseLongAnswer(clean) : clean,
    ].filter(Boolean);
    const rich = prepareRichMarkdown(parts.join("\n\n"));
    if (await editRichMessage(msg, rich.markdown, rich.plain)) return;
  }

  // 2) 回退：消息实体（4096 字符上限，需要分片）
  const header = config.showMeta ? headerHtml(provider, usageText(meta.usage), meta.startedAt, echo) : "";

  if (clean.length > ANSWER_FILE_THRESHOLD) {
    const preview = sanitizeTelegramHtml(renderRich(clean.slice(0, 1200)));
    await editHtml(
      msg,
      [header, `<blockquote expandable>${preview}</blockquote>`, "<i>回答较长，完整内容见附件。</i>"]
        .filter(Boolean)
        .join("\n")
    );
    await sendTextFile(msg, `ai-answer-${Date.now()}.txt`, stripHtml(renderRich(clean)), "完整回答");
    return;
  }

  // 模型输出的富文本先整体渲染，再按行分片并逐片补齐标签
  // 降级路径没有 <details>，长回答改用可展开引用块保持折叠效果
  const collapsible = config.collapse && clean.length > 800;
  const wrap = (chunk: string) => (collapsible ? `<blockquote expandable>${chunk}</blockquote>` : chunk);
  const chunks = splitMarkdown(renderRich(clean), 3200).map((chunk) => sanitizeTelegramHtml(chunk));
  let anchor = await editHtml(msg, [header, wrap(chunks[0])].filter(Boolean).join("\n"));
  for (const chunk of chunks.slice(1)) anchor = await replyHtml(anchor, wrap(chunk));
}

// ───────────────────────────── 菜单 ─────────────────────────────

function buildMenu(config: AiConfig): string {
  const entry = resolveEntry(config);
  const provider = entry ? toProvider(config, entry) : null;
  const skill = currentSkill(config);

  // 菜单走普通消息实体，不用富文本
  return [
    "<b>🤖 AI</b>",
    "",
    `<code>${mainPrefix}ai 内容</code> 对话，可回复图片/文件/贴纸`,
    `<code>${mainPrefix}ai s 100</code> 带聊天记录，不写内容＝总结`,
    `<code>${mainPrefix}ai mx</code> 模型列表，<code>${mainPrefix}ai mx 序号</code> 切换`,
    `<code>${mainPrefix}ai api</code> API 列表，<code>${mainPrefix}ai api 序号</code> 切换`,
    `<code>${mainPrefix}ai qh</code> 换最新模型，回复 API 则导入`,
    `<code>${mainPrefix}ai skill</code> 提示词，可回复文本/文件`,
    `<code>${mainPrefix}ai new</code> 清空记忆`,
    `<code>${mainPrefix}cai</code> 回复 API，测可用`,
    "",
    `模型：<code>${htmlEscape(provider ? provider.model : "未配置")}</code>`,
    skill.name ? `skill：<code>${htmlEscape(skill.name)}</code>` : "",
  ]
    .filter((line, index) => line !== "" || index > 0)
    .join("\n");
}

// ───────────────────────────── 子命令 ─────────────────────────────

/**
 * .ai mx —— 当前 API 的模型列表；.ai mx <模型名|序号> 直接切换（不做连通性测试）
 */
async function handleModelList(msg: any, body: string): Promise<void> {
  const config = await readConfig();
  const entry = resolveEntry(config);
  if (!entry) {
    await showRich(msg, errCard(`还没有可用的 API，请回复一条含「地址 + 密钥」的消息并执行 ${mainPrefix}ai qh`));
    return;
  }

  const wanted = body.trim();
  await showRich(msg, `> 🔍 正在读取 **${entry.tag}** 的模型列表…`);

  let infos: ModelInfo[] = [];
  let listError = "";
  try {
    infos = await fetchModelList(entry, Math.min(config.timeout, 30000));
  } catch (error) {
    listError = redact(formatProviderError(error), toProvider(config, entry));
  }
  if (infos.length) modelListCache.set(entry.tag, infos.map((item) => item.id));

  // 指定了模型名/序号：直接切换，不做测试
  if (wanted) {
    let model = "";
    if (/^\d+$/.test(wanted)) {
      const cached = infos.length ? infos.map((item) => item.id) : modelListCache.get(entry.tag) || [];
      model = cached[Number.parseInt(wanted, 10) - 1] || "";
      if (!model) {
        await showRich(msg, errCard(cached.length ? `序号超出范围（1-${cached.length}）` : `拿不到模型列表${listError ? `：${listError}` : ""}`));
        return;
      }
    } else {
      model = matchModel(infos, wanted) || wanted;
    }

    await updateConfig((current) => {
      current.currentChatModel = model;
      if (current.configs[entry.tag]) current.configs[entry.tag].model = model;
    });
    await showRich(msg, okCard(`已切换 \`${model}\``, `未测试，需要测试用 ${mainPrefix}ai qh`));
    return;
  }

  if (!infos.length) {
    await showRich(msg, errCard(["拿不到模型列表", listError].filter(Boolean).join("\n")));
    return;
  }

  const models = infos.map((item) => item.id);
  const latest = pickLatestModel(infos);
  const current = config.currentChatModel || entry.model || "";
  const shown = models.slice(0, 80);
  const rows = shown.map((model, index) => {
    const marks = [model === current ? "✅" : "", model === latest ? "⭐" : ""].filter(Boolean).join("");
    return `| ${index + 1} | \`${cell(model)}\` | ${marks || " "} |`;
  });

  await showRich(
    msg,
    [
      `## 模型 · ${models.length}`,
      "",
      "| # | 模型 | |",
      "| ---: | :--- | :--- |",
      ...rows,
      "",
      models.length > shown.length ? `另有 ${models.length - shown.length} 个` : "",
      `✅ 当前　⭐ 最新　　\`${mainPrefix}ai mx 序号\` 切换`,
    ]
      .filter((line, index, all) => line !== "" || all[index - 1] !== "")
      .join("\n")
  );
}

/** .ai api —— 列出、切换或删除已保存的 API。 */
async function handleApi(msg: any, body: string): Promise<void> {
  const config = await readConfig();
  const entries = Object.values(config.configs || {});
  if (!entries.length) {
    await showRich(msg, errCard(`还没有 API，请回复含「地址 + 密钥」的消息并执行 ${mainPrefix}ai qh`));
    return;
  }

  const action = firstWord(body).toLowerCase();
  const rest = restWords(body);
  if (["del", "delete", "rm", "删除"].includes(action)) {
    const entry = resolveProviderSelector(config, rest);
    if (!entry) {
      await showRich(msg, errCard(`找不到 API：${rest || "请提供序号或名称"}`));
      return;
    }

    await updateConfig((current) => {
      delete current.configs[entry.tag];
      if (current.currentChatTag === entry.tag) {
        const next = Object.values(current.configs)[0];
        current.currentChatTag = next?.tag || "";
        current.currentChatModel = next?.model || "";
      }
    });
    modelListCache.delete(entry.tag);
    await showRich(msg, okCard(`已删除 API · ${entry.tag}`));
    return;
  }

  const selector = ["use", "switch", "切换"].includes(action) ? rest : body.trim();
  if (selector) {
    const entry = resolveProviderSelector(config, selector);
    if (!entry) {
      await showRich(msg, errCard(`找不到 API：${selector}`));
      return;
    }

    let model = entry.model || "";
    let modelNote = model ? "使用该 API 已保存的模型" : "尚未选择模型";
    if (!model) {
      try {
        const models = await fetchModelList(entry, Math.min(config.timeout, 30000));
        model = pickLatestModel(models);
        if (models.length) modelListCache.set(entry.tag, models.map((item) => item.id));
        if (model) modelNote = "已自动选择最新模型";
      } catch {
        // 切换 API 本身仍然成功，之后可用 .ai mx 手动选择模型
      }
    }

    await updateConfig((current) => {
      current.currentChatTag = entry.tag;
      current.currentChatModel = model;
      if (current.configs[entry.tag] && model) current.configs[entry.tag].model = model;
    });
    await showRich(
      msg,
      infoCard("✅ API 已切换", [
        ["名称", entry.tag],
        ["类型", String(normalizeType(entry.type, entry.url, model))],
        ["地址", entry.url],
        ["模型", model || "未选择"],
      ], `${modelNote}${model ? "" : `，请执行 ${mainPrefix}ai mx`}`),
    );
    return;
  }

  const rows = entries.map((entry, index) => {
    const current = entry.tag === config.currentChatTag ? "✅" : "";
    const model = entry.model || (current ? config.currentChatModel : "") || "未选择";
    return `| ${index + 1} | ${current} \`${cell(entry.tag)}\` | \`${cell(model)}\` | ${cell(hostOf(entry.url))} |`;
  });
  await showRich(
    msg,
    [
      `## API · ${entries.length}`,
      "",
      "| # | 名称 | 模型 | 地址 |",
      "| ---: | :--- | :--- | :--- |",
      ...rows,
      "",
      `\`${mainPrefix}ai api 序号\` 切换　\`${mainPrefix}ai api del 序号\` 删除`,
      `回复 API 配置后执行 \`${mainPrefix}ai qh\` 可继续添加。`,
    ].join("\n"),
  );
}

/** 连通性自测 */
async function pingProvider(provider: AIProvider, timeout: number): Promise<{ ok: boolean; detail: string }> {
  const startedAt = Date.now();
  try {
    const result = await callModel(
      provider,
      [
        { role: "system", content: "你是连通性测试助手，只回复一句话。" },
        { role: "user", content: "你是哪个模型？一句话回答。" },
      ],
      [],
      Math.min(timeout, 30000)
    );
    return { ok: true, detail: `${elapsedText(startedAt)} · ${compact(result.text, 100) || "（空回复）"}` };
  } catch (error) {
    return { ok: false, detail: redact(formatProviderError(error), provider) };
  }
}

/**
 * .ai qh —— 一键切换模型：
 * - 回复包含「地址 + 密钥」的消息时，先自动提取并导入为供应商
 * - 不带参数：拉取模型列表并自动选最新的
 * - 带参数：切换到指定模型（支持模糊匹配）
 */
async function handleSwitch(msg: any, body: string): Promise<void> {
  const wanted = body.trim();

  const replied = await safeGetReplyMessage(msg).catch(() => undefined);
  const quote = quoteTextOf(msg);
  const sourceText = quote || messageText(replied);
  const extracted = sourceText ? extractApiFromText(sourceText) : null;

  let imported: { tag: string; created: boolean } | null = null;
  if (extracted) {
    await showRich(
      msg,
      `> 🔎 识别到 \`${extracted.url}\`　\`${maskKey(extracted.key)}\`\n> 导入中…`
    );
    imported = await saveExtracted(extracted);
  }

  const config = await readConfig();
  const entry = resolveEntry(config, imported?.tag);
  if (!entry) {
    await showRich(msg, errCard(`没有可用 API，请回复含「地址 + 密钥」的消息再执行 ${mainPrefix}ai qh`));
    return;
  }

  if (!imported) await showRich(msg, "> 📡 获取模型列表…");

  let models: ModelInfo[] = [];
  let listError = "";
  try {
    models = await fetchModelList(entry, Math.min(config.timeout, 30000));
  } catch (error) {
    listError = redact(formatProviderError(error), toProvider(config, entry));
  }

  // 接口拉不到时，用回复文本里的模型列表兜底
  let fromText = false;
  if (!models.length && extracted?.models.length) {
    models = extracted.models.map((id) => ({ id }));
    fromText = true;
  }

  const latest = models.length ? pickLatestModel(models) : "";
  let model = "";
  let how = "";
  if (wanted) {
    const matched = matchModel(models, wanted);
    model = matched || wanted;
    how = matched ? "指定模型" : "指定模型（列表中未找到，按原样设置）";
  } else if (models.length) {
    // 回复文本里已标注 ✅ 可用的模型，比“猜最新”更可靠，优先采用
    const verified = extracted?.verified ? matchModel(models, extracted.verified) : "";
    if (verified) {
      model = verified;
      how = "回复文本已验证可用";
    } else {
      model = latest;
      how = fromText ? "自动选最新（取自回复文本）" : "自动选最新";
    }
  } else if (extracted?.model) {
    model = extracted.model;
    how = "取自回复文本";
  }

  if (!model) {
    await showRich(
      msg,
      errCard([`无法获取 ${entry.tag} 的模型列表`, listError, `可手动指定：${mainPrefix}ai qh <模型名>`].filter(Boolean).join("\n"))
    );
    return;
  }

  await updateConfig((current) => {
    current.currentChatTag = entry.tag;
    current.currentChatModel = model;
    if (current.configs[entry.tag]) current.configs[entry.tag].model = model;
  });
  if (models.length && !fromText) modelListCache.set(entry.tag, models.map((item) => item.id));

  const after = await readConfig();
  const provider = toProvider(after, after.configs[entry.tag] || entry);

  // qh 一律做一次连通性测试；即使失败也保持已经切换好的状态
  await showRich(msg, `> 🔌 \`${model}\` 测试中…`);
  const ping = await pingProvider(provider, after.timeout);

  const rows: Array<[string, string]> = [
    ["模型", `${model}（${how}）`],
    ["地址", provider.base_url],
    ["密钥", maskKey(provider.api_key)],
    ["候选", models.length ? `${models.length}${fromText ? "（来自文本）" : ""}` : "未获取"],
    [ping.ok ? "测试" : "测试失败", compact(ping.detail, 160)],
  ];
  if (latest && latest !== model) rows.push(["最新", latest]);
  if (listError) rows.push(["列表", compact(listError, 120)]);

  await showRich(msg, infoCard(ping.ok ? "✅ 已切换" : "⚠️ 已切换，测试未通过", rows));
}

/**
 * .cai —— 回复一条包含「地址 + 密钥」的消息，检测这套 API 是否可用。
 * 只做检测，不写入配置；要采用它请用 .ai qh。不带回复时检测当前在用的 API。
 */
async function handleCheck(msg: any): Promise<void> {
  const replied = await safeGetReplyMessage(msg).catch(() => undefined);
  const quote = quoteTextOf(msg);
  const sourceText = quote || messageText(replied);
  const extracted = sourceText ? extractApiFromText(sourceText) : null;

  const config = await readConfig();
  let entry: ProviderEntry | null = null;
  let origin = "";

  if (extracted) {
    entry = {
      tag: sanitizeTag(extracted.name || hostOf(extracted.url) || "check"),
      url: extracted.url,
      key: extracted.key,
      type: detectProviderType(extracted.url, extracted.model),
      stream: true,
      responses: false,
      model: extracted.model,
    };
    origin = "回复的消息";
  } else {
    entry = resolveEntry(config);
    origin = "当前配置";
  }

  if (!entry || !entry.url || !entry.key) {
    await showRich(
      msg,
      errCard(`请回复一条包含「地址 + 密钥」的消息后执行 ${mainPrefix}cai，或先配置好 API 再直接执行 ${mainPrefix}cai`)
    );
    return;
  }

  await showRich(msg, `> 🔍 检测 \`${entry.url}\` …`);
  const timeout = Math.min(config.timeout, 30000);

  let models: ModelInfo[] = [];
  let listError = "";
  try {
    models = await fetchModelList(entry, timeout);
  } catch (error) {
    listError = redact(formatProviderError(error), toProvider(config, entry));
  }
  let fromText = false;
  if (!models.length && extracted?.models.length) {
    models = extracted.models.map((id) => ({ id }));
    fromText = true;
  }

  // 优先测文本里标注可用的模型，其次选最新的
  const verified = extracted?.verified ? matchModel(models, extracted.verified) : "";
  const target = verified || (models.length ? pickLatestModel(models) : entry.model || extracted?.model || "");
  const provider = toProvider(config, { ...entry, model: target }, target);
  const ping = target
    ? await pingProvider(provider, timeout)
    : { ok: false, detail: "没有可用于测试的模型" };

  const rows: Array<[string, string]> = [
    ["地址", entry.url],
    ["密钥", maskKey(entry.key)],
    ["类型", String(provider.type || "openai")],
    ["模型", models.length ? `${models.length}${fromText ? "（取自文本）" : ""}` : listError ? "获取失败" : "0"],
    ["测试", target || "无"],
    [ping.ok ? "返回" : "失败", compact(ping.detail, 160)],
  ];
  if (listError) rows.push(["列表", compact(listError, 120)]);
  if (origin === "当前配置") rows.push(["来源", origin]);

  const lines = [infoCard(ping.ok ? "✅ 可用" : "❌ 不可用", rows)];
  if (models.length) {
    lines.push(
      "",
      `<details><summary>模型 ${models.length}</summary>`,
      "",
      ...models.slice(0, 60).map((item, index) => `${index + 1}. \`${item.id}\`${item.id === target ? " ✅" : ""}`),
      models.length > 60 ? `\n…另有 ${models.length - 60} 个` : "",
      "",
      "</details>"
    );
  }
  if (extracted) lines.push("", `采用：\`${mainPrefix}ai qh\``);
  await showRich(msg, lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n"));
}


/**
 * .ai s [条数|30m|2h|today] <问题> —— 带聊天记录上下文对话
 * 不写问题时默认让模型总结这段记录。
 */
async function handleWithHistory(msg: any, body: string): Promise<void> {
  const client = msg.client || (await getGlobalClient());
  const config = await readConfig();
  const token = firstWord(body);
  const range = parseRange(token);
  const question = range ? restWords(body) : body.trim();
  // 按时间范围时先多取一些，再按时间过滤
  const limit = range?.count ?? (range?.sinceTs ? 400 : config.chatContextLimit);

  await showRich(msg, `> 📚 读取${range?.label || `最近 ${limit} 条`}…`);
  const history = await fetchChatHistory(client, msg, { limit, sinceTs: range?.sinceTs });
  if (!history.count) {
    await showRich(msg, errCard("没读到聊天记录"));
    return;
  }

  await runChat(msg, {
    question:
      question ||
      `请总结这个${msg?.chat?.type === "user" ? "对话" : "群聊"}：一句话结论，然后按话题分点写清参与者与结论/分歧，最后列出待跟进事项。`,
    contexts: [`[聊天记录 ${history.count} 条${history.truncated ? "，更早的已省略" : ""}]\n${history.lines.join("\n")}`],
    stateless: true,
    hint: `已读取 ${history.count} 条消息，正在处理…`,
  });
}

/** skill 内容上限 */
const MAX_SKILL_CHARS = 20000;

/**
 * .ai skill —— 设置唯一的系统提示词。
 * 取值优先级：命令后面的文字 → 引用片段 → 回复的文件内容 → 回复的消息文本。
 * `.ai skill off` 清除，`.ai skill` 查看当前。
 */
async function handleSkill(msg: any, body: string): Promise<void> {
  const value = body.trim();

  const sessionId = sessionKey(msg);

  if (["off", "clear", "关", "关闭", "清除"].includes(value.toLowerCase())) {
    await updateConfig((config) => {
      config.skill = "";
      config.skillName = "";
      delete config.sessions[sessionId];
    });
    await showRich(msg, okCard("已清除 skill", "记忆一并清空"));
    return;
  }

  let content = value;
  let name = value ? "文字" : "";

  if (!content) {
    const replied = await safeGetReplyMessage(msg).catch(() => undefined);
    const quote = quoteTextOf(msg);
    if (quote) {
      content = quote;
      name = "引用";
    } else if (replied) {
      const document: any = (replied as any)?.media?.type === "document" ? (replied as any).media : null;
      if (document) {
        const fileName = documentFileName(document);
        const mime = String(document.mimeType || "").toLowerCase();
        if (!TEXT_MIMES.test(mime) && !TEXT_EXTENSIONS.test(fileName)) {
          await showRich(msg, errCard("只能读取文本类文件"));
          return;
        }
        if (longToNumber(document.fileSize) > MAX_FILE_BYTES) {
          await showRich(msg, errCard("文件太大"));
          return;
        }
        const client = msg.client || (await getGlobalClient());
        const buffer = await downloadDocument(client, document);
        if (!buffer) {
          await showRich(msg, errCard("文件下载失败"));
          return;
        }
        content = buffer.toString("utf8").trim();
        name = fileName || "文件";
      } else {
        content = messageText(replied);
        name = "消息";
      }
    }
  }

  if (!content) {
    const config = await readConfig();
    const skill = currentSkill(config);
    await showRich(
      msg,
      skill.content
        ? [
            `## skill · ${skill.name}`,
            "",
            "<details><summary>内容</summary>",
            "",
            skill.content,
            "",
            "</details>",
            "",
            `\`${mainPrefix}ai skill 文字\`　回复文本/文件 + \`${mainPrefix}ai skill\`　\`${mainPrefix}ai skill off\``,
          ].join("\n")
        : [
            "## 未设置 skill",
            "",
            `\`${mainPrefix}ai skill 文字\` 设置`,
            `回复一条消息或文本文件后发 \`${mainPrefix}ai skill\``,
          ].join("\n")
    );
    return;
  }

  const saved = truncate(content, MAX_SKILL_CHARS);
  // 旧对话记忆里都是上一个人设的口吻，不清掉会把模型拉回去
  await updateConfig((config) => {
    config.skill = saved;
    config.skillName = name;
    delete config.sessions[sessionId];
  });
  await showRich(msg, okCard(`skill 已设置 · ${name}`, `记忆已清空　${compact(saved, 160)}`));
}

async function handleReset(msg: any): Promise<void> {
  const key = sessionKey(msg);
  await updateConfig((config) => {
    delete config.sessions[key];
  });
  await showRich(msg, okCard("记忆已清空"));
}

// ───────────────────────────── 插件主体 ─────────────────────────────

/** .ai 的完整处理流程；.md 是它的隐藏别名 */
async function handleAi(msg: any): Promise<void> {
  try {
    const body = commandArgument(msg.text || "");
    const command = firstWord(body);
    const rest = restWords(body);

    // 无参数：有回复/媒体就直接对话，否则显示菜单
    if (!body) {
      const hasReply = Boolean(msg.replyToMessage?.id) || Boolean(msg.media);
      if (!hasReply) {
        await editHtml(msg, buildMenu(await readConfig()));
        return;
      }
      await runChat(msg, { question: "" });
      return;
    }

    // 不是命令就当成对话，回复的图片/文件/贴纸/引用都会自动带上
    if (!isCommand(command, rest)) {
      await runChat(msg, { question: body });
      return;
    }

    switch (command) {
      case "help":
        await editHtml(msg, buildMenu(await readConfig()));
        return;
      case "s":
        await handleWithHistory(msg, rest);
        return;
      case "qh":
      case "切换":
        await handleSwitch(msg, rest);
        return;
      case "mx":
        await handleModelList(msg, rest);
        return;
      case "api":
        await handleApi(msg, rest);
        return;
      case "skill":
        await handleSkill(msg, rest);
        return;
      case "new":
        await handleReset(msg);
        return;
      default:
        await runChat(msg, { question: body });
        return;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await showRich(msg, errCard(redact(formatProviderError(error) || detail))).catch(() => undefined);
  }
}

class AiPlugin extends Plugin {
  description = (): string =>
    `AI 助手：${mainPrefix}ai 对话；${mainPrefix}ai api 管理多个 API；${mainPrefix}cai 检测 API`;

  // 每条命令各自编辑自己的消息，互不干扰，因此不做串行限制，支持并发
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    ai: handleAi,
    md: handleAi, // 隐藏别名，与 .ai 完全一致，不在菜单里列出

    cai: async (msg: any) => {
      try {
        await handleCheck(msg);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await showRich(msg, errCard(redact(formatProviderError(error) || detail))).catch(() => undefined);
      }
    },
  };

  cleanup(): void {
    modelListCache.clear();
    nameCache.clear();
    chatInfoCache.clear();
  }
}

export default new AiPlugin();
