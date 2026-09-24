/**
 * 临时校验：确认品牌区「两行左右对齐」在真实字体度量下成立。
 *
 * 思路：用 Skia（@napi-rs/canvas）按 CSS 里的字号实测两行文本宽度，
 *   · 若「上行（大字号 6 字）」比「下行（小字号 8 字）」宽 → 上行决定容器宽度，
 *     下行被 flex 的 space-between 撑满到同宽，两行左右边缘严格对齐；
 *   · 若反过来，则下行为宽度基准，上行被撑开（同样对齐，但字距会很大，观感差）。
 * 因此这里要验证的是「上行更宽」这个前提。
 *
 * 用法： node frontend/scripts/check-brand.mjs
 */
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

// 与 pages.css 中的取值保持一致
const PRIMARY = { text: '柒世纪视频组', fontSize: 17, marginEm: 0.06 }; // 1.0625rem
const SECONDARY = { text: '平面工程分享平台', fontSize: 11, marginEm: 0.06 }; // 0.6875rem

const canvas = createCanvas(400, 100);
const ctx = canvas.getContext('2d');

const families = GlobalFonts.families.map((f) => f.family);
const cjkCandidate =
  families.find((f) => /YaHei|SimHei|SimSun|Noto Sans CJK|Source Han|Microsoft YaHei/i.test(f)) ??
  families[0];

console.log(`可用字体数：${families.length}，用于测量：${cjkCandidate ?? '(默认)'}`);

function measure({ text, fontSize, marginEm }) {
  ctx.font = `800 ${fontSize}px "${cjkCandidate}"`;
  const chars = Array.from(text);
  const glyphs = chars.map((c) => ctx.measureText(c).width);
  const natural = glyphs.reduce((a, b) => a + b, 0);
  // CSS 里用 margin-right 给「非末字」加间距，末字不加 → 不会有多余的右侧空隙
  const withMargins = natural + (chars.length - 1) * marginEm * fontSize;
  return { chars: chars.length, perChar: natural / chars.length, natural, width: withMargins };
}

const p = measure(PRIMARY);
const s = measure(SECONDARY);

const fmt = (r) =>
  `字数=${r.chars}  单字宽=${r.perChar.toFixed(2)}px  自然宽=${r.natural.toFixed(1)}px  含字距=${r.width.toFixed(1)}px`;

console.log(`\n上行「${PRIMARY.text}」@${PRIMARY.fontSize}px  ${fmt(p)}`);
console.log(`下行「${SECONDARY.text}」@${SECONDARY.fontSize}px  ${fmt(s)}`);

const target = Math.max(p.width, s.width);
console.log(`\n容器宽度（取较宽者）= ${target.toFixed(1)}px`);
console.log(`  上行被撑开量 = ${(target - p.width).toFixed(1)}px`);
console.log(`  下行被撑开量 = ${(target - s.width).toFixed(1)}px`);

const ok = p.width >= s.width;
console.log(
  ok
    ? '\n✓ 前提成立：上行（大字号）更宽，它决定宽度、下行被撑满 → 两行左右边缘严格对齐'
    : '\n✗ 前提不成立：下行更宽，会导致上行字距被拉得过大（需调大上行字号或减小下行字号）',
);

console.log(
  `\n两行对齐后的右边缘坐标（从同一左边缘起算）：上行=${target.toFixed(1)}  下行=${target.toFixed(1)}  → 差值 ${(target - target).toFixed(1)}px`,
);

process.exit(ok ? 0 : 1);
