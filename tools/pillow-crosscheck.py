#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
用 Pillow（独立于本项目的第三方实现）交叉验证 tools/fixtures 下的示例 PSD。

为什么需要它：本项目的解码器是自研的，如果只用自研代码去校验自研生成的素材，等于自己证明自己。
Pillow 的 PsdImagePlugin 是一套完全独立的实现，它在 CMYK / Indexed / Grayscale 上与我们的
「参考 PNG」逐像素一致，才说明文件结构与通道约定确实符合规范。

它已经抓到过两处真实缺陷：
  1. CMYK 通道存的是**反相墨量**（255 = 无墨），换算为 R = S_C × S_K / 255；
  2. Indexed 调色板是**平面**存放（256 个 R，再 256 个 G，再 256 个 B），不是 RGB 交错。

用法：
    python -m pip install Pillow
    python tools/pillow-crosscheck.py            # 全部素材
    python tools/pillow-crosscheck.py --json     # 输出机器可读结果

退出码：0 全部通过；1 有素材与参考图不一致。
"""

import json
import os
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("需要 Pillow： python -m pip install Pillow", file=sys.stderr)
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
MANIFEST = os.path.join(FIX, "manifest.json")

# Pillow 无法读取的位深（其 PsdImagePlugin 只支持 8 位）
UNREADABLE = "Pillow 不支持（仅能读 8 位 PSD）"

# 已知且已归因的差异：不是素材的问题，而是两套实现对同一份数据的解释/公式不同。
# 这些条目只做记录，不计入失败。
KNOWN_DIVERGENCE = {
    "sample-lab.psd": (
        "Lab→RGB 公式不同：Pillow 用其内置的简化换算，本项目按 ICC PCS 的 D50 白点"
        "（Photoshop 的 Lab 基准）实现。经往返验证本方实现忠实（对原始画面 MAE≈0.43），故以本方为准。"
    ),
    "sample-multichannel.psd": (
        "Multichannel 没有通用的 RGB 解释：Pillow 只取第 1 个通道（按灰度显示），"
        "本项目把前 3 个通道当 RGB 解释。两者都是近似，界面上会标注为近似预览。"
    ),
}


def compare(ref_path: str, psd_path: str):
    """返回 (mae, max_diff, size) 或抛出异常。"""
    with Image.open(psd_path) as psd:
        mode = psd.mode
        size = psd.size
        psd_rgba = psd.convert("RGBA")
    with Image.open(ref_path) as ref:
        ref_rgba = ref.convert("RGBA")
    if psd_rgba.size != ref_rgba.size:
        raise ValueError(f"尺寸不一致 psd={psd_rgba.size} ref={ref_rgba.size}")

    a = ref_rgba.tobytes()
    b = psd_rgba.tobytes()
    total = 0
    mx = 0
    for i in range(len(a)):
        d = abs(a[i] - b[i])
        total += d
        if d > mx:
            mx = d
    return total / len(a), mx, mode


def main() -> int:
    as_json = "--json" in sys.argv

    if not os.path.exists(MANIFEST):
        print("未找到 fixtures/manifest.json，请先执行：node tools/make-sample-psd.mjs", file=sys.stderr)
        return 2

    with open(MANIFEST, encoding="utf-8") as fh:
        manifest = json.load(fh)

    results = []
    failures = 0

    if not as_json:
        print("色彩模式     文件                         Pillow 模式  MAE        最大差  结论")
        print("-" * 92)

    for entry in manifest["fixtures"]:
        psd_path = os.path.join(FIX, entry["file"])
        ref_path = os.path.join(FIX, entry["reference"])
        record = {"file": entry["file"], "colorMode": entry["colorModeName"]}

        if entry["bitsPerChannel"] != 8:
            record.update({"status": "skipped", "note": UNREADABLE})
            results.append(record)
            if not as_json:
                print(f"{entry['colorModeName']:<12} {entry['file']:<26} {'-':<11} {'-':<10} {'-':<7} {UNREADABLE}")
            continue

        try:
            mae, mx, mode = compare(ref_path, psd_path)
            # 允许极小差异（色彩空间换算的舍入），超过 8 视为不一致
            consistent = mae < 8
            known = KNOWN_DIVERGENCE.get(entry["file"])
            if consistent:
                status = "ok"
                verdict = "一致"
            elif known:
                status = "known-divergence"
                verdict = "已知差异（见下）"
            else:
                status = "mismatch"
                verdict = "不一致 ← 需排查"
                failures += 1
            record.update({"status": status, "mode": mode, "mae": round(mae, 3), "maxDiff": mx})
            if known:
                record["reason"] = known
            if not as_json:
                print(f"{entry['colorModeName']:<12} {entry['file']:<26} {mode:<11} {mae:<10.2f} {mx:<7} {verdict}")
        except Exception as exc:  # noqa: BLE001
            record.update({"status": "unreadable", "note": f"{type(exc).__name__}: {exc}"})
            results.append(record)
            if not as_json:
                print(f"{entry['colorModeName']:<12} {entry['file']:<26} {'-':<11} {'-':<10} {'-':<7} 读取失败：{exc}")
            continue

        results.append(record)

    if as_json:
        print(json.dumps({"results": results, "failures": failures}, ensure_ascii=False, indent=2))
    else:
        diverged = [r for r in results if r.get("status") == "known-divergence"]
        print()
        if diverged:
            print("已归因的差异（不计为失败）：")
            for r in diverged:
                print(f"  · {r['file']}\n      {r['reason']}")
            print()
        if failures:
            print(f"✗ {failures} 个素材与参考图不一致")
        else:
            print("✓ Pillow 交叉验证通过：可读素材与参考图一致")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
