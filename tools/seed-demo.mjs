#!/usr/bin/env node
/**
 * 往 PSD 展示台里塞一批演示数据（v2.0：上传 PNG + 网盘分享链接）。
 *
 *   node tools/seed-demo.mjs                                   # 打本地 127.0.0.1:4000
 *   node tools/seed-demo.mjs --base http://7thcv.cn:4100        # 打线上
 *   node tools/seed-demo.mjs --upload-token <token>             # 服务端开了上传令牌时
 *
 * 幂等：重复执行时撞到 sha256 去重的会跳过。
 *
 * ⚠️ 演示用的网盘链接是**占位链接**（域名真实、分享路径虚构），点进去网盘会提示分享不存在。
 *    这是刻意的：演示数据不应该指向任何真实资源。条目说明里也写明了这一点。
 *
 * 依赖 tools/make-sample-psd.mjs 生成的 PNG 素材（npm run fixture）。
 * 注意：不同位深/压缩变体的解码画面本来就完全相同，sha256 会重复，
 * 所以这里只挑**内容互不相同**的 7 张图。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(ROOT, 'tools', 'fixtures');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = getArg('base', 'http://127.0.0.1:4000').replace(/\/$/, '');
const TOKEN = getArg('upload-token', process.env.UPLOAD_TOKEN ?? '');

const DEMO_PROJECTS = [
  {
    png: 'sample-ui.png',
    title: '深色科幻 UI 稿 · 数据看板',
    description:
      '一套深色主题的数据看板主视觉稿：渐变背景、两颗主色圆形、斜条纹装饰，以及标题与副标题区块。\n\n' +
      '源文件（PSD 分层稿）放在百度网盘，提取码见下方。',
    author: 'Shirohae',
    tags: 'UI,科幻,深色,数据看板',
    netdiskUrl: 'https://pan.baidu.com/s/1dEmOxYzAbCdEfGhIjKlMn',
    extractCode: 'ui88',
    sourceFileName: '深色科幻UI稿_分层.psd',
    sourceNote: '含分层源文件，约 180 MB',
  },
  {
    png: 'sample-cmyk-rle.png',
    title: '印刷稿 · CMYK 四色色卡',
    description:
      'CMYK 四色模式工程（4 个颜色通道），用于核对印刷稿的墨量表现。\n\n' +
      '预览图是屏幕显示效果，实际印刷颜色请以源文件的色彩配置为准。',
    author: 'Shirohae',
    tags: '印刷,CMYK,色卡',
    netdiskUrl: 'https://pan.baidu.com/s/1ZyXwVuTsRqPoNmLkJiHgF',
    extractCode: 'cmyk',
    sourceFileName: '四色色卡_CMYK.psd',
    sourceNote: '含 ICC 特性文件',
  },
  {
    png: 'sample-lab.png',
    title: 'Lab 色彩空间稿',
    description:
      'Lab 模式（明度 L + 色度 a/b）的配色实验稿。\n\n' +
      'Lab 的色域比 sRGB 宽，屏幕预览会有部分颜色被裁到 sRGB 范围内。',
    author: 'Shirohae',
    tags: 'Lab,色彩空间,配色',
    netdiskUrl: 'https://pan.quark.cn/s/a1b2c3d4e5f6',
    extractCode: null,
    sourceFileName: 'Lab配色实验.psd',
    sourceNote: null,
  },
  {
    png: 'sample-indexed.png',
    title: '索引色 · 256 色量化',
    description:
      '索引色模式，颜色被量化到 256 色调色板。\n\n' +
      '适合做像素风、老游戏美术，或者需要严格控制颜色数量的场合。',
    author: 'Shirohae',
    tags: '索引色,像素风,量化',
    netdiskUrl: 'https://www.alipan.com/s/AbCdEfGhIjKl',
    extractCode: null,
    sourceFileName: '索引色底稿.psd',
    sourceNote: '256 色调色板已内嵌',
  },
  {
    png: 'sample-duotone.png',
    title: '双色调 · 单色印刷稿',
    description:
      '双色调模式，用两种油墨表现明暗层次，常用于单色印刷与海报。\n\n' +
      '源文件里保留了双色调曲线设置，需要按曲线才能还原专色效果。',
    author: 'Shirohae',
    tags: '双色调,海报,印刷',
    netdiskUrl: 'https://wwa.lanzouo.com/iAbCdEfGh',
    extractCode: '2tone',
    sourceFileName: '双色调海报.psd',
    sourceNote: null,
  },
  {
    png: 'sample-portrait.png',
    title: '手机 UI 稿 · 竖版画布 1080×2340',
    description:
      '竖版画布（1080×2340），常见于手机端 UI 设计稿。\n\n' +
      '这条也用来验证图库卡片与详情页的预览框是否**按画布真实比例**撑开，而不是套一个固定比例。',
    author: 'Shirohae',
    tags: '手机UI,竖版,App',
    netdiskUrl: 'https://1drv.ms/u/s!AbCdEfGhIjKlMn',
    extractCode: null,
    sourceFileName: 'App首页设计稿.psd',
    sourceNote: 'OneDrive 分享，无需提取码',
  },
  {
    png: 'sample-mini.png',
    title: '图标底稿 · 任意网盘示例',
    description:
      '这条演示的是「**未被识别的网盘/任意链接**」的情况：\n' +
      '链接域名不在已知网盘列表里，界面会显示为「其它链接」，功能完全不受影响。',
    author: 'Shirohae',
    tags: '图标,示例,其它链接',
    netdiskUrl: 'https://files.example.com/share/icon-draft-2026',
    extractCode: null,
    sourceFileName: '图标底稿.psd',
    sourceNote: '自建文件服务器',
  },
];

const headers = TOKEN ? { 'x-upload-token': TOKEN } : {};

async function main() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    const health = await res.json();
    console.log(`站点在线： ${BASE}   (${health.name} v${health.version})`);
  } catch (err) {
    console.error(`连不上 ${BASE}/api/health —— 先把服务起起来再跑这个脚本。\n${err.message}`);
    process.exit(1);
  }

  const config = await (await fetch(`${BASE}/api/config`)).json();
  if (config.uploadTokenRequired && !TOKEN) {
    console.error('该站点的上传接口需要令牌，请用 --upload-token <token> 传入。');
    process.exit(1);
  }
  console.log(`上传上限： ${config.maxUploadLabel}   接受的图片类型： ${(config.acceptedImageTypes ?? []).join(', ')}`);

  const before = (await (await fetch(`${BASE}/api/projects?pageSize=1`)).json()).total;
  console.log(`当前工程数： ${before}\n`);

  let created = 0;
  let skipped = 0;

  for (const demo of DEMO_PROJECTS) {
    const pngPath = join(FIXTURES, demo.png);
    if (!existsSync(pngPath)) {
      console.error(`✗ 缺少素材 ${pngPath}，请先执行： npm run fixture`);
      process.exit(1);
    }

    const form = new FormData();
    form.append('image', new Blob([readFileSync(pngPath)], { type: 'image/png' }), demo.png);
    form.append('title', demo.title);
    form.append('description', demo.description);
    form.append('author', demo.author);
    form.append('tags', demo.tags);
    form.append('netdiskUrl', demo.netdiskUrl);
    if (demo.extractCode) form.append('extractCode', demo.extractCode);
    if (demo.sourceFileName) form.append('sourceFileName', demo.sourceFileName);
    if (demo.sourceNote) form.append('sourceNote', demo.sourceNote);

    const res = await fetch(`${BASE}/api/projects`, { method: 'POST', body: form, headers });
    const body = await res.json().catch(() => ({}));

    if (res.status === 201) {
      created++;
      const item = body.item;
      console.log(`✓ 已创建  ${item.id}   [${item.source.providerLabel}]`);
      console.log(`         ${item.title}`);
      console.log(`         详情 ${BASE}/p/${item.id}    网盘跳转 ${BASE}${item.source ? `/api/projects/${item.id}/go` : ''}`);
    } else if (res.status === 409) {
      skipped++;
      const existingId = body?.error?.details?.existingId;
      console.log(`· 已存在，跳过  ${demo.title}`);
      if (existingId) console.log(`         已有工程 ${BASE}/p/${existingId}`);
    } else {
      console.error(`✗ 失败（${res.status}）  ${demo.title}\n         ${body?.error?.message ?? JSON.stringify(body)}`);
    }
  }

  const after = (await (await fetch(`${BASE}/api/projects?pageSize=1`)).json()).total;
  console.log(`\n完成：新建 ${created} 条，跳过 ${skipped} 条，站点工程总数 ${before} → ${after}`);
  console.log('提示：演示用的网盘链接是占位链接（分享路径虚构），点进去网盘会提示分享不存在。');
  console.log(`图库入口： ${BASE}/`);
}

main().catch((err) => {
  console.error(`运行异常：${err.stack ?? err.message}`);
  process.exit(1);
});
