import { Plugin, type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import type { InputPeerLike } from "@mtcute/core";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/runtimeManager";
import sharp from "sharp";
import axios from "axios";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import { getPrefixes } from "@utils/pluginManager";
import path from "path";
import fs from "fs";
import { encode, UnencodedFrame } from "modern-gif";
import { execFile } from "child_process";
import { promisify } from "util";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { htmlEscape } from "@utils/htmlEscape";
import { JSONFilePreset } from "lowdb/node";

const execAsync = promisify(execFile);

// 由于gif可能很多帧，最好缓存在本地，而不是每次都远程拿不同的帧数
const ASSET_PATH = createDirectoryInAssets("eatgif");
// 用来保存缓存的gif资源以及webm资源
const TEMP_PATH = createDirectoryInTemp("eatgif");

interface RoleConfig {
  x: number;
  y: number;
  mask: string;
  rotate?: number;
  brightness?: number;
}

interface GifResConfig {
  url: string;
  delay?: number;
  me?: RoleConfig;
  you?: RoleConfig;
}

// 表情包详细配置
interface EatGifConfig {
  width: number;
  height: number;
  res: GifResConfig[];
}

// 各种表情包配置列表
interface EatGifListConfig {
  [key: string]: { url: string; desc: string };
}

interface AvatarTarget {
  peer: InputPeerLike;
  label: string;
}

// 测试时可以更换主体url
const baseRepoURL =
  "https://github.com/TeleBoxOrg/TeleBox-Plugins/raw/refs/heads/main/eatgif/";
const baseConfigURL = baseRepoURL + "config.json";

let config: EatGifListConfig;

// 还是每次生命周期仅加载一次资源，或者 clear 来重载
async function loadGifListConfig(url: string): Promise<void> {
  const res = await axios.get(url);
  config = res.data;
}
loadGifListConfig(baseConfigURL);

// 命令前缀与帮助
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "eatgif";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `🧩 <b>头像动图表情</b>

<b>用法：</b>
<code>${commandName} [list|ls|clear|名称] [用户1] [用户2]</code>
• <b>空/ list</b>：查看表情列表
• <b>回复生成</b>：回复目标并输入名称，使用“自己 + 回复对象”
• <b>指定一人</b>：<code>${commandName} 名称 @用户</code>，使用“自己 + 指定用户”
• <b>指定两人</b>：<code>${commandName} 名称 @用户1 @用户2</code>
  用户1 放在“自己位”，用户2 放在“对方位”
• 回复用户2并指定用户1，也可组成两人表情
• 用户支持 <code>@username</code>、数字 ID、Telegram 文本提及和 <code>self</code>`;

async function ensureConfig(): Promise<void> {
  if (!config) await loadGifListConfig(baseConfigURL);
}

async function loadGifDetailConfig(url: string): Promise<EatGifConfig> {
  const res = await axios.get(baseRepoURL + url);
  return res.data;
}

// 由于很多帧，每个帧又有不同的mask等配置，最好就是缓存
async function assetBufferFor(filePath: string): Promise<Buffer> {
  const localPath = path.join(ASSET_PATH, filePath);
  const url = baseRepoURL + filePath;
  if (fs.existsSync(localPath)) {
    const buffer: Buffer = fs.readFileSync(localPath);
    return buffer;
  }
  const res = await axios.get(url, { responseType: "arraybuffer" });
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, res.data);
  return res.data;
}

class EatGifPlugin extends Plugin {

