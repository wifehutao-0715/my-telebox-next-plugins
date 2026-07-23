import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import type { MessageContext } from "@mtcute/dispatcher";
import { InputMedia, type Message } from "@mtcute/core";
import { thtml as html } from "@mtcute/html-parser";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import { JSONFilePreset } from "lowdb/node";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { getMessageMedia, getMessageGroupedId } from "@utils/entityTypeGuards";
import { sleep } from "@utils/asyncHelpers";
import { htmlEscape } from "@utils/htmlEscape";

// 必需工具函数

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 配置接口
interface PicToStickerConfig {
  defaultEmoji: string;
  quality: number;
  format: 'webp' | 'png';
  size: number;
  background: string;
  autoDelete: boolean;
  compressionLevel: number;
  stickerSetShortName: string;
}

interface PicToStickerMedia {
  type?: string;
  mimeType?: string;
  _?: string;
  photo?: unknown;
}

function isImageMedia(media: unknown): boolean {
  if (!media || typeof media !== "object") return false;

  const typedMedia = media as PicToStickerMedia;
  return typedMedia.type === "photo"
    || (typedMedia.type === "document" && typedMedia.mimeType?.toLowerCase().startsWith("image/") === true)
    || typedMedia._ === "messageMediaPhoto"
    || Boolean(typedMedia.photo);
}

class PicToStickerPlugin extends Plugin {

  private help_text = `🖼️ <b>图片转贴纸工具</b>

<b>📝 功能：</b>
• 将图片转换为高质量贴纸
• 支持多种图片格式（JPG/PNG/GIF/WEBP）
• 自动优化贴纸尺寸和质量
• 支持自定义表情和背景
• 批量处理多张图片

<b>🔧 使用：</b>
• <code>${mainPrefix}pts</code> - 转换回复的图片
• <code>${mainPrefix}pts [表情]</code> - 使用自定义表情
• <code>${mainPrefix}pts config</code> - 查看/修改配置
• <code>${mainPrefix}pts batch</code> - 批量转换（回复多张图片）

<b>⚙️ 配置选项：</b>
• <code>${mainPrefix}pts config emoji [表情]</code> - 设置默认表情
• <code>${mainPrefix}pts config size [256-512]</code> - 设置贴纸尺寸
• <code>${mainPrefix}pts config quality [1-100]</code> - 设置质量
• <code>${mainPrefix}pts config bg [transparent/white/black]</code> - 设置背景
• <code>${mainPrefix}pts config auto [on/off]</code> - 自动删除原消息
• <code>${mainPrefix}pts config set [短名/off]</code> - 加入贴纸包或关闭贴纸包

<b>💡 示例：</b>
• <code>${mainPrefix}pts</code> - 使用默认设置转换
• <code>${mainPrefix}pts 😎</code> - 使用太阳镜表情
• <code>${mainPrefix}pts config emoji 🔥</code> - 设置默认表情为火焰
• <code>${mainPrefix}pts config set my_pic_stickers</code> - 自动创建/追加到贴纸包
• <code>${mainPrefix}pts batch</code> - 批量转换多张图片

<b>📌 提示：</b>
• 支持回复图片消息或直接发送图片
• GIF动图会取首帧生成兼容的静态 WebP 贴纸
• 自动保持图片透明背景
• 智能压缩确保最佳质量`;

