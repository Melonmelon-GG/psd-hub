/**
 * blendModes 纯函数测试：PSD 混合模式（ag-psd 使用带空格的单词）
 * 必须全部映射到合法的 Canvas globalCompositeOperation，未知值有合理兜底。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANVAS_BLEND_MODES,
  KNOWN_PSD_BLEND_MODES,
  blendModeLabel,
  isApproximateBlendMode,
  mapBlendMode,
  normalizeBlendModeKey,
} from '../src/psd/blendModes.ts';

test('normalizeBlendModeKey 统一大小写、空格与下划线', () => {
  assert.equal(normalizeBlendModeKey('  Multiply '), 'multiply');
  assert.equal(normalizeBlendModeKey('linear burn'), 'linear-burn');
  assert.equal(normalizeBlendModeKey('color_burn'), 'color-burn');
  assert.equal(normalizeBlendModeKey('pass   through'), 'pass-through');
});

test('基础模式映射到同名 Canvas 模式', () => {
  assert.equal(mapBlendMode('multiply'), 'multiply');
  assert.equal(mapBlendMode('screen'), 'screen');
  assert.equal(mapBlendMode('overlay'), 'overlay');
  assert.equal(mapBlendMode('darken'), 'darken');
  assert.equal(mapBlendMode('lighten'), 'lighten');
  assert.equal(mapBlendMode('difference'), 'difference');
  assert.equal(mapBlendMode('exclusion'), 'exclusion');
  assert.equal(mapBlendMode('hue'), 'hue');
  assert.equal(mapBlendMode('saturation'), 'saturation');
  assert.equal(mapBlendMode('color'), 'color');
  assert.equal(mapBlendMode('luminosity'), 'luminosity');
  assert.equal(mapBlendMode('soft light'), 'soft-light');
  assert.equal(mapBlendMode('hard light'), 'hard-light');
  assert.equal(mapBlendMode('color dodge'), 'color-dodge');
  assert.equal(mapBlendMode('color burn'), 'color-burn');
});

test('normal 与 pass through 都映射为 source-over', () => {
  assert.equal(mapBlendMode('normal'), 'source-over');
  assert.equal(mapBlendMode('pass through'), 'source-over');
  assert.equal(mapBlendMode('pass-through'), 'source-over');
});

test('Canvas 无等价项的混合模式做近似映射', () => {
  // 线性加深 → 颜色加深（近似）
  assert.equal(mapBlendMode('linear burn'), 'color-burn');
  assert.equal(mapBlendMode('linear dodge'), 'color-dodge');
  assert.equal(mapBlendMode('vivid light'), 'hard-light');
  assert.equal(mapBlendMode('linear light'), 'hard-light');
  assert.equal(mapBlendMode('pin light'), 'hard-light');
  assert.equal(mapBlendMode('hard mix'), 'hard-light');
  assert.equal(mapBlendMode('subtract'), 'difference');
  assert.equal(mapBlendMode('divide'), 'color-dodge');
  // 深色/浅色 → 变暗/变亮
  assert.equal(mapBlendMode('darker color'), 'darken');
  assert.equal(mapBlendMode('lighter color'), 'lighten');
});

test('未知值与空值兜底为 source-over', () => {
  assert.equal(mapBlendMode('完全不存在的模式'), 'source-over');
  assert.equal(mapBlendMode(''), 'source-over');
  assert.equal(mapBlendMode(undefined), 'source-over');
  assert.equal(mapBlendMode(null), 'source-over');
});

test('兼容驼峰写法', () => {
  assert.equal(mapBlendMode('linearBurn'), 'color-burn');
  assert.equal(mapBlendMode('ColorBurn'), 'color-burn');
  assert.equal(mapBlendMode('passThrough'), 'source-over');
});

test('所有已知 PSD 混合模式的映射结果都是合法的 Canvas 模式', () => {
  const valid = new Set<string>([...CANVAS_BLEND_MODES, 'source-over']);
  for (const mode of KNOWN_PSD_BLEND_MODES) {
    const mapped = mapBlendMode(mode);
    assert.ok(
      valid.has(mapped),
      `PSD 模式 "${mode}" 映射结果 "${mapped}" 不是合法的 globalCompositeOperation`,
    );
  }
});

test('isApproximateBlendMode 标记无原生等价项的模式', () => {
  assert.equal(isApproximateBlendMode('multiply'), false);
  assert.equal(isApproximateBlendMode('normal'), false);
  assert.equal(isApproximateBlendMode('linear burn'), true);
  assert.equal(isApproximateBlendMode('dissolve'), true);
  assert.equal(isApproximateBlendMode(undefined), false);
});

test('blendModeLabel 返回中文标签，未收录时原样返回', () => {
  assert.equal(blendModeLabel('multiply'), '正片叠底');
  assert.equal(blendModeLabel('pass through'), '穿透');
  assert.equal(blendModeLabel('linear burn'), '线性加深');
  assert.equal(blendModeLabel('未收录模式'), '未收录模式');
  assert.equal(blendModeLabel(undefined), '正常');
});