  description: string = `生成头像融合动图\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: MessageContext, trigger?: MessageContext) => Promise<void>
  > = {
    eatgif: async (msg, trigger) => {
      await this.handleEatGif(msg, trigger);
    },
    // eatgif2
  };

  private async handleEatGif(msg: MessageContext, trigger?: MessageContext) {
    const firstLine = (msg.text || "").split(/\r?\n/g)[0] || "";
    const parts = firstLine.trim().split(/\s+/) || [];
    const [, ...args] = parts;
    const sub = (args[0] || "").toLowerCase();

    try {
      await ensureConfig();

      if (!sub || sub === "list" || sub === "ls") {
        await msg.edit({ text: html(this.listAllStickers()) });
        return;
      }

      if (sub === "help" || sub === "h") {
        await msg.edit({ text: html(help_text) });
        return;
      }

      if (sub === "clear") {
        await this.clearRes(msg);
        return;
      }

      if (!Object.keys(config).includes(sub)) {
        const text = `❌ 未找到 <code>${htmlEscape(
          sub
        )}</code>\n\n${this.listAllStickers()}`;
        await msg.edit({ text: html(text) });
        return;
      }

      const parsedTargets = this.parseAvatarTargets(msg, firstLine);
      if (parsedTargets.invalidTokens.length > 0) {
        await msg.edit({
          text: html`❌ 无法识别用户：<code>${htmlEscape(parsedTargets.invalidTokens.join(" "))}</code>\n\n支持 <code>@username</code>、数字 ID、Telegram 文本提及和 <code>self</code>`,
        });
        return;
      }

      if (parsedTargets.targets.length > 2) {
        await msg.edit({ text: html`❌ 最多只能指定两个用户` });
        return;
      }

      await msg.edit({
        text: html`⏳ 正在生成 <b>${htmlEscape(config[sub].desc)}</b>...`,
      });
      await this.generateGif(sub, {
        msg,
        trigger,
        explicitTargets: parsedTargets.targets,
      });
    } catch (e: unknown) {
      await msg.edit({
        text: html`❌ 失败：${htmlEscape(getErrorMessage(e) || String(e))}`,
      });
    }
  }

  private listAllStickers(): string {
    const keys = Object.keys(config || {});
    const items = keys.map(
      (k) => `• <code>${htmlEscape(k)}</code> - ${htmlEscape(config[k].desc)}`
    );
    const header = `🧩 <b>可用表情列表</b>\n回复生成：<code>${commandName} &lt;名称&gt;</code>\n指定两人：<code>${commandName} &lt;名称&gt; @用户1 @用户2</code>\n\n`;
    return header + items.join("\n");
  }

  private parseAvatarTargetToken(token: string): AvatarTarget | undefined {
    if (/^(?:me|self|我|自己)$/iu.test(token)) {
      return { peer: "self", label: "自己" };
    }

    const telegramLink = token.match(
      /^(?:https?:\/\/)?t\.me\/([a-z0-9_]+)\/?$/iu
    );
    if (telegramLink) {
      return { peer: `@${telegramLink[1]}`, label: `@${telegramLink[1]}` };
    }

    if (/^@[a-z0-9_]+$/iu.test(token)) {
      return { peer: token, label: token };
    }

    if (/^-?\d+$/u.test(token)) {
      const userId = Number(token);
      if (Number.isSafeInteger(userId)) {
        return { peer: userId, label: token };
      }
    }

    return undefined;
  }

  private parseAvatarTargets(
    msg: MessageContext,
    firstLine: string
  ): { targets: AvatarTarget[]; invalidTokens: string[] } {
    const commandAndName = firstLine.match(/^\s*\S+\s+\S+/u)?.[0];
    const targetStart = commandAndName?.length ?? firstLine.length;
    const candidates: Array<{
      offset: number;
      target: AvatarTarget;
    }> = [];
    const entitySpans: Array<{ start: number; end: number }> = [];

    for (const entity of msg.entities) {
      if (entity.offset < targetStart || entity.offset >= firstLine.length) {
        continue;
      }

      let target: AvatarTarget | undefined;
      if (entity.is("text_mention")) {
        target = {
          peer: entity.params.userId,
          label: entity.text || String(entity.params.userId),
        };
      } else if (entity.is("mention")) {
        target = this.parseAvatarTargetToken(entity.text);
      }

      if (!target) continue;
      candidates.push({ offset: entity.offset, target });
      entitySpans.push({
        start: entity.offset,
        end: entity.offset + entity.length,
      });
    }

    const invalidTokens: string[] = [];
    const tokenPattern = /[^\s,，]+/gu;
    tokenPattern.lastIndex = targetStart;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(firstLine)) !== null) {
      const offset = match.index;
      const end = offset + match[0].length;
      if (entitySpans.some((span) => offset < span.end && end > span.start)) {
        continue;
      }

      const target = this.parseAvatarTargetToken(match[0]);
      if (target) {
        candidates.push({ offset, target });
      } else {
        invalidTokens.push(match[0]);
      }
    }

    candidates.sort((left, right) => left.offset - right.offset);
    return {
      targets: candidates.map((candidate) => candidate.target),
      invalidTokens,
    };
  }

  private async clearRes(msg: MessageContext): Promise<void> {
    fs.rmSync(ASSET_PATH, { recursive: true, force: true });
    await loadGifListConfig(baseConfigURL);
    await msg.edit({ text: html`🧹 已清理缓存并刷新配置` });
  }

  private async generateGif(
    gifName: string,
    params: {
      msg: MessageContext;
      trigger?: MessageContext;
      explicitTargets: AvatarTarget[];
    }
  ) {
    const { msg, trigger, explicitTargets } = params;
    const gifConfig = await loadGifDetailConfig(config[gifName].url);

    const needsMe = gifConfig.res.some((entry) => Boolean(entry.me));
    const needsYou = gifConfig.res.some((entry) => Boolean(entry.you));
    let replyTarget: AvatarTarget | undefined;
    if (needsYou && explicitTargets.length < 2) {
      replyTarget = await this.getReplyAvatarTarget(msg, trigger);
    }

    let meTarget: AvatarTarget | undefined;
    let youTarget: AvatarTarget | undefined;

    if (needsMe && needsYou) {
      if (explicitTargets.length >= 2) {
        [meTarget, youTarget] = explicitTargets;
      } else if (explicitTargets.length === 1 && replyTarget) {
        meTarget = explicitTargets[0];
        youTarget = replyTarget;
      } else if (explicitTargets.length === 1) {
        meTarget = { peer: "self", label: "自己" };
        youTarget = explicitTargets[0];
      } else {
        meTarget = { peer: "self", label: "自己" };
        youTarget = replyTarget;
      }
    } else if (needsYou) {
      if (explicitTargets.length > 1) {
        await msg.edit({ text: html`❌ 这个表情只需要指定一个用户` });
        return;
      }
      youTarget = explicitTargets[0] ?? replyTarget;
    } else if (needsMe) {
      if (explicitTargets.length > 1) {
        await msg.edit({ text: html`❌ 这个表情只需要指定一个用户` });
        return;
      }
      meTarget = explicitTargets[0] ?? { peer: "self", label: "自己" };
    }

    if (needsMe && !meTarget) {
      await msg.edit({ text: html`💡 请回复一个用户，或在命令后指定用户` });
      return;
    }
    if (needsYou && !youTarget) {
      await msg.edit({ text: html`💡 请回复一个用户，或在命令后指定用户` });
      return;
    }

    let meAvatarBuffer: Buffer | undefined;
    if (meTarget) {
      meAvatarBuffer = await this.downloadProfilePhoto(meTarget.peer);
      if (!meAvatarBuffer) {
        await msg.edit({
          text: html`无法获取“自己位”用户 <code>${htmlEscape(meTarget.label)}</code> 的头像`,
        });
        await msg.deleteWithDelay(2000);
        return;
      }
    }

    let youAvatarBuffer: Buffer | undefined;
    if (youTarget) {
      youAvatarBuffer = await this.downloadProfilePhoto(youTarget.peer);
      if (!youAvatarBuffer) {
        await msg.edit({
          text: html`无法获取“对方位”用户 <code>${htmlEscape(youTarget.label)}</code> 的头像`,
        });
        await msg.deleteWithDelay(2000);
        return;
      }
    }

    const tasks: Array<Promise<Buffer | undefined>> = [];
    for (let i = 0; i < gifConfig.res.length; i++) {
      const entry = gifConfig.res[i];
      tasks.push(
        this.compositeWithEntryConfig(entry, {
          youAvatarBuffer,
          meAvatarBuffer,
        })
      );
    }
    const result = await Promise.all(tasks);

    if (result.length === 0 || result.every((r) => !r)) {
      await msg.edit({ text: html`合成动图失败` });
      return;
    }

    let frames: UnencodedFrame[] = [];
    for (let i = 0; i < gifConfig.res.length; i++) {
      const buffer = result[i];
      if (!buffer) continue;
      const data = Buffer.from(buffer);
      const delay = gifConfig.res[i].delay;
      frames.push({
        data,
        delay: delay ? delay : 100,
      });
    }

    const output = await encode({
      width: gifConfig.width,
      height: gifConfig.height,
      frames,
    });

    const gifPath = path.join(TEMP_PATH, "output.gif");
    const webmPath = path.join(TEMP_PATH, "output.webm");

    fs.writeFileSync(gifPath, Buffer.from(output));

    try {
      await msg.edit({ text: html`⏳ 正在转换为 webm 格式...` });
      await execAsync("ffmpeg", [
        "-y", "-i", gifPath,
        "-c:v", "libvpx-vp9",
        "-b:v", "0",
        "-crf", "41",
        "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0",
        webmPath,
      ]);

      const client = await getGlobalClient();
      if (!client) throw new Error("Client not available");

      const replyMsg = trigger ? (await safeGetReplyMessage(trigger)) || (await safeGetReplyMessage(msg)) : await safeGetReplyMessage(msg);

      await client.sendMedia(msg.chat.id, {
        type: "document",
        file: webmPath,
        fileName: "sticker.webm",
      }, {
        replyTo: replyMsg?.id,
      });
    } catch (e: unknown) {
      logger.info("exec ffmpeg error", e);
      await msg.edit({ text: html`生成 webm 失败 ${String(e)}` });

      const client = await getGlobalClient();
      if (client) {
        const replyMsg = trigger ? (await safeGetReplyMessage(trigger)) || (await safeGetReplyMessage(msg)) : await safeGetReplyMessage(msg);
        await client.sendMedia(msg.chat.id, {
          type: "document",
          file: gifPath,
          fileName: "sticker.gif",
        }, {
          replyTo: replyMsg?.id,
        });
      }
    }

    await msg.delete();

    fs.rmSync(gifPath, { force: true, recursive: true });
    fs.rmSync(webmPath, { force: true, recursive: true });
  }

  // 合成每一帧
  private async compositeWithEntryConfig(
    entry: GifResConfig,
    parmas: {
      youAvatarBuffer?: Buffer;
      meAvatarBuffer?: Buffer;
    }
  ): Promise<Buffer | undefined> {
    const { youAvatarBuffer, meAvatarBuffer } = parmas;

    const mainCanvas = await assetBufferFor(entry.url);

    let composite: sharp.OverlayOptions[] = [];
    if (entry.you) {
      if (!youAvatarBuffer) throw new Error("缺少对方位头像");
      const iconMasked = await this.iconMaskedFor(entry.you, youAvatarBuffer);
      composite.push(iconMasked);
    }

    // 如果有两人互动
    if (entry.me) {
      if (!meAvatarBuffer) throw new Error("缺少自己位头像");
      const iconMasked = await this.iconMaskedFor(entry.me, meAvatarBuffer);
      composite.push(iconMasked);
    }

    const outBuffer = await sharp(mainCanvas)
      .composite(composite)
      .raw()
      .toBuffer();

    return outBuffer;
  }

  // 拿到每一帧头像位置及裁剪形状
  private async iconMaskedFor(
    role: RoleConfig,
    avatar: Buffer
  ): Promise<sharp.OverlayOptions> {
    const maskBuffer = await assetBufferFor(role.mask);
    const { width: maskWidth, height: maskHeight } = await sharp(
      maskBuffer
    ).metadata();

    let iconRotate = await sharp(avatar)
      .resize(maskWidth, maskHeight)
      .toBuffer();

    if (role.rotate) {
      iconRotate = await sharp(iconRotate).rotate(role.rotate).toBuffer();
    }
    if (role.brightness) {
      iconRotate = await sharp(iconRotate)
        .modulate({ brightness: role.brightness })
        .toBuffer();
    }

    let iconSharp = sharp(iconRotate);

    const { width: iconWidth, height: iconHeight } = await iconSharp.metadata();

    const left = Math.max(0, Math.floor((iconWidth! - maskWidth!) / 2));
    const top = Math.max(0, Math.floor((iconHeight! - maskHeight!) / 2));

    let cropped = iconSharp.extract({
      left,
      top,
      width: maskWidth!,
      height: maskHeight!,
    });

    let iconMasked = await cropped
      .composite([
        {
          input: maskBuffer,
          blend: "dest-in", // 保留 mask 区域
        },
      ])
      .png()
      .toBuffer();

    return {
      input: iconMasked,
      top: role.y,
      left: role.x,
    };
  }
  // 获取头像等数据
  private async downloadProfilePhoto(
    target: InputPeerLike
  ): Promise<Buffer | undefined> {
    const client = await getGlobalClient();
    if (!client) return undefined;
    try {
      const photos = await client.getProfilePhotos(target, { limit: 1 });
      const photo = photos[0];
      if (!photo) return undefined;
      const buffer = await client.downloadAsBuffer(photo);
      return buffer.length > 0 ? Buffer.from(buffer) : undefined;
    } catch (err: unknown) {
      logger.error("[eatgif] downloadProfilePhoto failed:", err);
      return undefined;
    }
  }

  private async getReplyAvatarTarget(
    msg: MessageContext,
    trigger?: MessageContext
  ): Promise<AvatarTarget | undefined> {
    let replyTo = await safeGetReplyMessage(msg);
    if (!replyTo) {
      replyTo = await safeGetReplyMessage(trigger);
    }
    const sender = replyTo?.sender;
    if (!sender || sender.type !== "user") {
      return undefined;
    }
    return {
      peer: sender,
      label: sender.displayName || String(sender.id),
    };
  }



  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "eatgif",
    title: "吃 GIF",
    description: "吃 GIF 动图配置",
    category: "插件配置",
    icon: "🎬",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "x",
            "label": "X 坐标偏移",
            "type": "number",
            "min": -100,
            "max": 100,
            "default": 0
      },
      {
            "key": "y",
            "label": "Y 坐标偏移",
            "type": "number",
            "min": -100,
            "max": 100,
            "default": 0
      },
      {
            "key": "mask",
            "label": "遮罩形状",
            "type": "string",
            "default": "circle"
      },
      {
            "key": "rotate",
            "label": "旋转角度",
            "type": "number",
            "min": -360,
            "max": 360,
            "default": 0
      },
      {
            "key": "brightness",
            "label": "亮度",
            "type": "number",
            "min": 0,
            "max": 200,
            "default": 100
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<RoleConfig>(path.join(createDirectoryInAssets("eatgif"), "config.json"), {} as any);
      return db.data as unknown as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<RoleConfig>(path.join(createDirectoryInAssets("eatgif"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };
}

export default new EatGifPlugin();