  description = this.help_text;
  private configPath: string;
  private config: PicToStickerConfig;
  private tempDir: string;
  private assetsDir: string;

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    "pic_to_sticker": this.handlePicToSticker.bind(this),
    "pts": this.handlePicToSticker.bind(this),
  };

  constructor() {
    super();
    this.assetsDir = createDirectoryInAssets("pic_to_sticker");
    this.tempDir = createDirectoryInTemp("pic_to_sticker");
    this.configPath = path.join(this.assetsDir, "config.json");
    this.config = {
      defaultEmoji: "🙂",
      quality: 90,
      format: 'webp',
      size: 512,
      background: 'transparent',
      autoDelete: true,
      compressionLevel: 6,
      stickerSetShortName: ""
    };
    this.loadConfig();
  }

  private async loadConfig() {
    try {
      const db = await JSONFilePreset<PicToStickerConfig>(this.configPath, this.config);
      this.config = { ...this.config, ...db.data, format: 'webp' };
    } catch (error: unknown) {
      logger.error("[pic_to_sticker] 加载配置失败:", error);
    }
  }

  private async saveConfig() {
    try {
      const db = await JSONFilePreset<PicToStickerConfig>(this.configPath, this.config);
      db.data = this.config;
      await db.write();
    } catch (error: unknown) {
      logger.error("[pic_to_sticker] 保存配置失败:", error);
    }
  }

  private async handlePicToSticker(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();

    if (!client) {
      await msg.edit({
        text: "❌ 客户端未初始化"
      });
      return;
    }

    // acron.ts 模式参数解析
    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts;
    const sub = (args[0] || "").toLowerCase();

    try {
      // 处理帮助命令
      if (sub === "help" || sub === "h") {
        await msg.edit({ text: html(this.help_text) });
        return;
      }

      // 处理配置命令
      if (sub === "config") {
        await this.handleConfig(msg, args.slice(1));
        return;
      }

      // 处理批量转换
      if (sub === "batch") {
        await this.handleBatchConvert(msg);
        return;
      }

      // 获取自定义表情（如果提供）
      const customEmoji = args[0] && !['help', 'h', 'config', 'batch'].includes(sub) ? args[0] : this.config.defaultEmoji;

      // 处理单张图片转换
      await this.convertSingleImage(msg, customEmoji);
    } catch (error: unknown) {
      logger.error("[pic_to_sticker] 插件执行失败:", error);
      await msg.edit({
        text: html`❌ <b>转换失败:</b> ${htmlEscape(getErrorMessage(error) || '未知错误')}`
      });
    }
  }

  private async handleConfig(msg: MessageContext, args: string[]): Promise<void> {
    const option = (args[0] || "").toLowerCase();
    const value = args[1] || "";

    try {
      // 显示当前配置
      if (!option) {
        const configDisplay = `⚙️ <b>当前配置</b>\n\n` +
          `<b>默认表情:</b> ${this.config.defaultEmoji}\n` +
          `<b>贴纸尺寸:</b> ${this.config.size}x${this.config.size}\n` +
          `<b>图片质量:</b> ${this.config.quality}%\n` +
          `<b>背景颜色:</b> ${this.config.background}\n` +
          `<b>自动删除:</b> ${this.config.autoDelete ? '开启' : '关闭'}\n` +
          `<b>贴纸包:</b> ${this.config.stickerSetShortName || '未启用（发送独立贴纸）'}\n` +
          `<b>压缩等级:</b> ${this.config.compressionLevel}\n\n` +
          `💡 使用 <code>${mainPrefix}pts config [选项] [值]</code> 修改配置`;

        await msg.edit({ text: html(configDisplay) });
        return;
      }

      // 修改配置
      let updated = false;
      let message = "";

      switch (option) {
        case "emoji":
          if (!value) {
            message = `❌ 请提供表情，例如: <code>${mainPrefix}pts config emoji 🔥</code>`;
          } else {
            this.config.defaultEmoji = value;
            updated = true;
            message = `✅ 默认表情已设置为: ${value}`;
          }
          break;

        case "size":
          const size = parseInt(value);
          if (isNaN(size) || size < 256 || size > 512) {
            message = `❌ 尺寸必须在 256-512 之间`;
          } else {
            this.config.size = size;
            updated = true;
            message = `✅ 贴纸尺寸已设置为: ${size}x${size}`;
          }
          break;

        case "quality":
          const quality = parseInt(value);
          if (isNaN(quality) || quality < 1 || quality > 100) {
            message = `❌ 质量必须在 1-100 之间`;
          } else {
            this.config.quality = quality;
            updated = true;
            message = `✅ 图片质量已设置为: ${quality}%`;
          }
          break;

        case "bg":
        case "background":
          if (!['transparent', 'white', 'black'].includes(value)) {
            message = `❌ 背景必须是: transparent/white/black`;
          } else {
            this.config.background = value;
            updated = true;
            message = `✅ 背景已设置为: ${value}`;
          }
          break;

        case "auto":
          if (!['on', 'off'].includes(value)) {
            message = `❌ 自动删除必须是: on/off`;
          } else {
            this.config.autoDelete = value === 'on';
            updated = true;
            message = `✅ 自动删除已${this.config.autoDelete ? '开启' : '关闭'}`;
          }
          break;

        case "set":
        case "stickerset":
        case "pack": {
          const shortName = value.trim().toLowerCase();
          if (!shortName) {
            message = `❌ 请提供贴纸包短名，或使用 <code>${mainPrefix}pts config set off</code> 关闭`;
          } else if (['off', 'none', 'disable'].includes(shortName)) {
            this.config.stickerSetShortName = "";
            updated = true;
            message = "✅ 已关闭自动加入贴纸包，将直接发送独立贴纸";
          } else if (!/^[a-z0-9_]{1,64}$/.test(shortName)) {
            message = "❌ 贴纸包短名只能包含英文字母、数字和下划线，长度 1-64";
          } else {
            this.config.stickerSetShortName = shortName;
            updated = true;
            message = `✅ 已设置贴纸包: ${shortName}\n首次使用时会自动创建，之后自动追加`;
          }
          break;
        }

        default:
          message = `❌ 未知配置选项: ${htmlEscape(option)}`;
      }

      if (updated) {
        await this.saveConfig();
      }

      await msg.edit({ text: html`${message}` });
    } catch (error: unknown) {
      await msg.edit({
        text: html`❌ <b>配置失败:</b> ${htmlEscape(getErrorMessage(error))}`
      });
    }
  }

  private async handleBatchConvert(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    try {
      // 检查是否回复了消息
      if (!msg.replyToMessage) {
        await msg.edit({
          text: html`❌ <b>请回复包含图片的消息</b>\n\n使用方法:\n1. 回复包含多张图片的消息\n2. 发送 <code>${mainPrefix}pts batch</code>`
        });
        return;
      }

      await msg.edit({ text: "🔄 正在批量处理图片..." });

      // 获取回复的消息
      const targetMsg = await msg.getReplyTo();
      if (!targetMsg) {
        await msg.edit({
          text: html`❌ <b>无法获取回复的消息</b>`
        });
        return;
      }
      let processedCount = 0;
      let failedCount = 0;

      // 处理消息中的所有媒体
      const media = getMessageMedia(targetMsg);
      const groupedId = getMessageGroupedId(targetMsg);
      if (media) {
        if (groupedId) {
          // 媒体组（多张图片）- 获取历史消息
          const history = await client.getHistory(msg.chat.id, { limit: 10 });
          // 获取对应 group 的消息
          // 注意: mtcute 的 getHistory 返回的是旧消息在前，新消息在后

          for (const groupMsg of history) {
            if (getMessageGroupedId(groupMsg) === groupedId &&
                isImageMedia(getMessageMedia(groupMsg))) {
              const result = await this.processImage(groupMsg, this.config.defaultEmoji);
              if (result) {
                try {
                  await this.sendSticker(client, msg.chat.id, result.path, this.config.defaultEmoji, msg.id);
                  processedCount++;
                } finally {
                  if (fs.existsSync(result.path)) {
                    fs.unlinkSync(result.path);
                  }
                }
                await sleep(500); // 避免发送过快
              } else {
                failedCount++;
              }
            }
          }
        } else if (isImageMedia(media)) {
          // 单张图片
          const result = await this.processImage(targetMsg, this.config.defaultEmoji);
          if (result) {
            try {
              await this.sendSticker(client, msg.chat.id, result.path, this.config.defaultEmoji, msg.id);
              processedCount++;
            } finally {
              if (fs.existsSync(result.path)) {
                fs.unlinkSync(result.path);
              }
            }
          } else {
            failedCount++;
          }
        }
      }

      const resultMessage = processedCount > 0
        ? `✅ <b>批量转换完成</b>\n\n成功: ${processedCount} 张\n失败: ${failedCount} 张`
        : `❌ 未找到可转换的图片`;

      await msg.edit({ text: html(resultMessage) });

      if (this.config.autoDelete && processedCount > 0) {
        await sleep(3000);
        await msg.delete();
      }
    } catch (error: unknown) {
      logger.error("[pic_to_sticker] 批量转换失败:", error);
      await msg.edit({
        text: html`❌ <b>批量转换失败:</b> ${htmlEscape(getErrorMessage(error))}`
      });
    }
  }

  private async convertSingleImage(msg: MessageContext, emoji: string): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    try {
      let targetMsg: Message | MessageContext = msg;

      // 检查是否回复了消息
      if (msg.replyToMessage) {
        const repliedMsg = await msg.getReplyTo();
        if (repliedMsg) {
          targetMsg = repliedMsg;
        }
      }

      // 检查是否有图片
      const media = getMessageMedia(targetMsg);
      if (!isImageMedia(media)) {
        await msg.edit({
          text: html`❌ <b>请回复包含图片的消息</b>\n\n使用方法：\n1. 回复包含图片的消息\n2. 发送 <code>${mainPrefix}pts</code> 或 <code>${mainPrefix}pts [表情]</code>`
        });
        return;
      }

      await msg.edit({ text: "🔍 正在分析图片..." });

      // 处理图片
      const result = await this.processImage(targetMsg, emoji);
      if (!result) {
        await msg.edit({ text: "❌ 图片处理失败" });
        return;
      }

      await msg.edit({ text: "📤 正在发送贴纸..." });

      // 发送贴纸
      try {
        await this.sendSticker(client, msg.chat.id, result.path, emoji, msg.id);
      } finally {
        if (fs.existsSync(result.path)) {
          fs.unlinkSync(result.path);
        }
      }

      // 自动删除原消息
      if (this.config.autoDelete) {
        await msg.delete();
      } else {
        await msg.edit({ text: `✅ 贴纸已发送 ${emoji}` });
      }

    } catch (error: unknown) {
      logger.error("[pic_to_sticker] 转换失败:", error);

      let errorMsg = "❌ <b>转换失败</b>";
      const errMsg = getErrorMessage(error);

      if (errMsg.includes('MEDIA_INVALID')) {
        errorMsg = "❌ <b>无效的媒体文件</b>";
      } else if (errMsg.includes('FILE_PARTS_INVALID')) {
        errorMsg = "❌ <b>文件损坏或格式不支持</b>";
      } else if (errMsg.includes('PHOTO_INVALID')) {
        errorMsg = "❌ <b>无效的图片文件</b>";
      } else if (errMsg.includes('FLOOD_WAIT')) {
        const waitTime = parseInt(errMsg.match(/\d+/)?.[0] || "60");
        errorMsg = `❌ <b>请求过于频繁</b>\n\n请等待 ${waitTime} 秒后重试`;
      } else if (errMsg.includes('SHORT_NAME_OCCUPIED')) {
        errorMsg = "❌ <b>贴纸包短名已被占用</b>\n\n请使用 <code>pts config set 新短名</code> 更换";
      } else if (errMsg.includes('STICKERS_TOO_MUCH')) {
        errorMsg = "❌ <b>贴纸包已满</b>\n\n请更换一个新的贴纸包短名";
      } else {
        errorMsg = `❌ <b>转换失败:</b> ${htmlEscape(errMsg || '未知错误')}`;
      }

      await msg.edit({ text: html(errorMsg) });
    }
  }

  private async sendSticker(
    client: import("@mtcute/node").TelegramClient,
    peer: number,
    filePath: string,
    emoji: string,
    replyToId?: number
  ): Promise<void> {
    const stickerSetShortName = this.config.stickerSetShortName.trim();

    if (stickerSetShortName) {
      const stickerSet = await this.addToStickerSet(client, stickerSetShortName, filePath, emoji);
      const addedSticker = stickerSet.stickers[stickerSet.stickers.length - 1]?.sticker;

      if (!addedSticker) {
        throw new Error("贴纸已上传，但无法取得贴纸文件引用");
      }

      await client.sendMedia(peer, addedSticker.inputMedia, {
        replyTo: replyToId
      });
      return;
    }

    await client.sendMedia(peer, InputMedia.sticker(filePath, {
      fileName: path.basename(filePath),
      fileMime: "image/webp",
      alt: emoji
    }), {
      replyTo: replyToId
    });
  }

  private async addToStickerSet(
    client: import("@mtcute/node").TelegramClient,
    shortName: string,
    filePath: string,
    emoji: string
  ) {
    try {
      const stickerSet = await client.getStickerSet(shortName);
      if (!stickerSet.isCreator) {
        throw new Error(`贴纸包 ${shortName} 已存在，但不属于当前账号`);
      }

      return await client.addStickerToSet(shortName, {
        file: filePath,
        emojis: emoji
      });
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      const stickerSetMissing = errorMessage.includes("STICKERSET_INVALID")
        || errorMessage.includes("STICKERSET_NOT_FOUND");

      if (!stickerSetMissing) {
        throw error;
      }

      return await client.createStickerSet({
        owner: "self",
        title: "Pic to Sticker",
        shortName,
        stickers: [{
          file: filePath,
          emojis: emoji
        }]
      });
    }
  }

  private async processImage(msg: Message | MessageContext, emoji: string): Promise<{ path: string } | null> {
    const client = await getGlobalClient();
    const media = getMessageMedia(msg);
    if (!client || !isImageMedia(media)) return null;

    try {
      const timestamp = Date.now();
      const stickerPath = path.join(this.tempDir, `sticker_${timestamp}_${Math.random().toString(36).substring(7)}.webp`);
      const downloaded = await client.downloadAsBuffer(media as Parameters<typeof client.downloadAsBuffer>[0]);

      if (!downloaded) {
        logger.error("[pic_to_sticker] 下载失败");
        return null;
      }

      const buffer = Buffer.from(downloaded);

      try {
        const sourceMetadata = await sharp(buffer).metadata();
        if ((sourceMetadata.pages ?? 1) > 1) {
          logger.info("[pic_to_sticker] 检测到动图，将使用第一帧生成静态 WebP 贴纸");
        }

        const background = this.config.background === 'transparent'
          ? { r: 0, g: 0, b: 0, alpha: 0 }
          : this.config.background === 'white'
          ? { r: 255, g: 255, b: 255, alpha: 1 }
          : { r: 0, g: 0, b: 0, alpha: 1 };
        const targetSize = this.config.stickerSetShortName ? 512 : this.config.size;
        const maxFileSize = 512 * 1024;
        const configuredQuality = Math.max(1, Math.min(100, this.config.quality));
        const qualitySteps = Array.from(new Set([
          configuredQuality,
          Math.floor(configuredQuality * 0.8),
          Math.floor(configuredQuality * 0.6),
          Math.floor(configuredQuality * 0.4),
          Math.floor(configuredQuality * 0.2),
          10,
          5
        ].map((quality) => Math.max(1, quality)).filter((quality) => quality <= configuredQuality)));

        let outputSize = 0;
        for (const quality of qualitySteps) {
          await sharp(buffer, { page: 0, pages: 1 })
            .resize(targetSize, targetSize, {
              fit: 'contain',
              background
            })
            .webp({
              quality,
              effort: this.config.compressionLevel,
              lossless: false
            })
            .toFile(stickerPath);

          outputSize = fs.statSync(stickerPath).size;
          if (outputSize <= maxFileSize) {
            break;
          }

          logger.info(`[pic_to_sticker] 质量 ${quality}% 的 WebP 仍超过 512KB，继续压缩`);
        }

        if (!fs.existsSync(stickerPath)) {
          throw new Error("转换失败，输出文件不存在");
        }

        if (outputSize > maxFileSize) {
          throw new Error("压缩后的 WebP 仍超过 Telegram 贴纸 512KB 限制");
        }

        const outputMetadata = await sharp(stickerPath).metadata();
        if (outputMetadata.format !== "webp") {
          throw new Error(`输出格式错误: ${outputMetadata.format || "unknown"}`);
        }
        if (!outputMetadata.width || !outputMetadata.height
          || outputMetadata.width > 512 || outputMetadata.height > 512) {
          throw new Error("输出尺寸不符合 Telegram 贴纸要求");
        }
        if (this.config.stickerSetShortName
          && outputMetadata.width !== 512 && outputMetadata.height !== 512) {
          throw new Error("加入贴纸包要求至少一边为 512 像素");
        }

        return { path: stickerPath };

      } catch (sharpError: unknown) {
        logger.error("[pic_to_sticker] Sharp 处理失败:", sharpError);

        if (fs.existsSync(stickerPath)) {
          fs.unlinkSync(stickerPath);
        }

        return null;
      }

    } catch (error: unknown) {
      logger.error("[pic_to_sticker] 处理图片失败:", error);
      return null;
    }
  }
}

export default new PicToStickerPlugin();
